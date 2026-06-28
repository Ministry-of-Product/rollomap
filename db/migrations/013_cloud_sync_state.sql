-- Migration 013: cloud sync cursors for the client→Cloud sync agent (MIN-973).
--
-- Tracks the two INDEPENDENT high-water marks the sync agent advances when it
-- talks to RolloMap Cloud. One row per workspace (single-workspace local v1).
--
--   last_pushed_local_seq — high-water mark over LOCAL sync_event.server_seq
--                           that has been pushed to the cloud. Advances to the
--                           max server_seq SEEN in each push batch (including
--                           local-only/unpushable ops) so the cursor never
--                           stalls on an op with no wire representation.
--
--   remote_pull_cursor    — the cloud server_seq up to which we have
--                           pulled + applied + acked. Pull pages with `since`
--                           = this value; advanced (monotonically, via GREATEST)
--                           after each page is applied and acked.
--
-- Both cursors are monotonic and idempotent: a crash mid-run re-pushes /
-- re-pulls safely because push is deduped server-side on event.id and
-- applyEvent is idempotent.

CREATE TABLE IF NOT EXISTS cloud_sync_state (
  workspace_id          UUID PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  last_pushed_local_seq BIGINT NOT NULL DEFAULT 0,
  remote_pull_cursor    BIGINT NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
