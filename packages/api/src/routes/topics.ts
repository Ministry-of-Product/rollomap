import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID } from '../db.js';

export const topicsRouter = Router();

topicsRouter.get('/', async (req, res) => {
  const { q } = req.query as Record<string, string>;
  const params: unknown[] = [WORKSPACE_ID];
  let where = 't.workspace_id = $1';
  if (q) {
    params.push(q);
    where += ` AND (t.tsv @@ plainto_tsquery('english', $${params.length}) OR t.name ILIKE '%' || $${params.length} || '%')`;
  }
  const result = await query(
    `SELECT t.*,
            (SELECT count(*) FROM person_topic pt WHERE pt.topic_id = t.id) AS person_count
     FROM topic t WHERE ${where}
     ORDER BY person_count DESC, t.name ASC`,
    params,
  );
  res.json({ topics: result.rows });
});

topicsRouter.get('/:id', async (req, res) => {
  const topic = await query(
    `SELECT * FROM topic WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  if (topic.rowCount === 0) return res.status(404).json({ error: 'not_found' });

  const people = await query(
    `SELECT p.id, p.display_name, p.company, p.title, pt.confidence, pt.user_confirmed, pt.last_evidence_at
       FROM person_topic pt JOIN person p ON p.id = pt.person_id
      WHERE pt.topic_id = $1
      ORDER BY pt.confidence DESC, p.display_name ASC`,
    [req.params.id],
  );

  res.json({ topic: topic.rows[0], people: people.rows });
});

topicsRouter.post('/', async (req, res) => {
  const Body = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
  });
  const data = Body.parse(req.body);
  try {
    const result = await query(
      `INSERT INTO topic (workspace_id, name, description, aliases)
       VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
      [WORKSPACE_ID, data.name, data.description ?? null, JSON.stringify(data.aliases ?? [])],
    );
    res.status(201).json({ topic: result.rows[0] });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      return res.status(409).json({ error: 'topic_exists' });
    }
    throw err;
  }
});

topicsRouter.delete('/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM topic WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});
