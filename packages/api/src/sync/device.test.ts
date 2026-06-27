/**
 * Tests for device identity and trust service (MIN-930).
 * Runs against the rollomap_test DB (set up by pretest / test:reset).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, WORKSPACE_ID } from '../db.js';
import {
  getLocalDeviceId,
  isDeviceRevoked,
  revokeDevice,
  assertDevicePushable,
  listDevices,
} from './device.js';

describe('device service', () => {
  after(async () => {
    await pool.end();
  });

  it('getLocalDeviceId is idempotent — returns same UUID on repeated calls', async () => {
    const id1 = await getLocalDeviceId();
    const id2 = await getLocalDeviceId();
    assert.equal(id1, id2, 'getLocalDeviceId must return the same stable UUID');
    // Must be a valid UUID
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('default local device appears in listDevices and is not revoked', async () => {
    const localId = await getLocalDeviceId();
    const devices = await listDevices(WORKSPACE_ID);
    const local = devices.find((d) => d.id === localId);
    assert.ok(local, 'default device should appear in listDevices');
    assert.equal(local!.is_default, true);
    assert.equal(local!.revoked_at, null, 'default device must not be revoked');
  });

  it('isDeviceRevoked returns false for an active device', async () => {
    const id = await getLocalDeviceId();
    assert.equal(await isDeviceRevoked(id), false);
  });

  it('isDeviceRevoked returns true for an unknown device id', async () => {
    const fakeId = '00000000-dead-beef-cafe-000000000000';
    assert.equal(await isDeviceRevoked(fakeId), true);
  });

  it('revokeDevice sets revoked_at; isDeviceRevoked then returns true', async () => {
    // Insert a fresh test device
    const result = await pool.query<{ id: string }>(
      `INSERT INTO device (workspace_id, name, trusted_at)
       VALUES ($1, $2, now())
       RETURNING id`,
      [WORKSPACE_ID, `test-revokable-${Date.now()}`],
    );
    const deviceId = result.rows[0]!.id;

    assert.equal(await isDeviceRevoked(deviceId), false);

    const revoked = await revokeDevice(deviceId, WORKSPACE_ID);
    assert.equal(revoked, true, 'revokeDevice should return true on first revoke');

    assert.equal(await isDeviceRevoked(deviceId), true);
  });

  it('revokeDevice returns false when device is already revoked', async () => {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO device (workspace_id, name, revoked_at)
       VALUES ($1, $2, now())
       RETURNING id`,
      [WORKSPACE_ID, `test-already-revoked-${Date.now()}`],
    );
    const deviceId = result.rows[0]!.id;

    const second = await revokeDevice(deviceId, WORKSPACE_ID);
    assert.equal(second, false, 'revoking an already-revoked device should return false');
  });

  it('assertDevicePushable throws for a revoked device', async () => {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO device (workspace_id, name, revoked_at)
       VALUES ($1, $2, now())
       RETURNING id`,
      [WORKSPACE_ID, `test-assert-revoked-${Date.now()}`],
    );
    const deviceId = result.rows[0]!.id;

    await assert.rejects(
      () => assertDevicePushable(deviceId),
      /revoked or not found/,
      'assertDevicePushable should throw for a revoked device',
    );
  });

  it('assertDevicePushable does not throw for the default local device', async () => {
    const id = await getLocalDeviceId();
    await assert.doesNotReject(() => assertDevicePushable(id));
  });
});
