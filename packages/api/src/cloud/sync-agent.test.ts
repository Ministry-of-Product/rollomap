/**
 * Tests for the client→Cloud sync agent (MIN-973).
 *
 * Two layers:
 *   1. Cursor logic against an in-process STUB sync server (deterministic, no
 *      network): push advances past unpushable ops, pull acks the max applied
 *      seq and advances monotonically + paged, idempotent re-run is a no-op,
 *      unpaired client is a no-op.
 *   2. A LIVE :8080 round-trip proving convergence: device A pushes a seeded
 *      person to RolloMap Cloud; device B pulls + applies it into the same
 *      throwaway DB after the local row is deleted (simulating a fresh peer).
 *      Skipped gracefully if :8080 is unreachable.
 *
 * Runs against rollomap_test (pretest/reset-test-db.sh applies migration 013).
 */

// MUST be first — pins this process to a dedicated workspace BEFORE ../db.js
// loads, isolating the sync-agent singleton rows from parallel test files.
import './_test-workspace-env.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { pool, WORKSPACE_ID } from '../db.js';
import { recordEvent } from '../sync/events.js';
import { setCloudConfig, clearCloudConfig } from './config.js';
import {
  pushOnce,
  pullOnce,
  syncOnce,
  getCloudSyncState,
  setLastPushedLocalSeq,
  setRemotePullCursor,
} from './sync-agent.js';

// Create this process's dedicated workspace once, before any suite runs.
before(async () => {
  await pool.query(
    `INSERT INTO workspace (id, name) VALUES ($1, 'min973-sync-agent-test')
     ON CONFLICT (id) DO NOTHING`,
    [WORKSPACE_ID],
  );
});

after(async () => { await pool.end(); });

async function resetCloudState(): Promise<void> {
  await pool.query('DELETE FROM cloud_sync_state WHERE workspace_id = $1', [WORKSPACE_ID]);
  await clearCloudConfig();
}

async function maxLocalSeq(): Promise<number> {
  const { rows } = await pool.query<{ m: string }>(
    'SELECT COALESCE(MAX(server_seq), 0) AS m FROM sync_event',
  );
  return Number(rows[0]!.m);
}

async function seqOf(eventId: string): Promise<number> {
  const { rows } = await pool.query<{ server_seq: string }>(
    'SELECT server_seq FROM sync_event WHERE id = $1',
    [eventId],
  );
  return Number(rows[0]!.server_seq);
}

function uuid(): string {
  return crypto.randomUUID();
}

// ─── In-process stub sync server ──────────────────────────────────────────────

interface StubPullPage {
  events: Array<Record<string, unknown>>;
  has_more: boolean;
}

interface StubState {
  pushBatches: Array<Array<Record<string, unknown>>>;
  acks: number[];
  pullSince: string[];
  pullPages: StubPullPage[];
  headServerSeq: number;
}

function makeStub(state: StubState): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://stub');
      const send = (obj: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname === '/sync/push') {
        const events = (JSON.parse(body).events ?? []) as Array<Record<string, unknown>>;
        state.pushBatches.push(events);
        const results = events.map((e) => ({
          id: e.id,
          server_seq: ++state.headServerSeq,
          status: 'applied' as const,
        }));
        send({ results, head_server_seq: state.headServerSeq });
      } else if (url.pathname === '/sync/pull') {
        state.pullSince.push(url.searchParams.get('since') ?? '');
        const page = state.pullPages.shift() ?? { events: [], has_more: false };
        send({
          events: page.events,
          head_server_seq: state.headServerSeq,
          has_more: page.has_more,
        });
      } else if (url.pathname === '/sync/ack') {
        const seq = Number(JSON.parse(body).server_seq);
        state.acks.push(seq);
        send({ last_acked_server_seq: seq });
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function wirePullEvent(serverSeq: number): Record<string, unknown> {
  const id = uuid();
  const personId = uuid();
  return {
    id,
    server_seq: serverSeq,
    entity_type: 'person',
    entity_id: personId,
    op: 'person.created',
    payload: { id: personId, display_name: `Peer ${serverSeq}` },
    logical_clock: serverSeq,
    device_id: uuid(),
    created_at: new Date().toISOString(),
  };
}

// ─── PUSH cursor logic ────────────────────────────────────────────────────────

// NOTE: test files run in parallel against the shared rollomap_test DB, so other
// suites write sync_event rows concurrently. These tests therefore assert only on
// THEIR OWN event ids and use monotonic (>=) cursor checks — never exact global
// counts — so concurrent noise can't make them flaky.
describe('sync-agent push', () => {
  let server: http.Server;
  let state: StubState;
  let pushablePersonEventId = '';

  function sentIds(): string[] {
    return state.pushBatches.flat().map((e) => String(e.id));
  }

  before(async () => {
    state = { pushBatches: [], acks: [], pullSince: [], pullPages: [], headServerSeq: 0 };
    server = makeStub(state);
    const port = await listen(server);
    await resetCloudState();
    await setCloudConfig({ syncServerUrl: `http://127.0.0.1:${port}`, deviceToken: 'stub-tok' });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await resetCloudState();
  });

  it('skips local-only ops but ADVANCES the cursor past them (no stall)', async () => {
    await setLastPushedLocalSeq(await maxLocalSeq());
    // Two local-only ops — neither is pushable.
    const e1 = await recordEvent(pool, { entityType: 'contact_group', entityId: uuid(), operation: 'group.created', payload: { id: uuid() } });
    const e2 = await recordEvent(pool, { entityType: 'source_connection', entityId: uuid(), operation: 'connection.created', payload: { id: uuid() } });
    const mySeq = await seqOf(e2.id);

    const r = await pushOnce();

    assert.equal(r.paired, true);
    assert.ok(r.skipped >= 2, 'my two local-only ops were skipped');
    // The cursor advanced PAST my unpushable ops — proves no stall.
    assert.ok(r.lastPushedLocalSeq >= mySeq, 'cursor advanced past the unpushable ops');
    // My local-only ops were never put on the wire.
    const sent = new Set(sentIds());
    assert.ok(!sent.has(e1.id) && !sent.has(e2.id), 'local-only ops are never pushed');
  });

  it('pushes pushable ops (mapped via wire.ts, no device_id), advances cursor', async () => {
    await setLastPushedLocalSeq(await maxLocalSeq());
    const personId = uuid();
    const ev = await recordEvent(pool, {
      entityType: 'person',
      entityId: personId,
      operation: 'person.created',
      payload: { id: personId, display_name: 'Pushable Person' },
    });
    pushablePersonEventId = ev.id;
    const mySeq = await seqOf(ev.id);

    const r = await pushOnce();

    const sent = state.pushBatches.flat().find((e) => e.id === ev.id);
    assert.ok(sent, 'my pushable event was POSTed to /sync/push');
    assert.equal(sent!.op, 'person.created', 'mapped to wire op via wire.ts');
    assert.equal(sent!.device_id, undefined, 'no device_id on the wire');
    assert.ok(r.applied >= 1, 'server reported it applied');
    assert.ok(r.lastPushedLocalSeq >= mySeq, 'cursor advanced past my event');
  });

  it('idempotent — an already-pushed event is never re-sent, and no id is pushed twice', async () => {
    const before = sentIds().filter((id) => id === pushablePersonEventId).length;
    assert.equal(before, 1, 'event was pushed exactly once so far');
    await pushOnce(); // nothing new of ours
    const after = sentIds().filter((id) => id === pushablePersonEventId).length;
    assert.equal(after, 1, 're-running push does not re-send the event');
    // Cursor idempotency: no event id appears in more than one push envelope.
    const ids = sentIds();
    assert.equal(new Set(ids).size, ids.length, 'no event pushed twice');
  });
});

// ─── PULL cursor logic ────────────────────────────────────────────────────────

describe('sync-agent pull', () => {
  let server: http.Server;
  let state: StubState;

  before(async () => {
    state = { pushBatches: [], acks: [], pullSince: [], pullPages: [], headServerSeq: 100 };
    server = makeStub(state);
    const port = await listen(server);
    await resetCloudState();
    await setCloudConfig({ syncServerUrl: `http://127.0.0.1:${port}`, deviceToken: 'stub-tok' });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await resetCloudState();
  });

  it('applies paged events, acks max applied seq, advances cursor monotonically', async () => {
    state.pullPages = [
      { events: [wirePullEvent(10), wirePullEvent(11)], has_more: true },
      { events: [wirePullEvent(12)], has_more: false },
    ];

    const r = await pullOnce();

    assert.equal(r.pulled, 3, 'all three events received across two pages');
    assert.equal(r.applied, 3, 'all applied via applyEvent');
    assert.deepEqual(state.acks, [11, 12], 'acked max(server_seq) per page, monotonic');
    assert.deepEqual(state.pullSince, ['0', '11'], 'paged with since=last cursor');
    const st = await getCloudSyncState();
    assert.equal(st.remotePullCursor, 12, 'remote cursor advanced to last applied seq');
  });

  it('cursor never moves backward (GREATEST)', async () => {
    const after2 = await setRemotePullCursor(5); // below current 12
    assert.equal(after2, 12, 'lower value ignored — monotonic');
  });
});

// ─── Not-paired no-op ─────────────────────────────────────────────────────────

describe('sync-agent unpaired', () => {
  before(async () => { await resetCloudState(); });
  after(async () => { await resetCloudState(); });

  it('pushOnce / pullOnce / syncOnce are no-ops when not paired', async () => {
    const push = await pushOnce();
    const pull = await pullOnce();
    const sync = await syncOnce();
    assert.equal(push.paired, false);
    assert.equal(pull.paired, false);
    assert.equal(sync.paired, false);
  });
});

// ─── Live :8080 convergence round-trip ────────────────────────────────────────

describe('sync-agent live convergence (:8080)', () => {
  before(async () => { await resetCloudState(); });
  after(async () => { await resetCloudState(); });

  async function mintToken(name: string): Promise<string | null> {
    const login = await fetch('http://localhost:8080/auth/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dev@example.com' }),
    });
    if (!login.ok) return null;
    const cookie = login.headers.get('set-cookie') ?? '';
    const dev = await fetch('http://localhost:8080/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name }),
    });
    if (dev.status !== 201) return null;
    return ((await dev.json()) as { token: string }).token;
  }

  it('device A pushes a person; device B pulls + applies it (no loss)', async () => {
    let tokenA: string | null;
    let tokenB: string | null;
    try {
      tokenA = await mintToken(`min973-A-${Date.now()}`);
      tokenB = await mintToken(`min973-B-${Date.now()}`);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        console.warn('  [skip] localhost:8080 not reachable — live convergence test skipped');
        return;
      }
      throw err;
    }
    if (!tokenA || !tokenB) {
      console.warn('  [skip] could not mint device tokens — live convergence test skipped');
      return;
    }

    // ── Device A: pair, find current head, seed + push ──
    await setCloudConfig({ syncServerUrl: 'http://localhost:8080', deviceToken: tokenA });
    const headRes = await fetch('http://localhost:8080/sync/pull?since=0&limit=1', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const headBefore = ((await headRes.json()) as { head_server_seq: number }).head_server_seq;

    await setLastPushedLocalSeq(await maxLocalSeq()); // only push what we seed next
    const personId = uuid();
    const displayName = `MIN973 Converge ${personId.slice(0, 8)}`;
    await recordEvent(pool, {
      entityType: 'person',
      entityId: personId,
      operation: 'person.created',
      payload: { id: personId, display_name: displayName },
    });

    const pushRes = await pushOnce();
    assert.equal(pushRes.authError, undefined, 'no auth error on push');
    assert.ok(pushRes.applied >= 1, `expected >=1 applied, got ${pushRes.applied}`);
    assert.ok(
      (pushRes.headServerSeq ?? 0) > headBefore,
      'server head advanced past pre-push head',
    );

    // ── Simulate a fresh peer: delete the local row, switch to device B's token,
    //    point B's pull cursor at headBefore so it pulls A's just-pushed events. ──
    await pool.query('DELETE FROM person WHERE id = $1', [personId]);
    const gone = await pool.query('SELECT 1 FROM person WHERE id = $1', [personId]);
    assert.equal(gone.rowCount, 0, 'person removed locally before pull');

    await setCloudConfig({ syncServerUrl: 'http://localhost:8080', deviceToken: tokenB });
    await setRemotePullCursor(headBefore);

    const pullRes = await pullOnce();
    assert.equal(pullRes.authError, undefined, 'no auth error on pull');
    assert.ok(pullRes.applied >= 1, `expected >=1 applied on pull, got ${pullRes.applied}`);

    // ── Convergence: the person A pushed is now present locally (came from cloud). ──
    const back = await pool.query<{ display_name: string }>(
      'SELECT display_name FROM person WHERE id = $1',
      [personId],
    );
    assert.equal(back.rowCount, 1, 'person re-materialized from cloud pull');
    assert.equal(back.rows[0]!.display_name, displayName, 'no data loss in round-trip');
  });
});
