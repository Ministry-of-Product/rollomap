-- Migration 012: cloud configuration for device pairing (MIN-974).
--
-- Stores the local client's RolloMap Cloud pairing: the sync server URL and
-- the raw device token the client sends as Authorization: Bearer.
--
-- One row per workspace (single-workspace local v1). Upserted on connect,
-- deleted on disconnect.
--
-- SECURITY NOTE: The raw device token is stored in plaintext because the
-- client must transmit it verbatim as a Bearer token. This is an acceptable
-- tradeoff for a single-user local v1 deployment (the DB lives on the local
-- machine, protected by OS filesystem permissions). A future v2 should encrypt
-- at rest using a keychain-backed or system-secret key.

CREATE TABLE IF NOT EXISTS cloud_config (
  workspace_id    UUID PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  sync_server_url TEXT NOT NULL,
  device_token    TEXT NOT NULL,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_check_at   TIMESTAMPTZ,
  last_check_ok   BOOLEAN,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
