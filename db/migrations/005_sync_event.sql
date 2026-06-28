-- Append-only sync event log (MIN-931)
-- Durable, immutable record of every user-visible mutation so each device can
-- push/pull and replay changes locally for offline multi-machine sync.
--
-- Design notes:
--  * operation / entity_type are free-form TEXT (NOT NULL only) — later tickets
--    add tombstone/merge/assertion/share operations without a migration.
--  * logical_clock is drawn from a dedicated per-workspace SEQUENCE so it is
--    monotonic under concurrency (never MAX()+1).
--  * Rows are immutable: a trigger rejects UPDATE and DELETE. Sync does NOT
--    depend on audit_log; this is a separate, self-sufficient log.

-- Monotonic logical clock shared across the workspace's sync events.
CREATE SEQUENCE IF NOT EXISTS sync_event_clock_seq;

CREATE TABLE IF NOT EXISTS sync_event (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  device_id      UUID NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL,
  entity_id      UUID NOT NULL,
  operation      TEXT NOT NULL,
  payload        JSONB NOT NULL,
  logical_clock  BIGINT NOT NULL,
  hash           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_event_workspace_clock_idx
  ON sync_event (workspace_id, logical_clock);
CREATE INDEX IF NOT EXISTS sync_event_entity_idx
  ON sync_event (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS sync_event_created_at_idx
  ON sync_event (created_at);

-- Immutability: events are append-only. Reject any UPDATE/DELETE at the DB
-- level so no write path (REST, MCP, or ad-hoc SQL) can mutate history.
CREATE OR REPLACE FUNCTION sync_event_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sync_event is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  EXECUTE 'CREATE TRIGGER sync_event_no_update BEFORE UPDATE ON sync_event FOR EACH ROW EXECUTE FUNCTION sync_event_block_mutation()';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE TRIGGER sync_event_no_delete BEFORE DELETE ON sync_event FOR EACH ROW EXECUTE FUNCTION sync_event_block_mutation()';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
