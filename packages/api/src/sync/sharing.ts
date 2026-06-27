/**
 * Snapshot contact sharing: bundle build + bundle import (MIN-938).
 *
 * SNAPSHOT vs LIVE SHARING
 * ─────────────────────────
 * This module implements SNAPSHOT sharing only. A bundle is a self-contained
 * JSON payload exported at a point in time. The recipient creates LOCAL OWNED
 * records — they do NOT depend on the sender's database afterward. There is no
 * live/real-time sharing model here. See docs/contact-sharing.md for the
 * explicit boundary between snapshot (today) and live (future).
 *
 * BUNDLE SCHEMA
 * ──────────────
 * {
 *   version:            "1",
 *   mode:               "snapshot",
 *   shared_by:          string,          // free-form sharer identifier
 *   shared_at:          ISO string,
 *   source_workspace_id: UUID string,
 *   people: [{
 *     external_id?:  UUID string,        // person.id in source workspace (informational)
 *     fields:        { display_name, primary_email, company, title, linkedin_url,
 *                      aliases?, known_emails?, known_phones?, how_known? },
 *     topics?:       string[],           // topic names
 *   }]
 * }
 *
 * SENSITIVE-FIELD DEFAULTS
 * ─────────────────────────
 * buildBundle() excludes by default:
 *   - People whose sensitivity_level != 'normal'  (unless include_sensitive=true)
 *   - The `summary` field                         (AI/synthesized text; opt-in)
 *   - Note bodies entirely                        (never included — first-class private content)
 * Callers may additionally exclude any assertable field via exclude_fields[].
 *
 * PROVENANCE ON IMPORT
 * ─────────────────────
 * importBundle() stamps provenance for NEWLY CREATED people only (not matched):
 *   - Asserts how_known = "Imported from share by <shared_by> on <shared_at>"
 *     (user_confirmed=false, confidence=0.8; sits as a competing assertion so the
 *      user can override it by editing how_known directly).
 *   - Writes a note body: "Imported via RolloMap share from <shared_by> on <shared_at>.
 *     Source workspace: <source_workspace_id>." so the exact provenance is preserved.
 * For MATCHED people: only field assertions are written (no how_known/note stamp)
 * to avoid note spam and LWW clobbers of existing how_known on re-import.
 *
 * MATCH LOGIC ON IMPORT
 * ──────────────────────
 * For each bundle person (in order):
 *   1. primary_email match (case-insensitive) against live (non-tombstoned) people.
 *   2. known_emails overlap — checks each bundle email against primary_email and
 *      known_emails JSONB array of live people.
 *   3. display_name exact match (case-insensitive, first result wins if multiple).
 *   4. No match → INSERT new person, then assert all bundle fields.
 *
 * RE-IMPORT BEHAVIOUR
 * ────────────────────
 * The same bundle may safely be imported twice. Persons matched in step 1-3 won't
 * be duplicated. Each import call writes NEW assertion rows (fresh UUIDs) for
 * matched people — the canonical column is unchanged for equal values, and for
 * updated values the new assertion wins per the standard conflict policy. Provenance
 * notes are NOT re-written on re-import of matched people.
 */

import crypto from 'node:crypto';
import { WORKSPACE_ID } from '../db.js';
import type { QueryableClient } from './device.js';
import { assertField, ASSERTABLE_FIELDS } from './assertions.js';
import { recordEvent } from './events.js';

// ─── Bundle types ─────────────────────────────────────────────────────────────

export interface BundlePerson {
  /** person.id in the source workspace — informational only, not used for matching. */
  external_id?: string;
  /** Assertable contact fields. Scalars for single-value fields; arrays for multi-value. */
  fields: Record<string, unknown>;
  /** Topic names to link on the recipient side (find-or-create). */
  topics?: string[];
}

export interface ShareBundle {
  version: '1';
  mode: 'snapshot';
  /** Free-form identifier of the sharer (workspace name, handle, etc.). */
  shared_by: string;
  /** ISO 8601 timestamp when the bundle was created. */
  shared_at: string;
  /** workspace.id of the exporting workspace. */
  source_workspace_id: string;
  people: BundlePerson[];
}

// ─── Field exclusion defaults ─────────────────────────────────────────────────

/**
 * Fields excluded from bundles by default.
 * summary: may contain AI-derived or sensitive synthesised text; opt-in via
 *          omitting it from exclude_fields once the caller is sure it's safe.
 *
 * Note bodies (note.body) are NEVER included — they live in the `note` table and
 * are treated as first-class private content, not shareable contact fields.
 */
const DEFAULT_EXCLUDED_FIELDS = new Set(['summary']);

/**
 * Fields never bundled regardless of caller options.
 * user_pinned is a local workspace preference with no meaning outside the source.
 * (It is also absent from ASSERTABLE_FIELDS, but be explicit here for clarity.)
 */
const NEVER_BUNDLE_FIELDS = new Set(['user_pinned']);

// ─── NOT_TOMBSTONED helper ────────────────────────────────────────────────────

const NOT_TOMBSTONED_PERSON = `NOT EXISTS (
  SELECT 1 FROM entity_tombstone et
   WHERE et.workspace_id = p.workspace_id
     AND et.entity_type  = 'person'
     AND et.entity_id    = p.id
)`;

// ─── buildBundle ──────────────────────────────────────────────────────────────

export interface BuildBundleOptions {
  /** Additional field names to exclude (on top of the default exclusions). */
  exclude_fields?: string[];
  /**
   * If true, include people whose sensitivity_level != 'normal'.
   * Default: false — sensitive people are silently omitted.
   */
  include_sensitive?: boolean;
  /** Free-form identifier for the sharer embedded in the bundle header. */
  shared_by?: string;
}

/**
 * Build a share bundle from all (live, non-tombstoned) members of a contact group.
 *
 * Pure read — does NOT emit a sync event. Rationale: a bundle export mutates no
 * local state and produces no artifact that needs to replicate across devices.
 * If a share-log feature is added later (a table recording outbound shares), that
 * path would emit 'group.shared'. See docs/contact-sharing.md.
 */
export async function buildBundle(
  client: QueryableClient,
  groupId: string,
  opts: BuildBundleOptions = {},
): Promise<ShareBundle> {
  const {
    include_sensitive = false,
    shared_by = 'unknown',
    exclude_fields = [],
  } = opts;

  // Effective exclusion set for this export
  const excluded = new Set([...DEFAULT_EXCLUDED_FIELDS, ...NEVER_BUNDLE_FIELDS, ...exclude_fields]);

  // Fetch group members (no workspace filter needed — group_id is a UUID PK; still
  // guard with workspace_id on the group to prevent cross-workspace leakage)
  const membersRes = await client.query<{ person_id: string }>(
    `SELECT cgm.person_id
       FROM contact_group cg
       JOIN contact_group_member cgm ON cgm.group_id = cg.id
      WHERE cg.id = $1 AND cg.workspace_id = $2`,
    [groupId, WORKSPACE_ID],
  );

  const people: BundlePerson[] = [];

  for (const { person_id } of membersRes.rows) {
    // Fetch person (skip tombstoned)
    const pRes = await client.query<Record<string, unknown>>(
      `SELECT * FROM person p
        WHERE p.id = $1 AND p.workspace_id = $2 AND ${NOT_TOMBSTONED_PERSON}`,
      [person_id, WORKSPACE_ID],
    );
    if (!pRes.rowCount) continue;
    const person = pRes.rows[0]!;

    // Skip sensitive people unless caller explicitly asked for them
    if (!include_sensitive && (person.sensitivity_level as string) !== 'normal') continue;

    // Collect only assertable fields, applying exclusions
    const fields: Record<string, unknown> = {};
    for (const field of ASSERTABLE_FIELDS) {
      if (NEVER_BUNDLE_FIELDS.has(field) || excluded.has(field)) continue;
      const val = person[field];
      if (val !== null && val !== undefined) {
        fields[field] = val;
      }
    }

    // Topics: include names only (topic.id has no meaning outside this workspace)
    const topicsRes = await client.query<{ name: string }>(
      `SELECT t.name
         FROM person_topic pt
         JOIN topic t ON t.id = pt.topic_id
        WHERE pt.person_id = $1 AND pt.workspace_id = $2
        ORDER BY pt.confidence DESC`,
      [person_id, WORKSPACE_ID],
    );
    const topics = topicsRes.rows.map((r) => r.name);

    people.push({
      external_id: person_id as string,
      fields,
      ...(topics.length > 0 ? { topics } : {}),
    });
  }

  return {
    version: '1',
    mode: 'snapshot',
    shared_by,
    shared_at: new Date().toISOString(),
    source_workspace_id: WORKSPACE_ID,
    people,
  };
}

// ─── importBundle ─────────────────────────────────────────────────────────────

export interface ImportResult {
  created: number;
  matched: number;
}

/**
 * Import a share bundle into the current workspace.
 *
 * Must be called inside a transaction (withSyncTxn) — the caller is responsible.
 * Each person's field assertions use assertField() so provenance + canonical
 * derivation flow through the same path as manual edits and connector imports.
 *
 * Emits one 'group.imported' sync event at the end (summary, not per-person).
 */
export async function importBundle(
  client: QueryableClient,
  bundle: ShareBundle,
): Promise<ImportResult> {
  const provenanceLabel =
    `Imported from share by ${bundle.shared_by} on ${bundle.shared_at}`;

  let created = 0;
  let matched = 0;

  for (const bundlePerson of bundle.people) {
    const { fields, topics = [] } = bundlePerson;

    // ── 1. Match or create ──────────────────────────────────────────────────
    let personId: string | null = null;
    let isNew = false;

    // 1a. primary_email (exact, case-insensitive)
    const primaryEmail =
      typeof fields.primary_email === 'string' ? fields.primary_email : null;
    if (primaryEmail) {
      const r = await client.query<{ id: string }>(
        `SELECT p.id FROM person p
          WHERE p.workspace_id = $1
            AND lower(p.primary_email) = lower($2)
            AND ${NOT_TOMBSTONED_PERSON}
          LIMIT 1`,
        [WORKSPACE_ID, primaryEmail],
      );
      if (r.rowCount && r.rows[0]) personId = r.rows[0].id;
    }

    // 1b. known_emails overlap — check each bundle email vs primary_email + known_emails
    if (!personId) {
      const knownEmails = Array.isArray(fields.known_emails)
        ? (fields.known_emails as string[])
        : [];
      for (const email of knownEmails) {
        // Check against primary_email
        const r1 = await client.query<{ id: string }>(
          `SELECT p.id FROM person p
            WHERE p.workspace_id = $1
              AND lower(p.primary_email) = lower($2)
              AND ${NOT_TOMBSTONED_PERSON}
            LIMIT 1`,
          [WORKSPACE_ID, email],
        );
        if (r1.rowCount && r1.rows[0]) { personId = r1.rows[0].id; break; }
        // Check against known_emails JSONB array
        const r2 = await client.query<{ id: string }>(
          `SELECT p.id FROM person p
            WHERE p.workspace_id = $1
              AND p.known_emails @> $2::jsonb
              AND ${NOT_TOMBSTONED_PERSON}
            LIMIT 1`,
          [WORKSPACE_ID, JSON.stringify([email])],
        );
        if (r2.rowCount && r2.rows[0]) { personId = r2.rows[0].id; break; }
      }
    }

    // 1c. display_name exact match (case-insensitive, first result wins)
    if (!personId) {
      const displayName =
        typeof fields.display_name === 'string' ? fields.display_name : null;
      if (displayName) {
        const r = await client.query<{ id: string }>(
          `SELECT p.id FROM person p
            WHERE p.workspace_id = $1
              AND lower(p.display_name) = lower($2)
              AND ${NOT_TOMBSTONED_PERSON}
            LIMIT 1`,
          [WORKSPACE_ID, displayName],
        );
        if (r.rowCount && r.rows[0]) personId = r.rows[0].id;
      }
    }

    // 1d. No match — create a new person with just the display_name
    if (!personId) {
      const displayName =
        typeof fields.display_name === 'string'
          ? fields.display_name
          : bundlePerson.external_id
            ? `Imported contact ${bundlePerson.external_id}`
            : 'Unknown Contact';
      const r = await client.query<{ id: string }>(
        `INSERT INTO person (workspace_id, display_name)
         VALUES ($1, $2)
         RETURNING id`,
        [WORKSPACE_ID, displayName],
      );
      personId = r.rows[0]!.id;
      isNew = true;
    }

    // ── 2. Assert all bundle fields via the assertions system ───────────────
    // user_confirmed=false so a locally confirmed value always wins.
    // confidence=0.8 (high-quality bundle data, but not locally verified).
    for (const field of ASSERTABLE_FIELDS) {
      const val = fields[field];
      if (val === null || val === undefined) continue;
      await assertField(client, {
        personId,
        fieldName: field,
        fieldValue: val,
        userConfirmed: false,
        confidence: 0.8,
      });
    }

    // ── 3. Stamp provenance for newly created people ────────────────────────
    if (isNew) {
      // Provenance label in how_known (competing assertion; user edit wins later)
      await assertField(client, {
        personId,
        fieldName: 'how_known',
        fieldValue: provenanceLabel,
        userConfirmed: false,
        confidence: 0.8,
      });

      // Explicit provenance note — carries shared_by + source_workspace_id
      await client.query(
        `INSERT INTO note (workspace_id, person_id, body, kind)
         VALUES ($1, $2, $3, 'note')`,
        [
          WORKSPACE_ID,
          personId,
          `${provenanceLabel}. Source workspace: ${bundle.source_workspace_id}.`,
        ],
      );

      created++;
    } else {
      matched++;
    }

    // ── 4. Link topics (find-or-create, upsert) ─────────────────────────────
    for (const topicName of topics) {
      let topicId: string;
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM topic WHERE workspace_id = $1 AND lower(name) = lower($2)`,
        [WORKSPACE_ID, topicName],
      );
      if (existing.rowCount && existing.rows[0]) {
        topicId = existing.rows[0].id;
      } else {
        const created_topic = await client.query<{ id: string }>(
          `INSERT INTO topic (workspace_id, name) VALUES ($1, $2) RETURNING id`,
          [WORKSPACE_ID, topicName],
        );
        topicId = created_topic.rows[0]!.id;
      }
      await client.query(
        `INSERT INTO person_topic (workspace_id, person_id, topic_id, confidence, user_confirmed)
         VALUES ($1, $2, $3, 0.5, false)
         ON CONFLICT (workspace_id, person_id, topic_id) DO NOTHING`,
        [WORKSPACE_ID, personId, topicId],
      );
    }
  }

  // ── Emit one group.imported event per import action ─────────────────────
  // entityId: a fresh UUID per import (no local group entity on the recipient side).
  // This event records the provenance of the import action in the sync log.
  if (bundle.people.length > 0) {
    await recordEvent(client, {
      entityType: 'contact_group',
      entityId: crypto.randomUUID(),
      operation: 'group.imported',
      payload: {
        source_workspace_id: bundle.source_workspace_id,
        shared_by: bundle.shared_by,
        shared_at: bundle.shared_at,
        created,
        matched,
      },
    });
  }

  return { created, matched };
}
