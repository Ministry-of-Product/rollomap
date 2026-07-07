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
import { applyRemoteMerge, applyRemoteReverse, resolvePersonRedirect } from './merge.js';
import { applyFieldAssertion } from './assertions.js';
import { tombstoneBlocksApply } from './conflict-policy.js';

export interface ApplicableEvent {
  id?: string;
  device_id?: string;
  entity_type?: string;
  entity_id?: string;
  operation: string;
  payload: unknown;
  /**
   * Origin Lamport clock of the event (bigint as string, or number). Used by the
   * single-row LWW materializers (workspace_profile) to reject stale replays.
   * Absent when a caller replays an event without an ordering key — such events
   * are treated as "apply unconditionally", matching the other materializers.
   */
  logical_clock?: string | number;
  /**
   * Node-local server sequence (from pull). Tiebreaks the LWW comparison when two
   * events share a logical_clock. Absent for locally-authored / peer-push events.
   */
  server_seq?: string | number;
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
      // Tombstone precedence / no resurrection (MIN-933, policy owned by MIN-936's
      // conflict-policy.tombstoneBlocksApply): a delete is FINAL wrt sync ordering —
      // a create/update never resurrects a tombstoned person regardless of the order
      // events apply. Rationale: a tombstone is only compacted once every trusted
      // device has acked past its delete event, so its presence means the delete is
      // the latest known intent. (delete-wins, rule 4 in conflict-policy.ts.)
      if (personId && tombstoneBlocksApply(await isTombstoned(client, 'person', personId))) {
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
      // Replay a peer's merge (MIN-934): idempotently move source→target refs,
      // merge topics, record the person_merge row, and tombstone the source. Two
      // devices merging the same A→B pair converge (each records its own
      // person_merge row; both redirect source→target with no data loss).
      return applyRemoteMerge(client, payload, event);

    case 'person.merge_reversed':
      // Replay a peer's reversal (MIN-934): restore the source + its captured
      // references from THIS device's person_merge row. No-op if unknown locally.
      return applyRemoteReverse(client, payload);

    case 'identity.added':
      return applyIdentity(client, payload);

    case 'topic.created':
      return applyTopicCreated(client, payload, event.entity_id);

    case 'topic.linked':
      return applyTopicLink(client, payload);

    case 'note.created':
      return applyNote(client, payload);

    case 'interaction.created':
      return applyInteraction(client, payload);

    case 'field.asserted':
      // Replay a peer's field-level contact assertion (MIN-935): upsert the row
      // (idempotent) then re-derive the canonical person column so every device
      // converges on the same winner. resolvePersonRedirect (inside) lands
      // assertions about a merged-away source on the live target.
      return applyFieldAssertion(client, payload);

    case 'profile.updated':
      // Replay a peer's workspace personalization profile (MIN-1123). The
      // workspace_profile is a single-row config table keyed by workspace_id
      // (= event.entity_id). Unlike the other materializers (plain overwrite by
      // apply order), profile.updated uses a last-writer-wins guard on the
      // reserved last_event_clock/last_event_seq columns so a stale/re-delivered
      // event can't regress a newer applied state. See applyProfile.
      return applyProfile(client, payload, event);

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
  // Map a merged-away source person onto its live target (MIN-934).
  const personId = await resolvePersonRedirect(client, p.person_id as string);
  await client.query(
    `INSERT INTO person_identity
       (id, workspace_id, person_id, identity_type, identity_value, source_item_id, confidence, verified_by_user, created_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))
     ON CONFLICT (workspace_id, identity_type, identity_value) DO NOTHING`,
    [
      p.id ?? null,
      (p.workspace_id as string) ?? WORKSPACE_ID,
      personId,
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

/** Insert a topic keyed by id and unique name; idempotent. */
async function applyTopicCreated(
  client: QueryableClient,
  p: Row,
  entityId?: string,
): Promise<ApplyResult> {
  const topicId = (p.id as string) ?? entityId ?? null;
  const ws = (p.workspace_id as string) ?? WORKSPACE_ID;
  if (!topicId || !p.name) {
    return { applied: false, reason: 'topic.created missing id/name' };
  }
  await client.query(
    `INSERT INTO topic (id, workspace_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [topicId, ws, p.name],
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
  // Map a merged-away source person onto its live target (MIN-934).
  const personId = await resolvePersonRedirect(client, p.person_id as string);
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
      personId,
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
  // Map a merged-away source person onto its live target (MIN-934).
  const personId = p.person_id
    ? await resolvePersonRedirect(client, p.person_id as string)
    : null;
  await client.query(
    `INSERT INTO note (id, workspace_id, person_id, body, kind, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), COALESCE($7::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING`,
    [
      p.id,
      (p.workspace_id as string) ?? WORKSPACE_ID,
      personId,
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
  for (const rawPersonId of participantIds) {
    // Map a merged-away source person onto its live target (MIN-934).
    const personId = await resolvePersonRedirect(client, rawPersonId);
    await client.query(
      `INSERT INTO interaction_participant (workspace_id, interaction_id, person_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [(p.workspace_id as string) ?? WORKSPACE_ID, p.id, personId],
    );
  }
  return { applied: true };
}

/** Coerce a bigint-ish event field (string | number | undefined) to a param value. */
function bigintParam(v: string | number | undefined): string | null {
  return v === undefined || v === null ? null : String(v);
}

/**
 * Upsert the single-row workspace_profile from a profile.updated payload (MIN-1123),
 * keyed by the event's entity_id (= workspace_id). Idempotent + last-writer-wins.
 *
 * LWW model: the row's last_event_clock/last_event_seq record the ordering key of
 * the event that last wrote it. The incoming event's (logical_clock, server_seq)
 * are compared against them in the ON CONFLICT WHERE guard, so an older/stale or
 * re-delivered event never overwrites a newer applied state, and applying the same
 * event twice is a no-op (equal clock/seq ⇒ guard is false).
 *
 * NULL handling (deliberate, per MIN-1123): the LOCAL write path (updateProfile)
 * does NOT stamp last_event_clock/seq, and a caller may replay an event with no
 * ordering key. In both cases we apply unconditionally (stored NULL, or incoming
 * NULL ⇒ guard true), matching the other materializers' "remote/last write wins".
 * The clock guard only arbitrates between two clock-bearing remote events.
 *
 * The payload carries the WorkspaceProfile shape recorded by updateProfile
 * (camelCase keys), NOT snake_case DB columns.
 */
async function applyProfile(
  client: QueryableClient,
  p: Row,
  event: ApplicableEvent,
): Promise<ApplyResult> {
  const workspaceId = (event.entity_id as string) ?? WORKSPACE_ID;
  await client.query(
    `INSERT INTO workspace_profile
       (workspace_id, owner_name, owner_emails, owner_aliases, interests,
        primary_network, import_recipes, journal_skip_phrases, metadata,
        last_event_clock, last_event_seq, created_at, updated_at)
     VALUES ($1, $2, COALESCE($3::jsonb, '[]'::jsonb), COALESCE($4::jsonb, '[]'::jsonb),
             COALESCE($5::jsonb, '[]'::jsonb), $6, COALESCE($7::jsonb, '[]'::jsonb),
             COALESCE($8::jsonb, '[]'::jsonb), COALESCE($9::jsonb, '{}'::jsonb),
             $10::bigint, $11::bigint,
             COALESCE($12::timestamptz, now()), COALESCE($13::timestamptz, now()))
     ON CONFLICT (workspace_id) DO UPDATE SET
       owner_name           = EXCLUDED.owner_name,
       owner_emails         = EXCLUDED.owner_emails,
       owner_aliases        = EXCLUDED.owner_aliases,
       interests            = EXCLUDED.interests,
       primary_network      = EXCLUDED.primary_network,
       import_recipes       = EXCLUDED.import_recipes,
       journal_skip_phrases = EXCLUDED.journal_skip_phrases,
       metadata             = EXCLUDED.metadata,
       last_event_clock     = EXCLUDED.last_event_clock,
       last_event_seq       = EXCLUDED.last_event_seq
       -- updated_at is refreshed by the workspace_profile_set_updated_at trigger
     WHERE workspace_profile.last_event_clock IS NULL
        OR EXCLUDED.last_event_clock IS NULL
        OR EXCLUDED.last_event_clock > workspace_profile.last_event_clock
        OR (EXCLUDED.last_event_clock = workspace_profile.last_event_clock
            AND COALESCE(EXCLUDED.last_event_seq, 0) > COALESCE(workspace_profile.last_event_seq, 0))`,
    [
      workspaceId,
      p.ownerName ?? null,
      p.ownerEmails !== undefined ? JSON.stringify(p.ownerEmails) : null,
      p.ownerAliases !== undefined ? JSON.stringify(p.ownerAliases) : null,
      p.interests !== undefined ? JSON.stringify(p.interests) : null,
      p.primaryNetwork ?? null,
      p.importRecipes !== undefined ? JSON.stringify(p.importRecipes) : null,
      p.journalSkipPhrases !== undefined ? JSON.stringify(p.journalSkipPhrases) : null,
      p.metadata !== undefined ? JSON.stringify(p.metadata) : null,
      bigintParam(event.logical_clock),
      bigintParam(event.server_seq),
      p.createdAt ?? null,
      p.updatedAt ?? null,
    ],
  );
  return { applied: true };
}
