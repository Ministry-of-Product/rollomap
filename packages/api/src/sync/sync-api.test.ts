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

  // MIN-984: topic.linked self-healing and per-event resilience.

  it('topic.linked with topic_name self-heals: creates topic + link even when topic row is absent', async () => {
    const deviceA = await makeDevice('tl-selfheal');
    const personId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO person (id, workspace_id, display_name) VALUES ($1, $2, $3)`,
      [personId, WORKSPACE_ID, 'Topic Self-Heal Person'],
    );

    const topicId = crypto.randomUUID();
    const linkEv: SyncEventEnvelope = {
      id: crypto.randomUUID(),
      device_id: deviceA,
      entity_type: 'person_topic',
      entity_id: crypto.randomUUID(),
      operation: 'topic.linked',
      payload: {
        person_id: personId,
        topic_id: topicId,
        topic_name: 'Self-Heal Topic',
        workspace_id: WORKSPACE_ID,
        confidence: 0.9,
        user_confirmed: true,
      },
      logical_clock: 1,
      hash: 'tl-selfheal',
    };

    const result = await pushEvents(deviceA, [linkEv]);
    assert.equal(result.applied, 1, 'topic.linked must be applied when topic_name present');
    assert.equal(result.skipped, 0);

    // Topic row must exist (created by self-healing).
    const topicRow = await pool.query(
      `SELECT id FROM topic WHERE workspace_id = $1 AND lower(name) = lower($2)`,
      [WORKSPACE_ID, 'Self-Heal Topic'],
    );
    assert.equal(topicRow.rowCount, 1, 'topic row must have been created');

    // person_topic link must exist.
    const linkRow = await pool.query(
      `SELECT 1 FROM person_topic WHERE person_id = $1 AND topic_id = $2`,
      [personId, topicRow.rows[0]!.id],
    );
    assert.equal(linkRow.rowCount, 1, 'person_topic link must have been created');
  });

  it('topic.linked self-heal preserves payload topic_id so a later topic.created is idempotent', async () => {
    const deviceA = await makeDevice('tl-idempotent');
    const personId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO person (id, workspace_id, display_name) VALUES ($1, $2, $3)`,
      [personId, WORKSPACE_ID, 'Idempotent Person'],
    );

    const topicId = crypto.randomUUID();
    const linkEv: SyncEventEnvelope = {
      id: crypto.randomUUID(),
      device_id: deviceA,
      entity_type: 'person_topic',
      entity_id: crypto.randomUUID(),
      operation: 'topic.linked',
      payload: {
        person_id: personId,
        topic_id: topicId,
        topic_name: 'Idempotent Topic',
        workspace_id: WORKSPACE_ID,
      },
      logical_clock: 1,
      hash: 'tl-idempotent',
    };
    await pushEvents(deviceA, [linkEv]);

    // The topic row must use the payload's topic_id.
    const topicRow = await pool.query(`SELECT id FROM topic WHERE id = $1`, [topicId]);
    assert.equal(topicRow.rowCount, 1, 'topic must exist with the payload topic_id');

    // Now push topic.created for the same id — must be a no-op (not a duplicate row).
    const createdEv: SyncEventEnvelope = {
      id: crypto.randomUUID(),
      device_id: deviceA,
      entity_type: 'topic',
      entity_id: topicId,
      operation: 'topic.created',
      payload: { id: topicId, name: 'Idempotent Topic', workspace_id: WORKSPACE_ID },
      logical_clock: 2,
      hash: 'tc-idempotent',
    };
    const r2 = await pushEvents(deviceA, [createdEv]);
    assert.equal(r2.applied, 1, 'topic.created must succeed idempotently');

    // Still only one topic row.
    const all = await pool.query(
      `SELECT id FROM topic WHERE workspace_id = $1 AND lower(name) = lower($2)`,
      [WORKSPACE_ID, 'Idempotent Topic'],
    );
    assert.equal(all.rowCount, 1, 'must not create a duplicate topic row');
  });

  it('topic.linked without topic_name and missing topic row is skipped — does not 500 the batch', async () => {
    const deviceA = await makeDevice('tl-missing');
    const personId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO person (id, workspace_id, display_name) VALUES ($1, $2, $3)`,
      [personId, WORKSPACE_ID, 'Missing Topic Person'],
    );

    const missingTopicId = crypto.randomUUID(); // never inserted
    const linkEv: SyncEventEnvelope = {
      id: crypto.randomUUID(),
      device_id: deviceA,
      entity_type: 'person_topic',
      entity_id: crypto.randomUUID(),
      operation: 'topic.linked',
      payload: {
        person_id: personId,
        topic_id: missingTopicId,
        // no topic_name — cannot self-heal
        workspace_id: WORKSPACE_ID,
      },
      logical_clock: 1,
      hash: 'tl-missing',
    };

    // Must not throw (no 500).
    const result = await pushEvents(deviceA, [linkEv]);
    assert.equal(result.skipped, 1, 'topic.linked with missing topic must be skipped');
    assert.equal(result.applied, 0);

    // No phantom person_topic row.
    const link = await pool.query(
      `SELECT 1 FROM person_topic WHERE person_id = $1 AND topic_id = $2`,
      [personId, missingTopicId],
    );
    assert.equal(link.rowCount, 0, 'no person_topic row must be written for a skipped event');
  });

  it('topic.linked failure does not roll back other valid events in the same batch (MIN-984)', async () => {
    const deviceA = await makeDevice('tl-isolation');
    const personId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO person (id, workspace_id, display_name) VALUES ($1, $2, $3)`,
      [personId, WORKSPACE_ID, 'Isolation Person'],
    );

    const missingTopicId = crypto.randomUUID(); // never inserted
    const newPersonId = crypto.randomUUID();

    const linkEv: SyncEventEnvelope = {
      id: crypto.randomUUID(),
      device_id: deviceA,
      entity_type: 'person_topic',
      entity_id: crypto.randomUUID(),
      operation: 'topic.linked',
      payload: { person_id: personId, topic_id: missingTopicId, workspace_id: WORKSPACE_ID },
      logical_clock: 1,
      hash: 'tl-isolation-link',
    };
    const personEv: SyncEventEnvelope = {
      id: crypto.randomUUID(),
      device_id: deviceA,
      entity_type: 'person',
      entity_id: newPersonId,
      operation: 'person.created',
      payload: { id: newPersonId, workspace_id: WORKSPACE_ID, display_name: 'Valid New Person' },
      logical_clock: 2,
      hash: 'tl-isolation-person',
    };

    const result = await pushEvents(deviceA, [linkEv, personEv]);
    // topic.linked skipped, person.created applied.
    assert.equal(result.skipped, 1);
    assert.equal(result.applied, 1);
    // The person must exist despite the skipped topic.linked.
    assert.ok(await personExists(newPersonId), 'valid person.created must survive the skipped topic.linked');
  });
});
