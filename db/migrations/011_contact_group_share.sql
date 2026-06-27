-- Migration 011: contact groups + snapshot sharing tables (MIN-938).
--
-- Adds two tables:
--   contact_group        — named set of people owned by a workspace.
--   contact_group_member — junction: which people are in which group.
--
-- Share bundles (the JSON export payload) are transient — no table needed.
-- The bundle schema lives in sync/sharing.ts (buildBundle / importBundle).
--
-- "Live sharing" (a persistent shared view where both parties see updates) is
-- explicitly OUT OF SCOPE for this migration and ticket. All sharing today is
-- snapshot-only (mode: 'snapshot'). See docs/contact-sharing.md.

CREATE TABLE IF NOT EXISTS contact_group (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_group_workspace_idx ON contact_group (workspace_id);

-- Reuse the existing set_updated_at() trigger from migration 001.
CREATE TRIGGER contact_group_set_updated_at
  BEFORE UPDATE ON contact_group
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS contact_group_member (
  group_id   UUID NOT NULL REFERENCES contact_group(id) ON DELETE CASCADE,
  person_id  UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, person_id)
);
-- Fast "which groups is this person in?" lookups.
CREATE INDEX IF NOT EXISTS contact_group_member_person_idx ON contact_group_member (person_id);
