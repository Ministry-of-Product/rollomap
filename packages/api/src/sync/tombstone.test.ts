/**
 * Tombstone / sync-safe delete tests (MIN-933).
 * Runs against rollomap_test (pretest / test:reset gives a clean, fully-migrated DB).
 *
 * Mounts the real peopleRouter on an ephemeral express server so the GET-list /
 * GET-:id read filters and the DELETE route are exercised end-to-end, then drives
 * the apply + compaction service layer directly.
 *
 * Covers:
 *   - DELETE person writes a tombstone, KEEPS the canonical row, emits a
 *     person.deleted event, and the person disappears from GET / and GET /:id (404).
 *   - applying a person.created for a tombstoned id does NOT resurrect it
 *     (applied:false, still absent from reads).
 *   - compactTombstones removes rows ONLY when its precondition (all trusted
 *     devices acked past the delete event) is satisfied.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { pool, WORKSPACE_ID } from '../db.js';
import { peopleRouter } from '../routes/people.js';
import { applyEvent } from './apply.js';
import { compactTombstones, minTrustedAckedServerSeq } from './tombstone.js';

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

/** Force every trusted device's cursor to `seq` so the compaction floor is known. */
async function setAllTrustedCursors(seq: number): Promise<void> {
  await pool.query(
    `INSERT INTO sync_cursor (workspace_id, device_id, last_seen_server_seq)
       SELECT workspace_id, id, $2 FROM device
        WHERE workspace_id = $1 AND revoked_at IS NULL
     ON CONFLICT (workspace_id, device_id)
       DO UPDATE SET last_seen_server_seq = EXCLUDED.last_seen_server_seq`,
    [WORKSPACE_ID, seq],
  );
}

describe('tombstone / sync-safe delete', () => {
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('DELETE person tombstones, keeps the row, emits an event, and hides it from reads', async () => {
    const id = await createPerson('Tombstone Target');

    // Visible before delete.
    const listBefore = await api('GET', '/api/people?limit=5000');
    assert.ok(
      (listBefore.json.people as Array<{ id: string }>).some((p) => p.id === id),
      'person visible in list before delete',
    );
    assert.equal((await api('GET', `/api/people/${id}`)).status, 200);

    const del = await api('DELETE', `/api/people/${id}`);
    assert.equal(del.status, 200);
    assert.equal(del.json.deleted, 1, 'live person tombstone reports deleted:1');

    // Canonical row KEPT, tombstone written.
    assert.ok(await personRowExists(id), 'canonical person row is kept');
    assert.ok(await tombstoneExists(id), 'tombstone row written');

    // person.deleted event emitted carrying {id, deleted_by_device_id}.
    const ev = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM sync_event
        WHERE entity_type = 'person' AND entity_id = $1 AND operation = 'person.deleted'`,
      [id],
    );
    assert.equal(ev.rowCount, 1, 'exactly one person.deleted event');
    assert.equal(ev.rows[0]!.payload.id, id);
    assert.ok(ev.rows[0]!.payload.deleted_by_device_id, 'event carries deleted_by_device_id');

    // Hidden from reads.
    const listAfter = await api('GET', '/api/people?limit=5000');
    assert.ok(
      !(listAfter.json.people as Array<{ id: string }>).some((p) => p.id === id),
      'tombstoned person hidden from list',
    );
    assert.equal((await api('GET', `/api/people/${id}`)).status, 404, 'GET /:id returns 404');

    // Deleting again is a no-op (already tombstoned).
    const delAgain = await api('DELETE', `/api/people/${id}`);
    assert.equal(delAgain.json.deleted, 0, 're-delete reports deleted:0');
  });

  it('applying person.created for a tombstoned id does NOT resurrect it', async () => {
    const id = await createPerson('Resurrect Me');
    const del = await api('DELETE', `/api/people/${id}`);
    assert.equal(del.json.deleted, 1);

    const client = await pool.connect();
    try {
      const result = await applyEvent(client, {
        id: crypto.randomUUID(),
        device_id: crypto.randomUUID(),
        entity_type: 'person',
        entity_id: id,
        operation: 'person.created',
        payload: { id, workspace_id: WORKSPACE_ID, display_name: 'Resurrect Me (stale)' },
      });
      assert.equal(result.applied, false, 'create against a tombstone is not applied');
      assert.match(result.reason ?? '', /tombstone/i);
    } finally {
      client.release();
    }

    // Still hidden / still tombstoned.
    assert.equal((await api('GET', `/api/people/${id}`)).status, 404, 'still 404 after stale create');
    assert.ok(await tombstoneExists(id), 'tombstone still present');
  });

  it('a remote person.deleted event applies a tombstone idempotently (no hard delete)', async () => {
    const id = await createPerson('Remote Delete');
    const client = await pool.connect();
    try {
      const remoteDelete = {
        id: crypto.randomUUID(),
        device_id: crypto.randomUUID(),
        entity_type: 'person',
        entity_id: id,
        operation: 'person.deleted',
        payload: { id, deleted_by_device_id: crypto.randomUUID(), reason: 'remote' },
      };
      const first = await applyEvent(client, remoteDelete);
      assert.equal(first.applied, true);
      const second = await applyEvent(client, remoteDelete); // idempotent replay
      assert.equal(second.applied, true);
    } finally {
      client.release();
    }
    assert.ok(await personRowExists(id), 'remote delete keeps the canonical row');
    assert.ok(await tombstoneExists(id), 'remote delete writes a tombstone');
    assert.equal((await api('GET', `/api/people/${id}`)).status, 404);
  });

  it('compactTombstones removes rows ONLY once all trusted devices have acked', async () => {
    const id = await createPerson('Compact Me');
    const del = await api('DELETE', `/api/people/${id}`);
    assert.equal(del.json.deleted, 1);

    // server_seq of this delete's event.
    const seqRow = await pool.query<{ server_seq: string }>(
      `SELECT e.server_seq FROM entity_tombstone t
         JOIN sync_event e ON e.id = t.delete_event_id
        WHERE t.workspace_id = $1 AND t.entity_type = 'person' AND t.entity_id = $2`,
      [WORKSPACE_ID, id],
    );
    const deleteSeq = Number(seqRow.rows[0]!.server_seq);

    // NOT safe yet: a fresh trusted device with no cursor pins the floor to 0.
    const laggard = await pool.query<{ id: string }>(
      `INSERT INTO device (workspace_id, name, trusted_at)
         VALUES ($1, $2, now()) RETURNING id`,
      [WORKSPACE_ID, `laggard-${crypto.randomUUID()}`],
    );
    const laggardId = laggard.rows[0]!.id;

    const client = await pool.connect();
    try {
      assert.ok(
        (await minTrustedAckedServerSeq(client)) < deleteSeq,
        'floor below delete seq while a device lags',
      );
      const notYet = await compactTombstones(client, { entityType: 'person' });
      assert.ok(!notYet.compacted.includes(id), 'not compacted while unsafe');
      assert.ok(await personRowExists(id), 'row kept while unsafe');

      // Now every trusted device (incl. the laggard + local-default) acks past it.
      await setAllTrustedCursors(deleteSeq);
      assert.ok(
        (await minTrustedAckedServerSeq(client)) >= deleteSeq,
        'floor now at/above delete seq',
      );
      const compacted = await compactTombstones(client, { entityType: 'person' });
      assert.ok(compacted.compacted.includes(id), 'compacted once safe');
    } finally {
      client.release();
      // cleanup the synthetic device so it can't skew later test files.
      await pool.query(`DELETE FROM sync_cursor WHERE device_id = $1`, [laggardId]);
      await pool.query(`DELETE FROM device WHERE id = $1`, [laggardId]);
    }

    assert.equal(await personRowExists(id), false, 'canonical row physically removed');
    assert.equal(await tombstoneExists(id), false, 'tombstone removed after compaction');
  });
});
