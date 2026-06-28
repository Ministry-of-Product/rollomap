-- Device identity and trust model (MIN-930)
-- Tracks which machine/client authored changes; supports revocation for sync gating.

CREATE TABLE IF NOT EXISTS device (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  public_key    TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  trusted_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS device_workspace_id_idx ON device (workspace_id);

-- At most one default device per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS device_workspace_default_unique
  ON device (workspace_id)
  WHERE is_default = true;

-- Wire device into the updated_at trigger (set_updated_at defined in 001_init.sql).
DO $$
BEGIN
  EXECUTE 'CREATE TRIGGER device_set_updated_at BEFORE UPDATE ON device FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Bootstrap the default local device for the default workspace.
INSERT INTO device (workspace_id, name, is_default, trusted_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'local-default', true, now())
ON CONFLICT (workspace_id, name) DO NOTHING;
