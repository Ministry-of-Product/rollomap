/**
 * First-class, reversible, sync-safe person merge (MIN-934).
 *
 * A merge moves every reference (interaction participations, notes, commitments,
 * identities, topics) from a SOURCE person onto a TARGET person, tombstones the
 * source (kept as a redirect, never hard-deleted — MIN-933), and records a durable
 * `person_merge` row capturing EXACTLY which rows moved so the merge can be
 * reversed and replayed on other devices.
 *
 * This module is the single shared implementation path:
 *   - routes/people.ts authors a LOCAL merge      → mergePeople()      (emits events)
 *   - sync/apply.ts replays a REMOTE peer's merge  → applyRemoteMerge() (event-free)
 * Both funnel through the same ref-moving core (`moveReferences`) and the same
 * `upsertPersonMerge`, so the two paths can never diverge.
 *
 * CONVERGENCE: every step is idempotent. Replaying the same person.merged twice,
 * or two devices independently merging the same A→B pair, converges with no data
 * loss and no error — the source ends tombstoned, refs land on the target, and
 * resolvePersonRedirect maps any stale source reference onto the live target.
 */

import crypto from 'node:crypto';
import { WORKSPACE_ID } from '../db.js';
import type { QueryableClient } from './device.js';
import { getLocalDeviceId } from './device.js';
import { recordEvent } from './events.js';
import { tombstoneEntity, insertTombstone } from './tombstone.js';

type Row = Record<string, unknown>;

/**
 * Exactly which reference rows a merge moved source→target — enough to reverse it.
 *  - `moved` ids are flipped back to the source on reverse.
 *  - `deleted` interaction_participant rows (removed because the target was already
 *    a participant of that interaction — UNIQUE(interaction_id, person_id)) and the
 *    source's `person_topic` rows are re-inserted on reverse.
 */
export interface Relocations {
  interaction_participant: { moved: string[]; deleted: Row[] };
  note: string[];
  commitment: string[];
  person_identity: string[];
  person_topic: Row[];
}

function emptyRelocations(): Relocations {
  return {
    interaction_participant: { moved: [], deleted: [] },
    note: [],
    commitment: [],
    person_identity: [],
    person_topic: [],
  };
}

/**
 * Move every reference row from `sourceId` to `targetId` and merge person_topic
 * (keeping the higher confidence, summing evidence_count — mirrors the original
 * route logic). Returns the captured `relocations` so the move can be reversed.
 *
 * Idempotent: once the source has been emptied, a second call moves nothing and
 * returns empty relocations (the authoritative relocations are preserved by the
 * ON CONFLICT DO NOTHING on person_merge).
 */
export async function moveReferences(
  client: QueryableClient,
  sourceId: string,
  targetId: string,
): Promise<Relocations> {
  const r = emptyRelocations();

  // interaction_participant has UNIQUE(interaction_id, person_id): if the target
  // is ALREADY a participant of an interaction the source is in, the source row
  // can't simply be re-pointed — delete it (capturing the full row to restore on
  // reverse), then move the non-conflicting remainder.
  const deletedP = await client.query<Row>(
    `DELETE FROM interaction_participant s
      WHERE s.workspace_id = $1 AND s.person_id = $2
        AND EXISTS (SELECT 1 FROM interaction_participant t
                     WHERE t.workspace_id = $1 AND t.person_id = $3
                       AND t.interaction_id = s.interaction_id)
      RETURNING s.*`,
    [WORKSPACE_ID, sourceId, targetId],
  );
  r.interaction_participant.deleted = deletedP.rows;

  const movedP = await client.query<{ id: string }>(
    `UPDATE interaction_participant SET person_id = $3
      WHERE workspace_id = $1 AND person_id = $2 RETURNING id`,
    [WORKSPACE_ID, sourceId, targetId],
  );
  r.interaction_participant.moved = movedP.rows.map((x) => x.id);

  const movedNote = await client.query<{ id: string }>(
    `UPDATE note SET person_id = $3 WHERE workspace_id = $1 AND person_id = $2 RETURNING id`,
    [WORKSPACE_ID, sourceId, targetId],
  );
  r.note = movedNote.rows.map((x) => x.id);

  const movedCommit = await client.query<{ id: string }>(
    `UPDATE commitment SET person_id = $3 WHERE workspace_id = $1 AND person_id = $2 RETURNING id`,
    [WORKSPACE_ID, sourceId, targetId],
  );
  r.commitment = movedCommit.rows.map((x) => x.id);

  const movedIdent = await client.query<{ id: string }>(
    `UPDATE person_identity SET person_id = $3 WHERE workspace_id = $1 AND person_id = $2 RETURNING id`,
    [WORKSPACE_ID, sourceId, targetId],
  );
  r.person_identity = movedIdent.rows.map((x) => x.id);

  // person_topic: merge into target keeping the higher confidence (summing
  // evidence_count), then remove the source rows — capturing them so reverse can
  // re-attach them to the source.
  await client.query(
    `INSERT INTO person_topic (workspace_id, person_id, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed)
         SELECT workspace_id, $3, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed
           FROM person_topic WHERE workspace_id = $1 AND person_id = $2
       ON CONFLICT (workspace_id, person_id, topic_id) DO UPDATE
         SET confidence = GREATEST(person_topic.confidence, EXCLUDED.confidence),
             evidence_count = person_topic.evidence_count + EXCLUDED.evidence_count`,
    [WORKSPACE_ID, sourceId, targetId],
  );
  const removedTopics = await client.query<Row>(
    `DELETE FROM person_topic WHERE workspace_id = $1 AND person_id = $2 RETURNING *`,
    [WORKSPACE_ID, sourceId],
  );
  r.person_topic = removedTopics.rows;

  return r;
}

export interface UpsertPersonMergeInput {
  id: string;
  sourceId: string;
  targetId: string;
  mergeEventId?: string | null;
  createdByDeviceId?: string | null;
  relocations: Relocations;
}

/**
 * Record (or no-op) the person_merge row. ON CONFLICT (id) DO NOTHING makes
 * replaying the SAME merge idempotent and preserves the AUTHORITATIVE relocations
 * captured on the first apply (a later replay computes empty relocations).
 */
export async function upsertPersonMerge(
  client: QueryableClient,
  input: UpsertPersonMergeInput,
): Promise<void> {
  await client.query(
    `INSERT INTO person_merge
       (id, workspace_id, source_person_id, target_person_id, merge_event_id, created_by_device_id, relocations)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.id,
      WORKSPACE_ID,
      input.sourceId,
      input.targetId,
      input.mergeEventId ?? null,
      input.createdByDeviceId ?? null,
      JSON.stringify(input.relocations),
    ],
  );
}

/**
 * Follow non-reversed person_merge rows source→target, transitively, returning the
 * live target id. A→B→C resolves to C. Used by apply.ts so a replayed event that
 * references a merged-away source lands on the live target. Cycle-guarded.
 */
export async function resolvePersonRedirect(
  client: QueryableClient,
  personId: string,
): Promise<string> {
  let current = personId;
  const seen = new Set<string>([current]);
  // Bounded loop: at most one redirect hop per existing merge.
  for (let i = 0; i < 1000; i++) {
    const r = await client.query<{ target_person_id: string }>(
      `SELECT target_person_id FROM person_merge
        WHERE workspace_id = $1 AND source_person_id = $2 AND reversed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [WORKSPACE_ID, current],
    );
    if (!r.rowCount || !r.rows[0]) break;
    const next = r.rows[0].target_person_id;
    if (seen.has(next)) break; // cycle / self → stop
    seen.add(next);
    current = next;
  }
  return current;
}

export interface MergePeopleInput {
  sourceId: string;
  targetId: string;
  /** Authoring device; defaults to the local device. */
  deviceId?: string;
}

/**
 * LOCAL merge (route path). Inside the caller's transaction:
 *  1. keep writing user_correction (something may read it — MIN-934 keeps it AND
 *     adds the richer person_merge record);
 *  2. move all references source→target (capturing relocations);
 *  3. tombstone the source (emits person.deleted, so peers don't resurrect it);
 *  4. emit person.merged carrying {merge_id, source_person_id, target_person_id,
 *     created_by_device_id} — enough for a peer to replay;
 *  5. record the person_merge row.
 *
 * Returns the new merge id.
 */
export async function mergePeople(
  client: QueryableClient,
  input: MergePeopleInput,
): Promise<{ mergeId: string }> {
  const { sourceId, targetId } = input;
  const deviceId = input.deviceId ?? (await getLocalDeviceId(client));
  const mergeId = crypto.randomUUID();

  // (1) Preserve existing user_correction behavior.
  await client.query(
    `INSERT INTO user_correction (workspace_id, entity_type, entity_id, correction_type, before_value)
     VALUES ($1,'person',$2,'merge',$3::jsonb)`,
    [WORKSPACE_ID, targetId, JSON.stringify({ merged_from: sourceId })],
  );

  // (2) Move references.
  const relocations = await moveReferences(client, sourceId, targetId);

  // (3) Tombstone the source (event-emitting; redirect, not hard delete).
  await tombstoneEntity(client, {
    entityType: 'person',
    entityId: sourceId,
    reason: `merged into ${targetId}`,
  });

  // (4) Emit person.merged with a replayable payload.
  const event = await recordEvent(client, {
    entityType: 'person',
    entityId: targetId,
    operation: 'person.merged',
    payload: {
      merge_id: mergeId,
      source_person_id: sourceId,
      target_person_id: targetId,
      created_by_device_id: deviceId,
    },
  });

  // (5) Record the person_merge row (with the authoritative relocations).
  await upsertPersonMerge(client, {
    id: mergeId,
    sourceId,
    targetId,
    mergeEventId: event.id,
    createdByDeviceId: deviceId,
    relocations,
  });

  return { mergeId };
}

/**
 * REMOTE merge (apply path). Event-free: never calls recordEvent (that would echo).
 * Idempotently moves refs, records the person_merge row under the REMOTE merge id
 * (ON CONFLICT DO NOTHING), and tombstones the source via insertTombstone.
 */
export async function applyRemoteMerge(
  client: QueryableClient,
  payload: Row,
  event: { id?: string; device_id?: string },
): Promise<{ applied: boolean; reason?: string }> {
  const sourceId = (payload.source_person_id as string) ?? (payload.source_id as string);
  const targetId = (payload.target_person_id as string) ?? (payload.target_id as string);
  const mergeId = (payload.merge_id as string) ?? event.id ?? crypto.randomUUID();
  if (!sourceId || !targetId) {
    return { applied: false, reason: 'person.merged missing source/target id' };
  }

  const relocations = await moveReferences(client, sourceId, targetId);
  await upsertPersonMerge(client, {
    id: mergeId,
    sourceId,
    targetId,
    mergeEventId: event.id ?? null,
    createdByDeviceId: (payload.created_by_device_id as string) ?? event.device_id ?? null,
    relocations,
  });
  // Event-free tombstone (the source's own person.deleted event replays the same).
  await insertTombstone(client, {
    entityType: 'person',
    entityId: sourceId,
    deletedByDeviceId: (payload.created_by_device_id as string) ?? event.device_id ?? null,
    reason: `merged into ${targetId}`,
  });
  return { applied: true };
}

/**
 * Restore the captured relocations back onto the source and un-tombstone it.
 * Shared by the local reverse route and the replayed person.merge_reversed.
 *
 * LIMITATION (documented): person_topic confidences/evidence_count that were
 * ELEVATED on the target during the merge (GREATEST / sum) are NOT un-elevated —
 * we restore the source's own topic rows but leave the target's merged values in
 * place (un-merging them would require the pre-merge target state, which the merge
 * did not capture). All other reference types restore exactly.
 */
async function restoreRelocations(
  client: QueryableClient,
  sourceId: string,
  relocations: Relocations,
): Promise<void> {
  const reloc: Relocations = { ...emptyRelocations(), ...relocations };
  const ip = reloc.interaction_participant ?? { moved: [], deleted: [] };

  // person_topic: re-attach the source's original rows.
  for (const t of reloc.person_topic ?? []) {
    await client.query(
      `INSERT INTO person_topic
         (id, workspace_id, person_id, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed, created_at, updated_at)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8,
               COALESCE($9::timestamptz, now()), COALESCE($10::timestamptz, now()))
       ON CONFLICT (workspace_id, person_id, topic_id) DO NOTHING`,
      [
        t.id ?? null,
        WORKSPACE_ID,
        sourceId,
        t.topic_id,
        t.confidence ?? 0.5,
        t.evidence_count ?? 0,
        t.last_evidence_at ?? null,
        t.user_confirmed ?? false,
        t.created_at ?? null,
        t.updated_at ?? null,
      ],
    );
  }

  // interaction_participant: re-point the moved rows back to the source...
  if (ip.moved && ip.moved.length > 0) {
    await client.query(
      `UPDATE interaction_participant SET person_id = $2
        WHERE workspace_id = $1 AND id = ANY($3::uuid[])`,
      [WORKSPACE_ID, sourceId, ip.moved],
    );
  }
  // ...and re-insert the rows that were deleted to satisfy the unique constraint.
  for (const d of ip.deleted ?? []) {
    await client.query(
      `INSERT INTO interaction_participant (id, workspace_id, interaction_id, person_id, role, confidence, created_at)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
       ON CONFLICT (interaction_id, person_id) DO NOTHING`,
      [
        d.id ?? null,
        WORKSPACE_ID,
        d.interaction_id,
        sourceId,
        d.role ?? 'participant',
        d.confidence ?? 1.0,
        d.created_at ?? null,
      ],
    );
  }

  // note / commitment / person_identity: re-point moved rows back to the source.
  if (reloc.note && reloc.note.length > 0) {
    await client.query(
      `UPDATE note SET person_id = $2 WHERE workspace_id = $1 AND id = ANY($3::uuid[])`,
      [WORKSPACE_ID, sourceId, reloc.note],
    );
  }
  if (reloc.commitment && reloc.commitment.length > 0) {
    await client.query(
      `UPDATE commitment SET person_id = $2 WHERE workspace_id = $1 AND id = ANY($3::uuid[])`,
      [WORKSPACE_ID, sourceId, reloc.commitment],
    );
  }
  if (reloc.person_identity && reloc.person_identity.length > 0) {
    await client.query(
      `UPDATE person_identity SET person_id = $2 WHERE workspace_id = $1 AND id = ANY($3::uuid[])`,
      [WORKSPACE_ID, sourceId, reloc.person_identity],
    );
  }

  // Un-tombstone the source so it is live again.
  await client.query(
    `DELETE FROM entity_tombstone
      WHERE workspace_id = $1 AND entity_type = 'person' AND entity_id = $2`,
    [WORKSPACE_ID, sourceId],
  );
}

export interface ReverseMergeInput {
  mergeId: string;
  deviceId?: string;
}

/**
 * LOCAL reverse (route path). Restores the source + its captured references, marks
 * the person_merge reversed, and emits person.merge_reversed so peers replicate it.
 * Returns null if the merge is unknown or already reversed.
 */
export async function reverseMerge(
  client: QueryableClient,
  input: ReverseMergeInput,
): Promise<{ sourceId: string; targetId: string } | null> {
  const deviceId = input.deviceId ?? (await getLocalDeviceId(client));
  const row = await client.query<{
    source_person_id: string;
    target_person_id: string;
    relocations: Relocations;
    reversed_at: Date | null;
  }>(
    `SELECT source_person_id, target_person_id, relocations, reversed_at
       FROM person_merge WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, input.mergeId],
  );
  if (!row.rowCount || !row.rows[0]) return null;
  if (row.rows[0].reversed_at) return null; // already reversed → no-op

  const { source_person_id: sourceId, target_person_id: targetId, relocations } = row.rows[0];
  await restoreRelocations(client, sourceId, relocations);
  await client.query(
    `UPDATE person_merge SET reversed_at = now(), reversed_by_device_id = $3
      WHERE workspace_id = $1 AND id = $2 AND reversed_at IS NULL`,
    [WORKSPACE_ID, input.mergeId, deviceId],
  );
  await recordEvent(client, {
    entityType: 'person',
    entityId: targetId,
    operation: 'person.merge_reversed',
    payload: {
      merge_id: input.mergeId,
      source_person_id: sourceId,
      target_person_id: targetId,
      reversed_by_device_id: deviceId,
    },
  });
  return { sourceId, targetId };
}

/**
 * REMOTE reverse (apply path). Event-free. Looks up the LOCAL person_merge row by
 * merge_id and reverses it using the relocations THIS device captured. If the merge
 * is unknown locally (never replicated here) it's a safe no-op.
 */
export async function applyRemoteReverse(
  client: QueryableClient,
  payload: Row,
): Promise<{ applied: boolean; reason?: string }> {
  const mergeId = payload.merge_id as string;
  if (!mergeId) return { applied: false, reason: 'person.merge_reversed missing merge_id' };
  const row = await client.query<{
    source_person_id: string;
    relocations: Relocations;
    reversed_at: Date | null;
  }>(
    `SELECT source_person_id, relocations, reversed_at
       FROM person_merge WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, mergeId],
  );
  if (!row.rowCount || !row.rows[0]) {
    return { applied: false, reason: 'person.merge_reversed for unknown local merge — skipped' };
  }
  if (row.rows[0].reversed_at) return { applied: true }; // already reversed (idempotent)

  await restoreRelocations(client, row.rows[0].source_person_id, row.rows[0].relocations);
  await client.query(
    `UPDATE person_merge SET reversed_at = now(), reversed_by_device_id = $3
      WHERE workspace_id = $1 AND id = $2 AND reversed_at IS NULL`,
    [WORKSPACE_ID, mergeId, (payload.reversed_by_device_id as string) ?? null],
  );
  return { applied: true };
}
