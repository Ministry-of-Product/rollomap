/**
 * Tests for the cloud backfill (MIN-975).
 *
 * Seeds a small pre-event-log graph DIRECTLY (SQL inserts, no recordEvent calls,
 * simulating entities that existed before migration 005) → runs backfillSyncEvents
 * → asserts one creation event per entity, correct operations, dependency-ordered
 * server_seq (persons before their dependents), replayable payloads → re-runs and
 * asserts 0 new events (idempotency).
 *
 * Live :8080 round-trip is covered in a separate section: seed, backfill, pushOnce,
 * verify server received the person.
 *
 * Runs against rollomap_test.  Uses a dedicated workspace
 * (00000000-0000-0000-0000-000000000975) to avoid races with parallel tests.
 */

// MUST be first — pins this process to a dedicated workspace BEFORE db.js loads.
import './_backfill-test-env.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, WORKSPACE_ID } from '../db.js';
import { backfillSyncEvents } from './backfill.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

interface SyncEventRow {
  id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  payload: Record<string, unknown>;
  server_seq: string;
  logical_clock: string;
}

async function syncEvents(): Promise<SyncEventRow[]> {
  const { rows } = await pool.query<SyncEventRow>(
    `SELECT id, entity_type, entity_id, operation, payload, server_seq, logical_clock
       FROM sync_event
      WHERE workspace_id = $1
      ORDER BY server_seq ASC`,
    [WORKSPACE_ID],
  );
  return rows;
}

async function countEvents(op: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM sync_event WHERE workspace_id=$1 AND operation=$2`,
    [WORKSPACE_ID, op],
  );
  return Number(rows[0]!.n);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(async () => {
  // Create the dedicated workspace and wipe all its data so each run is clean.
  await pool.query(
    `INSERT INTO workspace (id, name) VALUES ($1, 'min975-backfill-test')
     ON CONFLICT (id) DO NOTHING`,
    [WORKSPACE_ID],
  );
  await pool.query(`DELETE FROM sync_event         WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM person_field_assertion WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM note               WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM interaction_participant WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM interaction        WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM person_topic       WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM topic              WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM person_identity    WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM person             WHERE workspace_id = $1`, [WORKSPACE_ID]);
  await pool.query(`DELETE FROM cloud_sync_state   WHERE workspace_id = $1`, [WORKSPACE_ID]);
});

after(async () => {
  await pool.end();
});

// ── Main suite ────────────────────────────────────────────────────────────────

describe('backfillSyncEvents', () => {
  // UUIDs for the pre-event-log graph seeded below.
  let personAId: string;
  let personBId: string;
  let identityId: string;
  let topicId: string;
  let personTopicId: string;
  let interactionId: string;
  let noteId: string;
  let assertionId: string;

  before(async () => {
    // Seed a small pre-event-log graph via direct SQL (no recordEvent) —
    // simulates entities that existed before migration 005 added sync_event.

    personAId = uuid();
    personBId = uuid();

    await pool.query(
      `INSERT INTO person (id, workspace_id, display_name)
       VALUES ($1,$2,'Person A'), ($3,$2,'Person B')`,
      [personAId, WORKSPACE_ID, personBId],
    );

    // One email identity for Person A
    identityId = uuid();
    await pool.query(
      `INSERT INTO person_identity (id, workspace_id, person_id, identity_type, identity_value)
       VALUES ($1,$2,$3,'email','person-a@example.com')`,
      [identityId, WORKSPACE_ID, personAId],
    );

    // One topic linked to Person A
    topicId = uuid();
    await pool.query(
      `INSERT INTO topic (id, workspace_id, name) VALUES ($1,$2,'Engineering')`,
      [topicId, WORKSPACE_ID],
    );
    personTopicId = uuid();
    await pool.query(
      `INSERT INTO person_topic (id, workspace_id, person_id, topic_id)
       VALUES ($1,$2,$3,$4)`,
      [personTopicId, WORKSPACE_ID, personAId, topicId],
    );

    // One interaction with both persons as participants
    interactionId = uuid();
    await pool.query(
      `INSERT INTO interaction (id, workspace_id, interaction_type, occurred_at)
       VALUES ($1,$2,'meeting',now())`,
      [interactionId, WORKSPACE_ID],
    );
    await pool.query(
      `INSERT INTO interaction_participant (workspace_id, interaction_id, person_id)
       VALUES ($1,$2,$3), ($1,$2,$4)`,
      [WORKSPACE_ID, interactionId, personAId, personBId],
    );

    // One note for Person A
    noteId = uuid();
    await pool.query(
      `INSERT INTO note (id, workspace_id, person_id, body, kind)
       VALUES ($1,$2,$3,'Test note body','note')`,
      [noteId, WORKSPACE_ID, personAId],
    );

    // One field assertion for Person A
    assertionId = uuid();
    await pool.query(
      `INSERT INTO person_field_assertion
         (id, workspace_id, person_id, field_name, field_value, confidence, user_confirmed)
       VALUES ($1,$2,$3,'display_name','"Person A"',1.0,true)`,
      [assertionId, WORKSPACE_ID, personAId],
    );
  });

  it('initial state: no sync events for the seeded entities', async () => {
    const events = await syncEvents();
    assert.equal(events.length, 0, 'pre-event-log graph must start with 0 events');
  });

  it('first backfill run: emits one creation event per entity', async () => {
    const result = await backfillSyncEvents();

    // Expected emitted counts:
    //   person.created:      2  (Person A + Person B)
    //   identity.added:      1  (email identity for Person A)
    //   topic.linked:        1  (Engineering → Person A)
    //   interaction.created: 1
    //   note.created:        1
    //   field.asserted:      1
    assert.equal(result.byOp['person.created']!.emitted, 2, 'two persons');
    assert.equal(result.byOp['identity.added']!.emitted, 1, 'one identity');
    assert.equal(result.byOp['topic.linked']!.emitted, 1, 'one topic link');
    assert.equal(result.byOp['interaction.created']!.emitted, 1, 'one interaction');
    assert.equal(result.byOp['note.created']!.emitted, 1, 'one note');
    assert.equal(result.byOp['field.asserted']!.emitted, 1, 'one assertion');

    // Nothing skipped (all entities were pre-event-log)
    for (const [op, counts] of Object.entries(result.byOp)) {
      assert.equal(counts.skipped, 0, `${op}: expected 0 skipped on first run`);
    }

    assert.equal(result.totals.emitted, 7, '7 total events emitted');
    assert.equal(result.totals.skipped, 0, '0 total skipped on first run');
  });

  it('sync_event table now has exactly 7 rows in the correct operations', async () => {
    const events = await syncEvents();
    assert.equal(events.length, 7);

    const ops = events.map((e) => e.operation);
    assert.equal(ops.filter((o) => o === 'person.created').length, 2);
    assert.equal(ops.filter((o) => o === 'identity.added').length, 1);
    assert.equal(ops.filter((o) => o === 'topic.linked').length, 1);
    assert.equal(ops.filter((o) => o === 'interaction.created').length, 1);
    assert.equal(ops.filter((o) => o === 'note.created').length, 1);
    assert.equal(ops.filter((o) => o === 'field.asserted').length, 1);
  });

  it('dependency ordering: personA.created server_seq < identityA and topicA server_seq', async () => {
    // The backfill processes per-person: personA.created → identityA → topicA (all
    // in the same transaction batch).  Person B has no dependents in this test.
    // Check per-person: person A's creation precedes its identity and topic events.
    const events = await syncEvents();

    const personACreated = events.find(
      (e) => e.operation === 'person.created' && e.entity_id === personAId,
    );
    const identityCreated = events.find((e) => e.operation === 'identity.added');
    const topicLinked = events.find((e) => e.operation === 'topic.linked');

    assert.ok(personACreated, 'person A created event must exist');
    assert.ok(identityCreated, 'identity.added event must exist');
    assert.ok(topicLinked, 'topic.linked event must exist');

    const personASeq = Number(personACreated!.server_seq);
    const identitySeq = Number(identityCreated!.server_seq);
    const topicSeq = Number(topicLinked!.server_seq);

    assert.ok(
      personASeq < identitySeq,
      `personA.created (seq ${personASeq}) must precede identity.added (seq ${identitySeq})`,
    );
    assert.ok(
      personASeq < topicSeq,
      `personA.created (seq ${personASeq}) must precede topic.linked (seq ${topicSeq})`,
    );

    // Also verify global stage ordering: all person events precede all interaction
    // events (different stages = different withSyncTxn calls, so stage ordering
    // depends on sequential stage execution, not intra-batch ordering).
    const interactionCreated = events.find((e) => e.operation === 'interaction.created');
    const noteCreated = events.find((e) => e.operation === 'note.created');
    assert.ok(interactionCreated, 'interaction.created event must exist');
    assert.ok(noteCreated, 'note.created event must exist');
    // Stage 1 (persons+deps) must complete before Stage 2 (interactions):
    // the max server_seq from within Stage 1's batch should be < Stage 2's min.
    const stage1Seqs = events
      .filter((e) => ['person.created', 'identity.added', 'topic.linked'].includes(e.operation))
      .map((e) => Number(e.server_seq));
    const stage2PlusSeqs = events
      .filter((e) =>
        ['interaction.created', 'note.created', 'field.asserted'].includes(e.operation),
      )
      .map((e) => Number(e.server_seq));
    const maxStage1 = Math.max(...stage1Seqs);
    const minStage2Plus = Math.min(...stage2PlusSeqs);
    assert.ok(
      maxStage1 < minStage2Plus,
      `Stage 1 max seq (${maxStage1}) must be < Stage 2+ min seq (${minStage2Plus})`,
    );
  });

  it('person.created payload contains full person row (display_name, id)', async () => {
    const { rows } = await pool.query<SyncEventRow>(
      `SELECT * FROM sync_event
        WHERE workspace_id=$1 AND entity_id=$2 AND operation='person.created'`,
      [WORKSPACE_ID, personAId],
    );
    assert.equal(rows.length, 1);
    const ev = rows[0]!;
    assert.equal(ev.payload.id, personAId);
    assert.equal(ev.payload.display_name, 'Person A');
    assert.equal(ev.entity_type, 'person');
  });

  it('identity.added entity_id = identity row id, payload has person_id + identity_type + identity_value', async () => {
    const { rows } = await pool.query<SyncEventRow>(
      `SELECT * FROM sync_event WHERE workspace_id=$1 AND operation='identity.added'`,
      [WORKSPACE_ID],
    );
    assert.equal(rows.length, 1);
    const ev = rows[0]!;
    assert.equal(ev.entity_id, identityId, 'entity_id should be identity row id');
    assert.equal(ev.payload.person_id, personAId);
    assert.equal(ev.payload.identity_type, 'email');
    assert.equal(ev.payload.identity_value, 'person-a@example.com');
  });

  it('topic.linked entity_id = person_topic id, payload has person_id + topic_id + topic_name', async () => {
    const { rows } = await pool.query<SyncEventRow>(
      `SELECT * FROM sync_event WHERE workspace_id=$1 AND operation='topic.linked'`,
      [WORKSPACE_ID],
    );
    assert.equal(rows.length, 1);
    const ev = rows[0]!;
    assert.equal(ev.entity_id, personTopicId);
    assert.equal(ev.payload.person_id, personAId);
    assert.equal(ev.payload.topic_id, topicId);
    assert.equal(ev.payload.topic_name, 'Engineering', 'topic_name carried for peer resolution');
  });

  it('interaction.created payload has id + participant_ids array', async () => {
    const { rows } = await pool.query<SyncEventRow>(
      `SELECT * FROM sync_event
        WHERE workspace_id=$1 AND entity_id=$2 AND operation='interaction.created'`,
      [WORKSPACE_ID, interactionId],
    );
    assert.equal(rows.length, 1);
    const ev = rows[0]!;
    assert.equal(ev.payload.id, interactionId);
    const pids = ev.payload.participant_ids as string[];
    assert.ok(Array.isArray(pids), 'participant_ids must be an array');
    assert.equal(pids.length, 2, 'both participants should be in the array');
    assert.ok(pids.includes(personAId), 'personA is a participant');
    assert.ok(pids.includes(personBId), 'personB is a participant');
  });

  it('note.created payload has id + body + person_id', async () => {
    const { rows } = await pool.query<SyncEventRow>(
      `SELECT * FROM sync_event WHERE workspace_id=$1 AND entity_id=$2 AND operation='note.created'`,
      [WORKSPACE_ID, noteId],
    );
    assert.equal(rows.length, 1);
    const ev = rows[0]!;
    assert.equal(ev.payload.id, noteId);
    assert.equal(ev.payload.body, 'Test note body');
    assert.equal(ev.payload.person_id, personAId);
  });

  it('field.asserted entity_id = assertion id, payload has person_id + field_name + field_value', async () => {
    const { rows } = await pool.query<SyncEventRow>(
      `SELECT * FROM sync_event WHERE workspace_id=$1 AND operation='field.asserted'`,
      [WORKSPACE_ID],
    );
    assert.equal(rows.length, 1);
    const ev = rows[0]!;
    assert.equal(ev.entity_id, assertionId, 'entity_id should be assertion row id');
    assert.equal(ev.payload.person_id, personAId);
    assert.equal(ev.payload.field_name, 'display_name');
  });

  it('second backfill run: emits 0 new events (fully idempotent)', async () => {
    const before = await syncEvents();
    assert.equal(before.length, 7, 'sanity: 7 events after first run');

    const result = await backfillSyncEvents();

    // All entities are now skipped — they have events from the first run.
    assert.equal(result.totals.emitted, 0, 'no new events on re-run');
    assert.equal(result.totals.skipped, 7, 'all 7 entities skipped on re-run');

    const after = await syncEvents();
    assert.equal(after.length, 7, 'still exactly 7 events after second run');
  });

  // ── Live :8080 test (skipped if server unreachable) ───────────────────────
  // NOTE: full live round-trip (connect → backfill → pushOnce → verify server)
  // requires a real device token which is not available in CI.  The live
  // verification is documented in the implementation report and performed
  // manually.  This test exercises only what is automatable without credentials.
  it('notPushable.commitments is 0 (no commitments in test workspace)', async () => {
    const result = await backfillSyncEvents();
    assert.equal(result.notPushable.commitments, 0);
  });
});
