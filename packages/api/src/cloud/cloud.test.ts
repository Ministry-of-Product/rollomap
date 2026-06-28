/**
 * Tests for cloud config store + cloudFetch (MIN-974).
 *
 * Runs against rollomap_test DB (set up by pretest/reset-test-db.sh).
 * Requires migration 012 (cloud_config table) to be applied.
 *
 * Live :8080 checks:
 *   - CloudAuthError on 401: points cloudFetch at http://localhost:8080 with a
 *     garbage token — a real live 401 from the test server.
 *   - Header attachment: spins up a minimal in-process HTTP server to capture
 *     the Authorization header without needing a real cloud credential.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pool } from '../db.js';
import {
  getCloudConfig,
  setCloudConfig,
  clearCloudConfig,
  updateCloudCheckResult,
} from './config.js';
import { cloudFetch, CloudAuthError, CloudNotConfiguredError } from './client.js';

// Single top-level pool teardown — runs after all suites in this file.
after(async () => { await pool.end(); });

// Clean the cloud_config table.
async function resetConfig(): Promise<void> {
  await pool.query('DELETE FROM cloud_config');
}

describe('cloud config store', () => {
  before(async () => { await resetConfig(); });
  after(async () => { await resetConfig(); });

  it('getCloudConfig returns null when no config is stored', async () => {
    const cfg = await getCloudConfig();
    assert.equal(cfg, null);
  });

  it('setCloudConfig + getCloudConfig round-trip', async () => {
    await setCloudConfig({
      syncServerUrl: 'https://cloud.example.com',
      deviceToken: 'tok-abc-123',
    });
    const cfg = await getCloudConfig();
    assert.ok(cfg, 'config should exist after set');
    assert.equal(cfg!.syncServerUrl, 'https://cloud.example.com');
    assert.equal(cfg!.deviceToken, 'tok-abc-123');
    assert.ok(cfg!.connectedAt instanceof Date);
    assert.equal(cfg!.lastCheckAt, null);
    assert.equal(cfg!.lastCheckOk, null);
  });

  it('setCloudConfig is idempotent — upserts on re-connect', async () => {
    await setCloudConfig({ syncServerUrl: 'https://cloud.example.com', deviceToken: 'tok-v1' });
    await setCloudConfig({ syncServerUrl: 'https://cloud2.example.com', deviceToken: 'tok-v2' });
    const cfg = await getCloudConfig();
    assert.equal(cfg!.syncServerUrl, 'https://cloud2.example.com');
    assert.equal(cfg!.deviceToken, 'tok-v2');
  });

  it('setCloudConfig stores lastCheckAt and lastCheckOk', async () => {
    const checkAt = new Date();
    await setCloudConfig({
      syncServerUrl: 'https://cloud.example.com',
      deviceToken: 'tok-check',
      lastCheckAt: checkAt,
      lastCheckOk: true,
    });
    const cfg = await getCloudConfig();
    assert.equal(cfg!.lastCheckOk, true);
    assert.ok(cfg!.lastCheckAt !== null);
  });

  it('updateCloudCheckResult sets last_check_at and last_check_ok', async () => {
    await setCloudConfig({ syncServerUrl: 'https://cloud.example.com', deviceToken: 'tok-upd' });
    await updateCloudCheckResult(false);
    const cfg = await getCloudConfig();
    assert.equal(cfg!.lastCheckOk, false);
    assert.ok(cfg!.lastCheckAt instanceof Date);
  });

  it('clearCloudConfig removes the pairing', async () => {
    await setCloudConfig({ syncServerUrl: 'https://cloud.example.com', deviceToken: 'tok-clear' });
    await clearCloudConfig();
    const cfg = await getCloudConfig();
    assert.equal(cfg, null);
  });
});

describe('cloudFetch', () => {
  before(async () => { await resetConfig(); });
  after(async () => { await resetConfig(); });

  it('throws CloudNotConfiguredError when no pairing config is stored', async () => {
    await resetConfig();
    await assert.rejects(
      () => cloudFetch('/sync/pull?since=0&limit=1'),
      (err: unknown) => {
        assert.ok(
          err instanceof CloudNotConfiguredError,
          `expected CloudNotConfiguredError, got ${String(err)}`,
        );
        return true;
      },
    );
  });

  it('attaches Authorization: Bearer header to outbound request', async () => {
    let capturedAuth: string | undefined;
    const server = http.createServer((_req, res) => {
      capturedAuth = _req.headers['authorization'];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [], head_server_seq: 0, has_more: false }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await setCloudConfig({
        syncServerUrl: `http://127.0.0.1:${port}`,
        deviceToken: 'my-secret-tok',
      });
      const resp = await cloudFetch('/sync/pull?since=0&limit=1');
      assert.equal(resp.status, 200, 'local server should return 200');
      assert.equal(capturedAuth, 'Bearer my-secret-tok', 'Authorization header must carry the token');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('throws CloudAuthError on HTTP 401 (live :8080 with garbage token)', async () => {
    // Points at the test sync server with a clearly-invalid token.
    // If :8080 is unreachable, this test is skipped with a diagnostic.
    try {
      await setCloudConfig({
        syncServerUrl: 'http://localhost:8080',
        deviceToken: 'garbage-invalid-token-does-not-exist',
      });
      await assert.rejects(
        () => cloudFetch('/sync/pull?since=0&limit=1'),
        (err: unknown) => {
          assert.ok(
            err instanceof CloudAuthError,
            `expected CloudAuthError, got ${String(err)}`,
          );
          return true;
        },
      );
    } catch (err) {
      if (err instanceof CloudAuthError) throw err;
      const msg = String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        console.warn('  [skip] localhost:8080 not reachable — live 401 check skipped');
        return;
      }
      throw err;
    }
  });

  it('throws CloudAuthError (status=403) on HTTP 403 (live :8080 revoked device)', async () => {
    // Mint a device via dev-login, then revoke it, then confirm pull is blocked.
    // If :8080 is unreachable or the dev-login endpoint is absent, skip gracefully.
    try {
      // Dev-login to get a session cookie
      const loginRes = await fetch('http://localhost:8080/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'matt@ministryofproduct.com' }),
      });
      if (!loginRes.ok) {
        console.warn('  [skip] dev-login unavailable — revocation 403 test skipped');
        return;
      }
      const cookieHeader = loginRes.headers.get('set-cookie') ?? '';

      // Register a device
      const devRes = await fetch('http://localhost:8080/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify({ name: 'test-revoke-974' }),
      });
      assert.equal(devRes.status, 201, 'device registration should succeed');
      const { id: deviceId, token } = (await devRes.json()) as { id: string; token: string };

      // Revoke the device
      const revokeRes = await fetch(`http://localhost:8080/api/devices/${deviceId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      });
      assert.equal(revokeRes.status, 200, 'revoke should return 200');

      // cloudFetch with revoked token → CloudAuthError(403)
      await setCloudConfig({ syncServerUrl: 'http://localhost:8080', deviceToken: token });
      await assert.rejects(
        () => cloudFetch('/sync/pull?since=0&limit=1'),
        (err: unknown) => {
          assert.ok(err instanceof CloudAuthError, `expected CloudAuthError, got ${String(err)}`);
          assert.equal((err as CloudAuthError).status, 403);
          return true;
        },
      );
    } catch (err) {
      if (err instanceof CloudAuthError) throw err;
      const msg = String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        console.warn('  [skip] localhost:8080 not reachable — revocation 403 test skipped');
        return;
      }
      throw err;
    }
  });

  it('does not throw CloudAuthError on non-4xx-auth responses', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await setCloudConfig({
        syncServerUrl: `http://127.0.0.1:${port}`,
        deviceToken: 'tok-404',
      });
      const resp = await cloudFetch('/nonexistent');
      assert.equal(resp.status, 404, 'cloudFetch should propagate non-auth error responses as-is');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
