import { Router } from 'express';
import { query, WORKSPACE_ID } from '../db.js';

export const statsRouter = Router();

statsRouter.get('/', async (_req, res) => {
  const result = await query(
    `SELECT
       (SELECT count(*) FROM person WHERE workspace_id = $1) AS people,
       (SELECT count(*) FROM interaction WHERE workspace_id = $1) AS interactions,
       (SELECT count(*) FROM topic WHERE workspace_id = $1) AS topics,
       (SELECT count(*) FROM source_item WHERE workspace_id = $1) AS source_items,
       (SELECT count(*) FROM commitment WHERE workspace_id = $1 AND status = 'open') AS open_commitments,
       (SELECT count(*) FROM note WHERE workspace_id = $1) AS notes`,
    [WORKSPACE_ID],
  );
  res.json(result.rows[0]);
});
