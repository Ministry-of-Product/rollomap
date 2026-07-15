-- Notes are immutable + archivable (see docs/sync-field-coverage.md).
--
-- There is no note-edit endpoint, so notes are already append-only. This adds a
-- soft-archive: "deleting" a note sets archived_at instead of removing the row,
-- which (a) preserves the audit trail and (b) replicates across devices as the
-- `note.deleted` wire tombstone (a hard DELETE recorded no sync event and lost
-- the row locally). Reads exclude archived notes by default.
ALTER TABLE note ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Fast "live notes for a person" lookups (the common read path).
CREATE INDEX IF NOT EXISTS note_person_live_idx
  ON note(person_id, kind, created_at DESC)
  WHERE archived_at IS NULL;
