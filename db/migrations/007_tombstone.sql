-- Central tombstone table for sync-safe deletes (MIN-933).
--
-- WHY: A hard DELETE on a canonical row can be RESURRECTED when another device
-- later pushes a stale create/update for the same id. Instead of physically
-- removing the row, a delete now writes a tombstone here (and keeps the canonical
-- row), and emits a sync event (operation 'person.deleted', meaning "tombstoned").
-- Reads exclude tombstoned entities; apply.ts refuses to resurrect them.
--
-- Option 2 (central table) was chosen over per-table deleted_at columns so the
-- delete/exclusion/compaction logic lives in one place across entity types.
--
-- Physical removal happens later via compactTombstones() (sync/tombstone.ts),
-- only once every trusted device has acked past the delete event's server_seq.

CREATE TABLE IF NOT EXISTS entity_tombstone (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  entity_type          TEXT NOT NULL,
  entity_id            UUID NOT NULL,
  -- Origin device that authored the delete. Plain UUID (NO FK): a tombstone can
  -- be replayed from a peer whose device row isn't (yet) known locally, and the
  -- field is informational only.
  deleted_by_device_id UUID,
  -- The sync_event.id of the 'person.deleted' (tombstone) event. Used by
  -- compaction to find the event's server_seq and check it has been acked.
  delete_event_id      UUID,
  deleted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason               TEXT,
  UNIQUE (workspace_id, entity_type, entity_id)
);

-- Fast "is this entity tombstoned?" lookups used by every list/get read path.
CREATE INDEX IF NOT EXISTS entity_tombstone_lookup_idx
  ON entity_tombstone (workspace_id, entity_type, entity_id);
