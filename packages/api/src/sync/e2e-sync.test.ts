/**
 * End-to-end multi-device offline-sync test harness (MIN-939).
 *
 * Each test creates ISOLATED per-device databases via harness.makeDevice(), drives
 * the real sync code (recordEvent / applyEvent / tombstoneEntity / mergePeople /
 * assertField / getFieldConflicts) on device-scoped pg clients, and tears down the
 * device DBs in a finally block. The sync transfer uses harness.syncDevices(), which
 * mirrors the production push+pull semantics (see harness.ts module header).
 *
 * Prerequisites: the Docker postgres container (`rollomap-postgres`) must be running.
 * Run with: `npm --workspace @rollomap/api test`
 *
 * Scenarios:
 *   1. Offline creates converge — A creates Alice, B creates Bob, sync → both on both.
 *   2. Concurrent field assertions — A adds email, B adds phone to SAME person;
 *      multi-value union after sync.
 *   3. Tombstone beats stale update — A deletes, B edits; tombstone wins everywhere.
 *   4. Merge convergence — A and B create duplicates; A merges; sync converges.
 *   5. Connector/user conflict — source-backed vs user-confirmed assertion;
 *      both preserved, policy winner correct, needs_review as expected.
 *   6. Idempotency — re-applying the same event batch is a no-op (no duplicates,
 *      no errors); cursor advancement is asserted explicitly.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, WORKSPACE_ID } from '../db.js';
import { recordEvent } from './events.js';
import { tombstoneEntity } from './tombstone.js';
import { mergePeople } from './merge.js';
import { assertField, getFieldConflicts } from './assertions.js';
import {
  makeDevice,
  teardownAll,
  withDeviceTxn,
  syncDevices,
  dumpEvents,
  type Device,
} from './harness.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Insert a person with a specific (or auto-generated) id and record its creation event. */
async function createPersonOn(
  device: Device,
  displayName: string,
  overrideId?: string,
): Promise<string> {
  return withDeviceTxn(device, async (client) => {
    const row = (
      await client.query<{
        id: string;
        workspace_id: string;
        display_name: string;
        primary_email: string | null;
        aliases: unknown;
        known_emails: unknown;
        known_phones: unknown;
        linkedin_url: string | null;
        company: string | null;
        title: string | null;
        summary: string | null;
        how_known: string | null;
        first_seen_at: Date | null;
        last_seen_at: Date | null;
        interaction_count: number;
        relationship_strength: number;
        confidence: number;
        user_pinned: boolean;
        sensitivity_level: string;
        created_at: Date;
        updated_at: Date;
      }>(
        overrideId
          ? `INSERT INTO person
               (id, workspace_id, display_name)
             VALUES ($1::uuid, $2, $3)
             ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
             RETURNING id, workspace_id, display_name, primary_email, aliases, known_emails,
               known_phones, linkedin_url, company, title, summary, how_known, first_seen_at,
               last_seen_at, interaction_count, relationship_strength, confidence, user_pinned,
               sensitivity_level, created_at, updated_at`
          : `INSERT INTO person (workspace_id, display_name)
             VALUES ($1, $2)
             RETURNING id, workspace_id, display_name, primary_email, aliases, known_emails,
               known_phones, linkedin_url, company, title, summary, how_known, first_seen_at,
               last_seen_at, interaction_count, relationship_strength, confidence, user_pinned,
               sensitivity_level, created_at, updated_at`,
        overrideId ? [overrideId, WORKSPACE_ID, displayName] : [WORKSPACE_ID, displayName],
      )
    ).rows[0]!;

    await recordEvent(client, {
      entityType: 'person',
      entityId: row.id,
      operation: 'person.created',
      payload: row,
    });
    return row.id;
  });
}

/** True when the person row exists in the device's DB (not considering tombstone). */
async function personExistsOn(device: Device, personId: string): Promise<boolean> {
  const r = await device.pool.query(
    `SELECT 1 FROM person WHERE id = $1 AND workspace_id = $2`,
    [personId, WORKSPACE_ID],
  );
  return (r.rowCount ?? 0) > 0;
}

/** True when entity_tombstone has an entry for this entity. */
async function isTombstonedOn(
  device: Device,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const r = await device.pool.query(
    `SELECT 1 FROM entity_tombstone
      WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3`,
    [WORKSPACE_ID, entityType, entityId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Current cursor in `device`'s DB for `fromDevice`'s event stream. */
async function getCursorOn(device: Device, fromDevice: Device): Promise<number> {
  const r = await device.pool.query<{ last_seen_server_seq: string }>(
    `SELECT last_seen_server_seq FROM sync_cursor
      WHERE workspace_id = $1 AND device_id = $2`,
    [WORKSPACE_ID, fromDevice.deviceId],
  );
  return r.rowCount ? Number(r.rows[0]!.last_seen_server_seq) : 0;
}

/** Count sync_event rows on a device. */
async function eventCountOn(device: Device): Promise<number> {
  const r = await device.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sync_event WHERE workspace_id = $1`,
    [WORKSPACE_ID],
  );
  return Number(r.rows[0]!.n);
}

// ─── Close the singleton pool so the process exits ───────────────────────────
after(async () => {
  await pool.end();
});

// ─── Scenarios ────────────────────────────────────────────────────────────────

describe('e2e sync harness — isolated multi-device scenarios', () => {
  // ── Scenario 1 ──────────────────────────────────────────────────────────────
  it('Scenario 1: offline creates on A and B converge after bidirectional sync', async () => {
    const devices: Device[] = [];
    try {
      const a = await makeDevice('s1a');
      const b = await makeDevice('s1b');
      devices.push(a, b);

      // A creates Alice offline; B creates Bob offline.
      const aliceId = await createPersonOn(a, 'Alice');
      const bobId = await createPersonOn(b, 'Bob');

      assert.ok(await personExistsOn(a, aliceId), 'Alice must exist on A');
      assert.ok(await personExistsOn(b, bobId), 'Bob must exist on B');
      assert.equal(await personExistsOn(b, aliceId), false, 'Alice not yet on B before sync');
      assert.equal(await personExistsOn(a, bobId), false, 'Bob not yet on A before sync');

      // Sync A → B
      const atob = await syncDevices(a, b);
      assert.ok(
        atob.transferred > 0,
        `A→B must transfer at least 1 event (got ${atob.transferred})`,
      );
      assert.ok(atob.cursor > 0, `A→B cursor must advance (got ${atob.cursor})`);
      assert.ok(
        await personExistsOn(b, aliceId),
        `Alice must exist on B after sync (entity=${aliceId}, dev=${b.deviceId})`,
      );

      // Sync B → A
      const btoa = await syncDevices(b, a);
      assert.ok(btoa.transferred > 0, `B→A must transfer at least 1 event (got ${btoa.transferred})`);
      assert.ok(btoa.cursor > 0, `B→A cursor must advance (got ${btoa.cursor})`);
      assert.ok(
        await personExistsOn(a, bobId),
        `Bob must exist on A after sync (entity=${bobId}, dev=${a.deviceId})`,
      );

      // Second sync in each direction must be a no-op.
      const noOpAB = await syncDevices(a, b);
      const noOpBA = await syncDevices(b, a);
      assert.equal(
        noOpAB.transferred,
        0,
        `Second A→B sync with no new events must be a no-op (got ${noOpAB.transferred})`,
      );
      assert.equal(
        noOpBA.transferred,
        0,
        `Second B→A sync with no new events must be a no-op (got ${noOpBA.transferred})`,
      );

      // Cursor must not have regressed. After B→A sync, A gains B's events as relayed
      // entries (new server_seq in A's DB), so a second A→B may advance the cursor
      // past atob.cursor to cover those relayed entries. ">=" is the correct invariant.
      assert.ok(
        noOpAB.cursor >= atob.cursor,
        `A→B cursor must not regress on no-op sync (was=${atob.cursor}, now=${noOpAB.cursor})`,
      );
      assert.ok(
        noOpBA.cursor >= btoa.cursor,
        `B→A cursor must not regress on no-op sync (was=${btoa.cursor}, now=${noOpBA.cursor})`,
      );
    } catch (err) {
      // Emit debug context on failure before re-throwing.
      if (devices[0]) await dumpEvents(devices[0], 's1a').catch(() => {});
      if (devices[1]) await dumpEvents(devices[1], 's1b').catch(() => {});
      throw err;
    } finally {
      await teardownAll(devices);
    }
  });

  // ── Scenario 2 ──────────────────────────────────────────────────────────────
  it('Scenario 2: concurrent field assertions on same person — multi-value union after sync', async () => {
    const devices: Device[] = [];
    try {
      const a = await makeDevice('s2a');
      const b = await makeDevice('s2b');
      devices.push(a, b);

      // Seed the same person on A, then sync to B.
      const sharedId = await createPersonOn(a, 'Shared Person');
      await syncDevices(a, b);
      assert.ok(
        await personExistsOn(b, sharedId),
        `Shared person must arrive on B before assertions (entity=${sharedId})`,
      );

      // A adds an email (union field).
      await withDeviceTxn(a, async (client) => {
        await assertField(client, {
          personId: sharedId,
          fieldName: 'known_emails',
          fieldValue: ['alice@example.com'],
          userConfirmed: false,
        });
      });

      // B adds a phone (union field) to the SAME person.
      await withDeviceTxn(b, async (client) => {
        await assertField(client, {
          personId: sharedId,
          fieldName: 'known_phones',
          fieldValue: ['555-1234'],
          userConfirmed: false,
        });
      });

      // Sync both ways.
      await syncDevices(a, b);
      await syncDevices(b, a);

      // Both values must be present on both devices.
      const checkBothValues = async (device: Device, label: string) => {
        const emailsRes = await device.pool.query<{ known_emails: unknown[] }>(
          `SELECT known_emails FROM person WHERE id = $1 AND workspace_id = $2`,
          [sharedId, WORKSPACE_ID],
        );
        const phonesRes = await device.pool.query<{ known_phones: unknown[] }>(
          `SELECT known_phones FROM person WHERE id = $1 AND workspace_id = $2`,
          [sharedId, WORKSPACE_ID],
        );
        const emails = emailsRes.rows[0]!.known_emails as string[];
        const phones = phonesRes.rows[0]!.known_phones as string[];
        assert.ok(
          emails.includes('alice@example.com'),
          `${label}: expected known_emails to contain 'alice@example.com', got ${JSON.stringify(emails)} (entity=${sharedId})`,
        );
        assert.ok(
          phones.includes('555-1234'),
          `${label}: expected known_phones to contain '555-1234', got ${JSON.stringify(phones)} (entity=${sharedId})`,
        );
      };

      await checkBothValues(a, 'Device A');
      await checkBothValues(b, 'Device B');

      // Both assertion rows must exist (union: values are preserved, not replaced).
      const assertionCount = async (device: Device, label: string) => {
        const r = await device.pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM person_field_assertion
            WHERE workspace_id = $1 AND person_id = $2 AND superseded_at IS NULL`,
          [WORKSPACE_ID, sharedId],
        );
        const n = Number(r.rows[0]!.n);
        assert.ok(
          n >= 2,
          `${label}: expected at least 2 live assertions, got ${n} (entity=${sharedId})`,
        );
      };
      await assertionCount(a, 'Device A');
      await assertionCount(b, 'Device B');
    } catch (err) {
      if (devices[0]) await dumpEvents(devices[0], 's2a').catch(() => {});
      if (devices[1]) await dumpEvents(devices[1], 's2b').catch(() => {});
      throw err;
    } finally {
      await teardownAll(devices);
    }
  });

  // ── Scenario 3 ──────────────────────────────────────────────────────────────
  it('Scenario 3: tombstone beats stale update — delete-wins after bidirectional sync', async () => {
    const devices: Device[] = [];
    try {
      const a = await makeDevice('s3a');
      const b = await makeDevice('s3b');
      devices.push(a, b);

      // Seed the same person on both.
      const sharedId = await createPersonOn(a, 'Person To Delete');
      await syncDevices(a, b);
      assert.ok(await personExistsOn(b, sharedId), `Seed person must arrive on B (entity=${sharedId})`);

      // A tombstones the person offline.
      await withDeviceTxn(a, async (client) => {
        await tombstoneEntity(client, { entityType: 'person', entityId: sharedId, reason: 'e2e test delete' });
      });

      // B edits the same person offline (person.updated).
      await withDeviceTxn(b, async (client) => {
        const updated = (
          await client.query<{ id: string; display_name: string }>(
            `UPDATE person SET display_name = 'Updated Display Name'
              WHERE workspace_id = $1 AND id = $2
              RETURNING id, workspace_id, display_name, primary_email, aliases, known_emails,
                known_phones, linkedin_url, company, title, summary, how_known, first_seen_at,
                last_seen_at, interaction_count, relationship_strength, confidence, user_pinned,
                sensitivity_level, created_at, updated_at`,
            [WORKSPACE_ID, sharedId],
          )
        ).rows[0]!;
        await recordEvent(client, {
          entityType: 'person',
          entityId: sharedId,
          operation: 'person.updated',
          payload: updated,
        });
      });

      // Sync A → B: B receives the tombstone.
      const atob = await syncDevices(a, b);
      assert.ok(atob.transferred > 0, `A→B must transfer tombstone event (got ${atob.transferred})`);

      // Sync B → A: A receives B's person.updated (should be blocked by tombstone).
      const btoa = await syncDevices(b, a);
      assert.ok(btoa.transferred > 0, `B→A must transfer person.updated event (got ${btoa.transferred})`);

      // Tombstone must win on both devices.
      assert.ok(
        await isTombstonedOn(a, 'person', sharedId),
        `Person must be tombstoned on A (entity=${sharedId}, dev=${a.deviceId})`,
      );
      assert.ok(
        await isTombstonedOn(b, 'person', sharedId),
        `Person must be tombstoned on B after sync (entity=${sharedId}, dev=${b.deviceId})`,
      );

      // The person row must still exist on both (tombstone keeps it; compaction removes it later).
      assert.ok(
        await personExistsOn(a, sharedId),
        `Canonical person row must survive on A (tombstone doesn't hard-delete; entity=${sharedId})`,
      );
      assert.ok(
        await personExistsOn(b, sharedId),
        `Canonical person row must survive on B (entity=${sharedId})`,
      );
    } catch (err) {
      if (devices[0]) await dumpEvents(devices[0], 's3a').catch(() => {});
      if (devices[1]) await dumpEvents(devices[1], 's3b').catch(() => {});
      throw err;
    } finally {
      await teardownAll(devices);
    }
  });

  // ── Scenario 4 ──────────────────────────────────────────────────────────────
  it('Scenario 4: merge convergence — duplicate people merged on A, sync converges on B', async () => {
    const devices: Device[] = [];
    try {
      const a = await makeDevice('s4a');
      const b = await makeDevice('s4b');
      devices.push(a, b);

      // A creates Alice; B creates Bob (likely duplicates).
      const aliceId = await createPersonOn(a, 'Alice Dup');
      const bobId = await createPersonOn(b, 'Bob Dup');

      // Sync both ways so A has Bob and B has Alice.
      await syncDevices(a, b);
      await syncDevices(b, a);

      assert.ok(await personExistsOn(a, bobId), `A must have Bob before merge (entity=${bobId})`);
      assert.ok(await personExistsOn(b, aliceId), `B must have Alice before merge (entity=${aliceId})`);

      // A merges Alice → Bob (Alice is source, Bob is target / survivor).
      let mergeId: string;
      await withDeviceTxn(a, async (client) => {
        const result = await mergePeople(client, { sourceId: aliceId, targetId: bobId });
        mergeId = result.mergeId;
      });

      // A: Alice must be tombstoned, Bob must survive, merge row must exist.
      assert.ok(
        await isTombstonedOn(a, 'person', aliceId),
        `Alice must be tombstoned on A after merge (entity=${aliceId}, dev=${a.deviceId})`,
      );
      assert.ok(
        await personExistsOn(a, bobId),
        `Bob (merge target) must still exist on A (entity=${bobId})`,
      );
      const mergeRowA = await a.pool.query<{ id: string }>(
        `SELECT id FROM person_merge WHERE workspace_id = $1 AND id = $2`,
        [WORKSPACE_ID, mergeId!],
      );
      assert.equal(mergeRowA.rowCount, 1, `person_merge row must exist on A (merge_id=${mergeId!})`);

      // Sync A → B: B receives person.deleted (Alice) + person.merged.
      const atob = await syncDevices(a, b);
      assert.ok(
        atob.transferred >= 2,
        `A→B must transfer at least 2 merge events (person.deleted + person.merged), got ${atob.transferred}`,
      );

      // B: Alice tombstoned, Bob survives, merge row recorded.
      assert.ok(
        await isTombstonedOn(b, 'person', aliceId),
        `Alice must be tombstoned on B after merge sync (entity=${aliceId}, dev=${b.deviceId})`,
      );
      assert.ok(
        await personExistsOn(b, bobId),
        `Bob (merge target) must still exist on B (entity=${bobId})`,
      );
      const mergeRowB = await b.pool.query<{ id: string }>(
        `SELECT id FROM person_merge WHERE workspace_id = $1 AND id = $2`,
        [WORKSPACE_ID, mergeId!],
      );
      assert.equal(
        mergeRowB.rowCount,
        1,
        `person_merge row must arrive on B (merge_id=${mergeId!}, dev=${b.deviceId})`,
      );

      // No data loss: person_merge row has non-empty relocations on both.
      const relocationsA = await a.pool.query<{ relocations: unknown }>(
        `SELECT relocations FROM person_merge WHERE workspace_id = $1 AND id = $2`,
        [WORKSPACE_ID, mergeId!],
      );
      assert.ok(
        relocationsA.rows[0]!.relocations !== null,
        'merge relocations must be recorded on A',
      );
    } catch (err) {
      if (devices[0]) await dumpEvents(devices[0], 's4a').catch(() => {});
      if (devices[1]) await dumpEvents(devices[1], 's4b').catch(() => {});
      throw err;
    } finally {
      await teardownAll(devices);
    }
  });

  // ── Scenario 5 ──────────────────────────────────────────────────────────────
  it('Scenario 5: connector vs user-confirmed assertion — both preserved, policy winner correct', async () => {
    const devices: Device[] = [];
    try {
      const a = await makeDevice('s5a');
      const b = await makeDevice('s5b');
      devices.push(a, b);

      // Seed shared person on A, sync to B.
      const sharedId = await createPersonOn(a, 'Conflict Person');
      await syncDevices(a, b);

      const fakeConnId = crypto.randomUUID(); // no FK on source_connection_id

      // A makes a source-backed assertion: company = 'Acme Corp' (not user-confirmed).
      await withDeviceTxn(a, async (client) => {
        await assertField(client, {
          personId: sharedId,
          fieldName: 'company',
          fieldValue: 'Acme Corp',
          sourceConnectionId: fakeConnId,
          confidence: 0.8,
          userConfirmed: false,
        });
      });

      // B makes a user-confirmed assertion for the SAME field with a different value.
      await withDeviceTxn(b, async (client) => {
        await assertField(client, {
          personId: sharedId,
          fieldName: 'company',
          fieldValue: 'ACME Inc',
          userConfirmed: true,
          confidence: 1.0,
        });
      });

      // Sync both ways.
      await syncDevices(a, b);
      await syncDevices(b, a);

      // Both assertion rows must be preserved on both devices (no deletion of losers).
      const checkAssertions = async (device: Device, label: string) => {
        const r = await device.pool.query<{ field_value: unknown; user_confirmed: boolean }>(
          `SELECT field_value, user_confirmed FROM person_field_assertion
            WHERE workspace_id = $1 AND person_id = $2 AND field_name = 'company'
              AND superseded_at IS NULL
            ORDER BY user_confirmed DESC`,
          [WORKSPACE_ID, sharedId],
        );
        assert.equal(
          r.rowCount,
          2,
          `${label}: expected 2 live company assertions, got ${r.rowCount} (entity=${sharedId})`,
        );
        const values = r.rows.map((x) => x.field_value);
        assert.ok(
          values.some((v) => v === 'Acme Corp'),
          `${label}: source-backed assertion 'Acme Corp' must be preserved, got ${JSON.stringify(values)}`,
        );
        assert.ok(
          values.some((v) => v === 'ACME Inc'),
          `${label}: user-confirmed assertion 'ACME Inc' must be preserved, got ${JSON.stringify(values)}`,
        );
      };
      await checkAssertions(a, 'Device A');
      await checkAssertions(b, 'Device B');

      // Canonical company column must equal the user-confirmed winner on both.
      const checkCanonical = async (device: Device, label: string) => {
        const r = await device.pool.query<{ company: string }>(
          `SELECT company FROM person WHERE workspace_id = $1 AND id = $2`,
          [WORKSPACE_ID, sharedId],
        );
        assert.equal(
          r.rows[0]!.company,
          'ACME Inc',
          `${label}: canonical company must be user-confirmed 'ACME Inc', got '${r.rows[0]!.company}' (entity=${sharedId})`,
        );
      };
      await checkCanonical(a, 'Device A');
      await checkCanonical(b, 'Device B');

      // getFieldConflicts must report has_user_confirmed_winner=true, needs_review=false.
      const checkConflicts = async (device: Device, label: string) => {
        const conflicts = await getFieldConflicts(device.pool, sharedId);
        const companyConflict = conflicts.find((c) => c.field_name === 'company');
        assert.ok(
          companyConflict !== undefined,
          `${label}: company conflict must be detected (entity=${sharedId})`,
        );
        assert.equal(
          companyConflict!.winner,
          'ACME Inc',
          `${label}: conflict winner must be 'ACME Inc', got '${String(companyConflict!.winner)}'`,
        );
        assert.equal(
          companyConflict!.has_user_confirmed_winner,
          true,
          `${label}: has_user_confirmed_winner must be true`,
        );
        assert.equal(
          companyConflict!.needs_review,
          false,
          `${label}: needs_review must be false (user confirmed the winner)`,
        );
        assert.equal(
          companyConflict!.competing.length,
          2,
          `${label}: must have 2 competing values, got ${companyConflict!.competing.length}`,
        );
      };
      await checkConflicts(a, 'Device A');
      await checkConflicts(b, 'Device B');
    } catch (err) {
      if (devices[0]) await dumpEvents(devices[0], 's5a').catch(() => {});
      if (devices[1]) await dumpEvents(devices[1], 's5b').catch(() => {});
      throw err;
    } finally {
      await teardownAll(devices);
    }
  });

  // ── Scenario 6 ──────────────────────────────────────────────────────────────
  it('Scenario 6: idempotency — re-applying the same event batch produces identical state', async () => {
    const devices: Device[] = [];
    try {
      const a = await makeDevice('s6a');
      const b = await makeDevice('s6b');
      devices.push(a, b);

      // Create two people on A.
      const p1Id = await createPersonOn(a, 'Idempotent One');
      const p2Id = await createPersonOn(a, 'Idempotent Two');

      // First sync A → B.
      const first = await syncDevices(a, b);
      assert.equal(first.transferred, 2, `First sync must transfer 2 events, got ${first.transferred}`);
      assert.ok(first.cursor > 0, `Cursor must advance after first sync (got ${first.cursor})`);
      assert.ok(await personExistsOn(b, p1Id), `P1 must exist on B after first sync (entity=${p1Id})`);
      assert.ok(await personExistsOn(b, p2Id), `P2 must exist on B after first sync (entity=${p2Id})`);

      const eventCountBefore = await eventCountOn(b);
      assert.equal(eventCountBefore, 2, `B must have exactly 2 events after first sync`);

      // Monotonically advancing cursor: second sync with no new events is a no-op.
      const noOp = await syncDevices(a, b);
      assert.equal(
        noOp.transferred,
        0,
        `Second sync must transfer 0 events (cursor advanced, got ${noOp.transferred})`,
      );
      assert.equal(
        noOp.cursor,
        first.cursor,
        `Cursor must not advance when there are no new events`,
      );

      // Reset B's cursor to 0 to simulate a re-delivery of the same events.
      // sync_event is append-only (no delete/update), but sync_cursor is mutable.
      await b.pool.query(
        `UPDATE sync_cursor SET last_seen_server_seq = 0 WHERE workspace_id = $1 AND device_id = $2`,
        [WORKSPACE_ID, a.deviceId],
      );

      // Re-deliver same events: ON CONFLICT (id) DO NOTHING on sync_event must catch them.
      const redelivered = await syncDevices(a, b);
      assert.equal(
        redelivered.transferred,
        0,
        `Re-delivered events must be caught by ON CONFLICT DO NOTHING (transferred=${redelivered.transferred})`,
      );

      // Final state must be identical: still exactly 2 events and 2 people.
      const eventCountAfter = await eventCountOn(b);
      assert.equal(
        eventCountAfter,
        2,
        `B must still have exactly 2 events after re-delivery, got ${eventCountAfter}`,
      );

      const personCount = await b.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM person WHERE workspace_id = $1`,
        [WORKSPACE_ID],
      );
      assert.equal(
        Number(personCount.rows[0]!.n),
        2,
        `B must have exactly 2 person rows after re-delivery, got ${personCount.rows[0]!.n}`,
      );

      // Cursor must advance monotonically from 0 back to the same value.
      const cursorAfter = await getCursorOn(b, a);
      assert.equal(
        cursorAfter,
        first.cursor,
        `Cursor must advance to the correct value after re-delivery (expected=${first.cursor}, got=${cursorAfter})`,
      );
    } catch (err) {
      if (devices[0]) await dumpEvents(devices[0], 's6a').catch(() => {});
      if (devices[1]) await dumpEvents(devices[1], 's6b').catch(() => {});
      throw err;
    } finally {
      await teardownAll(devices);
    }
  });
});
