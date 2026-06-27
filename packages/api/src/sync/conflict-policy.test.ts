/**
 * Contact-sync conflict-resolution policy (MIN-936).
 * Runs against rollomap_test (pretest / test:reset gives a clean, fully-migrated DB).
 *
 * Covers the documented policy (docs/sync-conflict-policy.md):
 *   - add/add        → union keeps both values;
 *   - update/update  → deterministic winner, loser preserved + flagged needs_review;
 *   - DETERMINISM    → conflicting assertions applied in BOTH orders converge identically;
 *   - delete/update  → tombstone beats a stale update, no resurrection;
 *   - merge/update   → an update to a merged-away source lands on the target via redirect;
 *   - source-vs-confirmed → a source value never overrides a user_confirmed value, both
 *                     queryable, needs_review only when nobody has confirmed.
 *
 * Plus pure-unit checks of the centralized selector + classification helpers.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { pool, WORKSPACE_ID } from '../db.js';
import { peopleRouter } from '../routes/people.js';
import { applyEvent } from './apply.js';
import { assertField } from './assertions.js';
import {
  resolveSingleValue,
  compareAssertions,
  isLowRiskField,
  isPrimaryPreservingField,
  isUnionField,
  resolutionFor,
  type AssertionLike,
} from './conflict-policy.js';

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

async function personColumn(id: string, col: string): Promise<unknown> {
  const r = await pool.query(`SELECT ${col} AS v FROM person WHERE id = $1`, [id]);
  return r.rows[0]?.v ?? null;
}

async function createPerson(name: string): Promise<string> {
  const create = await api('POST', '/api/people', { display_name: name });
  assert.equal(create.status, 201, 'person created');
  return create.json.person.id as string;
}

/** Build a field.asserted sync event for a person/field/value with given provenance. */
function assertedEvent(opts: {
  personId: string;
  field: string;
  value: unknown;
  assertionId?: string;
  deviceId?: string;
  confidence?: number;
  userConfirmed?: boolean;
  isPrimary?: boolean;
  createdAt?: string;
}) {
  return {
    id: crypto.randomUUID(),
    device_id: opts.deviceId ?? crypto.randomUUID(),
    entity_type: 'person',
    entity_id: opts.personId,
    operation: 'field.asserted',
    payload: {
      id: opts.assertionId ?? crypto.randomUUID(),
      workspace_id: WORKSPACE_ID,
      person_id: opts.personId,
      field_name: opts.field,
      field_value: opts.value,
      device_id: opts.deviceId ?? null,
      confidence: opts.confidence ?? 1.0,
      is_primary: opts.isPrimary ?? false,
      user_confirmed: opts.userConfirmed ?? false,
      created_at: opts.createdAt ?? new Date().toISOString(),
    },
  };
}

describe('conflict-policy: centralized selector (pure unit)', () => {
  it('classifies fields by the documented strategy', () => {
    assert.equal(resolutionFor('known_emails'), 'union');
    assert.equal(resolutionFor('company'), 'primary-preserving');
    assert.equal(resolutionFor('how_known'), 'lww');
    assert.equal(resolutionFor('user_pinned'), 'lww');
    assert.equal(resolutionFor('unknown_field'), undefined);

    assert.ok(isUnionField('aliases'));
    assert.ok(isPrimaryPreservingField('title'));
    assert.ok(isLowRiskField('how_known'));
    assert.ok(!isLowRiskField('company'), 'company is NOT low-risk');
  });

  it('user_confirmed beats higher confidence', () => {
    const rows: AssertionLike[] = [
      { id: 'a', field_value: 'Imported', confidence: 0.99, is_primary: false, user_confirmed: false, created_at: '2026-01-02T00:00:00Z' },
      { id: 'b', field_value: 'Manual', confidence: 0.5, is_primary: false, user_confirmed: true, created_at: '2026-01-01T00:00:00Z' },
    ];
    assert.equal(resolveSingleValue(rows)!.field_value, 'Manual');
  });

  it('the final tie-break is the assertion id (stable across devices)', () => {
    // Everything equal except id → smaller id wins deterministically.
    const base = { confidence: 0.7, is_primary: false, user_confirmed: false, created_at: '2026-01-01T00:00:00Z' };
    const x: AssertionLike = { id: '00000000-aaaa', field_value: 'X', ...base };
    const y: AssertionLike = { id: 'ffffffff-zzzz', field_value: 'Y', ...base };
    assert.equal(resolveSingleValue([x, y])!.field_value, 'X');
    assert.equal(resolveSingleValue([y, x])!.field_value, 'X', 'order-independent');
    assert.ok(compareAssertions(x, y) < 0);
  });
});

describe('conflict-policy: sync conflict scenarios (MIN-936)', () => {
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('add/add: two devices add different emails → union keeps both', async () => {
    const id = await createPerson('AddAdd Person');
    await assertField(pool, {
      personId: id, fieldName: 'known_emails', fieldValue: ['dev1@x.com'],
      deviceId: crypto.randomUUID(), userConfirmed: false, confidence: 0.8,
    });
    await assertField(pool, {
      personId: id, fieldName: 'known_emails', fieldValue: ['dev2@x.com'],
      deviceId: crypto.randomUUID(), userConfirmed: false, confidence: 0.8,
    });
    const emails = (await personColumn(id, 'known_emails')) as string[];
    assert.deepEqual([...emails].sort(), ['dev1@x.com', 'dev2@x.com'], 'union keeps both');
  });

  it('update/update: deterministic winner, loser preserved + flagged needs_review', async () => {
    const id = await createPerson('UpdateUpdate Person');
    await assertField(pool, {
      personId: id, fieldName: 'company', fieldValue: 'Acme Corp',
      deviceId: crypto.randomUUID(), userConfirmed: false, confidence: 0.9,
    });
    await assertField(pool, {
      personId: id, fieldName: 'company', fieldValue: 'Acme Inc',
      deviceId: crypto.randomUUID(), userConfirmed: false, confidence: 0.6,
    });

    // Higher-confidence value wins the canonical slot, loser NOT discarded.
    assert.equal(await personColumn(id, 'company'), 'Acme Corp', 'deterministic winner');

    const a = await api('GET', `/api/people/${id}/assertions`);
    const companies = (a.json.assertions as Array<Record<string, unknown>>)
      .filter((x) => x.field_name === 'company')
      .map((x) => x.field_value);
    assert.equal(companies.length, 2, 'both competing values preserved');
    assert.ok(companies.includes('Acme Inc'), 'loser still queryable');

    const conflicts = a.json.conflicts as Array<Record<string, unknown>>;
    const companyConflict = conflicts.find((c) => c.field_name === 'company');
    assert.ok(companyConflict, 'company surfaced as a conflict');
    assert.equal(companyConflict!.needs_review, true, 'flagged needs_review (no confirmed winner)');
    assert.equal(companyConflict!.has_user_confirmed_winner, false);
    assert.equal(companyConflict!.winner, 'Acme Corp');
    assert.equal((companyConflict!.competing as unknown[]).length, 2);
  });

  it('DETERMINISM: conflicting assertions converge identically in either apply order', async () => {
    // Two genuinely-concurrent claims equal in every rank key except id. Each
    // "device" (person row) receives the SAME logical conflict — the LOW-id
    // assertion always carries 'Value LOW' — but applies the two events in the
    // OPPOSITE order. Because the canonical winner is chosen by the id tie-break
    // at derive time (not insertion order), both must converge to 'Value LOW'.
    const sameTs = '2026-03-01T00:00:00.000Z';

    // Distinct id pairs per person (PK is global); low id → 'Value LOW' on both.
    const [loA, hiA] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    const [loB, hiB] = [crypto.randomUUID(), crypto.randomUUID()].sort();

    const p1 = await createPerson('Determinism One');
    const p2 = await createPerson('Determinism Two');

    const client = await pool.connect();
    try {
      // p1: LOW then HIGH
      await applyEvent(client, assertedEvent({ personId: p1, field: 'title', value: 'Value LOW', assertionId: loA, confidence: 0.7, createdAt: sameTs }));
      await applyEvent(client, assertedEvent({ personId: p1, field: 'title', value: 'Value HIGH', assertionId: hiA, confidence: 0.7, createdAt: sameTs }));
      // p2: HIGH then LOW (reverse apply order)
      await applyEvent(client, assertedEvent({ personId: p2, field: 'title', value: 'Value HIGH', assertionId: hiB, confidence: 0.7, createdAt: sameTs }));
      await applyEvent(client, assertedEvent({ personId: p2, field: 'title', value: 'Value LOW', assertionId: loB, confidence: 0.7, createdAt: sameTs }));
    } finally {
      client.release();
    }

    const c1 = await personColumn(p1, 'title');
    const c2 = await personColumn(p2, 'title');
    assert.equal(c1, c2, 'same canonical value regardless of apply order');
    assert.equal(c1, 'Value LOW', 'winner is the smaller-id assertion (stable tie-break)');
  });

  it('delete/update: tombstone beats a stale update — no resurrection', async () => {
    const id = await createPerson('DeleteUpdate Person');
    const client = await pool.connect();
    try {
      // Delete (tombstone).
      const del = await applyEvent(client, {
        id: crypto.randomUUID(), device_id: crypto.randomUUID(),
        entity_type: 'person', entity_id: id, operation: 'person.deleted',
        payload: { id },
      });
      assert.equal(del.applied, true, 'delete tombstones the person');

      // A stale update arrives AFTER the delete → must not resurrect.
      const upd = await applyEvent(client, {
        id: crypto.randomUUID(), device_id: crypto.randomUUID(),
        entity_type: 'person', entity_id: id, operation: 'person.updated',
        payload: { id, display_name: 'RESURRECTED' },
      });
      assert.equal(upd.applied, false, 'stale update is rejected');
      assert.match(String(upd.reason), /tombstone/i);
    } finally {
      client.release();
    }

    // Canonical name unchanged; person excluded from reads.
    assert.notEqual(await personColumn(id, 'display_name'), 'RESURRECTED');
    const get = await api('GET', `/api/people/${id}`);
    assert.equal(get.status, 404, 'tombstoned person not readable');
  });

  it('merge/update: an update to a merged-away source lands on the target', async () => {
    const source = await createPerson('Merge Source');
    const target = await createPerson('Merge Target');
    const client = await pool.connect();
    try {
      // Replay a merge source→target (tombstones source, records redirect).
      const merged = await applyEvent(client, {
        id: crypto.randomUUID(), device_id: crypto.randomUUID(),
        entity_type: 'person', entity_id: target, operation: 'person.merged',
        payload: { merge_id: crypto.randomUUID(), source_person_id: source, target_person_id: target },
      });
      assert.equal(merged.applied, true, 'merge applied');

      // An assertion about the (now merged-away) SOURCE must redirect onto target.
      const ev = await applyEvent(client, assertedEvent({
        personId: source, field: 'company', value: 'Redirected Co', userConfirmed: false, confidence: 0.9,
      }));
      assert.equal(ev.applied, true, 'field.asserted applied');
    } finally {
      client.release();
    }

    assert.equal(await personColumn(target, 'company'), 'Redirected Co', 'update landed on target');
    const rows = await pool.query(
      `SELECT person_id FROM person_field_assertion WHERE person_id = $1 AND field_name = 'company'`,
      [target],
    );
    assert.equal(rows.rowCount, 1, 'assertion stored under target, not the merged-away source');
  });

  it('source-vs-confirmed: a source value never overrides a confirmed one; surfaced only when appropriate', async () => {
    const id = await createPerson('SourceConfirmed Person');

    // User confirms a company (manual).
    await api('PATCH', `/api/people/${id}`, { company: 'Confirmed Co' });
    // A connector asserts a different company (source-backed, higher confidence even).
    await assertField(pool, {
      personId: id, fieldName: 'company', fieldValue: 'Source Co',
      sourceItemId: crypto.randomUUID(), userConfirmed: false, confidence: 0.99,
    });

    // Canonical stays the confirmed value despite the source's higher confidence.
    assert.equal(await personColumn(id, 'company'), 'Confirmed Co', 'confirmed value not overridden');

    const a = await api('GET', `/api/people/${id}/assertions`);
    const companies = (a.json.assertions as Array<Record<string, unknown>>)
      .filter((x) => x.field_name === 'company')
      .map((x) => x.field_value);
    assert.ok(companies.includes('Confirmed Co') && companies.includes('Source Co'), 'both queryable');

    // Distinct values disagree but a user confirmed one → NOT needs_review.
    const conflicts = a.json.conflicts as Array<Record<string, unknown>>;
    const companyConflict = conflicts.find((c) => c.field_name === 'company');
    assert.ok(companyConflict, 'still reported as a (resolved) conflict');
    assert.equal(companyConflict!.has_user_confirmed_winner, true);
    assert.equal(companyConflict!.needs_review, false, 'confirmed winner → not flagged for review');
    assert.equal(companyConflict!.winner, 'Confirmed Co');
  });
});
