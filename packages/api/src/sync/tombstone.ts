/**
 * Sync-safe tombstones (MIN-933).
 *
 * A delete no longer physically removes a canonical row — that lets a stale
 * create/update from another device RESURRECT it after the fact. Instead we
 * write an entity_tombstone row, KEEP the canonical row, and emit a sync event
 * (operation 'person.deleted', now meaning "tombstoned"). Reads exclude
 * tombstoned entities; apply.ts refuses to resurrect them.
 *
 * These helpers are the single source of truth shared by routes (local deletes)
 * and apply.ts (replayed remote deletes) so the logic isn't duplicated.
 */

import { recordEvent } from './events.js';
import { getLocalDeviceId, type QueryableClient } from './device.js';
import { WORKSPACE_ID } from '../db.js';

export interface TombstoneInput {
  entityType: string;
  entityId: string;
  reason?: string;
}

/**
 * LOCAL delete path: insert a tombstone AND emit its sync event, atomically in
 * the caller's transaction. Idempotent — a second delete of the same entity is a
 * no-op tombstone-wise but still emits an event (callers gate on row existence).
 *
 * The emitted event's payload carries { id, deleted_by_device_id, reason? } so a
 * peer replaying it (via applyEvent → applyTombstone) can reconstruct the
 * tombstone without re-deriving the device.
 *
 * Returns the recorded sync event { id, logical_clock }.
 */
export async function tombstoneEntity(
  client: QueryableClient,
  input: TombstoneInput,
): Promise<{ id: string; logical_clock: string }> {
  const deviceId = await getLocalDeviceId(client);
  const operation = `${input.entityType}.deleted`;
  const payload = {
    id: input.entityId,
    deleted_by_device_id: deviceId,
    ...(input.reason ? { reason: input.reason } : {}),
  };

  // Record the event first so we can stamp the tombstone with its id.
  const event = await recordEvent(client, {
    entityType: input.entityType,
    entityId: input.entityId,
    operation,
    payload,
  });

  await insertTombstone(client, {
    entityType: input.entityType,
    entityId: input.entityId,
    deletedByDeviceId: deviceId,
    deleteEventId: event.id,
    reason: input.reason,
  });

  return event;
}

export interface InsertTombstoneInput {
  entityType: string;
  entityId: string;
  deletedByDeviceId?: string | null;
  deleteEventId?: string | null;
  reason?: string | null;
}

/**
 * REMOTE/raw path: insert a tombstone row WITHOUT emitting an event (apply.ts
 * must never recordEvent — that would echo). ON CONFLICT DO NOTHING keeps it
 * idempotent: the first delete wins, later replays are no-ops.
 */
export async function insertTombstone(
  client: QueryableClient,
  input: InsertTombstoneInput,
): Promise<void> {
  await client.query(
    `INSERT INTO entity_tombstone
       (workspace_id, entity_type, entity_id, deleted_by_device_id, delete_event_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, entity_type, entity_id) DO NOTHING`,
    [
      WORKSPACE_ID,
      input.entityType,
      input.entityId,
      input.deletedByDeviceId ?? null,
      input.deleteEventId ?? null,
      input.reason ?? null,
    ],
  );
}

/** True when an entity has a tombstone (i.e. has been deleted). */
export async function isTombstoned(
  client: QueryableClient,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM entity_tombstone
      WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3`,
    [WORKSPACE_ID, entityType, entityId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The highest server_seq that EVERY trusted (non-revoked) device has acked.
 *
 * A trusted device with no sync_cursor row has acked nothing → contributes 0, so
 * the floor is 0 and nothing is safe to compact until all of them catch up. This
 * is the precondition gate for compaction.
 */
export async function minTrustedAckedServerSeq(
  client: QueryableClient,
): Promise<number> {
  const r = await client.query<{ floor: string | null }>(
    `SELECT MIN(COALESCE(c.last_seen_server_seq, 0))::text AS floor
       FROM device d
       LEFT JOIN sync_cursor c
         ON c.workspace_id = d.workspace_id AND c.device_id = d.id
      WHERE d.workspace_id = $1 AND d.revoked_at IS NULL`,
    [WORKSPACE_ID],
  );
  return r.rows[0]?.floor ? Number(r.rows[0].floor) : 0;
}

export interface CompactResult {
  /** entity_ids whose canonical row + tombstone were physically removed. */
  compacted: string[];
}

/**
 * COMPACTION / eventual hard delete.
 *
 * Precondition (the only time it's safe to physically remove data): EVERY trusted
 * device has acked PAST the delete event's server_seq — i.e. every device has
 * already learned of the tombstone, so no device can ever push a stale
 * create/update that would resurrect the entity. We gate on
 * minTrustedAckedServerSeq() (see above); a tombstone whose delete_event_id's
 * server_seq is <= that floor is provably known everywhere.
 *
 * Tombstones with a NULL delete_event_id, or whose event is no longer present,
 * are conservatively SKIPPED (we cannot prove they're known everywhere).
 *
 * This is intentionally a manual helper, not a scheduler — call it from an admin
 * task once devices are known to be caught up.
 *
 * @param entityType e.g. 'person'. Determines which canonical table is purged.
 */
export async function compactTombstones(
  client: QueryableClient,
  { entityType }: { entityType: string },
): Promise<CompactResult> {
  const floor = await minTrustedAckedServerSeq(client);

  // Tombstones provably known by every trusted device.
  const safe = await client.query<{ entity_id: string }>(
    `SELECT t.entity_id
       FROM entity_tombstone t
       JOIN sync_event e ON e.id = t.delete_event_id
      WHERE t.workspace_id = $1 AND t.entity_type = $2
        AND e.server_seq <= $3`,
    [WORKSPACE_ID, entityType, floor],
  );
  const entityIds = safe.rows.map((r) => r.entity_id);
  if (entityIds.length === 0) return { compacted: [] };

  // Physically remove the canonical rows. Only 'person' is wired today; extend
  // this map as more entity types adopt tombstones.
  const canonicalTable: Record<string, string> = { person: 'person' };
  const table = canonicalTable[entityType];
  if (table) {
    await client.query(
      `DELETE FROM ${table} WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [WORKSPACE_ID, entityIds],
    );
  }

  // Drop the now-redundant tombstones.
  await client.query(
    `DELETE FROM entity_tombstone
      WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = ANY($3::uuid[])`,
    [WORKSPACE_ID, entityType, entityIds],
  );

  return { compacted: entityIds };
}
