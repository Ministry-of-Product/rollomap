import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID } from '../db.js';

export const commitmentsRouter = Router();

commitmentsRouter.get('/', async (req, res) => {
  const { status, person_id } = req.query as Record<string, string>;
  const params: unknown[] = [WORKSPACE_ID];
  let where = 'c.workspace_id = $1';
  if (status) {
    params.push(status);
    where += ` AND c.status = $${params.length}`;
  }
  if (person_id) {
    params.push(person_id);
    where += ` AND c.person_id = $${params.length}`;
  }
  const result = await query(
    `SELECT c.*, p.display_name AS person_name
       FROM commitment c LEFT JOIN person p ON p.id = c.person_id
      WHERE ${where}
      ORDER BY (c.status = 'open') DESC, c.due_date NULLS LAST, c.created_at DESC`,
    params,
  );
  res.json({ commitments: result.rows });
});

commitmentsRouter.post('/', async (req, res) => {
  const Body = z.object({
    person_id: z.string().uuid().nullable().optional(),
    interaction_id: z.string().uuid().nullable().optional(),
    description: z.string().min(1),
    due_date: z.string().nullable().optional(),
    status: z.enum(['open', 'done', 'dismissed']).optional(),
  });
  const data = Body.parse(req.body);
  const result = await query(
    `INSERT INTO commitment (workspace_id, person_id, interaction_id, description, due_date, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [WORKSPACE_ID, data.person_id ?? null, data.interaction_id ?? null, data.description, data.due_date ?? null, data.status ?? 'open'],
  );
  res.status(201).json({ commitment: result.rows[0] });
});

commitmentsRouter.patch('/:id', async (req, res) => {
  const Body = z.object({
    status: z.enum(['open', 'done', 'dismissed']).optional(),
    description: z.string().optional(),
    due_date: z.string().nullable().optional(),
  });
  const data = Body.parse(req.body);
  const fields: string[] = [];
  const params: unknown[] = [WORKSPACE_ID, req.params.id];
  for (const [k, v] of Object.entries(data)) {
    params.push(v);
    fields.push(`${k} = $${params.length}`);
  }
  if (!fields.length) return res.status(400).json({ error: 'no_fields' });
  const result = await query(
    `UPDATE commitment SET ${fields.join(', ')} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
    params,
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ commitment: result.rows[0] });
});

commitmentsRouter.delete('/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM commitment WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});
