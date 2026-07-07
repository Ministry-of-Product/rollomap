/**
 * Sync materialization for the workspace personalization profile (MIN-1123).
 * Runs against rollomap_test (pretest / test:reset gives a clean, fully-migrated DB).
 *
 * Drives applyEvent directly for the sync-replay cases, proving:
 *   (a) a remote profile.updated event upserts the single-row workspace_profile;
 *   (b) idempotency — replaying the SAME event twice is a no-op;
 *   (c) last-writer-wins — a stale (lower clock) event does NOT overwrite a newer
 *       applied state, and a newer event does;
 *   (d) convergence — a local write (high clock) is not clobbered by a stale remote
 *       (low clock), and BOTH apply orderings agree on the same winner.
 *
 * ISOLATION: this suite operates on its OWN throwaway workspace (a fresh uuid,
 * inserted in before() and dropped in after()), NOT the default WORKSPACE_ID. The
 * workspace_profile is a single row keyed by workspace_id, and `node --test` runs
 * test files concurrently against one shared rollomap_test DB. store.test.ts owns
 * the default WORKSPACE_ID row; keeping this file on a dedicated workspace means the
 * two suites never race on the same row. applyProfile keys the row by the event's
 * entity_id (= workspace_id), so a synthetic workspace id flows through end-to-end.
 *
 * The wire round-trip case lives in wire.test.ts alongside the other ops.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { applyEvent, type ApplicableEvent } from './apply.js';

// Dedicated throwaway workspace for this file (see ISOLATION note above).
const WS = crypto.randomUUID();

/** Build a remote profile.updated event with the given clock and payload fields. */
function profileEvent(
  clock: number,
  payload: Record<string, unknown>,
  serverSeq?: number,
): ApplicableEvent {
  return {
    id: crypto.randomUUID(),
    device_id: crypto.randomUUID(),
    entity_type: 'workspace_profile',
    entity_id: WS,
    operation: 'profile.updated',
    payload,
    logical_clock: clock,
    server_seq: serverSeq,
  };
}

async function readProfile(): Promise<{
  owner_name: string | null;
  interests: unknown;
  last_event_clock: string | null;
  last_event_seq: string | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT owner_name, interests, last_event_clock, last_event_seq
       FROM workspace_profile WHERE workspace_id = $1`,
    [WS],
  );
  return rows[0] ?? null;
}

describe('workspace_profile sync apply (MIN-1123)', () => {
  before(async () => {
    // A workspace row must exist for the workspace_profile FK.
    await pool.query(
      `INSERT INTO workspace (id, name) VALUES ($1, 'profile-sync-test') ON CONFLICT (id) DO NOTHING`,
      [WS],
    );
  });

  beforeEach(async () => {
    // Start each case from no profile row (single-row config table).
    await pool.query(`DELETE FROM workspace_profile WHERE workspace_id = $1`, [WS]);
  });

  after(async () => {
    await pool.query(`DELETE FROM workspace_profile WHERE workspace_id = $1`, [WS]);
    await pool.query(`DELETE FROM workspace WHERE id = $1`, [WS]);
    await pool.end();
  });

  it('(a) a remote profile.updated event upserts workspace_profile', async () => {
    const result = await applyEvent(
      pool,
      profileEvent(10, {
        ownerName: 'Alice',
        ownerEmails: ['alice@example.com'],
        interests: ['ai'],
        metadata: { source: 'remote' },
      }),
    );
    assert.equal(result.applied, true, 'event should be applied');

    const row = await readProfile();
    assert.ok(row, 'workspace_profile row was created');
    assert.equal(row!.owner_name, 'Alice');
    assert.deepEqual(row!.interests, ['ai']);
    assert.equal(row!.last_event_clock, '10', 'stores the event clock for LWW');
  });

  it('(b) applying the same event twice is idempotent (no-op)', async () => {
    const event = profileEvent(10, { ownerName: 'Alice', interests: ['ai'] });

    const first = await applyEvent(pool, event);
    assert.equal(first.applied, true);
    const afterFirst = await readProfile();

    const second = await applyEvent(pool, event);
    assert.equal(second.applied, true, 'replay is still a safe apply, not an error');
    const afterSecond = await readProfile();

    assert.equal(afterSecond!.owner_name, 'Alice');
    assert.equal(afterSecond!.last_event_clock, '10');
    assert.deepEqual(afterSecond!.interests, afterFirst!.interests, 'state unchanged by replay');
  });

  it('(c) LWW — a stale (older-clock) event does not overwrite newer state', async () => {
    // Apply a newer event first (clock 20).
    await applyEvent(pool, profileEvent(20, { ownerName: 'Bob', interests: ['systems'] }));
    let row = await readProfile();
    assert.equal(row!.owner_name, 'Bob');
    assert.equal(row!.last_event_clock, '20');

    // A stale event (clock 5) must NOT regress the row.
    const stale = await applyEvent(pool, profileEvent(5, { ownerName: 'Stale', interests: ['old'] }));
    assert.equal(stale.applied, true, 'stale replay is not an error');
    row = await readProfile();
    assert.equal(row!.owner_name, 'Bob', 'stale event did not overwrite newer state');
    assert.deepEqual(row!.interests, ['systems']);
    assert.equal(row!.last_event_clock, '20', 'clock did not regress');

    // A genuinely newer event (clock 30) DOES win.
    await applyEvent(pool, profileEvent(30, { ownerName: 'Carol', interests: ['design'] }));
    row = await readProfile();
    assert.equal(row!.owner_name, 'Carol');
    assert.equal(row!.last_event_clock, '30');
  });

  it('(c2) equal-clock tiebreak uses server_seq; lower seq does not overwrite', async () => {
    await applyEvent(pool, profileEvent(10, { ownerName: 'HighSeq' }, 200));
    let row = await readProfile();
    assert.equal(row!.owner_name, 'HighSeq');
    assert.equal(row!.last_event_seq, '200');

    // Same clock, lower seq → loses.
    await applyEvent(pool, profileEvent(10, { ownerName: 'LowSeq' }, 100));
    row = await readProfile();
    assert.equal(row!.owner_name, 'HighSeq', 'lower-seq event did not overwrite');

    // Same clock, higher seq → wins.
    await applyEvent(pool, profileEvent(10, { ownerName: 'HigherSeq' }, 300));
    row = await readProfile();
    assert.equal(row!.owner_name, 'HigherSeq');
    assert.equal(row!.last_event_seq, '300');
  });

  it('(d) convergence — a stale remote cannot clobber a higher-clock write; both orderings agree', async () => {
    // "A-local" reproduces exactly the row a local updateProfile write now leaves
    // behind after BLOCKER 2's fix: its own state, stamped with a high clock (100).
    await applyEvent(pool, profileEvent(100, { ownerName: 'A-local', interests: ['a'] }));
    // A stale remote event from device B (clock 5) must NOT clobber it.
    await applyEvent(pool, profileEvent(5, { ownerName: 'B-stale', interests: ['b'] }));
    let row = await readProfile();
    assert.equal(row!.owner_name, 'A-local', 'stale remote did not clobber the higher-clock write');
    assert.equal(row!.last_event_clock, '100');

    // Reverse ordering on a fresh row must converge to the SAME winner (A, clock 100).
    await pool.query(`DELETE FROM workspace_profile WHERE workspace_id = $1`, [WS]);
    await applyEvent(pool, profileEvent(5, { ownerName: 'B-stale', interests: ['b'] }));
    await applyEvent(pool, profileEvent(100, { ownerName: 'A-local', interests: ['a'] }));
    row = await readProfile();
    assert.equal(row!.owner_name, 'A-local', 'reverse ordering converges to the same winner');
    assert.equal(row!.last_event_clock, '100');
  });
});
