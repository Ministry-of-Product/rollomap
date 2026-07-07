/**
 * One-time backfill: emit a creation sync_event for every existing entity that
 * pre-dates the sync_event log (MIN-975).
 *
 * WHY: migration 005 added sync_event, but existing data has no events.  A freshly-
 * paired client therefore pushes 0 rows.  This backfill emits creation events for
 * the full historical graph so pushOnce can send them to the cloud server.
 *
 * ── Dependency order (server_seq grows monotonically within each stage) ────────
 *   Stage 0 — topics (topic.created must precede topic.linked in the event log)
 *   Stage 1 — persons + their identities + their topic links
 *   Stage 2 — interactions (reference persons via participants)
 *   Stage 3 — notes (reference persons via person_id)
 *   Stage 4 — field assertions (reference persons via person_id)
 *   Stage 5 — workspace profile (single-row config; no FK deps)
 *
 * ── Idempotency ────────────────────────────────────────────────────────────────
 *   Before emitting, we check sync_event for (workspace_id, entity_id, operation).
 *   Entity IDs used per operation:
 *     topic.created       → topic.id
 *     person.created      → person.id
 *     identity.added      → person_identity.id   (per-identity; different from
 *                                                  sources.ts which uses person_id)
 *     topic.linked        → person_topic.id       (per-link)
 *     interaction.created → interaction.id
 *     note.created        → note.id
 *     field.asserted      → person_field_assertion.id  (per-assertion)
 *     profile.updated     → workspace_id               (single-row config)
 *   Re-running emits nothing new.
 *
 * ── SKIPPED (not pushable today) ─────────────────────────────────────────────
 *   commitment.created — no wire op for commitments exists in wire.ts.
 */

import { pool, WORKSPACE_ID } from '../db.js';
import { recordEvent, withSyncTxn } from '../sync/events.js';
import type { QueryableClient } from '../sync/device.js';

// ── Result types ──────────────────────────────────────────────────────────────

export interface OpCounts {
  emitted: number;
  skipped: number;
}

export interface BackfillResult {
  /** Per-operation emit/skip counts. */
  byOp: Record<string, OpCounts>;
  /** Sum across all ops. */
  totals: { emitted: number; skipped: number };
  /** Counts for entity types that cannot be synced yet (informational only). */
  notPushable: {
    /** Commitments present in DB but without a wire op — cannot be backfilled. */
    commitments: number;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Entities processed per transaction; keeps memory low and txns short. */
const BATCH = 100;

/** UUID that sorts before any real UUID — used to bootstrap the cursor. */
const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

// ── Helpers ───────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** True if no event with this (entity_id, operation) exists yet. */
async function hasNoEvent(
  client: QueryableClient,
  entityId: string,
  operation: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM sync_event
      WHERE workspace_id = $1 AND entity_id = $2 AND operation = $3
      LIMIT 1`,
    [WORKSPACE_ID, entityId, operation],
  );
  return !rowCount;
}

/** Count rows in a table for the current workspace. */
async function countRows(table: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = $1`,
    [WORKSPACE_ID],
  );
  return Number(rows[0]!.n);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Emit a creation sync event for every existing entity with no event yet.
 * Idempotent: safe to call multiple times; subsequent calls emit nothing.
 */
export async function backfillSyncEvents(): Promise<BackfillResult> {
  const byOp: Record<string, OpCounts> = {
    'topic.created': { emitted: 0, skipped: 0 },
    'person.created': { emitted: 0, skipped: 0 },
    'identity.added': { emitted: 0, skipped: 0 },
    'topic.linked': { emitted: 0, skipped: 0 },
    'interaction.created': { emitted: 0, skipped: 0 },
    'note.created': { emitted: 0, skipped: 0 },
    'field.asserted': { emitted: 0, skipped: 0 },
    'profile.updated': { emitted: 0, skipped: 0 },
  };

  const commitments = await countRows('commitment');

  // ── Stage 0: Topics ────────────────────────────────────────────────────────
  // Must run BEFORE Stage 1 so every topic.created event has a LOWER server_seq
  // than the topic.linked events that reference the same topic_id.  The cloud
  // server's topic.linked handler does INSERT INTO person_topic ... with a FK on
  // topic_id → topic(id); if the topic row doesn't exist yet the insert fails
  // with a FK violation and the whole push batch rolls back.
  {
    let cursor = UUID_ZERO;
    for (;;) {
      const { rows: topics } = await pool.query<Row>(
        `SELECT * FROM topic
          WHERE workspace_id = $1 AND id > $2
          ORDER BY id ASC
          LIMIT $3`,
        [WORKSPACE_ID, cursor, BATCH],
      );
      if (topics.length === 0) break;

      await withSyncTxn(async (client) => {
        for (const topic of topics) {
          const topicId = topic.id as string;
          if (await hasNoEvent(client, topicId, 'topic.created')) {
            await recordEvent(client, {
              entityType: 'topic',
              entityId: topicId,
              operation: 'topic.created',
              payload: topic,
            });
            byOp['topic.created']!.emitted++;
          } else {
            byOp['topic.created']!.skipped++;
          }
        }
      });

      cursor = topics[topics.length - 1]!.id as string;
      if (topics.length < BATCH) break;
    }
  }

  // ── Stage 1: Persons + identities + topic links ────────────────────────────
  // Process persons in cursor-paginated batches (by id).  Within each batch:
  //   person.created → identity.added → topic.linked
  // so server_seq grows in dependency order within each person.
  {
    let cursor = UUID_ZERO;
    for (;;) {
      const { rows: persons } = await pool.query<Row>(
        `SELECT p.*
           FROM person p
          WHERE p.workspace_id = $1
            AND p.id > $2
            AND NOT EXISTS (
              SELECT 1 FROM entity_tombstone et
               WHERE et.workspace_id = p.workspace_id
                 AND et.entity_type = 'person'
                 AND et.entity_id   = p.id
            )
          ORDER BY p.id ASC
          LIMIT $3`,
        [WORKSPACE_ID, cursor, BATCH],
      );
      if (persons.length === 0) break;

      await withSyncTxn(async (client) => {
        for (const person of persons) {
          const personId = person.id as string;

          // person.created
          if (await hasNoEvent(client, personId, 'person.created')) {
            await recordEvent(client, {
              entityType: 'person',
              entityId: personId,
              operation: 'person.created',
              payload: person,
            });
            byOp['person.created']!.emitted++;
          } else {
            byOp['person.created']!.skipped++;
          }

          // identity.added — one event per identity row (entity_id = identity.id)
          const { rows: identities } = await client.query<Row>(
            `SELECT * FROM person_identity
              WHERE workspace_id = $1 AND person_id = $2
              ORDER BY id ASC`,
            [WORKSPACE_ID, personId],
          );
          for (const ident of identities) {
            const identId = ident.id as string;
            if (await hasNoEvent(client, identId, 'identity.added')) {
              await recordEvent(client, {
                entityType: 'person_identity',
                entityId: identId,
                operation: 'identity.added',
                payload: ident,
              });
              byOp['identity.added']!.emitted++;
            } else {
              byOp['identity.added']!.skipped++;
            }
          }

          // topic.linked — one event per person_topic row.
          // Payload carries topic_name so applying peers can resolve/create the
          // topic even without a topic.created event (wire.ts has no local
          // topic.created pushable op today).
          const { rows: topicLinks } = await client.query<Row>(
            `SELECT pt.*, t.name AS topic_name
               FROM person_topic pt
               JOIN topic t ON t.id = pt.topic_id
              WHERE pt.workspace_id = $1 AND pt.person_id = $2
              ORDER BY pt.id ASC`,
            [WORKSPACE_ID, personId],
          );
          for (const pt of topicLinks) {
            const ptId = pt.id as string;
            if (await hasNoEvent(client, ptId, 'topic.linked')) {
              await recordEvent(client, {
                entityType: 'person_topic',
                entityId: ptId,
                operation: 'topic.linked',
                payload: pt,
              });
              byOp['topic.linked']!.emitted++;
            } else {
              byOp['topic.linked']!.skipped++;
            }
          }
        }
      });

      cursor = persons[persons.length - 1]!.id as string;
      if (persons.length < BATCH) break;
    }
  }

  // ── Stage 2: Interactions ──────────────────────────────────────────────────
  // Persons are already in the log (Stage 1) so FK-like references are safe.
  {
    let cursor = UUID_ZERO;
    for (;;) {
      const { rows: interactions } = await pool.query<Row>(
        `SELECT * FROM interaction
          WHERE workspace_id = $1 AND id > $2
          ORDER BY id ASC
          LIMIT $3`,
        [WORKSPACE_ID, cursor, BATCH],
      );
      if (interactions.length === 0) break;

      await withSyncTxn(async (client) => {
        for (const interaction of interactions) {
          const interactionId = interaction.id as string;
          if (await hasNoEvent(client, interactionId, 'interaction.created')) {
            // Collect participant_ids: mirrors routes/interactions.ts payload shape.
            const { rows: parts } = await client.query<{ person_id: string }>(
              `SELECT person_id FROM interaction_participant
                WHERE workspace_id = $1 AND interaction_id = $2`,
              [WORKSPACE_ID, interactionId],
            );
            const participantIds = parts.map((p) => p.person_id);
            await recordEvent(client, {
              entityType: 'interaction',
              entityId: interactionId,
              operation: 'interaction.created',
              payload: { ...interaction, participant_ids: participantIds },
            });
            byOp['interaction.created']!.emitted++;
          } else {
            byOp['interaction.created']!.skipped++;
          }
        }
      });

      cursor = interactions[interactions.length - 1]!.id as string;
      if (interactions.length < BATCH) break;
    }
  }

  // ── Stage 3: Notes ─────────────────────────────────────────────────────────
  {
    let cursor = UUID_ZERO;
    for (;;) {
      const { rows: notes } = await pool.query<Row>(
        `SELECT * FROM note
          WHERE workspace_id = $1 AND id > $2
          ORDER BY id ASC
          LIMIT $3`,
        [WORKSPACE_ID, cursor, BATCH],
      );
      if (notes.length === 0) break;

      await withSyncTxn(async (client) => {
        for (const note of notes) {
          const noteId = note.id as string;
          if (await hasNoEvent(client, noteId, 'note.created')) {
            await recordEvent(client, {
              entityType: 'note',
              entityId: noteId,
              operation: 'note.created',
              payload: note,
            });
            byOp['note.created']!.emitted++;
          } else {
            byOp['note.created']!.skipped++;
          }
        }
      });

      cursor = notes[notes.length - 1]!.id as string;
      if (notes.length < BATCH) break;
    }
  }

  // ── Stage 4: Field assertions ──────────────────────────────────────────────
  // entity_id = assertion.id so idempotency is per-assertion.
  // Payload is the full person_field_assertion row (mirrors assertions.ts).
  {
    let cursor = UUID_ZERO;
    for (;;) {
      const { rows: assertions } = await pool.query<Row>(
        `SELECT * FROM person_field_assertion
          WHERE workspace_id = $1 AND id > $2
          ORDER BY id ASC
          LIMIT $3`,
        [WORKSPACE_ID, cursor, BATCH],
      );
      if (assertions.length === 0) break;

      await withSyncTxn(async (client) => {
        for (const assertion of assertions) {
          const assertionId = assertion.id as string;
          if (await hasNoEvent(client, assertionId, 'field.asserted')) {
            await recordEvent(client, {
              entityType: 'person',
              // entity_id = assertionId so each assertion has its own idempotency
              // key (multiple assertions per person would share entity_id=personId
              // and we could not distinguish them on re-run).
              entityId: assertionId,
              operation: 'field.asserted',
              payload: assertion,
            });
            byOp['field.asserted']!.emitted++;
          } else {
            byOp['field.asserted']!.skipped++;
          }
        }
      });

      cursor = assertions[assertions.length - 1]!.id as string;
      if (assertions.length < BATCH) break;
    }
  }

  // ── Stage 5: Workspace profile ─────────────────────────────────────────────
  // Single-row config table (one row per workspace, keyed by workspace_id) with
  // no FK dependencies. Emit one profile.updated event carrying the full profile
  // so a freshly-paired device receives the owner's personalization. Idempotent
  // via hasNoEvent(WORKSPACE_ID, 'profile.updated'). Payload mirrors updateProfile
  // (camelCase WorkspaceProfile shape) so applyEvent reads it uniformly.
  {
    await withSyncTxn(async (client) => {
      const { rows } = await client.query<Row>(
        `SELECT owner_name, owner_emails, owner_aliases, interests, primary_network,
                import_recipes, journal_skip_phrases, metadata,
                last_event_clock, last_event_seq, created_at, updated_at
           FROM workspace_profile WHERE workspace_id = $1`,
        [WORKSPACE_ID],
      );
      if (rows.length > 0) {
        if (await hasNoEvent(client, WORKSPACE_ID, 'profile.updated')) {
          const r = rows[0]!;
          await recordEvent(client, {
            entityType: 'workspace_profile',
            entityId: WORKSPACE_ID,
            operation: 'profile.updated',
            payload: {
              ownerName: r.owner_name,
              ownerEmails: r.owner_emails,
              ownerAliases: r.owner_aliases,
              interests: r.interests,
              primaryNetwork: r.primary_network,
              importRecipes: r.import_recipes,
              journalSkipPhrases: r.journal_skip_phrases,
              metadata: r.metadata,
              lastEventClock: r.last_event_clock,
              lastEventSeq: r.last_event_seq,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            },
          });
          byOp['profile.updated']!.emitted++;
        } else {
          byOp['profile.updated']!.skipped++;
        }
      }
    });
  }

  const totals = {
    emitted: Object.values(byOp).reduce((s, c) => s + c.emitted, 0),
    skipped: Object.values(byOp).reduce((s, c) => s + c.skipped, 0),
  };

  return { byOp, totals, notPushable: { commitments } };
}
