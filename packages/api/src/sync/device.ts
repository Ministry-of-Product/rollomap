/**
 * Device identity and trust service (MIN-930).
 *
 * A "device" represents a machine/client that writes to this workspace.
 * In single-user local mode there is exactly one default device ('local-default').
 * Later tickets gate sync-event pushes on trust (MIN-932) using the helpers here.
 */

import pg from 'pg';
import { pool, WORKSPACE_ID } from '../db.js';

/** Any pg client that exposes a `.query` method (pg.Pool or pg.PoolClient). */
export type QueryableClient = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
};

/** Shape returned for a device row. */
export interface DeviceRow {
  id: string;
  workspace_id: string;
  name: string;
  public_key: string | null;
  is_default: boolean;
  trusted_at: Date | null;
  revoked_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const DEVICE_COLUMNS =
  'id, workspace_id, name, public_key, is_default, trusted_at, revoked_at, last_seen_at, created_at, updated_at';

/**
 * Return the id of this workspace's default local device, bootstrapping it
 * idempotently if it doesn't exist yet.
 *
 * Safe to call repeatedly — always returns the same stable UUID.
 * Optionally accepts a pg client/pool to participate in a caller's transaction.
 */
export async function getLocalDeviceId(client?: QueryableClient): Promise<string> {
  const c = client ?? pool;
  const result = await c.query<{ id: string }>(
    `INSERT INTO device (workspace_id, name, is_default, trusted_at)
     VALUES ($1, 'local-default', true, now())
     ON CONFLICT (workspace_id, name) DO UPDATE
       SET last_seen_at = now()
     RETURNING id`,
    [WORKSPACE_ID],
  );
  return result.rows[0]!.id;
}

/**
 * Register a new (non-default) device for a workspace.
 * Trusted immediately (trusted_at = now()).
 */
export async function registerDevice(
  workspaceId: string,
  name: string,
  publicKey?: string,
  client?: QueryableClient,
): Promise<DeviceRow> {
  const c = client ?? pool;
  const result = await c.query<DeviceRow>(
    `INSERT INTO device (workspace_id, name, public_key, trusted_at)
     VALUES ($1, $2, $3, now())
     RETURNING ${DEVICE_COLUMNS}`,
    [workspaceId, name, publicKey ?? null],
  );
  return result.rows[0]!;
}

/**
 * List all devices for a workspace, default first.
 */
export async function listDevices(
  workspaceId: string,
  client?: QueryableClient,
): Promise<DeviceRow[]> {
  const c = client ?? pool;
  const result = await c.query<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS}
     FROM device
     WHERE workspace_id = $1
     ORDER BY is_default DESC, created_at ASC`,
    [workspaceId],
  );
  return result.rows;
}

/**
 * Return true when the device is revoked or does not exist.
 * Unknown devices are treated as revoked to fail-safe.
 */
export async function isDeviceRevoked(
  deviceId: string,
  client?: QueryableClient,
): Promise<boolean> {
  const c = client ?? pool;
  const result = await c.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM device WHERE id = $1`,
    [deviceId],
  );
  if ((result.rowCount ?? 0) === 0) return true; // not found → treat as revoked
  return result.rows[0]!.revoked_at !== null;
}

/**
 * Throw if the device is revoked or unknown. Used by sync-event push routes (MIN-932).
 */
export async function assertDevicePushable(
  deviceId: string,
  client?: QueryableClient,
): Promise<void> {
  const revoked = await isDeviceRevoked(deviceId, client);
  if (revoked) {
    throw new Error(`Device ${deviceId} is revoked or not found — push rejected.`);
  }
}

/**
 * Revoke a device so it can no longer push sync events.
 * Returns true if the device was revoked, false if already revoked or not found.
 */
export async function revokeDevice(
  deviceId: string,
  workspaceId: string,
  client?: QueryableClient,
): Promise<boolean> {
  const c = client ?? pool;
  const result = await c.query<{ id: string }>(
    `UPDATE device
     SET revoked_at = now()
     WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [deviceId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
