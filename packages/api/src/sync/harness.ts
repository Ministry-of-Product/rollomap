/**
 * E2E sync test harness (MIN-939).
 *
 * Provides per-device isolated databases (Approach A: separate databases) so
 * sync scenarios can run against the real sync code without cross-contaminating
 * the shared rollomap_test DB.
 *
 * Isolation model: each `makeDevice(name)` call creates a fresh
 * `rollomap_test_dev_{name}_{suffix}` database, applies ALL db/migrations/*.sql
 * in order (simple query protocol → multi-statement files work), and bootstraps
 * the default device row so `getLocalDeviceId` has a stable UUID.
 *
 * Sync transfer: pushEvents / pullEvents / ackCursor all use the singleton `pool`
 * from db.ts and cannot be called with a per-device pool without modifying their
 * internals. Rather than adding optional-pool params to every internal call site in
 * replication.ts (which would be a larger, cross-cutting change), the harness
 * implements a THIN MIRROR that replicates every semantic step of the production
 * push+pull path:
 *   1. Per-pair cursor lookup (sync_cursor keyed by from.deviceId in to's DB)
 *   2. SELECT events from `from` with server_seq > cursor (ordered by server_seq)
 *   3. INSERT verbatim into `to`'s sync_event (ON CONFLICT id DO NOTHING)
 *   4. applyEvent(toClient, event) for genuinely-new events — the real replay path
 *   5. Advance cursor in `to`'s DB
 * This is deliberately identical in semantics to the production path. No device
 * trust check (assertDevicePushable) is performed — isolation is enforced by the
 * per-device databases; trust gating belongs in the HTTP transport layer.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pg from 'pg';
import { WORKSPACE_ID } from '../db.js';
import { getLocalDeviceId } from './device.js';
import { applyEvent, type ApplicableEvent } from './apply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to repo-root db/migrations/ (relative: sync/ → src/ → api/ → packages/ → root) */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/migrations');

/** Full test-DB URL — same env var the test script sets. */
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://rollomap:rollomap@localhost:5432/rollomap_test';

/** Base URL without the trailing /dbname so we can substitute device DB names. */
const PG_BASE_URL = TEST_DB_URL.replace(/\/[^/]*$/, '');

// ─── Device ──────────────────────────────────────────────────────────────────

export interface Device {
  /** Human label for debugging. */
  name: string;
  /** Pool connected to this device's isolated database. */
  pool: pg.Pool;
  /** The UUID of this device's 'local-default' row in its own DB. */
  deviceId: string;
  /** Fully-qualified DB name (e.g. rollomap_test_dev_alice_a1b2c3d4). */
  dbName: string;
}

export interface SyncTransferResult {
  /** Number of events newly written to `to`'s sync_event table. */
  transferred: number;
  /** The cursor value (server_seq in `from`'s DB) advanced to in `to`. */
  cursor: number;
}

// ─── DB lifecycle ─────────────────────────────────────────────────────────────

/**
 * Create a throwaway device database, apply every migration, bootstrap the
 * default device row, and return a Device handle.
 *
 * Prerequisites: the Docker postgres container must be running (same requirement
 * as the existing test suite — reset-test-db.sh also needs it).
 */
export async function makeDevice(name: string): Promise<Device> {
  // Unique suffix prevents collisions when test files run in parallel workers.
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const dbName = `rollomap_test_dev_${safeName}_${suffix}`;

  // Create the device DB (admin connection → any other DB works; we use the test DB).
  const adminPool = new pg.Pool({ connectionString: TEST_DB_URL });
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  // Open a pool for the new DB and apply all migrations in numeric order.
  const devicePool = new pg.Pool({ connectionString: `${PG_BASE_URL}/${dbName}` });

  const migFiles = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // simple query protocol (no params) supports multi-statement SQL files,
  // including DO $$ ... $$ blocks with embedded semicolons.
  const migClient = await devicePool.connect();
  try {
    for (const file of migFiles) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await migClient.query(sql);
    }
  } finally {
    migClient.release();
  }

  // Bootstrap / fetch the local-default device UUID.
  const deviceId = await getLocalDeviceId(devicePool);

  return { name, pool: devicePool, deviceId, dbName };
}

/** End the device's pool and drop its database. Safe to call after a failure. */
export async function teardownDevice(device: Device): Promise<void> {
  try {
    await device.pool.end();
  } catch {
    /* already ended */
  }
  const adminPool = new pg.Pool({ connectionString: TEST_DB_URL });
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS "${device.dbName}" WITH (FORCE)`);
  } finally {
    await adminPool.end();
  }
}

/** Tear down multiple devices, continuing past individual failures. */
export async function teardownAll(devices: Device[]): Promise<void> {
  for (const d of devices) {
    try {
      await teardownDevice(d);
    } catch (err) {
      console.error(`[harness] teardownDevice(${d.name}) failed: ${err}`);
    }
  }
}

// ─── Transaction helper ───────────────────────────────────────────────────────

/**
 * Run `fn` inside a BEGIN/COMMIT transaction on `device`'s pool. Mirrors
 * withSyncTxn (events.ts) but scoped to the device's pool, not the singleton.
 */
export async function withDeviceTxn<T>(
  device: Device,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await device.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Sync transfer ────────────────────────────────────────────────────────────

/**
 * Transfer sync events from `from` to `to`, applying each idempotently.
 *
 * This is the thin-mirror replication path (see module header). The cursor
 * used here is stored in `to`'s sync_cursor table keyed by `from.deviceId`.
 * This repurposes sync_cursor for per-pair tracking (semantically: "to has
 * consumed from's event log up to this server_seq").
 */
export async function syncDevices(
  from: Device,
  to: Device,
): Promise<SyncTransferResult> {
  // 1. Look up the per-pair cursor in `to`'s DB.
  //    Ensure from.deviceId exists as a device row in `to`'s DB first (FK on sync_cursor).
  await to.pool.query(
    `INSERT INTO device (id, workspace_id, name, trusted_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO NOTHING`,
    [from.deviceId, WORKSPACE_ID, `remote-${from.name}`],
  );

  const cursorRes = await to.pool.query<{ last_seen_server_seq: string }>(
    `SELECT last_seen_server_seq FROM sync_cursor
      WHERE workspace_id = $1 AND device_id = $2`,
    [WORKSPACE_ID, from.deviceId],
  );
  const since = cursorRes.rowCount ? Number(cursorRes.rows[0]!.last_seen_server_seq) : 0;

  // 2. Read all of `from`'s events after the cursor.
  const eventsRes = await from.pool.query<{
    id: string;
    device_id: string;
    entity_type: string;
    entity_id: string;
    operation: string;
    payload: unknown;
    logical_clock: string;
    hash: string;
    server_seq: string;
  }>(
    `SELECT id, device_id, entity_type, entity_id, operation, payload,
            logical_clock, hash, server_seq
       FROM sync_event
      WHERE workspace_id = $1 AND server_seq > $2
      ORDER BY server_seq ASC`,
    [WORKSPACE_ID, since],
  );

  const events = eventsRes.rows;
  if (events.length === 0) return { transferred: 0, cursor: since };

  // 3. Transfer in one transaction on `to`.
  const toClient = await to.pool.connect();
  let transferred = 0;
  let maxSeq = since;

  try {
    await toClient.query('BEGIN');

    for (const ev of events) {
      // Ensure the event's ORIGIN device is known in `to`'s DB (FK on sync_event.device_id).
      // Handles relay: events authored by a third device that `from` is relaying.
      await toClient.query(
        `INSERT INTO device (id, workspace_id, name, trusted_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (id) DO NOTHING`,
        [ev.device_id, WORKSPACE_ID, `remote-${ev.device_id}`],
      );

      // Store verbatim (server_seq is BIGSERIAL — assigned fresh in `to`'s DB).
      const ins = await toClient.query(
        `INSERT INTO sync_event
           (id, workspace_id, device_id, entity_type, entity_id, operation, payload, logical_clock, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          ev.id,
          WORKSPACE_ID,
          ev.device_id,
          ev.entity_type,
          ev.entity_id,
          ev.operation,
          JSON.stringify(ev.payload),
          String(ev.logical_clock),
          ev.hash,
        ],
      );

      if ((ins.rowCount ?? 0) > 0) {
        // Genuine new event — replay its canonical effect (the REAL apply path).
        const applicable: ApplicableEvent = {
          id: ev.id,
          device_id: ev.device_id,
          entity_type: ev.entity_type,
          entity_id: ev.entity_id,
          operation: ev.operation,
          payload: ev.payload,
        };
        await applyEvent(toClient, applicable);
        transferred++;
      }

      maxSeq = Math.max(maxSeq, Number(ev.server_seq));
    }

    // 4. Advance the per-pair cursor (never moves backward via GREATEST).
    await toClient.query(
      `INSERT INTO sync_cursor (workspace_id, device_id, last_seen_server_seq, last_synced_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (workspace_id, device_id) DO UPDATE SET
         last_seen_server_seq = GREATEST(sync_cursor.last_seen_server_seq, EXCLUDED.last_seen_server_seq),
         last_synced_at = now()`,
      [WORKSPACE_ID, from.deviceId, maxSeq],
    );

    await toClient.query('COMMIT');
  } catch (err) {
    await toClient.query('ROLLBACK');
    throw err;
  } finally {
    toClient.release();
  }

  return { transferred, cursor: maxSeq };
}

// ─── Debug helper ─────────────────────────────────────────────────────────────

/** Print all sync_event rows for a device to stderr (for test failure context). */
export async function dumpEvents(device: Device, label?: string): Promise<void> {
  const res = await device.pool.query<{
    server_seq: string;
    device_id: string;
    operation: string;
    entity_type: string;
    entity_id: string;
    id: string;
  }>(
    `SELECT server_seq, device_id, operation, entity_type, entity_id, id
       FROM sync_event WHERE workspace_id = $1 ORDER BY server_seq ASC`,
    [WORKSPACE_ID],
  );
  const tag = label ?? device.name;
  console.error(`[dumpEvents:${tag}] ${res.rowCount ?? 0} events:`);
  for (const row of res.rows) {
    console.error(
      `  seq=${row.server_seq} op=${row.operation}` +
        ` type=${row.entity_type} entity=${row.entity_id}` +
        ` dev=${row.device_id} id=${row.id}`,
    );
  }
}
