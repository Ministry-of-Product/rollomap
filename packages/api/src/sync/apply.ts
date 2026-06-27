/**
 * Apply a remote sync event's effect to the canonical tables (MIN-932).
 *
 * This is the "replay" half of sync: when a peer's event is accepted by push
 * (events.ts records LOCAL mutations; this file replays REMOTE ones), we write
 * the canonical row(s) the event describes.
 *
 * Hard rules:
 *  - Applying a remote event MUST NOT call recordEvent — that would mint a NEW
 *    local event and create an echo/replication loop. We write canonical rows
 *    DIRECTLY, inside the caller's push transaction.
 *  - Every apply is keyed by the entity's OWN id and is idempotent (ON CONFLICT
 *    DO NOTHING / DO UPDATE), so replaying the same event twice is a no-op.
 *  - Unknown / not-yet-applicable operations are SKIPPED safely (never throw the
 *    whole batch); they return { applied: false, reason }.
 *
 * Conflict policy is deliberately BORING here (last-write-wins by payload row
 * state, plain deletes, best-effort merge). >>> EXTENSION POINT: MIN-933 layers
 * tombstones, MIN-934 real merge-sync, MIN-936 real conflict resolution. Add
 * that policy in the per-operation helpers below. <<<
 */

import { WORKSPACE_ID } from '../db.js';
import type { QueryableClient } from './device.js';
import { insertTombstone, isTombstoned } from './tombstone.js';

export interface ApplicableEvent {
  id?: string;
  device_id?: string;
  entity_type?: string;
  entity_id?: string;
  operation: string;
  payload: unknown;
}

export interface ApplyResult {
  applied: boolean;
  /** Set when the event was intentionally skipped (unknown op, deferred, etc). */
  reason?: string;
}

type Row = Record<string, unknown>;

function asRow(payload: unknown): Row {
  return (payload && typeof payload === 'object' ? payload : {}) as Row;
}

/**
 * Apply one event idempotently to canonical state. Returns whether a canonical
 * write was performed; callers should not treat applied:false as an error.
 */
export async function applyEvent(
  client: QueryableClient,
  event: ApplicableEvent,
): Promise<ApplyResult> {
  const payload = asRow(event.payload);
  switch (event.operation) {
    case 'person.created':
    case 'person.updated': {
      const personId = (payload.id as string) ?? event.entity_id;
      // Tombstone wins / no resurrection (MIN-933): if this person was already
      // deleted, a stale create/update must NOT bring it back. This is the
      // boring-correct default; strict delete-vs-later-update ordering (e.g. an
      // update genuinely newer than the delete) is refined in MIN-936.
      if (personId && (await isTombstoned(client, 'person', personId))) {
        return { applied: false, reason: 'person is tombstoned — not resurrected' };
      }
      await applyPerson(client, payload);
      return { applied: true };
    }

    case 'person.deleted':
      // Tombstone (MIN-933) instead of hard-deleting, so a peer's later stale
      // create/update can't resurrect the row. Idempotent via ON CONFLICT DO
      // NOTHING. We KEEP the canonical row; compaction removes it later once all
      // trusted devices have acked (see sync/tombstone.ts compactTombstones).
      await insertTombstone(client, {
        entityType: 'person',
        entityId: (payload.id as string) ?? event.entity_id,
        deletedByDeviceId: (payload.deleted_by_device_id as string) ?? event.device_id ?? null,
        deleteEventId: event.id ?? null,
        reason: (payload.reason as string) ?? null,
      });
      return { applied: true };

    case 'person.merged':
      // Best-effort no-op: real merge-sync is owned by MIN-934. Never block the
      // batch on a merge we can't safely reconstruct here.
      return { applied: false, reason: 'person.merged deferred to MIN-934' };

    case 'identity.added':
      return applyIdentity(client, payload);

    case 'topic.linked':
      return applyTopicLink(client, payload);

    case 'note.created':
      return applyNote(client, payload);

    case 'interaction.created':
      return applyInteraction(client, payload);

    default:
      // Unknown operation — skip safely so newer producers don't break older
      // consumers. MIN-936 may register additional handlers here.
      return { applied: false, reason: `unknown operation: ${event.operation}` };
  }
}

/** Upsert a person from its full row payload (last-write-wins). Preserves origin id. */
async function applyPerson(client: QueryableClient, p: Row): Promise<void> {
  await client.query(
    `INSERT INTO person
       (id, workspace_id, display_name, primary_email, aliases, known_emails, known_phones,
        linkedin_url, company, title, summary, how_known, first_seen_at, last_seen_at,
        interaction_count, relationship_strength, confidence, user_pinned, sensitivity_level,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,
             $15,$16,$17,$18,$19,
             COALESCE($20::timestamptz, now()), COALESCE($21::timestamptz, now()))
     ON CONFLICT (id) DO UPDATE SET
       display_name          = EXCLUDED.display_name,
       primary_email         = EXCLUDED.primary_email,
       aliases               = EXCLUDED.aliases,
       known_emails          = EXCLUDED.known_emails,
       known_phones          = EXCLUDED.known_phones,
       linkedin_url          = EXCLUDED.linkedin_url,
       company               = EXCLUDED.company,
       title                 = EXCLUDED.title,
       summary               = EXCLUDED.summary,
       how_known             = EXCLUDED.how_known,
       first_seen_at         = EXCLUDED.first_seen_at,
       last_seen_at          = EXCLUDED.last_seen_at,
       interaction_count     = EXCLUDED.interaction_count,
       relationship_strength = EXCLUDED.relationship_strength,
       confidence            = EXCLUDED.confidence,
       user_pinned           = EXCLUDED.user_pinned,
       sensitivity_level     = EXCLUDED.sensitivity_level`,
    [
      p.id,
      (p.workspace_id as string) ?? WORKSPACE_ID,
      p.display_name,
      p.primary_email ?? null,
      JSON.stringify(p.aliases ?? []),
      JSON.stringify(p.known_emails ?? []),
      JSON.stringify(p.known_phones ?? []),
      p.linkedin_url ?? null,
      p.company ?? null,
      p.title ?? null,
      p.summary ?? null,
      p.how_known ?? null,
      p.first_seen_at ?? null,
      p.last_seen_at ?? null,
      p.interaction_count ?? 0,
      p.relationship_strength ?? 0,
      p.confidence ?? 1.0,
      p.user_pinned ?? false,
      p.sensitivity_level ?? 'normal',
      p.created_at ?? null,
      p.updated_at ?? null,
    ],
  );
}

/** Upsert a person_identity by its natural key. */
async function applyIdentity(client: QueryableClient, p: Row): Promise<ApplyResult> {
  if (!p.person_id || !p.identity_type || !p.identity_value) {
    return { applied: false, reason: 'identity.added missing person_id/type/value' };
  }
  await client.query(
    `INSERT INTO person_identity
       (id, workspace_id, person_id, identity_type, identity_value, source_item_id, confidence, verified_by_user, created_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))
     ON CONFLICT (workspace_id, identity_type, identity_value) DO NOTHING`,
    [
      p.id ?? null,
      (p.workspace_id as string) ?? WORKSPACE_ID,
      p.person_id,
      p.identity_type,
      p.identity_value,
      p.source_item_id ?? null,
      p.confidence ?? 1.0,
      p.verified_by_user ?? false,
      p.created_at ?? null,
    ],
  );
  return { applied: true };
}

/**
 * Link a person to a topic. The topic is resolved by name when the payload
 * carries one (creating it if needed), else by an explicit topic_id. If neither
 * can be resolved we skip rather than fail the FK (the topic will arrive on its
 * own event in a later batch).
 */
async function applyTopicLink(client: QueryableClient, p: Row): Promise<ApplyResult> {
  let topicId = (p.topic_id as string) ?? null;
  const topicName = (p.topic_name as string) ?? null;
  if (topicName) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM topic WHERE workspace_id = $1 AND lower(name) = lower($2)`,
      [(p.workspace_id as string) ?? WORKSPACE_ID, topicName],
    );
    if (existing.rowCount && existing.rows[0]) {
      topicId = existing.rows[0].id;
    } else {
      const created = await client.query<{ id: string }>(
        `INSERT INTO topic (workspace_id, name) VALUES ($1, $2) RETURNING id`,
        [(p.workspace_id as string) ?? WORKSPACE_ID, topicName],
      );
      topicId = created.rows[0]!.id;
    }
  }
  if (!topicId || !p.person_id) {
    return { applied: false, reason: 'topic.linked unresolved topic/person — skipped' };
  }
  await client.query(
    `INSERT INTO person_topic
       (id, workspace_id, person_id, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, person_id, topic_id) DO UPDATE SET
       confidence     = EXCLUDED.confidence,
       user_confirmed = EXCLUDED.user_confirmed`,
    [
      p.id ?? null,
      (p.workspace_id as string) ?? WORKSPACE_ID,
      p.person_id,
      topicId,
      p.confidence ?? 0.7,
      p.evidence_count ?? 0,
      p.last_evidence_at ?? null,
      p.user_confirmed ?? true,
    ],
  );
  return { applied: true };
}

/** Insert a note keyed by its own id; idempotent. */
async function applyNote(client: QueryableClient, p: Row): Promise<ApplyResult> {
  if (!p.id || !p.body) return { applied: false, reason: 'note.created missing id/body' };
  await client.query(
    `INSERT INTO note (id, workspace_id, person_id, body, kind, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), COALESCE($7::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING`,
    [
      p.id,
      (p.workspace_id as string) ?? WORKSPACE_ID,
      p.person_id ?? null,
      p.body,
      p.kind ?? 'note',
      p.created_at ?? null,
      p.updated_at ?? null,
    ],
  );
  return { applied: true };
}

/** Insert an interaction (+ its participants) keyed by id; idempotent. */
async function applyInteraction(client: QueryableClient, p: Row): Promise<ApplyResult> {
  if (!p.id) return { applied: false, reason: 'interaction.created missing id' };
  await client.query(
    `INSERT INTO interaction
       (id, workspace_id, source_item_id, interaction_type, title, summary, body, occurred_at, topics, sensitivity_level, confidence, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, COALESCE($12::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING`,
    [
      p.id,
      (p.workspace_id as string) ?? WORKSPACE_ID,
      p.source_item_id ?? null,
      p.interaction_type ?? 'unknown',
      p.title ?? null,
      p.summary ?? null,
      p.body ?? null,
      p.occurred_at ?? new Date().toISOString(),
      JSON.stringify(p.topics ?? []),
      p.sensitivity_level ?? 'normal',
      p.confidence ?? 1.0,
      p.created_at ?? null,
    ],
  );
  const participantIds = Array.isArray(p.participant_ids) ? (p.participant_ids as string[]) : [];
  for (const personId of participantIds) {
    await client.query(
      `INSERT INTO interaction_participant (workspace_id, interaction_id, person_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [(p.workspace_id as string) ?? WORKSPACE_ID, p.id, personId],
    );
  }
  return { applied: true };
}
