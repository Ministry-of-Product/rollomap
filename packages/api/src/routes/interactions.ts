import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID, pool } from '../db.js';
import { recordEvent } from '../sync/events.js';

export const interactionsRouter = Router();

const InteractionInput = z.object({
  interaction_type: z.string().min(1),
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  occurred_at: z.string(),
  topics: z.array(z.string()).optional(),
  participant_ids: z.array(z.string().uuid()).optional(),
  source_item_id: z.string().uuid().nullable().optional(),
});

interactionsRouter.get('/', async (req, res) => {
  const { q, person_id, limit = '100' } = req.query as Record<string, string>;
  const params: unknown[] = [WORKSPACE_ID];
  let where = 'i.workspace_id = $1';
  if (q) {
    params.push(q);
    where += ` AND i.tsv @@ plainto_tsquery('english', $${params.length})`;
  }
  if (person_id) {
    params.push(person_id);
    where += ` AND EXISTS (SELECT 1 FROM interaction_participant ip WHERE ip.interaction_id = i.id AND ip.person_id = $${params.length})`;
  }
  params.push(Math.min(Number(limit) || 100, 500));

  const result = await query(
    `SELECT i.*,
            (SELECT json_agg(json_build_object('id', p.id, 'display_name', p.display_name))
               FROM interaction_participant ip JOIN person p ON p.id = ip.person_id
               WHERE ip.interaction_id = i.id) AS participants
     FROM interaction i
     WHERE ${where}
     ORDER BY i.occurred_at DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json({ interactions: result.rows });
});

interactionsRouter.get('/:id', async (req, res) => {
  const interaction = await query(
    `SELECT * FROM interaction WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  if (interaction.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  const participants = await query(
    `SELECT p.id, p.display_name, p.primary_email, ip.role
       FROM interaction_participant ip JOIN person p ON p.id = ip.person_id
      WHERE ip.interaction_id = $1`,
    [req.params.id],
  );
  const evidence = await query(
    `SELECT * FROM evidence WHERE interaction_id = $1`,
    [req.params.id],
  );
  res.json({
    interaction: interaction.rows[0],
    participants: participants.rows,
    evidence: evidence.rows,
  });
});

interactionsRouter.post('/', async (req, res) => {
  const data = InteractionInput.parse(req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO interaction (workspace_id, source_item_id, interaction_type, title, summary, body, occurred_at, topics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING *`,
      [
        WORKSPACE_ID,
        data.source_item_id ?? null,
        data.interaction_type,
        data.title ?? null,
        data.summary ?? null,
        data.body ?? null,
        data.occurred_at,
        JSON.stringify(data.topics ?? []),
      ],
    );
    const interaction = ins.rows[0];
    for (const personId of data.participant_ids ?? []) {
      await client.query(
        `INSERT INTO interaction_participant (workspace_id, interaction_id, person_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [WORKSPACE_ID, interaction.id, personId],
      );
      await client.query(
        `UPDATE person SET interaction_count = interaction_count + 1,
                          last_seen_at = GREATEST(coalesce(last_seen_at, $2::timestamptz), $2::timestamptz),
                          first_seen_at = LEAST(coalesce(first_seen_at, $2::timestamptz), $2::timestamptz)
         WHERE workspace_id = $1 AND id = $3`,
        [WORKSPACE_ID, data.occurred_at, personId],
      );
    }
    await recordEvent(client, {
      entityType: 'interaction',
      entityId: interaction.id,
      operation: 'interaction.created',
      payload: { ...interaction, participant_ids: data.participant_ids ?? [] },
    });
    await client.query('COMMIT');
    res.status(201).json({ interaction });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

interactionsRouter.delete('/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM interaction WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});
