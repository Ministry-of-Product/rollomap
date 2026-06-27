-- Sync cursors + server-assigned ordering for event replication (MIN-932).
--
-- WHY server_seq (the crux of cross-device ordering):
--   logical_clock is drawn from a LOCAL sequence (sync_event_clock_seq) on the
--   ORIGIN device, so clocks COLLIDE across devices and cannot be a cross-device
--   pull cursor by themselves. server_seq is a node-local, strictly-monotonic
--   order — the order in which THIS node learned of each event, whether the
--   event was authored locally (recordEvent) or accepted from a peer via push.
--   pull / ack / cursor all operate on server_seq. The origin logical_clock and
--   device_id are PRESERVED on every row for causality + debugging (and future
--   conflict resolution in MIN-936).
--
-- BIGSERIAL auto-creates its backing sequence and assigns a value via the column
-- DEFAULT on INSERT — so pushed events (stored verbatim with their origin
-- id/device_id/logical_clock/hash) still get a fresh local server_seq here.

ALTER TABLE sync_event ADD COLUMN IF NOT EXISTS server_seq BIGSERIAL;

-- Stable total order for this node's log.
CREATE UNIQUE INDEX IF NOT EXISTS sync_event_server_seq_uidx
  ON sync_event (server_seq);

-- Fast cross-device pull: "events for this workspace after server_seq N".
CREATE INDEX IF NOT EXISTS sync_event_workspace_server_seq_idx
  ON sync_event (workspace_id, server_seq);

-- Per-device replication cursor: how far each device has consumed THIS node's
-- log (by server_seq). Advanced explicitly + idempotently via /api/sync/ack.
--   last_seen_server_seq — the cursor pull/ack operate on (never moves backward).
--   last_seen_event_id    — the sync_event.id at that cursor, for debugging.
--   last_synced_at        — bookkeeping.
CREATE TABLE IF NOT EXISTS sync_cursor (
  workspace_id          UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  device_id             UUID NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  last_seen_server_seq  BIGINT NOT NULL DEFAULT 0,
  last_seen_event_id    UUID,
  last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, device_id)
);
