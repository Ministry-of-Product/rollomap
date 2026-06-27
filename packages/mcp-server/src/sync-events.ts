/**
 * Append-only sync event recorder for the MCP write path (MIN-931).
 *
 * The MCP server is a separate package with its own pg pool and a `rootDir: src`
 * tsconfig, so it cannot import the API package's src/sync/events.ts directly.
 * This is a deliberate, minimal MIRROR of that service. The canonical-JSON +
 * sha256 hash format and the logical_clock source (sync_event_clock_seq) MUST
 * stay byte-identical to packages/api/src/sync/events.ts so events authored by
 * either write path are replayable and verifiable the same way. If you change
 * one, change the other.
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { pool, WORKSPACE_ID } from './db.js';

type QueryableClient = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
};

export interface RecordEventInput {
  entityType: string;
  entityId: string;
  operation: string;
  payload: unknown;
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Idempotent bootstrap of the workspace's default local device. Mirrors
 * getLocalDeviceId in the API package; safe to call repeatedly.
 */
async function getLocalDeviceId(client: QueryableClient): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO device (workspace_id, name, is_default, trusted_at)
     VALUES ($1, 'local-default', true, now())
     ON CONFLICT (workspace_id, name) DO UPDATE
       SET last_seen_at = now()
     RETURNING id`,
    [WORKSPACE_ID],
  );
  return result.rows[0]!.id;
}

/**
 * Record one sync event inside the caller's transaction. See the API package's
 * recordEvent for the authoritative contract.
 */
export async function recordEvent(
  client: QueryableClient,
  input: RecordEventInput,
): Promise<{ id: string; logical_clock: string }> {
  const deviceId = await getLocalDeviceId(client);

  const clockRes = await client.query<{ logical_clock: string }>(
    `SELECT nextval('sync_event_clock_seq') AS logical_clock`,
  );
  const logicalClock = clockRes.rows[0]!.logical_clock;

  const hash = crypto
    .createHash('sha256')
    .update(
      canonicalJSON({
        workspace: WORKSPACE_ID,
        device: deviceId,
        entity_type: input.entityType,
        entity_id: input.entityId,
        operation: input.operation,
        payload: input.payload,
        logical_clock: logicalClock,
      }),
    )
    .digest('hex');

  const result = await client.query<{ id: string; logical_clock: string }>(
    `INSERT INTO sync_event
       (workspace_id, device_id, entity_type, entity_id, operation, payload, logical_clock, hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id, logical_clock`,
    [
      WORKSPACE_ID,
      deviceId,
      input.entityType,
      input.entityId,
      input.operation,
      JSON.stringify(input.payload),
      logicalClock,
      hash,
    ],
  );

  return result.rows[0]!;
}

/**
 * Run `fn` inside a single BEGIN/COMMIT transaction with a dedicated client, so
 * a data change and its recordEvent share one atomic transaction.
 */
export async function withSyncTxn<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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
