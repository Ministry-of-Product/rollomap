/**
 * Event replication service: push / pull / ack (MIN-932).
 *
 * Ordering model (the crux — see db/migrations/006_sync_cursor.sql):
 *   Each event carries an ORIGIN logical_clock assigned from the origin device's
 *   LOCAL sequence, so clocks collide across devices. The cross-device cursor is
 *   instead `server_seq` — a node-local BIGSERIAL assigned when THIS node first
 *   stores the event. pull/ack/cursor all operate on server_seq; logical_clock +
 *   device_id ride along for causality/debugging.
 *
 * Trust: push is gated on the SENDING device via assertDevicePushable (revoked /
 * unknown senders are rejected). The origin device_id inside each event is
 * preserved verbatim.
 */

import { pool, WORKSPACE_ID } from '../db.js';
import { assertDevicePushable } from './device.js';
import { applyEvent } from './apply.js';

export const DEFAULT_PULL_BATCH = 500;
export const MAX_PULL_BATCH = 5000;

/** Sentinel so callers can distinguish a trust rejection (→ 403) from a 500. */
export class DeviceNotPushableError extends Error {}

/** An event as it travels between devices (origin-stamped, stored verbatim). */
export interface SyncEventEnvelope {
  id: string;
  device_id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  payload: unknown;
  logical_clock: string | number;
  hash: string;
}

export interface PulledEvent extends SyncEventEnvelope {
  /** Node-local total order assigned by THIS node. The pull/ack cursor. */
  server_seq: string;
  created_at: Date;
}

export interface PushResult {
  received: number;
  /** Newly stored events whose effect was applied to canonical tables. */
  applied: number;
  /** Events already present (ON CONFLICT) — idempotent re-push. */
  duplicate: number;
  /** New events with no canonical effect (unknown/deferred operation). */
  skipped: number;
}

/**
 * Accept a batch of events from a trusted sending device.
 *
 * For each event: store it VERBATIM (origin id/device_id/logical_clock/hash) with
 * ON CONFLICT (id) DO NOTHING — server_seq is assigned locally on insert — then,
 * only for genuinely-new events, apply its effect via applyEvent (NEVER
 * recordEvent → no echo loop). Whole batch is one transaction. An empty batch is
 * a successful no-op.
 */
export async function pushEvents(
  senderDeviceId: string,
  events: SyncEventEnvelope[],
): Promise<PushResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await assertDevicePushable(senderDeviceId, client);
    } catch (err) {
      throw new DeviceNotPushableError(
        err instanceof Error ? err.message : String(err),
      );
    }

    let applied = 0;
    let duplicate = 0;
    let skipped = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const ins = await client.query(
        `INSERT INTO sync_event
           (id, workspace_id, device_id, entity_type, entity_id, operation, payload, logical_clock, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
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
      if ((ins.rowCount ?? 0) === 0) {
        duplicate++; // already learned of this event — apply was done before
        continue;
      }
      // SAVEPOINT so an unexpected exception inside applyEvent does not abort the
      // whole batch. applyEvent returns { applied: false } for expected skips
      // (unknown op, deferred FK, etc.); the catch here handles truly unexpected
      // errors — it parks the event as skipped and lets the rest of the batch commit
      // (MIN-984). The sync_event row is kept (outside the savepoint) so peers still
      // learn about the event even when canonical apply fails.
      const sp = `ev_${i}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        const result = await applyEvent(client, ev);
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        if (result.applied) applied++;
        else skipped++;
      } catch (applyErr) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        console.error(
          `[sync/push] apply failed for event ${ev.id} (${ev.operation}), parking as skipped:`,
          applyErr instanceof Error ? applyErr.message : String(applyErr),
        );
        skipped++;
      }
    }

    await client.query('COMMIT');
    return { received: events.length, applied, duplicate, skipped };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface PullOptions {
  /** server_seq cursor; events with server_seq > since are returned. */
  since?: number | null;
  /** Include the requesting device's OWN events (default false — no echo). */
  includeOwn?: boolean;
  limit?: number;
}

export interface PullResult {
  events: PulledEvent[];
  /** Max server_seq in this batch (or the effective cursor if empty) — ack this. */
  cursor: number;
  count: number;
}

/**
 * Return events this device hasn't seen yet, in server_seq order.
 *
 * `since` defaults to the device's stored cursor (0 if none). By default a
 * device does NOT receive its own events — pass includeOwn to override
 * (e.g. ?include_own=1). Pulling when nothing is new is a successful empty batch.
 */
export async function pullEvents(
  requestingDeviceId: string,
  opts: PullOptions = {},
): Promise<PullResult> {
  const includeOwn = opts.includeOwn ?? false;
  const limit = Math.min(opts.limit ?? DEFAULT_PULL_BATCH, MAX_PULL_BATCH);

  let since = opts.since ?? null;
  if (since === null || since === undefined) {
    since = await getCursor(requestingDeviceId);
  }

  const result = await pool.query<PulledEvent>(
    `SELECT id, device_id, entity_type, entity_id, operation, payload,
            logical_clock, hash, server_seq, created_at
       FROM sync_event
      WHERE workspace_id = $1
        AND server_seq > $2
        AND ($3::boolean OR device_id <> $4)
      ORDER BY server_seq ASC
      LIMIT $5`,
    [WORKSPACE_ID, since, includeOwn, requestingDeviceId, limit],
  );

  const events = result.rows;
  const cursor = events.length
    ? Number(events[events.length - 1]!.server_seq)
    : since;
  return { events, cursor, count: events.length };
}

/**
 * Advance a device's cursor to `serverSeq`. UPSERT keyed by (workspace, device),
 * idempotent, and NEVER moves the cursor backward (GREATEST). Returns the
 * resulting cursor value.
 */
export async function ackCursor(
  deviceId: string,
  serverSeq: number,
  lastEventId?: string | null,
): Promise<{ last_seen_server_seq: number }> {
  const res = await pool.query<{ last_seen_server_seq: string }>(
    `INSERT INTO sync_cursor (workspace_id, device_id, last_seen_server_seq, last_seen_event_id, last_synced_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (workspace_id, device_id) DO UPDATE SET
       last_seen_server_seq = GREATEST(sync_cursor.last_seen_server_seq, EXCLUDED.last_seen_server_seq),
       last_seen_event_id   = CASE
         WHEN EXCLUDED.last_seen_server_seq > sync_cursor.last_seen_server_seq
           THEN EXCLUDED.last_seen_event_id
           ELSE sync_cursor.last_seen_event_id END,
       last_synced_at = now()
     RETURNING last_seen_server_seq`,
    [WORKSPACE_ID, deviceId, serverSeq, lastEventId ?? null],
  );
  return { last_seen_server_seq: Number(res.rows[0]!.last_seen_server_seq) };
}

/** Current stored cursor (server_seq) for a device, or 0 if it has none. */
export async function getCursor(deviceId: string): Promise<number> {
  const cur = await pool.query<{ last_seen_server_seq: string }>(
    `SELECT last_seen_server_seq FROM sync_cursor WHERE workspace_id = $1 AND device_id = $2`,
    [WORKSPACE_ID, deviceId],
  );
  return cur.rowCount ? Number(cur.rows[0]!.last_seen_server_seq) : 0;
}
