-- RolloMap initial schema (local v1)
-- Single-user, single-workspace local setup. No auth.
-- The default workspace is created at the bottom of this file.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- workspace ----------
CREATE TABLE workspace (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- source_connection ----------
-- Represents a connector (gmail, google_drive, calendar, linkedin, manual).
-- In v1 only "manual" and "import" are populated.
CREATE TABLE source_connection (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON source_connection (workspace_id);

-- ---------- source_item ----------
-- Raw or imported source content (email, doc, note, calendar event, etc).
CREATE TABLE source_item (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  source_connection_id UUID REFERENCES source_connection(id) ON DELETE SET NULL,
  provider             TEXT NOT NULL,
  provider_item_id     TEXT,
  source_type          TEXT NOT NULL,
  title                TEXT,
  body                 TEXT,
  source_url           TEXT,
  author               TEXT,
  participants         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at_source    TIMESTAMPTZ,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  hash                 TEXT,
  processing_status    TEXT NOT NULL DEFAULT 'processed',
  sensitivity_level    TEXT NOT NULL DEFAULT 'normal',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON source_item (workspace_id);
CREATE INDEX ON source_item (source_type);
CREATE UNIQUE INDEX source_item_provider_unique
  ON source_item (workspace_id, provider, provider_item_id)
  WHERE provider_item_id IS NOT NULL;

-- Full-text search over title+body
ALTER TABLE source_item
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED;
CREATE INDEX source_item_tsv_idx ON source_item USING GIN (tsv);

-- ---------- person ----------
CREATE TABLE person (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  display_name          TEXT NOT NULL,
  primary_email         TEXT,
  aliases               JSONB NOT NULL DEFAULT '[]'::jsonb,
  known_emails          JSONB NOT NULL DEFAULT '[]'::jsonb,
  known_phones          JSONB NOT NULL DEFAULT '[]'::jsonb,
  linkedin_url          TEXT,
  company               TEXT,
  title                 TEXT,
  summary               TEXT,
  how_known             TEXT,
  first_seen_at         TIMESTAMPTZ,
  last_seen_at          TIMESTAMPTZ,
  interaction_count     INTEGER NOT NULL DEFAULT 0,
  relationship_strength NUMERIC(4,3) NOT NULL DEFAULT 0,
  confidence            NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  user_pinned           BOOLEAN NOT NULL DEFAULT false,
  sensitivity_level     TEXT NOT NULL DEFAULT 'normal',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON person (workspace_id);
CREATE INDEX ON person (lower(primary_email));
CREATE INDEX ON person (lower(display_name));

ALTER TABLE person
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(company, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(how_known, '')), 'C')
  ) STORED;
CREATE INDEX person_tsv_idx ON person USING GIN (tsv);

-- ---------- person_identity ----------
-- Each row is an identity signal (email, name, linkedin, etc.) attached to a person.
CREATE TABLE person_identity (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  person_id         UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  identity_type     TEXT NOT NULL,
  identity_value    TEXT NOT NULL,
  source_item_id    UUID REFERENCES source_item(id) ON DELETE SET NULL,
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  verified_by_user  BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, identity_type, identity_value)
);
CREATE INDEX ON person_identity (person_id);

-- ---------- topic ----------
CREATE TABLE topic (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  aliases         JSONB NOT NULL DEFAULT '[]'::jsonb,
  description     TEXT,
  parent_topic_id UUID REFERENCES topic(id) ON DELETE SET NULL,
  created_by      TEXT NOT NULL DEFAULT 'user',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON topic (workspace_id);
CREATE UNIQUE INDEX topic_workspace_name_unique
  ON topic (workspace_id, lower(name));

ALTER TABLE topic
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;
CREATE INDEX topic_tsv_idx ON topic USING GIN (tsv);

-- ---------- person_topic ----------
CREATE TABLE person_topic (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  person_id       UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  topic_id        UUID NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  evidence_count  INTEGER NOT NULL DEFAULT 0,
  last_evidence_at TIMESTAMPTZ,
  user_confirmed  BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, person_id, topic_id)
);
CREATE INDEX ON person_topic (person_id);
CREATE INDEX ON person_topic (topic_id);

-- ---------- interaction ----------
CREATE TABLE interaction (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  source_item_id    UUID REFERENCES source_item(id) ON DELETE SET NULL,
  interaction_type  TEXT NOT NULL,
  title             TEXT,
  summary           TEXT,
  body              TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL,
  topics            JSONB NOT NULL DEFAULT '[]'::jsonb,
  sensitivity_level TEXT NOT NULL DEFAULT 'normal',
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON interaction (workspace_id);
CREATE INDEX ON interaction (occurred_at DESC);

ALTER TABLE interaction
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) STORED;
CREATE INDEX interaction_tsv_idx ON interaction USING GIN (tsv);

-- ---------- interaction_participant ----------
CREATE TABLE interaction_participant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  interaction_id  UUID NOT NULL REFERENCES interaction(id) ON DELETE CASCADE,
  person_id       UUID NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'participant',
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (interaction_id, person_id)
);
CREATE INDEX ON interaction_participant (person_id);

-- ---------- evidence ----------
-- Anchors a claim (topic/role/etc.) to a source.
CREATE TABLE evidence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  claim_type        TEXT NOT NULL,
  claim_id          UUID NOT NULL,
  source_item_id    UUID REFERENCES source_item(id) ON DELETE SET NULL,
  interaction_id    UUID REFERENCES interaction(id) ON DELETE SET NULL,
  quote             TEXT,
  summary           TEXT,
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  created_at_source TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON evidence (workspace_id);
CREATE INDEX ON evidence (claim_type, claim_id);

-- ---------- commitment ----------
CREATE TABLE commitment (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  person_id       UUID REFERENCES person(id) ON DELETE SET NULL,
  interaction_id  UUID REFERENCES interaction(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  due_date        DATE,
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON commitment (workspace_id);
CREATE INDEX ON commitment (person_id);
CREATE INDEX ON commitment (status);

-- ---------- note ----------
-- A first-class manual user note. Distinct from extracted summaries.
CREATE TABLE note (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  person_id     UUID REFERENCES person(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON note (workspace_id);
CREATE INDEX ON note (person_id);

-- ---------- user_correction ----------
CREATE TABLE user_correction (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL,
  entity_id       UUID NOT NULL,
  correction_type TEXT NOT NULL,
  before_value    JSONB,
  after_value     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON user_correction (workspace_id);
CREATE INDEX ON user_correction (entity_type, entity_id);

-- ---------- audit_log ----------
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   UUID,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (workspace_id);
CREATE INDEX ON audit_log (created_at DESC);

-- ---------- updated_at trigger ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['workspace','source_connection','person','topic','person_topic','commitment','note'])
  LOOP
    EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------- default workspace ----------
-- Single-user local mode: create a stable default workspace ID matching .env.example.
INSERT INTO workspace (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Personal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO source_connection (workspace_id, provider, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'manual', 'active')
ON CONFLICT DO NOTHING;
