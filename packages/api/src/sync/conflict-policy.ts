/**
 * Centralized contact-sync conflict-resolution policy (MIN-936).
 *
 * This module is the SINGLE SOURCE OF TRUTH for how competing claims about a
 * person's fields are reconciled when two devices (or an import and a manual
 * edit) disagree. Everything else DELEGATES here so the policy can never drift:
 *   - assertions.ts deriveCanonicalField()  → field classification + winner order
 *   - assertions.ts getFieldConflicts()      → "needs review" conflict signal
 *   - apply.ts (person.created/updated)       → tombstone precedence rationale
 *   - merge.ts resolvePersonRedirect (used by apply paths) → merge redirect
 *
 * See docs/sync-conflict-policy.md for the prose version of these rules.
 *
 * ─── THE POLICY ──────────────────────────────────────────────────────────────
 *
 *  1. Additive multi-value fields (`union`): emails, phones, aliases, topics,
 *     groups. Every device's values are KEPT — the canonical value is the
 *     set-union. Nothing is ever dropped, so there is no conflict to resolve.
 *
 *  2. Single-value canonical fields (`primary-preserving`): company, title,
 *     display_name, linkedin_url, summary, primary_email. Competing assertions
 *     are PRESERVED (we never delete or supersede a losing row), so the value a
 *     device disagrees about stays queryable. The canonical column is the winner
 *     of a DETERMINISTIC selector (see SINGLE_VALUE_ORDER_SQL / compareAssertions):
 *       user_confirmed DESC, is_primary DESC, confidence DESC, created_at DESC,
 *       id ASC.
 *     The trailing `id ASC` is the load-bearing bit: for two GENUINELY CONCURRENT
 *     edits (same confirmation/primary/confidence/timestamp) created on different
 *     devices, created_at can tie or skew, so the assertion id — a UUID minted at
 *     origin and replicated verbatim — is the stable final tie-break. This makes
 *     the winner identical on every device regardless of the order events apply.
 *     When >1 distinct values compete with NO user-confirmed winner, the field is
 *     flagged needs-review (getFieldConflicts) rather than silently picking one.
 *
 *  3. Low-risk metadata (`lww`): how_known, user_pinned. Last-write-wins is
 *     acceptable because these are cheap, low-stakes, easily re-entered hints —
 *     not identity-bearing contact data. They still use the same deterministic
 *     selector (so devices converge), but the loser is NOT surfaced for review:
 *     a stale how_known simply being overwritten is not worth a user's attention.
 *
 *  4. Deletes/tombstones beat stale updates (delete-wins). A person.created or
 *     person.updated must never resurrect a tombstoned person, regardless of sync
 *     apply order — the delete is final once it exists. (Ordering rationale: a
 *     tombstone is only compacted away after every trusted device has acked past
 *     its delete event, so its mere presence means the delete is the latest known
 *     intent.) See tombstoneBlocksApply().
 *
 *  5. Merge redirects (merge-redirect). A reference to a merged-away SOURCE person
 *     is redirected onto the live TARGET via resolvePersonRedirect, so an update
 *     to a source lands on the target instead of being lost. apply.ts uses this in
 *     every reference path (identity/topic/note/interaction/assertion).
 */

export type ResolutionStrategy = 'union' | 'primary-preserving' | 'lww';

/**
 * The ONE field → strategy table. Also doubles as the WHITELIST of column names
 * deriveCanonicalField is allowed to interpolate into dynamic SQL (so the dynamic
 * UPDATE can't be an injection vector).
 */
export const FIELD_RESOLUTION: Record<string, ResolutionStrategy> = {
  // (1) additive multi-value → set-union
  aliases: 'union',
  known_emails: 'union',
  known_phones: 'union',
  // (2) single-value canonical → preserve competing, deterministic winner, flag review
  display_name: 'primary-preserving',
  primary_email: 'primary-preserving',
  company: 'primary-preserving',
  title: 'primary-preserving',
  linkedin_url: 'primary-preserving',
  summary: 'primary-preserving',
  // (3) low-risk metadata → last-write-wins, loser discarded, never flagged
  how_known: 'lww',
  user_pinned: 'lww',
};

/** Strategy for a field, or undefined if the field isn't policy-managed. */
export function resolutionFor(fieldName: string): ResolutionStrategy | undefined {
  return FIELD_RESOLUTION[fieldName];
}

/** Multi-value (set-union) field? */
export function isUnionField(fieldName: string): boolean {
  return FIELD_RESOLUTION[fieldName] === 'union';
}

/** Single-valued field (either preserve-competing or last-write-wins)? */
export function isSingleValueField(fieldName: string): boolean {
  const s = FIELD_RESOLUTION[fieldName];
  return s === 'primary-preserving' || s === 'lww';
}

/**
 * Low-risk metadata field whose conflicts are intentionally NOT surfaced for
 * review (last-write-wins is acceptable). Documented set: how_known, user_pinned.
 */
export function isLowRiskField(fieldName: string): boolean {
  return FIELD_RESOLUTION[fieldName] === 'lww';
}

/** Single-value fields whose competing values ARE preserved + surfaced for review. */
export function isPrimaryPreservingField(fieldName: string): boolean {
  return FIELD_RESOLUTION[fieldName] === 'primary-preserving';
}

/** Fields, by strategy — derived from the table so there is no second list to drift. */
export const UNION_FIELDS: readonly string[] = Object.keys(FIELD_RESOLUTION).filter(isUnionField);
export const SINGLE_VALUE_FIELD_NAMES: readonly string[] =
  Object.keys(FIELD_RESOLUTION).filter(isSingleValueField);

/**
 * Canonical winner ordering for single-value fields, as a SQL ORDER BY fragment.
 * MUST mirror compareAssertions() below. The trailing `id ASC` is the stable,
 * cross-device-deterministic final tie-break (see module header).
 */
export const SINGLE_VALUE_ORDER_SQL =
  'user_confirmed DESC, is_primary DESC, confidence DESC, created_at DESC, id ASC';

/** Minimal shape needed to rank an assertion (matches person_field_assertion rows). */
export interface AssertionLike {
  id: string;
  field_value: unknown;
  confidence: number | string;
  is_primary: boolean;
  user_confirmed: boolean;
  created_at: string | Date;
}

function toMillis(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/**
 * Total, deterministic order over competing assertions for ONE single-value field:
 * the winner sorts FIRST. Mirrors SINGLE_VALUE_ORDER_SQL exactly so the JS path
 * (getFieldConflicts, tests) and the SQL path (deriveCanonicalField) agree.
 * Returns <0 when `a` should win over `b`.
 */
export function compareAssertions(a: AssertionLike, b: AssertionLike): number {
  if (a.user_confirmed !== b.user_confirmed) return a.user_confirmed ? -1 : 1;
  if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
  const ca = Number(a.confidence);
  const cb = Number(b.confidence);
  if (ca !== cb) return cb - ca; // higher confidence first
  const ta = toMillis(a.created_at);
  const tb = toMillis(b.created_at);
  if (ta !== tb) return tb - ta; // more recent first
  // Stable, cross-device-identical final tie-break: assertion id (origin UUID).
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The winning assertion for a single-value field, or undefined if there are none. */
export function resolveSingleValue<T extends AssertionLike>(assertions: T[]): T | undefined {
  if (assertions.length === 0) return undefined;
  return [...assertions].sort(compareAssertions)[0];
}

/**
 * Tombstone precedence (delete-wins): given whether the target entity is
 * tombstoned, should a create/update be BLOCKED from applying? Always yes when a
 * tombstone exists — a delete is final wrt sync ordering and never resurrected.
 * Centralizes the rule apply.ts enforces so there is one documented source.
 */
export function tombstoneBlocksApply(isTombstoned: boolean): boolean {
  return isTombstoned;
}
