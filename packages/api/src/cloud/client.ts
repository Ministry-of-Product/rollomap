/**
 * Authenticated HTTP helper for RolloMap Cloud (MIN-974).
 *
 * cloudFetch(path, init) reads the stored cloud config, prefixes SYNC_SERVER_URL,
 * attaches Authorization: Bearer <token>, and surfaces 401 as a typed
 * CloudAuthError so callers (the MIN-973 sync agent) can react distinctly to
 * revocation without inspecting raw status codes.
 *
 * Requires Node 18+ (native global fetch).
 */

import { getCloudConfig } from './config.js';

/**
 * Thrown when the cloud server rejects the device token with HTTP 401 or 403.
 *
 * 401 = token not recognised (unknown / malformed).
 * 403 = token recognised but device has been revoked.
 *
 * Callers (the sync agent) should react to both by pausing sync and alerting
 * the user to re-pair the device.
 */
export class CloudAuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403 = 401, message?: string) {
    super(
      message ??
        (status === 403
          ? 'Cloud device has been revoked — re-pair the device to resume sync (403)'
          : 'Cloud device token is invalid or has been revoked (401)'),
    );
    this.name = 'CloudAuthError';
    this.status = status;
  }
}

/** Thrown when no cloud config is stored (client not yet paired). */
export class CloudNotConfiguredError extends Error {
  constructor() {
    super(
      'Client is not paired with a cloud server — call POST /api/cloud/connect first',
    );
    this.name = 'CloudNotConfiguredError';
  }
}

/**
 * Make an authenticated HTTP request to the cloud sync server.
 *
 * @param path  Path relative to sync_server_url (e.g. "/sync/pull?since=0").
 * @param init  Standard RequestInit — do NOT set Authorization (injected here).
 * @throws {CloudNotConfiguredError} if no pairing config is stored.
 * @throws {CloudAuthError}          on HTTP 401 — token revoked or invalid.
 * @throws {Error}                   on network errors or other HTTP failures.
 */
export async function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
  const config = await getCloudConfig();
  if (!config) throw new CloudNotConfiguredError();

  const url = `${config.syncServerUrl.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${config.deviceToken}`,
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new CloudAuthError(response.status as 401 | 403);
  }

  return response;
}
