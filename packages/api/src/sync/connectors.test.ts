/**
 * Source connector lifecycle tests (MIN-937).
 * Runs against rollomap_test (pretest / test:reset gives a clean, fully-migrated DB).
 *
 * Mounts sourcesRouter on an ephemeral express app and drives connector helpers
 * both directly and through the HTTP API.
 *
 * Covers:
 *   - GET /connections lists connections with counts
 *   - POST /connections creates a connection; emits connection.created
 *   - pause → import blocked (409)
 *   - resume → import unblocked
 *   - disconnect → import blocked; resume rejected (409)
 *   - resync stubs last_sync_at; rejected when paused
 *   - invalid transitions return 409
 *   - remove-data: deletes source_items + source-backed assertions; KEEPS
 *     user_confirmed=true assertion; re-derives canonical (manual value survives)
 *   - lifecycle transitions emit sync events
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { pool, WORKSPACE_ID } from '../db.js';
import { sourcesRouter } from '../routes/sources.js';
import { assertField } from './assertions.js';
import { withSyncTxn } from './events.js';

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sources', sourcesRouter);
  // minimal error handler so we can inspect status codes
  app.use(
    (
      err: Error & { statusCode?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.statusCode ?? 500).json({ error: err.message });
    },
  );
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createConnection(provider = 'test-provider') {
  const r = await api('POST', '/api/sources/connections', { provider });
  assert.equal(r.status, 201, `create connection: ${JSON.stringify(r.json)}`);
  return r.json.connection as { id: string; status: string };
}

async function createPerson(displayName: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO person (workspace_id, display_name) VALUES ($1, $2) RETURNING id`,
    [WORKSPACE_ID, displayName],
  );
  return r.rows[0]!.id;
}

async function getPersonColumn(personId: string, col: string): Promise<unknown> {
  const r = await pool.query(`SELECT ${col} AS v FROM person WHERE id = $1`, [personId]);
  return r.rows[0]?.v ?? null;
}

async function countSyncEvents(entityId: string, operation: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*) AS n FROM sync_event WHERE entity_id = $1 AND operation = $2`,
    [entityId, operation],
  );
  return Number(r.rows[0]!.n);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('source connector lifecycle (MIN-937)', () => {
  it('GET /connections lists existing connections', async () => {
    const r = await api('GET', '/api/sources/connections');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.connections), 'returns connections array');
    // There should be at least the default manual connection from the seed.
    const manual = (r.json.connections as Array<Record<string, unknown>>).find(
      (c) => c.provider === 'manual',
    );
    assert.ok(manual, 'default manual connection present');
    assert.ok('source_item_count' in manual, 'includes source_item_count');
    assert.ok('source_assertion_count' in manual, 'includes source_assertion_count');
  });

  it('POST /connections creates a connection with status active and emits connection.created', async () => {
    const conn = await createConnection('linkedin');
    assert.equal(conn.status, 'active');

    const events = await countSyncEvents(conn.id, 'connection.created');
    assert.equal(events, 1, 'one connection.created event emitted');
  });

  it('pause sets status to paused and emits connection.paused', async () => {
    const conn = await createConnection('google-contacts');

    const pause = await api('POST', `/api/sources/connections/${conn.id}/pause`);
    assert.equal(pause.status, 200, `pause: ${JSON.stringify(pause.json)}`);
    assert.equal(pause.json.connection.status, 'paused');

    const events = await countSyncEvents(conn.id, 'connection.paused');
    assert.equal(events, 1, 'one connection.paused event emitted');
  });

  it('a paused connection blocks POST /import with 409', async () => {
    const conn = await createConnection('blocked-provider');
    await api('POST', `/api/sources/connections/${conn.id}/pause`);

    const importR = await api('POST', '/api/sources/import', {
      connection_id: conn.id,
      items: [{ source_type: 'note', provider: 'test' }],
    });
    assert.equal(importR.status, 409, `import should be blocked: ${JSON.stringify(importR.json)}`);
    assert.ok(
      (importR.json as { error: string }).error.includes('paused'),
      'error mentions paused',
    );
  });

  it('resume transitions paused → active and unblocks import', async () => {
    const conn = await createConnection('resumable');
    await api('POST', `/api/sources/connections/${conn.id}/pause`);

    const resume = await api('POST', `/api/sources/connections/${conn.id}/resume`);
    assert.equal(resume.status, 200);
    assert.equal(resume.json.connection.status, 'active');

    const events = await countSyncEvents(conn.id, 'connection.resumed');
    assert.equal(events, 1, 'one connection.resumed event emitted');

    // Import should now succeed.
    const importR = await api('POST', '/api/sources/import', {
      connection_id: conn.id,
      items: [{ source_type: 'note', provider: 'test' }],
    });
    assert.equal(importR.status, 201, `import after resume: ${JSON.stringify(importR.json)}`);
  });

  it('disconnect transitions to disconnected and emits connection.disconnected', async () => {
    const conn = await createConnection('to-disconnect');

    const disconn = await api('POST', `/api/sources/connections/${conn.id}/disconnect`);
    assert.equal(disconn.status, 200);
    assert.equal(disconn.json.connection.status, 'disconnected');

    const events = await countSyncEvents(conn.id, 'connection.disconnected');
    assert.equal(events, 1, 'one connection.disconnected event emitted');
  });

  it('a disconnected connection blocks POST /import with 409', async () => {
    const conn = await createConnection('disconnected-provider');
    await api('POST', `/api/sources/connections/${conn.id}/disconnect`);

    const importR = await api('POST', '/api/sources/import', {
      connection_id: conn.id,
      items: [{ source_type: 'note', provider: 'test' }],
    });
    assert.equal(importR.status, 409);
    assert.ok(
      (importR.json as { error: string }).error.includes('disconnected'),
      'error mentions disconnected',
    );
  });

  it('resume on a disconnected connection returns 409 (invalid transition)', async () => {
    const conn = await createConnection('cant-resume');
    await api('POST', `/api/sources/connections/${conn.id}/disconnect`);

    const resume = await api('POST', `/api/sources/connections/${conn.id}/resume`);
    assert.equal(resume.status, 409, 'resuming a disconnected connection must fail');
  });

  it('pause on an already-paused connection returns 409 (invalid transition)', async () => {
    const conn = await createConnection('double-pause');
    await api('POST', `/api/sources/connections/${conn.id}/pause`);

    const pause2 = await api('POST', `/api/sources/connections/${conn.id}/pause`);
    assert.equal(pause2.status, 409, 'pausing an already-paused connection must fail');
  });

  it('disconnect on an already-disconnected connection returns 409', async () => {
    const conn = await createConnection('double-disconnect');
    await api('POST', `/api/sources/connections/${conn.id}/disconnect`);

    const disc2 = await api('POST', `/api/sources/connections/${conn.id}/disconnect`);
    assert.equal(disc2.status, 409, 'disconnecting twice must fail');
  });

  it('resync stubs last_sync_at and last_sync_status; rejected when paused', async () => {
    const conn = await createConnection('resyncer');

    const resync = await api('POST', `/api/sources/connections/${conn.id}/resync`);
    assert.equal(resync.status, 200);
    assert.equal(resync.json.connection.last_sync_status, 'ok');
    assert.ok(resync.json.connection.last_sync_at, 'last_sync_at was stamped');

    // Pause then try resync.
    await api('POST', `/api/sources/connections/${conn.id}/pause`);
    const badResync = await api('POST', `/api/sources/connections/${conn.id}/resync`);
    assert.equal(badResync.status, 409, 'resync on paused connection must fail');
  });

  it('remove-data deletes source items + source-backed assertions but preserves user_confirmed assertion and re-derives canonical', async () => {
    // 1. Create a connection.
    const conn = await createConnection('cleanup-test');

    // 2. Create a person and assert two competing company values:
    //    - one source-backed (from the connection) → should be deleted
    //    - one user_confirmed (manual) → must survive
    const personId = await createPerson('Cleanup Person');

    // Insert a source_item tied to this connection.
    const siR = await pool.query<{ id: string }>(
      `INSERT INTO source_item (workspace_id, provider, source_type, source_connection_id)
       VALUES ($1, 'cleanup-test', 'note', $2) RETURNING id`,
      [WORKSPACE_ID, conn.id],
    );
    const sourceItemId = siR.rows[0]!.id;

    // Source-backed assertion (user_confirmed=false, source_connection_id = conn.id).
    await withSyncTxn((client) =>
      assertField(client, {
        personId,
        fieldName: 'company',
        fieldValue: 'Source Corp',
        sourceItemId,
        sourceConnectionId: conn.id,
        userConfirmed: false,
        confidence: 0.7,
      }),
    );

    // Manual assertion (user_confirmed=true) — the one that must survive.
    await withSyncTxn((client) =>
      assertField(client, {
        personId,
        fieldName: 'company',
        fieldValue: 'Manual Corp',
        userConfirmed: true,
        confidence: 1.0,
      }),
    );

    // Canonical company should be 'Manual Corp' (user_confirmed wins the selector).
    const beforeCompany = await getPersonColumn(personId, 'company');
    assert.equal(beforeCompany, 'Manual Corp', 'manual value is canonical before removal');

    // 3. Call remove-data.
    const rm = await api('POST', `/api/sources/connections/${conn.id}/remove-data`);
    assert.equal(rm.status, 200, `remove-data: ${JSON.stringify(rm.json)}`);

    const result = rm.json as {
      source_items_removed: number;
      assertions_removed: number;
      persons_reprocessed: number;
    };
    assert.equal(result.source_items_removed, 1, '1 source_item deleted');
    assert.equal(result.assertions_removed, 1, '1 source-backed assertion deleted');
    assert.equal(result.persons_reprocessed, 1, '1 person re-derived');

    // 4. Verify: source_item is gone.
    const siCheck = await pool.query(
      `SELECT 1 FROM source_item WHERE id = $1`,
      [sourceItemId],
    );
    assert.equal(siCheck.rowCount, 0, 'source_item deleted');

    // 5. Verify: user_confirmed=true assertion still exists.
    const assertionCheck = await pool.query(
      `SELECT count(*) AS n FROM person_field_assertion
        WHERE person_id = $1 AND field_name = 'company' AND user_confirmed = true`,
      [personId],
    );
    assert.equal(Number(assertionCheck.rows[0]!.n), 1, 'manual assertion preserved');

    // 6. Verify: source-backed assertion is gone.
    const sourceAssertionCheck = await pool.query(
      `SELECT count(*) AS n FROM person_field_assertion
        WHERE person_id = $1 AND field_name = 'company' AND user_confirmed = false`,
      [personId],
    );
    assert.equal(Number(sourceAssertionCheck.rows[0]!.n), 0, 'source assertion deleted');

    // 7. Verify: canonical company is still 'Manual Corp' (re-derived from manual assertion).
    const afterCompany = await getPersonColumn(personId, 'company');
    assert.equal(afterCompany, 'Manual Corp', 'canonical value fell back to manual after removal');

    // 8. Verify: person row still exists.
    const personCheck = await pool.query(`SELECT 1 FROM person WHERE id = $1`, [personId]);
    assert.equal(personCheck.rowCount, 1, 'person row preserved');

    // 9. Verify: source.removed event emitted.
    const removeEvents = await countSyncEvents(conn.id, 'source.removed');
    assert.equal(removeEvents, 1, 'source.removed event emitted');
  });
});
