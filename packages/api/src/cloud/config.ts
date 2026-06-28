/**
 * Cloud config store (MIN-974): persists the device token + sync server URL
 * for the local workspace's pairing with RolloMap Cloud.
 *
 * Storage: `cloud_config` DB table (migration 012), keyed by workspace_id.
 * One row per workspace; upserted on connect, deleted on disconnect.
 *
 * Security note: The raw device token is stored in plaintext because the client
 * must transmit it as an Authorization: Bearer token. This is an acceptable
 * tradeoff for a single-user local v1 client (the DB is on the local machine,
 * access-controlled by OS filesystem permissions). A future v2 should encrypt
 * at rest using a keychain-backed or system-secret key.
 */

import { pool, WORKSPACE_ID } from '../db.js';

export interface CloudConfig {
  syncServerUrl: string;
  deviceToken: string;
  connectedAt: Date;
  lastCheckAt: Date | null;
  lastCheckOk: boolean | null;
}

type CloudConfigRow = {
  sync_server_url: string;
  device_token: string;
  connected_at: Date;
  last_check_at: Date | null;
  last_check_ok: boolean | null;
};

/** Return the cloud config for the default workspace, or null if not paired. */
export async function getCloudConfig(): Promise<CloudConfig | null> {
  const { rows } = await pool.query<CloudConfigRow>(
    `SELECT sync_server_url, device_token, connected_at, last_check_at, last_check_ok
       FROM cloud_config WHERE workspace_id = $1`,
    [WORKSPACE_ID],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    syncServerUrl: row.sync_server_url,
    deviceToken: row.device_token,
    connectedAt: row.connected_at,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok,
  };
}

/** Persist (or update) the cloud pairing config for the default workspace. */
export async function setCloudConfig(config: {
  syncServerUrl: string;
  deviceToken: string;
  lastCheckAt?: Date | null;
  lastCheckOk?: boolean | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO cloud_config
       (workspace_id, sync_server_url, device_token, connected_at, last_check_at, last_check_ok, updated_at)
     VALUES ($1, $2, $3, now(), $4, $5, now())
     ON CONFLICT (workspace_id) DO UPDATE
       SET sync_server_url = EXCLUDED.sync_server_url,
           device_token    = EXCLUDED.device_token,
           last_check_at   = COALESCE(EXCLUDED.last_check_at, cloud_config.last_check_at),
           last_check_ok   = COALESCE(EXCLUDED.last_check_ok, cloud_config.last_check_ok),
           updated_at      = now()`,
    [
      WORKSPACE_ID,
      config.syncServerUrl,
      config.deviceToken,
      config.lastCheckAt ?? null,
      config.lastCheckOk ?? null,
    ],
  );
}

/** Record the outcome of the most recent connectivity check (called by the sync agent). */
export async function updateCloudCheckResult(ok: boolean): Promise<void> {
  await pool.query(
    `UPDATE cloud_config
        SET last_check_at = now(), last_check_ok = $1, updated_at = now()
      WHERE workspace_id = $2`,
    [ok, WORKSPACE_ID],
  );
}

/** Remove the cloud pairing config (disconnect). */
export async function clearCloudConfig(): Promise<void> {
  await pool.query(`DELETE FROM cloud_config WHERE workspace_id = $1`, [WORKSPACE_ID]);
}
