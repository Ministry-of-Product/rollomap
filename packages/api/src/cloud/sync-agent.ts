/**
 * Client→Cloud sync agent (MIN-973): push / pull / ack.
 *
 * Composes the three layers already built:
 *   - wire.ts  (MIN-972): toWireEnvelope / fromWireEvent / isPushable — the ONLY
 *     place local↔wire op/entity mapping lives. We never re-implement it here.
 *   - cloud/client.ts (MIN-974): cloudFetch — prefixes the sync server URL,
 *     attaches the Bearer token, throws CloudAuthError on 401/403 and
 *     CloudNotConfiguredError when unpaired. We never re-implement auth.
 *   - sync/apply.ts: applyEvent — replays a remote event's canonical effect
 *     IDEMPOTENTLY and WITHOUT calling recordEvent, so applied remote events do
 *     NOT re-enter the local sync_event log (the anti-echo guarantee). We never
 *     call recordEvent for pulled events.
 *
 * ── Cursor model (two independent, locally-stored high-water marks) ───────────
 *   cloud_sync_state (migration 013), keyed by workspace:
 *     last_pushed_local_seq — max LOCAL sync_event.server_seq already pushed.
 *     remote_pull_cursor    — cloud server_seq pulled + applied + acked.
 *   Both monotonic; both safe to re-run after a crash (push dedups server-side
 *   on event.id, applyEvent is idempotent).
 *
 * ── Ordering ─────────────────────────────────────────────────────────────────
 *   syncOnce() pushes BEFORE it pulls, so our newest local state is on the server
 *   before we ingest peers. The two directions are cursor-tracked independently.
 */

import { pool, WORKSPACE_ID } from '../db.js';
import {
  toWireEnvelope,
  fromWireEvent,
  isPushable,
  type WireEnvelope,
  type WirePullEvent,
} from '../sync/wire.js';
import { applyEvent } from '../sync/apply.js';
import { cloudFetch, CloudAuthError, CloudNotConfiguredError } from './client.js';

/** Max events per push batch (protocol caps /sync/push at 1000). */
export const PUSH_BATCH_LIMIT = 1000;
/** Page size for pull (protocol caps /sync/pull?limit at 1000). */
export const PULL_PAGE_LIMIT = 500;

// ─── Cursor store (cloud_sync_state, migration 013) ───────────────────────────

export interface CloudSyncState {
  lastPushedLocalSeq: number;
  remotePullCursor: number;
}

/** Read the workspace's cloud sync cursors, bootstrapping a zeroed row if absent. */
export async function getCloudSyncState(): Promise<CloudSyncState> {
  const { rows } = await pool.query<{
    last_pushed_local_seq: string;
    remote_pull_cursor: string;
  }>(
    `INSERT INTO cloud_sync_state (workspace_id)
     VALUES ($1)
     ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
     RETURNING last_pushed_local_seq, remote_pull_cursor`,
    [WORKSPACE_ID],
  );
  const row = rows[0]!;
  return {
    lastPushedLocalSeq: Number(row.last_pushed_local_seq),
    remotePullCursor: Number(row.remote_pull_cursor),
  };
}

/** Advance the push cursor (monotonic — never moves backward). */
export async function setLastPushedLocalSeq(seq: number): Promise<number> {
  const { rows } = await pool.query<{ last_pushed_local_seq: string }>(
    `INSERT INTO cloud_sync_state (workspace_id, last_pushed_local_seq, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (workspace_id) DO UPDATE SET
       last_pushed_local_seq = GREATEST(cloud_sync_state.last_pushed_local_seq, EXCLUDED.last_pushed_local_seq),
       updated_at = now()
     RETURNING last_pushed_local_seq`,
    [WORKSPACE_ID, seq],
  );
  return Number(rows[0]!.last_pushed_local_seq);
}

/** Advance the remote pull cursor (monotonic — GREATEST, never backward). */
export async function setRemotePullCursor(seq: number): Promise<number> {
  const { rows } = await pool.query<{ remote_pull_cursor: string }>(
    `INSERT INTO cloud_sync_state (workspace_id, remote_pull_cursor, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (workspace_id) DO UPDATE SET
       remote_pull_cursor = GREATEST(cloud_sync_state.remote_pull_cursor, EXCLUDED.remote_pull_cursor),
       updated_at = now()
     RETURNING remote_pull_cursor`,
    [WORKSPACE_ID, seq],
  );
  return Number(rows[0]!.remote_pull_cursor);
}

// ─── Result shapes ────────────────────────────────────────────────────────────

export interface AuthErrorInfo {
  status: number;
  message: string;
}

export interface PushOnceResult {
  /** false → client not paired (no-op). */
  paired: boolean;
  /** Wire envelopes actually POSTed (pushable ops only). */
  pushed: number;
  /** Server reported newly-stored. */
  applied: number;
  /** Server reported already-seen (idempotent re-push). */
  duplicate: number;
  /** Local sync_event rows scanned (incl. skipped local-only ops). */
  scanned: number;
  /** Local-only/unpushable rows skipped. */
  skipped: number;
  lastPushedLocalSeq: number;
  headServerSeq: number | null;
  /** Set when the run stopped on a revoked/expired token. */
  authError?: AuthErrorInfo;
}

export interface PullOnceResult {
  paired: boolean;
  /** Wire events received across all pages. */
  pulled: number;
  /** Events whose canonical effect was applied (applyEvent applied:true). */
  applied: number;
  /** Events safely skipped (unknown/deferred ops). */
  skipped: number;
  remotePullCursor: number;
  headServerSeq: number | null;
  authError?: AuthErrorInfo;
}

export interface SyncOnceResult {
  paired: boolean;
  push: PushOnceResult;
  pull: PullOnceResult;
}

interface PushResponse {
  results: Array<{ id: string; server_seq: number; status: 'applied' | 'duplicate' }>;
  head_server_seq: number;
}

interface PullResponse {
  events: WirePullEvent[];
  head_server_seq: number;
  has_more: boolean;
}

function authErrorInfo(err: CloudAuthError): AuthErrorInfo {
  return { status: err.status, message: err.message };
}

function notPairedPush(): PushOnceResult {
  return {
    paired: false,
    pushed: 0,
    applied: 0,
    duplicate: 0,
    scanned: 0,
    skipped: 0,
    lastPushedLocalSeq: 0,
    headServerSeq: null,
  };
}

function notPairedPull(): PullOnceResult {
  return {
    paired: false,
    pulled: 0,
    applied: 0,
    skipped: 0,
    remotePullCursor: 0,
    headServerSeq: null,
  };
}

// ─── PUSH ─────────────────────────────────────────────────────────────────────

interface LocalRow {
  id: string;
  entity_type: string;
  entity_id: string;
  operation: string;
  payload: unknown;
  logical_clock: string;
  hash: string;
  server_seq: string;
}

/**
 * Push un-pushed LOCAL sync_event rows to the cloud.
 *
 * Selects sync_event rows with server_seq > last_pushed_local_seq in order,
 * maps the PUSHABLE ones (isPushable) to wire envelopes, POSTs in batches of
 * ≤1000, and advances last_pushed_local_seq to the max server_seq SEEN in the
 * batch — INCLUDING skipped local-only ops — so the cursor never stalls on an
 * unpushable op. Push is idempotent server-side (dedup on event.id).
 *
 * Local sync_event holds only locally-authored events (pulled remote events are
 * applied via applyEvent and never recorded), so this never re-pushes a peer's
 * event.
 */
export async function pushOnce(): Promise<PushOnceResult> {
  const state = await getCloudSyncState();
  let cursor = state.lastPushedLocalSeq;
  let pushed = 0;
  let applied = 0;
  let duplicate = 0;
  let scanned = 0;
  let skipped = 0;
  let headServerSeq: number | null = null;

  try {
    // Confirm pairing up front so an unpaired client is a clean no-op.
    // (cloudFetch would throw CloudNotConfiguredError on first request anyway.)
    for (;;) {
      const { rows } = await pool.query<LocalRow>(
        `SELECT id, entity_type, entity_id, operation, payload, logical_clock, hash, server_seq
           FROM sync_event
          WHERE workspace_id = $1 AND server_seq > $2
          ORDER BY server_seq ASC
          LIMIT $3`,
        [WORKSPACE_ID, cursor, PUSH_BATCH_LIMIT],
      );
      if (rows.length === 0) break;

      scanned += rows.length;
      const maxSeqSeen = Number(rows[rows.length - 1]!.server_seq);

      const envelopes: WireEnvelope[] = [];
      for (const r of rows) {
        if (isPushable(r.operation)) {
          envelopes.push(toWireEnvelope(r));
        } else {
          skipped++;
        }
      }

      if (envelopes.length > 0) {
        const resp = await cloudFetch('/sync/push', {
          method: 'POST',
          body: JSON.stringify({ events: envelopes }),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`push failed: HTTP ${resp.status} ${text}`);
        }
        const data = (await resp.json()) as PushResponse;
        for (const result of data.results ?? []) {
          if (result.status === 'duplicate') duplicate++;
          else applied++;
        }
        pushed += envelopes.length;
        headServerSeq = data.head_server_seq ?? headServerSeq;
      }

      // Advance past EVERY row seen (incl. skipped local-only ops) so the cursor
      // never stalls. Persist after each batch so a crash resumes here.
      cursor = await setLastPushedLocalSeq(maxSeqSeen);

      if (rows.length < PUSH_BATCH_LIMIT) break;
    }
  } catch (err) {
    if (err instanceof CloudNotConfiguredError) return notPairedPush();
    if (err instanceof CloudAuthError) {
      return {
        paired: true,
        pushed,
        applied,
        duplicate,
        scanned,
        skipped,
        lastPushedLocalSeq: cursor,
        headServerSeq,
        authError: authErrorInfo(err),
      };
    }
    throw err;
  }

  return {
    paired: true,
    pushed,
    applied,
    duplicate,
    scanned,
    skipped,
    lastPushedLocalSeq: cursor,
    headServerSeq,
  };
}

// ─── PULL ─────────────────────────────────────────────────────────────────────

/**
 * Pull peers' events from the cloud, apply them idempotently, and ack.
 *
 * Pages with since=remote_pull_cursor and include_self=0 (the server excludes
 * our own device). Each page is applied in ONE transaction — fromWireEvent then
 * applyEvent (NEVER recordEvent → no echo) — then POST /sync/ack with the max
 * server_seq applied, and remote_pull_cursor advances (GREATEST). Repeats while
 * has_more. applyEvent is idempotent so re-pulling a page is safe.
 */
export async function pullOnce(): Promise<PullOnceResult> {
  const state = await getCloudSyncState();
  let cursor = state.remotePullCursor;
  let pulled = 0;
  let applied = 0;
  let skipped = 0;
  let headServerSeq: number | null = null;

  try {
    for (;;) {
      const resp = await cloudFetch(
        `/sync/pull?since=${cursor}&limit=${PULL_PAGE_LIMIT}&include_self=0`,
        { method: 'GET' },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`pull failed: HTTP ${resp.status} ${text}`);
      }
      const data = (await resp.json()) as PullResponse;
      headServerSeq = data.head_server_seq ?? headServerSeq;
      const events = data.events ?? [];

      if (events.length === 0) {
        if (!data.has_more) break;
        // Defensive: server says more but returned nothing — avoid a tight loop.
        break;
      }

      pulled += events.length;

      // Apply this page in a single transaction; track the max server_seq.
      let maxApplied = cursor;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const wireEvent of events) {
          const local = fromWireEvent(wireEvent);
          const result = await applyEvent(client, {
            id: local.id,
            device_id: local.device_id,
            entity_type: local.entity_type,
            entity_id: local.entity_id,
            operation: local.operation,
            payload: local.payload,
            // Ordering key for single-row LWW materializers (workspace_profile);
            // ignored by the plain-overwrite materializers. (MIN-1123)
            logical_clock: local.logical_clock,
            server_seq: wireEvent.server_seq,
          });
          if (result.applied) applied++;
          else skipped++;
          const seq = Number(wireEvent.server_seq);
          if (seq > maxApplied) maxApplied = seq;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Ack the applied high-water mark, then advance the local cursor (GREATEST).
      const ackResp = await cloudFetch('/sync/ack', {
        method: 'POST',
        body: JSON.stringify({ server_seq: maxApplied }),
      });
      if (!ackResp.ok) {
        const text = await ackResp.text().catch(() => '');
        throw new Error(`ack failed: HTTP ${ackResp.status} ${text}`);
      }
      cursor = await setRemotePullCursor(maxApplied);

      if (!data.has_more) break;
    }
  } catch (err) {
    if (err instanceof CloudNotConfiguredError) return notPairedPull();
    if (err instanceof CloudAuthError) {
      return {
        paired: true,
        pulled,
        applied,
        skipped,
        remotePullCursor: cursor,
        headServerSeq,
        authError: authErrorInfo(err),
      };
    }
    throw err;
  }

  return {
    paired: true,
    pulled,
    applied,
    skipped,
    remotePullCursor: cursor,
    headServerSeq,
  };
}

// ─── FULL CYCLE ───────────────────────────────────────────────────────────────

/**
 * One full sync cycle: push local changes, THEN pull peers' changes. If push
 * stops on an auth error we skip pull and surface it (don't spin).
 */
export async function syncOnce(): Promise<SyncOnceResult> {
  const push = await pushOnce();
  if (!push.paired) {
    return { paired: false, push, pull: notPairedPull() };
  }
  if (push.authError) {
    // Token revoked/expired — surface immediately, skip pull.
    return { paired: true, push, pull: { ...notPairedPull(), paired: true } };
  }
  const pull = await pullOnce();
  return { paired: true, push, pull };
}
