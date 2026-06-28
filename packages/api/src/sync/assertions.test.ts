/**
 * Field-level contact assertions + provenance + canonical derivation (MIN-935).
 * Runs against rollomap_test (pretest / test:reset gives a clean, fully-migrated DB).
 *
 * Mounts the real peopleRouter on an ephemeral express server so PATCH /:id,
 * POST /, and GET /:id/assertions are exercised end-to-end, and drives the
 * apply + assertions service layer directly for the sync-replay cases.
 *
 * Covers:
 *   - PATCH company writes a user_confirmed assertion AND updates person.company;
 *   - a later SOURCE-backed (user_confirmed=false) assertion with a DIFFERENT company
 *     does NOT override the manual value (canonical stays manual), but BOTH are
 *     returned by GET /:id/assertions;
 *   - multi-value known_emails is the set-union of all live assertion values;
 *   - replaying the SAME field.asserted event twice is idempotent and converges
 *     canonical state.
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

describe('field-level contact assertions (MIN-935)', () => {
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  it('PATCH company writes a user_confirmed assertion AND updates person.company', async () => {
    const create = await api('POST', '/api/people', { display_name: 'Assert Person A' });
    assert.equal(create.status, 201);
    const id = create.json.person.id as string;

    const patch = await api('PATCH', `/api/people/${id}`, { company: 'Acme Corp' });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.person.company, 'Acme Corp', 'canonical column updated');
    assert.equal(await personColumn(id, 'company'), 'Acme Corp', 'derived canonical column persists');

    const a = await api('GET', `/api/people/${id}/assertions`);
    assert.equal(a.status, 200);
    const companyAssertions = (a.json.assertions as Array<Record<string, unknown>>).filter(
      (x) => x.field_name === 'company',
    );
    assert.equal(companyAssertions.length, 1, 'one company assertion written');
    assert.equal(companyAssertions[0]!.user_confirmed, true, 'manual edit is user_confirmed');
    assert.equal(companyAssertions[0]!.field_value, 'Acme Corp');
    assert.ok(companyAssertions[0]!.device_id, 'carries local device_id provenance');
  });

  it('a later source-backed assertion does NOT override the manual value but is preserved', async () => {
    const create = await api('POST', '/api/people', { display_name: 'Assert Person B' });
    const id = create.json.person.id as string;

    // Manual edit → user_confirmed company wins.
    await api('PATCH', `/api/people/${id}`, { company: 'Manual Co' });

    // A connector/import asserts a DIFFERENT company (source-backed, not confirmed).
    const sourceItemId = crypto.randomUUID();
    await assertField(pool, {
      personId: id,
      fieldName: 'company',
      fieldValue: 'Imported Co',
      sourceItemId,
      userConfirmed: false,
      confidence: 0.6,
    });

    // Canonical column STAYS the user's value (user_confirmed wins the selector).
    assert.equal(await personColumn(id, 'company'), 'Manual Co', 'manual value not clobbered');

    // BOTH competing values remain queryable for provenance.
    const a = await api('GET', `/api/people/${id}/assertions`);
    const companies = (a.json.assertions as Array<Record<string, unknown>>)
      .filter((x) => x.field_name === 'company')
      .map((x) => x.field_value);
    assert.equal(companies.length, 2, 'both assertions preserved');
    assert.ok(companies.includes('Manual Co'));
    assert.ok(companies.includes('Imported Co'));
  });

  it('multi-value known_emails is the set-union of all live assertion values', async () => {
    const create = await api('POST', '/api/people', { display_name: 'Assert Person C' });
    const id = create.json.person.id as string;

    await assertField(pool, {
      personId: id,
      fieldName: 'known_emails',
      fieldValue: ['a@example.com', 'b@example.com'],
      userConfirmed: false,
      confidence: 0.8,
    });
    await assertField(pool, {
      personId: id,
      fieldName: 'known_emails',
      fieldValue: ['b@example.com', 'c@example.com'],
      userConfirmed: false,
      confidence: 0.9,
    });

    const emails = (await personColumn(id, 'known_emails')) as string[];
    assert.deepEqual(
      [...emails].sort(),
      ['a@example.com', 'b@example.com', 'c@example.com'],
      'canonical known_emails is the de-duplicated union',
    );
  });

  it('replaying the SAME field.asserted event twice is idempotent and converges canonical state', async () => {
    const create = await api('POST', '/api/people', { display_name: 'Assert Person D' });
    const id = create.json.person.id as string;

    const assertionId = crypto.randomUUID();
    const event = {
      id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
      entity_type: 'person',
      entity_id: id,
      operation: 'field.asserted',
      payload: {
        id: assertionId,
        workspace_id: WORKSPACE_ID,
        person_id: id,
        field_name: 'title',
        field_value: 'Head of Widgets',
        confidence: 1.0,
        is_primary: false,
        user_confirmed: false,
        created_at: new Date().toISOString(),
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

    // Exactly one assertion row (ON CONFLICT id DO NOTHING) and canonical converged.
    const rows = await pool.query(
      `SELECT 1 FROM person_field_assertion WHERE id = $1`,
      [assertionId],
    );
    assert.equal(rows.rowCount, 1, 'exactly one assertion row after replay');
    assert.equal(await personColumn(id, 'title'), 'Head of Widgets', 'canonical title converged');
  });
});
