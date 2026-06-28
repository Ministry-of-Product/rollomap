/**
 * Contact group + snapshot sharing tests (MIN-938).
 * Runs against rollomap_test (pretest / test:reset gives a clean, fully-migrated DB).
 *
 * Covers:
 *   - Create group + list (member_count included).
 *   - Add members, delete a member.
 *   - Export bundle: default exclusions (summary, sensitivity != normal);
 *     custom exclude_fields; include_sensitive=true.
 *   - Import bundle: matched by primary_email (no duplicate), created for
 *     unknown email; assertions written with user_confirmed=false, confidence=0.8;
 *     provenance note + how_known stamped on created people.
 *   - Re-import same bundle: person matched, not duplicated.
 *   - 404 on export/members for unknown group.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { pool, WORKSPACE_ID } from '../db.js';
import { groupsRouter } from '../routes/groups.js';
import { peopleRouter } from '../routes/people.js';

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/groups', groupsRouter);
  app.use('/api/people', peopleRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
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

describe('contact group sharing (MIN-938)', () => {
  // ── group CRUD ────────────────────────────────────────────────────────────

  it('creates a group and lists it with member_count', async () => {
    const create = await api('POST', '/api/groups', { name: 'List Test Group' });
    assert.equal(create.status, 201);
    const groupId = create.json.group.id as string;
    assert.ok(groupId, 'group has id');
    assert.equal(create.json.group.name, 'List Test Group');

    const list = await api('GET', '/api/groups');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json.groups), 'groups is array');
    const found = (list.json.groups as Array<Record<string, unknown>>).find((g) => g.id === groupId);
    assert.ok(found, 'group appears in list');
    assert.equal(found.member_count, 0, 'empty group has member_count 0');
  });

  it('adds members to a group and reflects in member_count', async () => {
    const p1 = await api('POST', '/api/people', { display_name: 'Member Test Person 1' });
    const p2 = await api('POST', '/api/people', { display_name: 'Member Test Person 2' });
    const g  = await api('POST', '/api/groups', { name: 'Member Count Group' });
    const groupId = g.json.group.id as string;

    const addRes = await api('POST', `/api/groups/${groupId}/members`, {
      person_ids: [p1.json.person.id, p2.json.person.id],
    });
    assert.equal(addRes.status, 201);
    assert.equal(addRes.json.added.length, 2, '2 members added');

    const list = await api('GET', '/api/groups');
    const found = (list.json.groups as Array<Record<string, unknown>>).find((gg) => gg.id === groupId);
    assert.equal(found?.member_count, 2, 'member_count reflects additions');

    // Adding same person again is a no-op (ON CONFLICT DO NOTHING)
    const addAgain = await api('POST', `/api/groups/${groupId}/members`, {
      person_ids: [p1.json.person.id],
    });
    assert.equal(addAgain.status, 201);
    assert.equal(addAgain.json.added.length, 0, 'duplicate add is silently skipped');
  });

  it('removes a member from a group', async () => {
    const p = await api('POST', '/api/people', { display_name: 'Remove Test Person' });
    const g = await api('POST', '/api/groups', { name: 'Remove Member Group' });
    const personId = p.json.person.id as string;
    const groupId  = g.json.group.id as string;

    await api('POST', `/api/groups/${groupId}/members`, { person_ids: [personId] });

    const del = await api('DELETE', `/api/groups/${groupId}/members/${personId}`);
    assert.equal(del.status, 200);
    assert.equal(del.json.deleted, 1);

    const list = await api('GET', '/api/groups');
    const found = (list.json.groups as Array<Record<string, unknown>>).find((gg) => gg.id === groupId);
    assert.equal(found?.member_count, 0, 'member_count is 0 after removal');
  });

  it('returns 404 for export on unknown group', async () => {
    const res = await api('POST', '/api/groups/00000000-0000-0000-0000-000000000000/export', {});
    assert.equal(res.status, 404);
  });

  // ── bundle export ─────────────────────────────────────────────────────────

  it('export bundle excludes summary by default', async () => {
    const person = await api('POST', '/api/people', {
      display_name: 'Export Summary Test',
      primary_email: `export-summary-${Date.now()}@test.example`,
      company: 'Summary Corp',
      summary: 'Secret AI summary text',
    });
    assert.equal(person.status, 201);
    const personId = person.json.person.id as string;

    const g = await api('POST', '/api/groups', { name: 'Summary Export Group' });
    const groupId = g.json.group.id as string;
    await api('POST', `/api/groups/${groupId}/members`, { person_ids: [personId] });

    const exportRes = await api('POST', `/api/groups/${groupId}/export`, {});
    assert.equal(exportRes.status, 200);
    const bundle = exportRes.json;

    assert.equal(bundle.mode, 'snapshot', 'mode is snapshot');
    assert.equal(bundle.version, '1', 'version is 1');
    assert.ok(typeof bundle.shared_at === 'string', 'shared_at is set');
    assert.equal(bundle.people.length, 1, 'one person in bundle');

    const bp = bundle.people[0] as Record<string, unknown>;
    assert.equal((bp.fields as Record<string, unknown>).company, 'Summary Corp', 'company included');
    assert.ok(!Object.hasOwn(bp.fields as object, 'summary'), 'summary excluded by default');
  });

  it('export bundle excludes people with non-normal sensitivity by default', async () => {
    // Insert a sensitive person directly (PersonInput does not expose sensitivity_level)
    const sensitiveRes = await pool.query<{ id: string }>(
      `INSERT INTO person (workspace_id, display_name, primary_email, sensitivity_level)
       VALUES ($1, $2, $3, 'sensitive') RETURNING id`,
      [WORKSPACE_ID, 'Sensitive Person', `sensitive-${Date.now()}@test.example`],
    );
    const sensitiveId = sensitiveRes.rows[0]!.id;

    const normal = await api('POST', '/api/people', {
      display_name: 'Normal Sensitivity Person',
      primary_email: `normal-sensitivity-${Date.now()}@test.example`,
    });
    const normalId = normal.json.person.id as string;

    const g = await api('POST', '/api/groups', { name: 'Sensitivity Export Group' });
    const groupId = g.json.group.id as string;
    await api('POST', `/api/groups/${groupId}/members`, { person_ids: [sensitiveId, normalId] });

    // Default export: sensitive person excluded
    const def = await api('POST', `/api/groups/${groupId}/export`, {});
    assert.equal(def.json.people.length, 1, 'sensitive person excluded by default');
    assert.equal(
      (def.json.people[0] as Record<string, unknown>).external_id,
      normalId,
      'only the normal-sensitivity person is in the bundle',
    );

    // include_sensitive=true: both people included
    const inc = await api('POST', `/api/groups/${groupId}/export`, { include_sensitive: true });
    assert.equal(inc.json.people.length, 2, 'both people with include_sensitive=true');
  });

  it('export bundle honours custom exclude_fields', async () => {
    const person = await api('POST', '/api/people', {
      display_name: 'Exclude Fields Test',
      primary_email: `exclude-fields-${Date.now()}@test.example`,
      company: 'Excluded Corp',
      title: 'Engineer',
    });
    const personId = person.json.person.id as string;

    const g = await api('POST', '/api/groups', { name: 'Exclude Fields Group' });
    const groupId = g.json.group.id as string;
    await api('POST', `/api/groups/${groupId}/members`, { person_ids: [personId] });

    const exportRes = await api('POST', `/api/groups/${groupId}/export`, {
      exclude_fields: ['company', 'title'],
    });
    const fields = (exportRes.json.people[0] as Record<string, unknown>).fields as Record<string, unknown>;
    assert.ok(!Object.hasOwn(fields, 'company'), 'company excluded via exclude_fields');
    assert.ok(!Object.hasOwn(fields, 'title'), 'title excluded via exclude_fields');
    assert.ok(Object.hasOwn(fields, 'display_name'), 'display_name still included');
  });

  // ── bundle import ─────────────────────────────────────────────────────────

  it('import creates a new person with assertions (user_confirmed=false, confidence=0.8)', async () => {
    const email = `brand-new-import-${Date.now()}@test.example`;
    const bundle = {
      version: '1',
      mode: 'snapshot',
      shared_by: 'Alice',
      shared_at: new Date().toISOString(),
      source_workspace_id: '00000000-0000-0000-0000-000000000099',
      people: [{
        external_id: 'ext-001',
        fields: {
          display_name: 'Brand New Import Person',
          primary_email: email,
          company: 'Imported Corp',
        },
      }],
    };

    const importRes = await api('POST', '/api/groups/import', bundle);
    assert.equal(importRes.status, 200);
    assert.equal(importRes.json.created, 1, '1 person created');
    assert.equal(importRes.json.matched, 0, '0 matched');

    // Verify person exists with canonical company
    const personRow = await pool.query<Record<string, unknown>>(
      `SELECT * FROM person WHERE workspace_id = $1 AND lower(primary_email) = lower($2)`,
      [WORKSPACE_ID, email],
    );
    assert.equal(personRow.rowCount, 1, 'person created in DB');
    const p = personRow.rows[0]!;
    assert.equal(p.company, 'Imported Corp', 'canonical company derived from assertion');

    // Assertions are user_confirmed=false, confidence=0.8
    const assertionsRow = await pool.query<Record<string, unknown>>(
      `SELECT * FROM person_field_assertion WHERE person_id = $1 AND field_name = 'company'`,
      [p.id as string],
    );
    assert.ok(assertionsRow.rowCount! > 0, 'company assertion written');
    const companyAssertion = assertionsRow.rows[0]!;
    assert.equal(companyAssertion.user_confirmed, false, 'user_confirmed=false on import');
    assert.equal(Number(companyAssertion.confidence), 0.8, 'confidence=0.8 on import');

    // Provenance note written
    const noteRow = await pool.query<Record<string, unknown>>(
      `SELECT * FROM note WHERE person_id = $1 AND kind = 'note'`,
      [p.id as string],
    );
    assert.equal(noteRow.rowCount, 1, 'provenance note written');
    assert.ok((noteRow.rows[0]!.body as string).includes('Alice'), 'note body mentions sharer');
    assert.ok(
      (noteRow.rows[0]!.body as string).includes('00000000-0000-0000-0000-000000000099'),
      'note body includes source_workspace_id',
    );

    // how_known stamped with provenance label
    assert.ok(
      (p.how_known as string | null)?.includes('Alice'),
      'how_known carries import provenance',
    );
  });

  it('import matches existing person by primary_email and does not duplicate', async () => {
    const email = `import-match-${Date.now()}@test.example`;
    const existing = await api('POST', '/api/people', {
      display_name: 'Import Match Person',
      primary_email: email,
      company: 'Original Corp',
    });
    assert.equal(existing.status, 201);

    const bundle = {
      version: '1',
      mode: 'snapshot',
      shared_by: 'Bob',
      shared_at: new Date().toISOString(),
      source_workspace_id: '00000000-0000-0000-0000-000000000088',
      people: [{
        fields: {
          display_name: 'Import Match Person',
          primary_email: email,
          company: 'Updated Corp',
        },
      }],
    };

    const importRes = await api('POST', '/api/groups/import', bundle);
    assert.equal(importRes.json.matched, 1, 'existing person matched');
    assert.equal(importRes.json.created, 0, 'no new person created');

    // Only one person with this email exists
    const countRow = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM person WHERE workspace_id = $1 AND lower(primary_email) = lower($2)`,
      [WORKSPACE_ID, email],
    );
    assert.equal(Number(countRow.rows[0]!.c), 1, 'no duplicate person');

    // No provenance note was written for matched people
    const existingPerson = existing.json.person as Record<string, unknown>;
    const noteRow = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM note WHERE person_id = $1 AND kind = 'note'`,
      [existingPerson.id as string],
    );
    assert.equal(Number(noteRow.rows[0]!.c), 0, 'no provenance note for matched person');
  });

  it('re-importing the same bundle does not create a duplicate person', async () => {
    const email = `reimport-${Date.now()}@test.example`;
    const bundle = {
      version: '1',
      mode: 'snapshot',
      shared_by: 'Carol',
      shared_at: new Date().toISOString(),
      source_workspace_id: '00000000-0000-0000-0000-000000000077',
      people: [{
        fields: {
          display_name: 'Reimport Test Person',
          primary_email: email,
          company: 'Reimport Corp',
        },
      }],
    };

    const first = await api('POST', '/api/groups/import', bundle);
    assert.equal(first.json.created, 1, 'first import creates person');

    const second = await api('POST', '/api/groups/import', bundle);
    assert.equal(second.json.created, 0, 'second import does not create duplicate');
    assert.equal(second.json.matched, 1, 'second import matches existing person');

    // Count
    const countRow = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM person WHERE workspace_id = $1 AND lower(primary_email) = lower($2)`,
      [WORKSPACE_ID, email],
    );
    assert.equal(Number(countRow.rows[0]!.c), 1, 'exactly one person with that email');
  });

  it('import writes a group.imported sync event', async () => {
    const bundle = {
      version: '1',
      mode: 'snapshot',
      shared_by: 'Dave',
      shared_at: new Date().toISOString(),
      source_workspace_id: '00000000-0000-0000-0000-000000000066',
      people: [{
        fields: {
          display_name: `Event Test Person ${Date.now()}`,
          primary_email: `event-test-${Date.now()}@test.example`,
        },
      }],
    };

    await api('POST', '/api/groups/import', bundle);

    const eventRow = await pool.query<Record<string, unknown>>(
      `SELECT * FROM sync_event
        WHERE operation = 'group.imported'
          AND workspace_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [WORKSPACE_ID],
    );
    assert.ok(eventRow.rowCount! > 0, 'group.imported event was recorded');
    const payload = eventRow.rows[0]!.payload as Record<string, unknown>;
    assert.equal(payload.shared_by, 'Dave', 'event payload carries shared_by');
  });

  it('group.created sync event is recorded on group creation', async () => {
    const create = await api('POST', '/api/groups', { name: 'Event Group' });
    const groupId = create.json.group.id as string;

    const eventRow = await pool.query<Record<string, unknown>>(
      `SELECT * FROM sync_event WHERE entity_id = $1 AND operation = 'group.created'`,
      [groupId],
    );
    assert.equal(eventRow.rowCount, 1, 'one group.created event');
  });

  it('group.member_added sync event is recorded when adding members', async () => {
    const p = await api('POST', '/api/people', { display_name: 'Event Member Person' });
    const g = await api('POST', '/api/groups', { name: 'Event Member Group' });
    const groupId = g.json.group.id as string;
    const personId = p.json.person.id as string;

    await api('POST', `/api/groups/${groupId}/members`, { person_ids: [personId] });

    const eventRow = await pool.query<Record<string, unknown>>(
      `SELECT * FROM sync_event WHERE entity_id = $1 AND operation = 'group.member_added'`,
      [groupId],
    );
    assert.equal(eventRow.rowCount, 1, 'one group.member_added event');
    const payload = eventRow.rows[0]!.payload as Record<string, unknown>;
    assert.equal(payload.person_id, personId, 'event payload carries person_id');
  });
});
