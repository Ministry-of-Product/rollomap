import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID, pool } from '../db.js';

export const sourcesRouter = Router();

// List source items
sourcesRouter.get('/items', async (req, res) => {
  const { q, limit = '100' } = req.query as Record<string, string>;
  const params: unknown[] = [WORKSPACE_ID];
  let where = 'workspace_id = $1';
  if (q) {
    params.push(q);
    where += ` AND tsv @@ plainto_tsquery('english', $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const result = await query(
    `SELECT id, provider, source_type, title, author, participants,
            created_at_source, ingested_at, processing_status, sensitivity_level,
            length(body) AS body_length
       FROM source_item WHERE ${where}
       ORDER BY coalesce(created_at_source, ingested_at) DESC
       LIMIT $${params.length}`,
    params,
  );
  res.json({ source_items: result.rows });
});

sourcesRouter.get('/items/:id', async (req, res) => {
  const result = await query(
    `SELECT * FROM source_item WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ source_item: result.rows[0] });
});

sourcesRouter.delete('/items/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM source_item WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});

// Bulk import: accept an array of source items + minimal extracted facts.
const ImportItem = z.object({
  provider: z.string().default('manual'),
  source_type: z.enum(['email', 'doc', 'meeting_note', 'calendar_event', 'linkedin', 'note']),
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  participants: z.array(z.string()).optional(),
  created_at_source: z.string().nullable().optional(),
  // optional people to upsert and attach as participants
  person_emails: z.array(z.string()).optional(),
});

sourcesRouter.post('/import', async (req, res) => {
  const Body = z.object({ items: z.array(ImportItem) });
  const { items } = Body.parse(req.body);

  const client = await pool.connect();
  let inserted = 0;
  let people_created = 0;
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const itemRow = await client.query(
        `INSERT INTO source_item (workspace_id, provider, source_type, title, body, author, participants, created_at_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
        [
          WORKSPACE_ID,
          item.provider,
          item.source_type,
          item.title ?? null,
          item.body ?? null,
          item.author ?? null,
          JSON.stringify(item.participants ?? []),
          item.created_at_source ?? null,
        ],
      );
      const sourceId = itemRow.rows[0].id as string;
      inserted++;

      const participantPersonIds: string[] = [];
      for (const email of item.person_emails ?? []) {
        const existing = await client.query(
          `SELECT id FROM person WHERE workspace_id = $1 AND lower(primary_email) = lower($2) LIMIT 1`,
          [WORKSPACE_ID, email],
        );
        let personId: string;
        if (existing.rowCount && existing.rows[0]) {
          personId = existing.rows[0].id as string;
        } else {
          const created = await client.query(
            `INSERT INTO person (workspace_id, display_name, primary_email)
             VALUES ($1, $2, $3) RETURNING id`,
            [WORKSPACE_ID, email.split('@')[0] ?? email, email],
          );
          personId = created.rows[0].id as string;
          people_created++;
          await client.query(
            `INSERT INTO person_identity (workspace_id, person_id, identity_type, identity_value)
             VALUES ($1, $2, 'email', $3) ON CONFLICT DO NOTHING`,
            [WORKSPACE_ID, personId, email.toLowerCase()],
          );
        }
        participantPersonIds.push(personId);
      }

      if (participantPersonIds.length > 0) {
        const interactionType =
          item.source_type === 'email' ? 'email' :
          item.source_type === 'meeting_note' ? 'meeting' :
          item.source_type === 'calendar_event' ? 'meeting' :
          item.source_type === 'doc' ? 'document_mention' : 'note';

        const ix = await client.query(
          `INSERT INTO interaction (workspace_id, source_item_id, interaction_type, title, summary, body, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6, coalesce($7::timestamptz, now()))
           RETURNING id`,
          [
            WORKSPACE_ID,
            sourceId,
            interactionType,
            item.title ?? null,
            item.body ? item.body.slice(0, 280) : null,
            item.body ?? null,
            item.created_at_source ?? null,
          ],
        );
        const interactionId = ix.rows[0].id as string;

        for (const personId of participantPersonIds) {
          await client.query(
            `INSERT INTO interaction_participant (workspace_id, interaction_id, person_id)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [WORKSPACE_ID, interactionId, personId],
          );
          await client.query(
            `UPDATE person SET interaction_count = interaction_count + 1,
                              last_seen_at = GREATEST(coalesce(last_seen_at, now()), coalesce($2::timestamptz, now())),
                              first_seen_at = LEAST(coalesce(first_seen_at, now()), coalesce($2::timestamptz, now()))
             WHERE workspace_id = $1 AND id = $3`,
            [WORKSPACE_ID, item.created_at_source ?? null, personId],
          );
        }
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ inserted, people_created });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});
