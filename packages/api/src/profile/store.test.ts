/**
 * Tests for the workspace profile store (MIN-1122).
 *
 * Runs against rollomap_test DB (set up by pretest/reset-test-db.sh).
 * Requires migration 014 (workspace_profile table) to be applied.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, WORKSPACE_ID } from '../db.js';
import { getProfile, updateProfile } from './store.js';
import { applyEvent } from '../sync/apply.js';

// Single top-level pool teardown — runs after all suites in this file.
after(async () => { await pool.end(); });

// Clean this workspace's workspace_profile row. Scoped by workspace so it does
// not disturb other parallel test files. sync_event is append-only (DELETE is
// rejected by a DB trigger) so we do not (and cannot) clean it up here.
async function resetProfile(): Promise<void> {
  await pool.query('DELETE FROM workspace_profile WHERE workspace_id = $1', [WORKSPACE_ID]);
}

describe('workspace profile store', () => {
  before(async () => { await resetProfile(); });
  after(async () => { await resetProfile(); });

  it('getProfile returns a default empty profile when no row exists', async () => {
    const profile = await getProfile();
    assert.equal(profile.ownerName, null);
    assert.deepEqual(profile.ownerEmails, []);
    assert.deepEqual(profile.ownerAliases, []);
    assert.deepEqual(profile.interests, []);
    assert.equal(profile.primaryNetwork, null);
    assert.deepEqual(profile.importRecipes, []);
    assert.deepEqual(profile.journalSkipPhrases, []);
    assert.deepEqual(profile.metadata, {});
    assert.equal(profile.lastEventClock, null);
    assert.equal(profile.lastEventSeq, null);
  });

  it('updateProfile + getProfile round-trip', async () => {
    const updated = await updateProfile({
      interests: ['product management', 'machine learning'],
      ownerEmails: ['you@example.com'],
    });
    assert.deepEqual(updated.interests, ['product management', 'machine learning']);
    assert.deepEqual(updated.ownerEmails, ['you@example.com']);

    const fetched = await getProfile();
    assert.deepEqual(fetched.interests, ['product management', 'machine learning']);
    assert.deepEqual(fetched.ownerEmails, ['you@example.com']);
  });

  it('partial update preserves fields not included in the patch', async () => {
    await updateProfile({
      ownerName: 'Test Owner',
      interests: ['networking'],
      primaryNetwork: 'Test Network',
    });

    // Only touch owner_emails this time — owner_name, interests, and
    // primary_network should all survive untouched.
    const updated = await updateProfile({ ownerEmails: ['owner@example.com'] });

    assert.equal(updated.ownerName, 'Test Owner');
    assert.deepEqual(updated.interests, ['networking']);
    assert.equal(updated.primaryNetwork, 'Test Network');
    assert.deepEqual(updated.ownerEmails, ['owner@example.com']);
  });

  it('clearing owner_name to null works while an omitted field is preserved', async () => {
    await updateProfile({ ownerName: 'Someone', primaryNetwork: 'Some Network', interests: ['x'] });

    // Explicit null clears owner_name; primary_network + interests are omitted
    // and must survive untouched (not silently no-op'd back to their old value).
    const cleared = await updateProfile({ ownerName: null });
    assert.equal(cleared.ownerName, null, 'explicit null cleared owner_name');
    assert.equal(cleared.primaryNetwork, 'Some Network', 'omitted primary_network preserved');
    assert.deepEqual(cleared.interests, ['x'], 'omitted interests preserved');

    // primary_network can likewise be cleared with an explicit null.
    const cleared2 = await updateProfile({ primaryNetwork: null });
    assert.equal(cleared2.primaryNetwork, null, 'explicit null cleared primary_network');
    assert.deepEqual(cleared2.interests, ['x'], 'interests still preserved');
  });

  it('a local write stamps last_event_clock, so a stale remote event cannot clobber it (LWW)', async () => {
    // BLOCKER 2: the local write path must stamp last_event_clock (the ordering key
    // of its own recorded event). Without this the stored clock stays NULL and
    // applyProfile's guard applies unconditionally — letting two devices swap and
    // diverge forever.
    const local = await updateProfile({ ownerName: 'Local', interests: ['local'] });
    assert.ok(local.lastEventClock, 'local write stamped a non-null last_event_clock');
    assert.equal(local.lastEventSeq, null, 'a local (unpushed) write has no server_seq');

    // A stale remote profile.updated (clock strictly below the local write) must NOT
    // overwrite the local state.
    const staleClock = Number(local.lastEventClock) - 1;
    const stale = await applyEvent(pool, {
      id: crypto.randomUUID(),
      entity_type: 'workspace_profile',
      entity_id: WORKSPACE_ID,
      operation: 'profile.updated',
      payload: { ownerName: 'StaleRemote', interests: ['stale'] },
      logical_clock: staleClock,
    });
    assert.equal(stale.applied, true, 'stale replay is a safe apply, not an error');
    const afterStale = await getProfile();
    assert.equal(afterStale.ownerName, 'Local', 'stale remote did not clobber the stamped local write');
    assert.deepEqual(afterStale.interests, ['local']);

    // A genuinely newer remote event (higher clock) DOES win — convergence.
    const newerClock = Number(local.lastEventClock) + 1;
    await applyEvent(pool, {
      id: crypto.randomUUID(),
      entity_type: 'workspace_profile',
      entity_id: WORKSPACE_ID,
      operation: 'profile.updated',
      payload: { ownerName: 'NewerRemote', interests: ['newer'] },
      logical_clock: newerClock,
    });
    const afterNewer = await getProfile();
    assert.equal(afterNewer.ownerName, 'NewerRemote', 'a newer remote event wins');
    assert.equal(afterNewer.lastEventClock, String(newerClock));
  });

  it('updateProfile records a profile.updated sync event', async () => {
    const updated = await updateProfile({ interests: ['deep tech'] });

    const events = await pool.query<{
      operation: string;
      entity_type: string;
      entity_id: string;
      payload: { interests: string[] };
    }>(
      `SELECT operation, entity_type, entity_id, payload
         FROM sync_event
        WHERE workspace_id = $1 AND entity_id = $1 AND operation = 'profile.updated'
        ORDER BY logical_clock DESC
        LIMIT 1`,
      [WORKSPACE_ID],
    );
    assert.equal(events.rowCount, 1, 'expected a profile.updated event for this workspace');
    const ev = events.rows[0]!;
    assert.equal(ev.entity_type, 'workspace_profile');
    assert.equal(ev.entity_id, WORKSPACE_ID);
    assert.deepEqual(ev.payload.interests, updated.interests);
  });
});
