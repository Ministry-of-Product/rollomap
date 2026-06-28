-- First-class, reversible, sync-safe person merge (MIN-934).
--
-- WHY: Before this, a merge was a one-way operation — references were moved
-- source→target, a user_correction row recorded "merged_from", and the source
-- person was tombstoned. There was no durable record of WHICH reference rows
-- moved, so a merge could not be reversed, and apply.ts could not replay a peer's
-- merge (it was a deferred no-op). This table makes a merge a first-class,
-- replayable, reversible entity.
--
-- A person_merge row captures:
--   * the source→target pair (so resolvePersonRedirect can map stale references
--     from a merged-away source onto the live target, transitively);
--   * `relocations` — the EXACT reference rows that were moved (table + row ids,
--     plus rows deleted to satisfy unique constraints, plus the source's
--     person_topic rows) so reverse() can put them back;
--   * the sync event that authored the merge, for debugging/audit;
--   * reversal bookkeeping (reversed_at / reversed_by_device_id).
--
-- FK policy (mirrors entity_tombstone, MIN-933):
--   * NO FK to device(id): a merge may be replayed from a peer whose device row
--     isn't known locally yet; created_by/reversed_by_device_id are informational.
--   * NO FK to person(id) on source/target: the source person is tombstoned and
--     may later be COMPACTED (physically removed); a person FK would cascade-delete
--     this merge history. We deliberately retain the history past compaction.

CREATE TABLE IF NOT EXISTS person_merge (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  source_person_id      UUID NOT NULL,
  target_person_id      UUID NOT NULL,
  -- sync_event.id of the 'person.merged' event that authored this merge.
  merge_event_id        UUID,
  created_by_device_id  UUID,
  -- Exactly which reference rows were moved source→target. Shape:
  --   { interaction_participant: { moved: uuid[], deleted: row[] },
  --     note: uuid[], commitment: uuid[], person_identity: uuid[],
  --     person_topic: row[] }
  -- `moved` ids are flipped back to source on reverse; `deleted`/`person_topic`
  -- rows are re-inserted on reverse.
  relocations           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at           TIMESTAMPTZ,
  reversed_by_device_id UUID
);

CREATE INDEX IF NOT EXISTS person_merge_source_idx ON person_merge (workspace_id, source_person_id);
CREATE INDEX IF NOT EXISTS person_merge_target_idx ON person_merge (workspace_id, target_person_id);
