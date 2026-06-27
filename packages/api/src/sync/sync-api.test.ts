/**
 * Sync replication API tests (MIN-932).
 * Runs against rollomap_test (pretest / test:reset gives a clean, fully-migrated DB).
 *
 * Drives the push/pull/ack/apply service layer directly (the same functions the
 * HTTP routes call) against the test DB. Covers:
 *   - the A/B offline scenario (Device A → Alice, Device B → Bob; both converge),
 *   - empty-batch push and pull-when-nothing-new,
 *   - cursor idempotency (ack twice / backward never regresses),
 *   - no-echo-own (a device doesn't pull its own events by default),
 *   - revoked-device push rejected.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, WORKSPACE_ID } from '../db.js';
import {
  pushEvents,
  pullEvents,
  ackCursor,
  getCursor,
  DeviceNotPushableError,
  type SyncEventEnvelope,
} from './replication.js';

/** Create a trusted device row and return its id. */
async function makeDevice(label: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO device (workspace_id, name, trusted_at)
     VALUES ($1, $2, now()) RETURNING id`,
    [WORKSPACE_ID, `${label}-${crypto.randomUUID()}`],
  );
  return res.rows[0]!.id;
}

/** Build a person.created event as if authored OFFLINE on `deviceId`. */
function personCreatedEvent(deviceId: string, displayName: string): SyncEventEnvelope {
  const personId = crypto.randomUUID();
  const payload = {
    id: personId,
    workspace_id: WORKSPACE_ID,
    display_name: displayName,
  };
  return {
    id: crypto.randomUUID(),
    device_id: deviceId,
    entity_type: 'person',
    entity_id: personId,
    operation: 'person.created',
    payload,
    logical_clock: 1, // per-origin local clock — collides across devices by design
    hash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

async function personExists(id: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM person WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

async function maxServerSeq(): Promise<number> {
  const r = await pool.query<{ max: string | null }>(
    `SELECT max(server_seq)::text AS max FROM sync_event`,
  );
  return r.rows[0]!.max ? Number(r.rows[0]!.max) : 0;
}

describe('sync replication API', () => {
  after(async () => {
    await pool.end();
  });

  it('A/B offline scenario: both devices end with Alice AND Bob', async () => {
    const deviceA = await makeDevice('A');
    const deviceB = await makeDevice('B');

    // Each device creates a person while offline.
    const aliceEv = personCreatedEvent(deviceA, 'Alice');
    const bobEv = personCreatedEvent(deviceB, 'Bob');
    const aliceId = aliceEv.entity_id;
    const bobId = bobEv.entity_id;

    // Both come online and push their local events.
    const pushA = await pushEvents(deviceA, [aliceEv]);
    const pushB = await pushEvents(deviceB, [bobEv]);
    assert.equal(pushA.applied, 1);
    assert.equal(pushB.applied, 1);

    // Each device pulls the OTHER's events since the start of time and acks.
    const pulledByA = await pullEvents(deviceA, { since: 0 });
    const idsForA = pulledByA.events.map((e) => e.id);
    assert.ok(idsForA.includes(bobEv.id), 'A should receive Bob event');
    assert.ok(!idsForA.includes(aliceEv.id), 'A should NOT receive its own Alice event');
    await ackCursor(deviceA, pulledByA.cursor);

    const pulledByB = await pullEvents(deviceB, { since: 0 });
    const idsForB = pulledByB.events.map((e) => e.id);
    assert.ok(idsForB.includes(aliceEv.id), 'B should receive Alice event');
    assert.ok(!idsForB.includes(bobEv.id), 'B should NOT receive its own Bob event');
    await ackCursor(deviceB, pulledByB.cursor);

    // Converged canonical state: both Alice and Bob exist.
    assert.ok(await personExists(aliceId), 'Alice must exist after sync');
    assert.ok(await personExists(bobId), 'Bob must exist after sync');
  });

  it('push is idempotent — re-pushing the same event applies nothing new', async () => {
    const deviceA = await makeDevice('idem');
    const ev = personCreatedEvent(deviceA, 'Idem Person');
    const first = await pushEvents(deviceA, [ev]);
    assert.equal(first.applied, 1);
    assert.equal(first.duplicate, 0);

    const second = await pushEvents(deviceA, [ev]);
    assert.equal(second.applied, 0, 're-push must not re-apply');
    assert.equal(second.duplicate, 1, 're-push must be counted as duplicate');
  });

  it('empty-batch push and pull-when-nothing-new both succeed', async () => {
    const deviceA = await makeDevice('empty');

    const push = await pushEvents(deviceA, []);
    assert.deepEqual(push, { received: 0, applied: 0, duplicate: 0, skipped: 0 });

    // Pull from a cursor far past any server_seq in this test run (the DB is reset
    // before each run, so server_seqs stay in the low hundreds). Using a fixed
    // large value instead of maxServerSeq() prevents a race where a concurrent
    // test worker writes an event between the tip-capture and the pull call.
    const FUTURE_CURSOR = 1_000_000;
    const pull = await pullEvents(deviceA, { since: FUTURE_CURSOR });
    assert.equal(pull.count, 0, 'no events past the future cursor');
    assert.equal(pull.events.length, 0);
    assert.equal(pull.cursor, FUTURE_CURSOR, 'cursor stays put when nothing new');
  });

  it('cursor advancement is explicit and idempotent (never regresses)', async () => {
    const deviceA = await makeDevice('cursor');
    assert.equal(await getCursor(deviceA), 0, 'fresh device has cursor 0');

    const first = await ackCursor(deviceA, 5);
    assert.equal(first.last_seen_server_seq, 5);

    // Ack the same value again — idempotent.
    const again = await ackCursor(deviceA, 5);
    assert.equal(again.last_seen_server_seq, 5);

    // Ack a LOWER value — must not move backward.
    const lower = await ackCursor(deviceA, 3);
    assert.equal(lower.last_seen_server_seq, 5, 'cursor must never regress');

    // Ack a higher value — advances.
    const higher = await ackCursor(deviceA, 9);
    assert.equal(higher.last_seen_server_seq, 9);
    assert.equal(await getCursor(deviceA), 9);
  });

  it('no-echo-own: a device does not pull its own events unless include_own', async () => {
    const deviceA = await makeDevice('echo');
    const ev = personCreatedEvent(deviceA, 'Echo Person');
    await pushEvents(deviceA, [ev]);

    const withoutOwn = await pullEvents(deviceA, { since: 0 });
    assert.ok(
      !withoutOwn.events.some((e) => e.id === ev.id),
      'own event excluded by default',
    );

    const withOwn = await pullEvents(deviceA, { since: 0, includeOwn: true });
    assert.ok(
      withOwn.events.some((e) => e.id === ev.id),
      'own event included with includeOwn',
    );
  });

  it('revoked-device push is rejected', async () => {
    const deviceA = await makeDevice('revoked');
    // Revoke it.
    await pool.query(`UPDATE device SET revoked_at = now() WHERE id = $1`, [deviceA]);

    const ev = personCreatedEvent(deviceA, 'Should Not Apply');
    await assert.rejects(
      () => pushEvents(deviceA, [ev]),
      (err: unknown) =>
        err instanceof DeviceNotPushableError && /revoked or not found/.test((err as Error).message),
      'push from a revoked device must throw DeviceNotPushableError',
    );
    // And nothing was applied.
    assert.equal(await personExists(ev.entity_id), false, 'revoked push must not write canonical rows');
  });

  it('unknown operation is skipped safely, not applied', async () => {
    const deviceA = await makeDevice('unknown');
    const ev: SyncEventEnvelope = {
      id: crypto.randomUUID(),
      device_id: deviceA,
      entity_type: 'person',
      entity_id: crypto.randomUUID(),
      operation: 'person.teleported', // not a known operation
      payload: { id: crypto.randomUUID() },
      logical_clock: 1,
      hash: 'deadbeef',
    };
    const result = await pushEvents(deviceA, [ev]);
    assert.equal(result.applied, 0);
    assert.equal(result.skipped, 1, 'unknown op stored but not applied');
    assert.equal(result.duplicate, 0);
  });
});
