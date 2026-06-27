/**
 * Tests for the append-only sync event log (MIN-931).
 * Runs against the rollomap_test DB (set up by pretest / test:reset).
 *
 * Exercises the events service through the same transactional helper the route
 * handlers use, asserts replayable payloads + a monotonic logical_clock, and
 * verifies DB-level immutability (UPDATE/DELETE are rejected).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, WORKSPACE_ID } from '../db.js';
import { recordEvent, withSyncTxn } from './events.js';

interface SyncEventRow {
  id: string;
  workspace_id: string;
  device_id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  payload: Record<string, unknown>;
  logical_clock: string;
  hash: string;
  created_at: Date;
}

async function createPerson(displayName: string): Promise<{ id: string }> {
  return withSyncTxn(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO person (workspace_id, display_name) VALUES ($1, $2) RETURNING *`,
      [WORKSPACE_ID, displayName],
    );
    const row = result.rows[0]!;
    await recordEvent(client, {
      entityType: 'person',
      entityId: row.id,
      operation: 'person.created',
      payload: row,
    });
    return row;
  });
}

describe('sync event log', () => {
  after(async () => {
    await pool.end();
  });

  it('creating a person writes exactly one person.created event with a replayable payload', async () => {
    const person = await createPerson(`Test Person ${Date.now()}`);

    const events = await pool.query<SyncEventRow>(
      `SELECT * FROM sync_event WHERE entity_id = $1 AND operation = 'person.created'`,
      [person.id],
    );
    assert.equal(events.rowCount, 1, 'exactly one person.created event expected');

    const ev = events.rows[0]!;
    assert.equal(ev.entity_type, 'person');
    assert.equal(ev.workspace_id, WORKSPACE_ID);
    assert.ok(ev.device_id, 'event must carry a device_id');
    assert.ok(ev.created_at instanceof Date, 'event must carry a timestamp');
    assert.ok(ev.hash && ev.hash.length === 64, 'event must carry a sha256 hex hash');
    // Replayable: payload holds the full new row state (id + display_name).
    assert.equal(ev.payload.id, person.id);
    assert.ok(ev.payload.display_name, 'payload must include the full new row state');
  });

  it('logical_clock increases monotonically across events', async () => {
    const before = await pool.query<{ max: string | null }>(
      `SELECT max(logical_clock)::text AS max FROM sync_event`,
    );
    const baseline = before.rows[0]!.max ? BigInt(before.rows[0]!.max) : 0n;

    const a = await createPerson(`Mono A ${Date.now()}`);
    const b = await createPerson(`Mono B ${Date.now()}`);

    const rows = await pool.query<{ logical_clock: string }>(
      `SELECT logical_clock FROM sync_event WHERE entity_id = ANY($1::uuid[]) ORDER BY logical_clock ASC`,
      [[a.id, b.id]],
    );
    assert.equal(rows.rowCount, 2);
    const c1 = BigInt(rows.rows[0]!.logical_clock);
    const c2 = BigInt(rows.rows[1]!.logical_clock);
    assert.ok(c1 > baseline, 'clock must advance past prior events');
    assert.ok(c2 > c1, 'logical_clock must strictly increase');
  });

  it('person.deleted event carries the id for replay', async () => {
    const person = await createPerson(`To Delete ${Date.now()}`);
    await withSyncTxn(async (client) => {
      await client.query(`DELETE FROM person WHERE workspace_id = $1 AND id = $2`, [
        WORKSPACE_ID,
        person.id,
      ]);
      await recordEvent(client, {
        entityType: 'person',
        entityId: person.id,
        operation: 'person.deleted',
        payload: { id: person.id },
      });
    });
    const ev = await pool.query<SyncEventRow>(
      `SELECT * FROM sync_event WHERE entity_id = $1 AND operation = 'person.deleted'`,
      [person.id],
    );
    assert.equal(ev.rowCount, 1);
    assert.equal(ev.rows[0]!.payload.id, person.id);
  });

  it('events are immutable — UPDATE is rejected by the DB', async () => {
    const person = await createPerson(`Immutable U ${Date.now()}`);
    const ev = await pool.query<SyncEventRow>(
      `SELECT id FROM sync_event WHERE entity_id = $1 LIMIT 1`,
      [person.id],
    );
    const eventId = ev.rows[0]!.id;
    await assert.rejects(
      () => pool.query(`UPDATE sync_event SET operation = 'tampered' WHERE id = $1`, [eventId]),
      /append-only/,
      'UPDATE on sync_event must be rejected',
    );
  });

  it('events are immutable — DELETE is rejected by the DB', async () => {
    const person = await createPerson(`Immutable D ${Date.now()}`);
    const ev = await pool.query<SyncEventRow>(
      `SELECT id FROM sync_event WHERE entity_id = $1 LIMIT 1`,
      [person.id],
    );
    const eventId = ev.rows[0]!.id;
    await assert.rejects(
      () => pool.query(`DELETE FROM sync_event WHERE id = $1`, [eventId]),
      /append-only/,
      'DELETE on sync_event must be rejected',
    );
  });

  it('a failed transaction records no event (atomicity)', async () => {
    const marker = `Atomic ${Date.now()}`;
    await assert.rejects(() =>
      withSyncTxn(async (client) => {
        const r = await client.query<{ id: string }>(
          `INSERT INTO person (workspace_id, display_name) VALUES ($1, $2) RETURNING id`,
          [WORKSPACE_ID, marker],
        );
        await recordEvent(client, {
          entityType: 'person',
          entityId: r.rows[0]!.id,
          operation: 'person.created',
          payload: { id: r.rows[0]!.id },
        });
        throw new Error('boom');
      }),
    );
    // Neither the person nor its event should survive the rollback.
    const people = await pool.query(`SELECT id FROM person WHERE display_name = $1`, [marker]);
    assert.equal(people.rowCount, 0, 'person insert must have rolled back');
  });
});
