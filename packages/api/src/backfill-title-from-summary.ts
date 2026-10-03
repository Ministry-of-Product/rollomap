/**
 * One-off backfill (MIN-1512): populate person.title from the `Position:` line
 * left behind in `summary` by the LinkedIn connections import.
 *
 * Example summary content:
 *   Position: VP, Product - Omnichannel Solutions
 *
 *   Connected On: 22 Jul 2021
 *
 * Two traps, both verified against production data before writing this:
 *  1. Postgres `.` matches newline, so an unanchored capture like `(.*)` after
 *     `Position:` swallows the rest of the summary across blank lines (Connected
 *     On:, phone-contact addresses, etc). The capture below is anchored to
 *     `[^\n]*` so it stops at the end of the Position: line.
 *  2. The `— From LinkedIn export —` header some summaries carry is the
 *     MINORITY case (~100 of 1,039) — most summaries open with a bare
 *     `Position:` line. This does NOT key off that header; it matches
 *     `Position:` directly, wherever it appears in the summary.
 *
 * Safety:
 *  - Only writes rows where title is currently null/empty — an existing title
 *    is NEVER overwritten (conflicting rows are left exactly as-is).
 *  - `summary` is provenance and is never modified.
 *  - Writes the column with direct SQL and emits one `person.updated` sync
 *    event per changed row (same withSyncTxn/recordEvent primitives as the
 *    PATCH /api/people/:id handler) — deliberately WITHOUT going through
 *    assertProvidedFields, so this does not stamp 1,000+ machine-parsed titles
 *    as max-confidence user_confirmed assertions that would permanently
 *    outrank a future LinkedIn re-import or manual correction. See
 *    packages/api/src/sync/conflict-policy.ts (title is primary-preserving).
 *  - Idempotent: re-running finds nothing left to do, since the SELECT below
 *    only ever targets rows with a still-empty title.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx src/backfill-title-from-summary.ts
 */
import { pool, WORKSPACE_ID } from './db.js';
import { recordEvent, withSyncTxn } from './sync/events.js';

// Captures the rest of the `Position:` line only — see trap (1) above.
const POSITION_LINE_RE = /Position:[ \t]*([^\n]*)/;

interface CandidateRow {
  id: string;
  summary: string;
}

const main = async () => {
  const { rows } = await pool.query<CandidateRow>(
    `SELECT id, summary FROM person
     WHERE workspace_id = $1
       AND (title IS NULL OR title = '')
       AND summary ~ 'Position:'`,
    [WORKSPACE_ID],
  );

  console.log(`[backfill-title] ${rows.length} candidate rows (empty title, summary has a Position: line)`);

  let updated = 0;
  let emptyParse = 0;

  await withSyncTxn(async (client) => {
    for (const row of rows) {
      const title = row.summary.match(POSITION_LINE_RE)?.[1]?.trim();
      if (!title) {
        emptyParse++;
        continue;
      }

      // Re-check title is still empty at write time (defensive idempotency —
      // the outer SELECT already filtered on this, but this keeps a re-run
      // safe even if something else wrote a title in between).
      const result = await client.query(
        `UPDATE person SET title = $1
         WHERE id = $2 AND (title IS NULL OR title = '')
         RETURNING *`,
        [title, row.id],
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
    }
  });

  console.log(`[backfill-title] done — updated ${updated}, empty-parse skipped ${emptyParse}`);
  await pool.end();
};

main().catch((err) => {
  console.error('[backfill-title] failed', err);
  process.exit(1);
});
