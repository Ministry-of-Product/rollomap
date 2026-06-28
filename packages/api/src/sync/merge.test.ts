/**
 * Reversible, sync-safe person merge tests (MIN-934).
 * Runs against rollomap_test (pretest / test:reset gives a clean, fully-migrated DB).
 *
 * Mounts the real peopleRouter on an ephemeral express server (so POST /merge,
 * GET /merges, POST /merges/:id/reverse are exercised end-to-end) and drives the
 * apply + merge service layer directly.
 *
 * Covers:
 *   - a LOCAL merge tombstones the source, writes a person_merge row, emits a
 *     person.merged event, and moves refs to the target;
 *   - replaying the SAME person.merged event twice is idempotent;
 *   - TWO devices merging the same A→B pair converge (apply a remote merge then a
 *     local merge of the same pair — no data loss, no error);
 *   - resolvePersonRedirect maps source→target, transitively (A→B→C);
 *   - reverse() restores the source + its refs and emits person.merge_reversed.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { pool, WORKSPACE_ID } from '../db.js';
import { peopleRouter } from '../routes/people.js';
import { applyEvent } from './apply.js';
import { resolvePersonRedirect } from './merge.js';

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/people', peopleRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function createPerson(name: string): Promise<string> {
  const { status, json } = await api('POST', '/api/people', { display_name: name });
  assert.equal(status, 201, `create ${name}`);
  return json.person.id as string;
}

async function personRowExists(id: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM person WHERE workspace_id = $1 AND id = $2`, [
    WORKSPACE_ID,
    id,
  ]);
  return (r.rowCount ?? 0) > 0;
}

async function tombstoneExists(id: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM entity_tombstone WHERE workspace_id = $1 AND entity_type = 'person' AND entity_id = $2`,
    [WORKSPACE_ID, id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Create a note attached to a person directly (no note route dependency). */
async function createNote(personId: string, body: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO note (workspace_id, person_id, body) VALUES ($1, $2, $3) RETURNING id`,
    [WORKSPACE_ID, personId, body],
  );
  return r.rows[0]!.id;
}

async function notePersonId(noteId: string): Promise<string | null> {
  const r = await pool.query<{ person_id: string | null }>(
    `SELECT person_id FROM note WHERE id = $1`,
    [noteId],
  );
  return r.rows[0]?.person_id ?? null;
}

describe('person merge (reversible, sync-safe)', () => {
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('a LOCAL merge tombstones the source, writes person_merge, emits person.merged, moves refs', async () => {
    const target = await createPerson('Merge Target A');
    const source = await createPerson('Merge Source A');
    const note = await createNote(source, 'note that should move to target');

    const merge = await api('POST', '/api/people/merge', { target_id: target, source_id: source });
    assert.equal(merge.status, 200);
    assert.equal(merge.json.ok, true, 'response shape preserves { ok: true }');
    const mergeId = merge.json.merge_id as string;
    assert.ok(mergeId, 'returns merge_id');

    // Source tombstoned (kept as redirect), target live.
    assert.ok(await personRowExists(source), 'source canonical row kept');
    assert.ok(await tombstoneExists(source), 'source tombstoned');
    assert.equal((await api('GET', `/api/people/${source}`)).status, 404, 'source hidden from reads');

    // Note moved to target.
    assert.equal(await notePersonId(note), target, 'note moved source→target');

    // person_merge row written.
    const pm = await pool.query<{ source_person_id: string; target_person_id: string }>(
      `SELECT source_person_id, target_person_id FROM person_merge WHERE id = $1`,
      [mergeId],
    );
    assert.equal(pm.rowCount, 1, 'person_merge row written');
    assert.equal(pm.rows[0]!.source_person_id, source);
    assert.equal(pm.rows[0]!.target_person_id, target);

    // person.merged event with replayable payload.
    const ev = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM sync_event WHERE operation = 'person.merged' AND entity_id = $1`,
      [target],
    );
    assert.equal(ev.rowCount, 1, 'one person.merged event');
    assert.equal(ev.rows[0]!.payload.merge_id, mergeId);
    assert.equal(ev.rows[0]!.payload.source_person_id, source);
    assert.equal(ev.rows[0]!.payload.target_person_id, target);
    assert.ok(ev.rows[0]!.payload.created_by_device_id, 'payload carries created_by_device_id');

    // user_correction preserved.
    const uc = await pool.query(
      `SELECT 1 FROM user_correction WHERE entity_id = $1 AND correction_type = 'merge'`,
      [target],
    );
    assert.equal(uc.rowCount, 1, 'user_correction still written');

    // GET /merges surfaces it.
    const list = await api('GET', '/api/people/merges');
    assert.ok(
      (list.json.merges as Array<{ id: string }>).some((m) => m.id === mergeId),
      'merge listed in GET /merges',
    );
  });

  it('replaying the SAME person.merged event twice is idempotent', async () => {
    const target = await createPerson('Idem Target');
    const source = await createPerson('Idem Source');
    const note = await createNote(source, 'idempotent note');
    const mergeId = crypto.randomUUID();
    const event = {
      id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
      entity_type: 'person',
      entity_id: target,
      operation: 'person.merged',
      payload: {
        merge_id: mergeId,
        source_person_id: source,
        target_person_id: target,
        created_by_device_id: crypto.randomUUID(),
      },
    };

    const client = await pool.connect();
    try {
      const first = await applyEvent(client, event);
      assert.equal(first.applied, true, 'first apply applies');
      const second = await applyEvent(client, event); // replay
      assert.equal(second.applied, true, 'replay does not error');
    } finally {
      client.release();
    }

    assert.equal(await notePersonId(note), target, 'note on target after replay');
    assert.ok(await tombstoneExists(source), 'source tombstoned');
    const pm = await pool.query(`SELECT 1 FROM person_merge WHERE id = $1`, [mergeId]);
    assert.equal(pm.rowCount, 1, 'exactly one person_merge row after replay');
  });

  it('TWO devices merging the same A→B pair converge with no data loss/error', async () => {
    const target = await createPerson('Converge Target');
    const source = await createPerson('Converge Source');
    const note = await createNote(source, 'converge note');

    // Device 2 (remote) merged the same pair while we were offline.
    const remoteMergeId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      const remote = await applyEvent(client, {
        id: crypto.randomUUID(),
        device_id: crypto.randomUUID(),
        entity_type: 'person',
        entity_id: target,
        operation: 'person.merged',
        payload: {
          merge_id: remoteMergeId,
          source_person_id: source,
          target_person_id: target,
          created_by_device_id: crypto.randomUUID(),
        },
      });
      assert.equal(remote.applied, true);
    } finally {
      client.release();
    }

    // Now WE merge the same pair locally — must not error, no data loss.
    const local = await api('POST', '/api/people/merge', { target_id: target, source_id: source });
    assert.equal(local.status, 200, 'local merge of already-merged pair succeeds');

    assert.equal(await notePersonId(note), target, 'note still on target (no data loss)');
    assert.ok(await tombstoneExists(source), 'source still tombstoned');
    assert.equal(await resolvePersonRedirect(pool, source), target, 'source redirects to target');

    // Both merge records coexist; both redirect source→target → convergent.
    const pm = await pool.query(
      `SELECT 1 FROM person_merge WHERE source_person_id = $1 AND target_person_id = $2`,
      [source, target],
    );
    assert.ok((pm.rowCount ?? 0) >= 1, 'merge history retained');
  });

  it('resolvePersonRedirect maps source→target transitively (A→B→C)', async () => {
    const a = await createPerson('Redirect A');
    const b = await createPerson('Redirect B');
    const c = await createPerson('Redirect C');

    await api('POST', '/api/people/merge', { target_id: b, source_id: a }); // A→B
    await api('POST', '/api/people/merge', { target_id: c, source_id: b }); // B→C

    assert.equal(await resolvePersonRedirect(pool, a), c, 'A resolves transitively to C');
    assert.equal(await resolvePersonRedirect(pool, b), c, 'B resolves to C');
    assert.equal(await resolvePersonRedirect(pool, c), c, 'C resolves to itself');
  });

  it('reverse() restores the source + its refs and emits person.merge_reversed', async () => {
    const target = await createPerson('Reverse Target');
    const source = await createPerson('Reverse Source');
    const note = await createNote(source, 'note to be restored');

    const merge = await api('POST', '/api/people/merge', { target_id: target, source_id: source });
    const mergeId = merge.json.merge_id as string;
    assert.equal(await notePersonId(note), target, 'note on target after merge');
    assert.ok(await tombstoneExists(source), 'source tombstoned after merge');

    const reverse = await api('POST', `/api/people/merges/${mergeId}/reverse`);
    assert.equal(reverse.status, 200, 'reverse succeeds');
    assert.equal(reverse.json.ok, true);

    // Source live again, note back on source.
    assert.equal(await tombstoneExists(source), false, 'source un-tombstoned');
    assert.equal((await api('GET', `/api/people/${source}`)).status, 200, 'source visible again');
    assert.equal(await notePersonId(note), source, 'note restored to source');

    // person_merge marked reversed.
    const pm = await pool.query<{ reversed_at: Date | null }>(
      `SELECT reversed_at FROM person_merge WHERE id = $1`,
      [mergeId],
    );
    assert.ok(pm.rows[0]!.reversed_at, 'person_merge marked reversed');

    // resolvePersonRedirect no longer redirects (reversal honored).
    assert.equal(await resolvePersonRedirect(pool, source), source, 'redirect cleared after reverse');

    // person.merge_reversed event emitted.
    const ev = await pool.query(
      `SELECT 1 FROM sync_event WHERE operation = 'person.merge_reversed' AND entity_id = $1`,
      [target],
    );
    assert.equal(ev.rowCount, 1, 'person.merge_reversed event emitted');

    // Reversing again is a no-op (already reversed).
    const reverseAgain = await api('POST', `/api/people/merges/${mergeId}/reverse`);
    assert.equal(reverseAgain.status, 404, 're-reverse reports not_found_or_already_reversed');
  });
});
