/**
 * relationship_strength scoring job (MIN-1169, phase 1: recency x frequency
 * decay over interactions).
 *
 * relationship_strength is consumed by ranked queries but had no code that
 * ever computed it — it sat at its column default (0.000) on every person.
 * This job makes it real, computed PURELY from RolloMap's own `interaction`
 * rows. It deliberately consults no external signal and no other system:
 * RolloMap is open source now, and this is a self-contained feature that
 * works for any self-hoster out of the box (see MIN-1169 comment #1 — piping
 * in outside engagement signal is an explicit, separate, later phase-2
 * ticket, NOT this one).
 *
 * ─── FORMULA (v1 — simple and defensible, not a research project) ─────────
 * For every interaction a person participated in, compute a recency weight
 * that exponentially halves every HALF_LIFE_DAYS:
 *
 *   weight_i = 0.5 ^ (days_since_i / HALF_LIFE_DAYS)
 *            = exp(-ln(2) * days_since_i / HALF_LIFE_DAYS)
 *
 * A person's raw signal is the SUM of weights over all their interactions,
 * so both frequency (many interactions) and recency (large individual
 * weights) push it up — a person contacted often *and* recently scores
 * highest; a single ancient interaction decays toward (but never reaches)
 * zero; many recent interactions compound past what any single one could
 * contribute.
 *
 * raw is unbounded (0..infinity: e.g. 20 interactions all today sum to 20),
 * so it is squashed into [0, 1) with a saturating curve — rather than a hard
 * clip — so heavy engagement keeps separating gradually instead of every
 * "very active" person clustering at a maxed-out 1.0:
 *
 *   relationship_strength = raw / (raw + SATURATION_K)
 *
 * SATURATION_K is the raw value that maps to a score of 0.5 — i.e. roughly
 * SATURATION_K interactions near full (recent) weight is "the midpoint of
 * strong." People with zero interactions never enter the sum and score 0
 * (never-contacted != a relationship that decayed to nothing — see AC2).
 *
 * ─── TUNING (do this, but not now) ─────────────────────────────────────────
 * The two constants below are the ONE place to adjust after eyeballing
 * real output against intuition (see HALF_LIFE_DAYS / SATURATION_K). That
 * post-hoc tuning pass is explicitly out of scope for getting this job
 * built — ship with these documented defaults.
 *
 * ─── DETERMINISM / IDEMPOTENCY ─────────────────────────────────────────────
 * The score is a pure function of interaction rows and "now" at run time —
 * no random or externally-sourced input. Re-running with unchanged
 * interaction data at (effectively) the same moment reproduces byte-identical
 * scores (rows whose 3-decimal rounded score didn't change are skipped
 * entirely, so a same-day re-run is also a no-op: no writes, no events).
 * Running again after real time passes naturally reflects further decay —
 * that is the intended behavior, not a violation of idempotency.
 *
 * ─── SYNC ───────────────────────────────────────────────────────────────
 * Writes go through the same withSyncTxn/recordEvent primitives as the
 * PATCH /api/people/:id handler, emitting one person.updated event per
 * changed row so peers converge (relationship_strength is already carried
 * in the person sync payload — see sync/apply.ts applyPerson). Unlike
 * backfill-title-from-summary.ts, this does NOT need to route around
 * assertProvidedFields: relationship_strength is a derived column, not a
 * field.ASSERTABLE_FIELDS / FIELD_RESOLUTION entry (see
 * sync/conflict-policy.ts), so there's no provenance/assertion concern —
 * a plain column overwrite (what applyPerson already does for every
 * person.updated event) is exactly right for a recomputed derived value.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx src/score-relationship-strength.ts
 */
import { pool, WORKSPACE_ID } from './db.js';
import { recordEvent, withSyncTxn } from './sync/events.js';

// ─── TUNABLE CONSTANTS — the one place to edit for the post-hoc tuning pass ─
/**
 * Days for a single interaction's recency weight to halve. 180 (~6 months)
 * was chosen by checking against this workspace's real interaction age
 * distribution (mostly a multi-year LinkedIn/import history with sparse
 * recent activity): 60 days made ~90% of ever-contacted people round to the
 * same 0.000 as never-contacted people at the column's 3-decimal precision,
 * which erases the frequency signal an interaction_count-32 person should
 * still carry. 180 keeps last-year contact meaningfully visible while still
 * fading multi-year-old activity toward zero.
 */
const HALF_LIFE_DAYS = 180;
/** Raw (pre-normalization) decayed-interaction sum that maps to a 0.5 score. */
const SATURATION_K = 3;

interface ScoredRow {
  id: string;
  display_name: string;
  interaction_count: number;
  last_seen_at: string | null;
  old_score: string; // NUMERIC comes back as string
  new_score: string;
}

const main = async () => {
  // HALF_LIFE_DAYS / SATURATION_K are trusted constants defined above (not
  // user input), so they're safely interpolated directly into the SQL text.
  const { rows } = await pool.query<ScoredRow>(
    `WITH person_raw AS (
       SELECT ip.person_id,
              sum(
                exp(
                  -ln(2)
                  * greatest(extract(epoch FROM (now() - i.occurred_at)) / 86400.0, 0)
                  / ${HALF_LIFE_DAYS}
                )
              ) AS raw_score
         FROM interaction i
         JOIN interaction_participant ip ON ip.interaction_id = i.id
        WHERE i.workspace_id = $1
        GROUP BY ip.person_id
     )
     SELECT p.id, p.display_name, p.interaction_count, p.last_seen_at,
            p.relationship_strength::text AS old_score,
            round(
              (coalesce(pr.raw_score, 0) / (coalesce(pr.raw_score, 0) + ${SATURATION_K}))::numeric,
              3
            )::text AS new_score
       FROM person p
       LEFT JOIN person_raw pr ON pr.person_id = p.id
      WHERE p.workspace_id = $1`,
    [WORKSPACE_ID],
  );

  console.log(
    `[score-relationship-strength] ${rows.length} people in workspace ` +
      `(half_life=${HALF_LIFE_DAYS}d, saturation_k=${SATURATION_K})`,
  );

  let updated = 0;
  let unchanged = 0;
  const changes: { name: string; old: number; next: number }[] = [];

  await withSyncTxn(async (client) => {
    for (const row of rows) {
      const oldScore = Number(row.old_score);
      const newScore = Number(row.new_score);
      if (oldScore === newScore) {
        unchanged++;
        continue;
      }

      // Re-check the score is still what we computed it from at write time
      // (defensive idempotency, same pattern as backfill-title-from-summary.ts).
      const result = await client.query(
        `UPDATE person SET relationship_strength = $1
          WHERE id = $2 AND relationship_strength IS DISTINCT FROM $1
         RETURNING *`,
        [newScore, row.id],
      );
      if (result.rowCount === 0) continue;

      const updatedRow = result.rows[0];
      await recordEvent(client, {
        entityType: 'person',
        entityId: updatedRow.id,
        operation: 'person.updated',
        payload: updatedRow,
      });
      updated++;
      changes.push({ name: row.display_name, old: oldScore, next: newScore });
    }
  });

  // Small drift summary so a run's effect is visible at a glance.
  const risers = [...changes]
    .filter(c => c.next > c.old)
    .sort((a, b) => (b.next - b.old) - (a.next - a.old))
    .slice(0, 5);
  const fallers = [...changes]
    .filter(c => c.next < c.old)
    .sort((a, b) => (a.next - a.old) - (b.next - b.old))
    .slice(0, 5);

  if (risers.length) {
    console.log('[score-relationship-strength] top risers:');
    for (const c of risers) {
      console.log(`  ${c.name}: ${c.old.toFixed(3)} -> ${c.next.toFixed(3)}`);
    }
  }
  if (fallers.length) {
    console.log('[score-relationship-strength] top fallers:');
    for (const c of fallers) {
      console.log(`  ${c.name}: ${c.old.toFixed(3)} -> ${c.next.toFixed(3)}`);
    }
  }

  console.log(`[score-relationship-strength] done — updated ${updated}, unchanged ${unchanged}`);
  await pool.end();
};

main().catch((err) => {
  console.error('[score-relationship-strength] failed', err);
  process.exit(1);
});
