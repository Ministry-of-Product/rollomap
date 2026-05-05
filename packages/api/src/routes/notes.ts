import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID } from '../db.js';

export const notesRouter = Router();

notesRouter.get('/', async (req, res) => {
  const { person_id } = req.query as Record<string, string>;
  const params: unknown[] = [WORKSPACE_ID];
  let where = 'workspace_id = $1';
  if (person_id) {
    params.push(person_id);
    where += ` AND person_id = $${params.length}`;
  }
  const result = await query(
    `SELECT * FROM note WHERE ${where} ORDER BY created_at DESC`,
    params,
  );
  res.json({ notes: result.rows });
});

notesRouter.post('/', async (req, res) => {
  const Body = z.object({
    person_id: z.string().uuid().nullable().optional(),
    body: z.string().min(1),
  });
  const data = Body.parse(req.body);
  const result = await query(
    `INSERT INTO note (workspace_id, person_id, body) VALUES ($1, $2, $3) RETURNING *`,
    [WORKSPACE_ID, data.person_id ?? null, data.body],
  );
  res.status(201).json({ note: result.rows[0] });
});

notesRouter.delete('/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM note WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});
