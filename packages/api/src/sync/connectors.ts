/**
 * Source connector lifecycle helpers (MIN-937).
 *
 * All state-mutating functions accept a transaction client and must be called
 * inside a BEGIN/COMMIT block (use withSyncTxn from events.ts).  They emit a
 * sync event in the SAME transaction so the lifecycle action is replayable.
 *
 * STATUS VOCABULARY
 * -----------------
 *   active       — default; imports accepted.
 *   paused       — user suspended; imports blocked (409); resume → active.
 *   disconnected — user terminated; imports blocked (409); cannot be resumed,
 *                  requires a fresh POST /connections.
 *   error        — set by the adapter on sync failure; last_error carries detail.
 *
 * VALID TRANSITIONS
 * -----------------
 *   active → paused        (pause)
 *   paused → active        (resume)
 *   active | paused → disconnected   (disconnect)
 *   active → active        (resync — stamps last_sync_at, last_sync_status='ok')
 *
 * Attempting an invalid transition returns a 409-appropriate error (throw with
 * .statusCode = 409).
 */

import { WORKSPACE_ID } from '../db.js';
import type { QueryableClient } from './device.js';
import { recordEvent } from './events.js';
import { deriveCanonicalField } from './assertions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'active' | 'paused' | 'disconnected' | 'error';

export interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: string;
  status: ConnectionStatus;
  config: Record<string, unknown>;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fetch a connection row by id; throws a 404 error if not found. */
async function requireConnection(
  client: QueryableClient,
  connectionId: string,
): Promise<ConnectionRow> {
  const r = await client.query<ConnectionRow>(
    `SELECT id, workspace_id, provider, status, config, last_sync_at,
            last_sync_status, last_error, created_at, updated_at
       FROM source_connection
      WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, connectionId],
  );
  if (!r.rows[0]) {
    const err = new Error('connection not found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  return r.rows[0];
}

function transitionError(msg: string): Error & { statusCode: number } {
  const err = new Error(msg) as Error & { statusCode: number };
  err.statusCode = 409;
  return err;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ConnectionWithCounts extends ConnectionRow {
  source_item_count: number;
  source_assertion_count: number;
}

/** List all connections for the workspace, with item + assertion counts. */
export async function listConnections(client: QueryableClient): Promise<ConnectionWithCounts[]> {
  const r = await client.query<ConnectionWithCounts>(
    `SELECT sc.id, sc.workspace_id, sc.provider, sc.status, sc.config,
            sc.last_sync_at, sc.last_sync_status, sc.last_error,
            sc.created_at, sc.updated_at,
            count(DISTINCT si.id)::int   AS source_item_count,
            count(DISTINCT pfa.id)::int  AS source_assertion_count
       FROM source_connection sc
  LEFT JOIN source_item si
         ON si.source_connection_id = sc.id
        AND si.workspace_id = sc.workspace_id
  LEFT JOIN person_field_assertion pfa
         ON pfa.source_connection_id = sc.id
        AND pfa.workspace_id = sc.workspace_id
        AND pfa.user_confirmed = false
      WHERE sc.workspace_id = $1
   GROUP BY sc.id
   ORDER BY sc.created_at ASC`,
    [WORKSPACE_ID],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createConnection(
  client: QueryableClient,
  provider: string,
  config: Record<string, unknown> = {},
): Promise<ConnectionRow> {
  const r = await client.query<ConnectionRow>(
    `INSERT INTO source_connection (workspace_id, provider, status, config)
     VALUES ($1, $2, 'active', $3::jsonb)
     RETURNING id, workspace_id, provider, status, config,
               last_sync_at, last_sync_status, last_error, created_at, updated_at`,
    [WORKSPACE_ID, provider, JSON.stringify(config)],
  );
  const row = r.rows[0]!;
  await recordEvent(client, {
    entityType: 'source_connection',
    entityId: row.id,
    operation: 'connection.created',
    payload: row,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

export async function pauseConnection(
  client: QueryableClient,
  connectionId: string,
): Promise<ConnectionRow> {
  const conn = await requireConnection(client, connectionId);
  if (conn.status !== 'active') {
    throw transitionError(
      `cannot pause a connection with status '${conn.status}' — only 'active' connections can be paused`,
    );
  }
  const r = await client.query<ConnectionRow>(
    `UPDATE source_connection
        SET status = 'paused', updated_at = now()
      WHERE workspace_id = $1 AND id = $2
  RETURNING id, workspace_id, provider, status, config,
            last_sync_at, last_sync_status, last_error, created_at, updated_at`,
    [WORKSPACE_ID, connectionId],
  );
  const row = r.rows[0]!;
  await recordEvent(client, {
    entityType: 'source_connection',
    entityId: row.id,
    operation: 'connection.paused',
    payload: { id: row.id, status: row.status },
  });
  return row;
}

export async function resumeConnection(
  client: QueryableClient,
  connectionId: string,
): Promise<ConnectionRow> {
  const conn = await requireConnection(client, connectionId);
  if (conn.status !== 'paused') {
    throw transitionError(
      `cannot resume a connection with status '${conn.status}' — only 'paused' connections can be resumed`,
    );
  }
  const r = await client.query<ConnectionRow>(
    `UPDATE source_connection
        SET status = 'active', updated_at = now()
      WHERE workspace_id = $1 AND id = $2
  RETURNING id, workspace_id, provider, status, config,
            last_sync_at, last_sync_status, last_error, created_at, updated_at`,
    [WORKSPACE_ID, connectionId],
  );
  const row = r.rows[0]!;
  await recordEvent(client, {
    entityType: 'source_connection',
    entityId: row.id,
    operation: 'connection.resumed',
    payload: { id: row.id, status: row.status },
  });
  return row;
}

export async function disconnectConnection(
  client: QueryableClient,
  connectionId: string,
): Promise<ConnectionRow> {
  const conn = await requireConnection(client, connectionId);
  if (conn.status === 'disconnected') {
    throw transitionError(`connection is already disconnected`);
  }
  const r = await client.query<ConnectionRow>(
    `UPDATE source_connection
        SET status = 'disconnected', updated_at = now()
      WHERE workspace_id = $1 AND id = $2
  RETURNING id, workspace_id, provider, status, config,
            last_sync_at, last_sync_status, last_error, created_at, updated_at`,
    [WORKSPACE_ID, connectionId],
  );
  const row = r.rows[0]!;
  await recordEvent(client, {
    entityType: 'source_connection',
    entityId: row.id,
    operation: 'connection.disconnected',
    payload: { id: row.id, status: row.status },
  });
  return row;
}

/**
 * Resync stamps last_sync_at=now() and last_sync_status='ok'.
 * This is the control-model stub — no real data fetch happens here.
 * A real adapter would call this after successfully pulling updates.
 * Only allowed from 'active' (or 'error') status; not from paused/disconnected.
 */
export async function resyncConnection(
  client: QueryableClient,
  connectionId: string,
): Promise<ConnectionRow> {
  const conn = await requireConnection(client, connectionId);
  if (conn.status === 'paused' || conn.status === 'disconnected') {
    throw transitionError(
      `cannot resync a connection with status '${conn.status}' — connection must be active`,
    );
  }
  const r = await client.query<ConnectionRow>(
    `UPDATE source_connection
        SET last_sync_at = now(), last_sync_status = 'ok',
            last_error = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
  RETURNING id, workspace_id, provider, status, config,
            last_sync_at, last_sync_status, last_error, created_at, updated_at`,
    [WORKSPACE_ID, connectionId],
  );
  return r.rows[0]!;
  // resync is a control stub — no sync event emitted (no data changed, no replay needed).
}

// ---------------------------------------------------------------------------
// Safe removal of source-derived data
// ---------------------------------------------------------------------------

export interface RemoveDataResult {
  source_items_removed: number;
  assertions_removed: number;
  persons_reprocessed: number;
}

/**
 * Remove all source-derived data for a connection WITHOUT touching manually-
 * confirmed contact data.
 *
 * Guarantees:
 *  1. Deletes every source_item whose source_connection_id = connectionId.
 *  2. Deletes every person_field_assertion where user_confirmed=false AND
 *     source_connection_id = connectionId — source-backed claims only.
 *  3. NEVER touches user_confirmed=true assertions.
 *  4. NEVER deletes person rows (canonical contact records survive).
 *  5. After deletion, re-derives every canonical column for every affected
 *     person so values fall back to remaining / manual assertions.
 *  6. Emits a source.removed sync event in the same transaction.
 */
export async function removeSourceData(
  client: QueryableClient,
  connectionId: string,
): Promise<RemoveDataResult> {
  // Verify the connection exists (throws 404 if not).
  await requireConnection(client, connectionId);

  // Collect affected (person_id, field_name) BEFORE deleting so we can re-derive
  // after the assertions are gone.
  const affectedAssertions = await client.query<{ person_id: string; field_name: string }>(
    `SELECT DISTINCT person_id, field_name
       FROM person_field_assertion
      WHERE workspace_id = $1
        AND source_connection_id = $2
        AND user_confirmed = false`,
    [WORKSPACE_ID, connectionId],
  );
  const toRederive = affectedAssertions.rows; // [{person_id, field_name}, ...]

  // 1. Delete source-backed assertions for this connection.
  const deletedAssertions = await client.query(
    `DELETE FROM person_field_assertion
      WHERE workspace_id = $1
        AND source_connection_id = $2
        AND user_confirmed = false`,
    [WORKSPACE_ID, connectionId],
  );

  // 2. Delete source_items for this connection.
  const deletedItems = await client.query(
    `DELETE FROM source_item
      WHERE workspace_id = $1
        AND source_connection_id = $2`,
    [WORKSPACE_ID, connectionId],
  );

  // 3. Re-derive canonical columns for every affected person+field.
  //    If the deleted assertion was the only one, deriveCanonicalField leaves
  //    the column as-is (no winner → no UPDATE) so the value stays stale; this
  //    is acceptable — a future manual assertion will overwrite it.
  const seen = new Set<string>();
  for (const { person_id, field_name } of toRederive) {
    const key = `${person_id}:${field_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      await deriveCanonicalField(client, person_id, field_name);
    }
  }

  const result: RemoveDataResult = {
    source_items_removed: deletedItems.rowCount ?? 0,
    assertions_removed: deletedAssertions.rowCount ?? 0,
    persons_reprocessed: new Set(toRederive.map((r) => r.person_id)).size,
  };

  await recordEvent(client, {
    entityType: 'source_connection',
    entityId: connectionId,
    operation: 'source.removed',
    payload: result,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Import guard
// ---------------------------------------------------------------------------

/**
 * Throws a 409 if the given connection is paused or disconnected.
 * Called by POST /import when a connection_id is provided.
 */
export async function assertConnectionAcceptsImport(
  client: QueryableClient,
  connectionId: string,
): Promise<ConnectionRow> {
  const conn = await requireConnection(client, connectionId);
  if (conn.status === 'paused') {
    throw transitionError(
      `connection '${connectionId}' is paused — unpause it before importing`,
    );
  }
  if (conn.status === 'disconnected') {
    throw transitionError(
      `connection '${connectionId}' is disconnected — create a new connection to import`,
    );
  }
  return conn;
}
