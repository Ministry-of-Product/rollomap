-- Migration 014: workspace profile — foundation for DB-backed personalization
-- (MIN-1122).
--
-- Stores per-workspace personalization config: the owner's identity (used to
-- skip-self during ingest/dedup), research interests (for overlap scoring),
-- primary network, saved import recipes, and journal skip phrases.
--
-- One row per workspace (single-workspace local v1), like cloud_config
-- (migration 012). This is a workspace-LOCAL config table — it is NOT wired
-- into the sync apply/wire protocol here; that materialization is a separate
-- ticket (MIN-1123). last_event_clock / last_event_seq are reserved for that
-- ticket's LWW tiebreak logic.

CREATE TABLE IF NOT EXISTS workspace_profile (
  workspace_id         UUID PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  owner_name           TEXT,
  owner_emails         JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner_aliases        JSONB NOT NULL DEFAULT '[]'::jsonb,
  interests            JSONB NOT NULL DEFAULT '[]'::jsonb,
  primary_network      TEXT,
  import_recipes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  journal_skip_phrases JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_event_clock     BIGINT,
  last_event_seq       BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reuse the existing set_updated_at() trigger from migration 001.
-- Guarded so re-applying this migration to an existing DB is idempotent
-- (Postgres has no CREATE TRIGGER IF NOT EXISTS), matching migrations 004/005/011.
DO $$ BEGIN
  CREATE TRIGGER workspace_profile_set_updated_at
    BEFORE UPDATE ON workspace_profile
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
