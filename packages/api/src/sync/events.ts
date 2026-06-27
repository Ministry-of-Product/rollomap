/**
 * Append-only sync event log service (MIN-931).
 *
 * Every user-visible mutation records a sync event in the SAME transaction as
 * the data change, so each device can later push/pull and replay changes for
 * offline multi-machine sync. Events are immutable (enforced by DB triggers in
 * migration 005_sync_event.sql) and independent of audit_log.
 *
 * Usage from a route handler:
 *
 *   await withSyncTxn(async (client) => {
 *     const row = (await client.query('INSERT ... RETURNING *', [...])).rows[0];
 *     await recordEvent(client, {
 *       entityType: 'person', entityId: row.id,
 *       operation: 'person.created', payload: row,
 *     });
 *     return row;
 *   });
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { pool, WORKSPACE_ID } from '../db.js';
import { getLocalDeviceId, type QueryableClient } from './device.js';

/**
 * Known operation strings for the initial sync surface. Operation is free-form
 * at the DB level (TEXT NOT NULL) — later tickets add tombstone/merge/assertion/
 * share operations — so this is a convenience for callers, not an enum.
 */
export const SYNC_OPERATIONS = [
  'person.created',
  'person.updated',
  'person.deleted',
  'person.merged',
  'identity.added',
  'topic.linked',
  'note.created',
  'interaction.created',
] as const;

export type SyncOperation = (typeof SYNC_OPERATIONS)[number];

export interface RecordEventInput {
  /** Canonical entity type, e.g. 'person', 'note', 'interaction'. */
  entityType: string;
  /** UUID of the affected entity. */
  entityId: string;
  /** Operation string — use SYNC_OPERATIONS members where they apply. */
  operation: string;
  /**
   * Replayable payload. For create/update include the full new row state; for
   * delete include at least the id; for merge include source + target ids.
   */
  payload: unknown;
}

export interface SyncEventRow {
  id: string;
  workspace_id: string;
  device_id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  payload: unknown;
  logical_clock: string; // bigint comes back as string from pg
  hash: string;
  created_at: Date;
}

/**
 * Stable JSON serialization with sorted object keys, so the hash of an event is
 * deterministic regardless of key insertion order.
 */
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
 * Record one sync event inside the caller's transaction.
 *
 * Resolves device_id via getLocalDeviceId(client), assigns a monotonic
 * per-workspace logical_clock from sync_event_clock_seq, computes a sha256 hash
 * over the canonical JSON of the event content, and INSERTs the row.
 *
 * @param client a pg.PoolClient (or pool) running the caller's transaction.
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
 * a data change and its recordEvent call share one atomic transaction. Rolls
 * back and rethrows on any error, and always releases the client.
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
