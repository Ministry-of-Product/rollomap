/**
 * Field-level contact assertions + provenance, and canonical derivation (MIN-935).
 *
 * A person_field_assertion is one CLAIM about one field of one person, carrying its
 * provenance (source/device), confidence, and whether the user confirmed it. The
 * canonical person.* column is DERIVED from the live (non-superseded) assertions, so:
 *   - existing reads of person.* keep working unchanged;
 *   - a user's confirmed value is never clobbered by a later import (it wins the
 *     selector), yet the import's competing value stays queryable for provenance;
 *   - conflicting source values are preserved (we never UPDATE a competing row).
 *
 * This module is the single shared path used by BOTH:
 *   - routes (people.ts PATCH/POST, sources.ts import) → assertField() (emits a
 *     field.asserted sync event so the claim replicates);
 *   - sync/apply.ts replaying a peer's field.asserted → applyFieldAssertion()
 *     (event-free upsert + derive, so canonical state converges on every device).
 */

import crypto from 'node:crypto';
import { WORKSPACE_ID } from '../db.js';
import type { QueryableClient } from './device.js';
import { getLocalDeviceId } from './device.js';
import { recordEvent } from './events.js';
import { resolvePersonRedirect } from './merge.js';

type Row = Record<string, unknown>;

/**
 * Single-value canonical columns: the winning assertion's value is written back.
 * Multi-value columns: the canonical column is the set-union of all live values.
 *
 * Both sets double as a WHITELIST — deriveCanonicalField only interpolates a column
 * name found here, so the dynamic UPDATE can't be a SQL-injection vector.
 */
export const SINGLE_VALUE_FIELDS = new Set([
  'display_name',
  'primary_email',
  'company',
  'title',
  'linkedin_url',
  'summary',
  'how_known',
]);
export const MULTI_VALUE_FIELDS = new Set(['aliases', 'known_emails', 'known_phones']);

/** Fields the manual edit routes assert (in addition to keeping the column). */
export const ASSERTABLE_FIELDS = [
  'display_name',
  'primary_email',
  'company',
  'title',
  'linkedin_url',
  'summary',
  'how_known',
  'aliases',
  'known_emails',
  'known_phones',
] as const;

export interface AssertFieldInput {
  personId: string;
  fieldName: string;
  /** Scalar for single-value fields; string[] for multi-value fields. */
  fieldValue: unknown;
  sourceConnectionId?: string | null;
  sourceItemId?: string | null;
  /** Defaults to the local device when omitted. */
  deviceId?: string | null;
  confidence?: number;
  isPrimary?: boolean;
  userConfirmed?: boolean;
  /** Optional preset id (e.g. when re-asserting a known row); else generated. */
  id?: string;
}

/**
 * Write a LOCAL assertion (manual edit or import), emit a field.asserted sync event,
 * and re-derive the canonical person column. Resolves a merged-away person onto the
 * live target so the assertion lands where reads expect it.
 */
export async function assertField(
  client: QueryableClient,
  input: AssertFieldInput,
): Promise<Row | null> {
  const personId = await resolvePersonRedirect(client, input.personId);
  const deviceId = input.deviceId ?? (await getLocalDeviceId(client));
  const id = input.id ?? crypto.randomUUID();

  const res = await client.query<Row>(
    `INSERT INTO person_field_assertion
       (id, workspace_id, person_id, field_name, field_value, source_connection_id,
        source_item_id, device_id, confidence, is_primary, user_confirmed, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      id,
      WORKSPACE_ID,
      personId,
      input.fieldName,
      JSON.stringify(input.fieldValue ?? null),
      input.sourceConnectionId ?? null,
      input.sourceItemId ?? null,
      deviceId,
      input.confidence ?? 1.0,
      input.isPrimary ?? false,
      input.userConfirmed ?? false,
    ],
  );

  const row = res.rows[0] ?? null;
  if (row) {
    // Replayable payload — the full row so a peer's applyFieldAssertion reconstructs it.
    await recordEvent(client, {
      entityType: 'person',
      entityId: personId,
      operation: 'field.asserted',
      payload: row,
    });
  }

  await deriveCanonicalField(client, personId, input.fieldName);
  return row;
}

/**
 * REMOTE apply (event-free): upsert a peer's assertion idempotently (ON CONFLICT id
 * DO NOTHING) and re-derive the canonical column so state converges. Redirects a
 * merged-away source person onto the live target. Replaying twice is a no-op.
 */
export async function applyFieldAssertion(
  client: QueryableClient,
  p: Row,
): Promise<{ applied: boolean; reason?: string }> {
  if (!p.id || !p.person_id || !p.field_name) {
    return { applied: false, reason: 'field.asserted missing id/person_id/field_name' };
  }
  const personId = await resolvePersonRedirect(client, p.person_id as string);
  await client.query(
    `INSERT INTO person_field_assertion
       (id, workspace_id, person_id, field_name, field_value, source_connection_id,
        source_item_id, device_id, confidence, is_primary, user_confirmed, superseded_at, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12, COALESCE($13::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING`,
    [
      p.id,
      (p.workspace_id as string) ?? WORKSPACE_ID,
      personId,
      p.field_name,
      JSON.stringify(p.field_value ?? null),
      p.source_connection_id ?? null,
      p.source_item_id ?? null,
      p.device_id ?? null,
      p.confidence ?? 1.0,
      p.is_primary ?? false,
      p.user_confirmed ?? false,
      p.superseded_at ?? null,
      p.created_at ?? null,
    ],
  );
  await deriveCanonicalField(client, personId, p.field_name as string);
  return { applied: true };
}

/**
 * Pick the winning assertion(s) for one field and write the value back to the
 * canonical person column, keeping existing reads correct.
 *
 * >>> EXTENSION POINT (MIN-936): the SELECTION POLICY below is deliberately the
 * BORING default — prefer user_confirmed, then is_primary, then highest confidence,
 * then most-recent created_at. Refine it here (e.g. source trust, recency decay,
 * per-field rules). Multi-value fields are the set-union of all live values. <<<
 *
 * Returns the derived canonical value, or undefined for an unknown field_name.
 */
export async function deriveCanonicalField(
  client: QueryableClient,
  personId: string,
  fieldName: string,
): Promise<unknown> {
  if (MULTI_VALUE_FIELDS.has(fieldName)) {
    const rows = await client.query<{ field_value: unknown }>(
      `SELECT field_value FROM person_field_assertion
        WHERE workspace_id = $1 AND person_id = $2 AND field_name = $3 AND superseded_at IS NULL`,
      [WORKSPACE_ID, personId, fieldName],
    );
    // Set-union, case-insensitively de-duplicated, first-seen value preserved.
    const seen = new Map<string, string>();
    for (const r of rows.rows) {
      const arr = Array.isArray(r.field_value) ? (r.field_value as unknown[]) : [];
      for (const v of arr) {
        if (typeof v === 'string' && v.length > 0) {
          const key = v.toLowerCase();
          if (!seen.has(key)) seen.set(key, v);
        }
      }
    }
    const union = [...seen.values()];
    await client.query(
      `UPDATE person SET ${fieldName} = $3::jsonb WHERE workspace_id = $1 AND id = $2`,
      [WORKSPACE_ID, personId, JSON.stringify(union)],
    );
    return union;
  }

  if (SINGLE_VALUE_FIELDS.has(fieldName)) {
    const win = await client.query<{ field_value: unknown }>(
      `SELECT field_value FROM person_field_assertion
        WHERE workspace_id = $1 AND person_id = $2 AND field_name = $3 AND superseded_at IS NULL
        ORDER BY user_confirmed DESC, is_primary DESC, confidence DESC, created_at DESC
        LIMIT 1`,
      [WORKSPACE_ID, personId, fieldName],
    );
    if (win.rowCount === 0) return undefined; // nothing asserted yet — leave column as-is
    const value = win.rows[0]!.field_value; // jsonb scalar → JS string/null
    await client.query(
      `UPDATE person SET ${fieldName} = $3 WHERE workspace_id = $1 AND id = $2`,
      [WORKSPACE_ID, personId, value],
    );
    return value;
  }

  // Unknown field — no canonical column to derive.
  return undefined;
}

/**
 * All assertions for a person, sorted by field then by the same winner-first order
 * the selector uses. Powers GET /api/people/:id/assertions (provenance surface).
 */
export async function getAssertions(client: QueryableClient, personId: string): Promise<Row[]> {
  const r = await client.query<Row>(
    `SELECT id, person_id, field_name, field_value, source_connection_id, source_item_id,
            device_id, confidence, is_primary, user_confirmed, superseded_at, created_at
       FROM person_field_assertion
      WHERE workspace_id = $1 AND person_id = $2
      ORDER BY field_name ASC, user_confirmed DESC, is_primary DESC, confidence DESC, created_at DESC`,
    [WORKSPACE_ID, personId],
  );
  return r.rows;
}
