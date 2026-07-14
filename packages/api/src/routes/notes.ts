import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID } from '../db.js';
import { recordEvent, withSyncTxn } from '../sync/events.js';

export const notesRouter = Router();

notesRouter.get('/', async (req, res) => {
  const { person_id, include_archived } = req.query as Record<string, string>;
  const params: unknown[] = [WORKSPACE_ID];
  let where = 'workspace_id = $1';
  if (person_id) {
    params.push(person_id);
    where += ` AND person_id = $${params.length}`;
  }
  // Notes are immutable + archivable: hide archived notes unless asked (?include_archived=1).
  if (include_archived !== '1' && include_archived !== 'true') {
    where += ' AND archived_at IS NULL';
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
    kind: z.enum(['note', 'deep_dive']).default('note'),
  });
  const data = Body.parse(req.body);
  const note = await withSyncTxn(async (client) => {
    const result = await client.query(
      `INSERT INTO note (workspace_id, person_id, body, kind) VALUES ($1, $2, $3, $4) RETURNING *`,
      [WORKSPACE_ID, data.person_id ?? null, data.body, data.kind],
    );
    const row = result.rows[0];
    await recordEvent(client, {
      entityType: 'note',
      entityId: row.id,
      operation: 'note.created',
      payload: row,
    });
    return row;
  });
  res.status(201).json({ note });
});

// Notes are immutable: "deleting" a note soft-archives it (sets archived_at)
// rather than removing the row. This preserves the audit trail and replicates
// across devices as the `note.deleted` wire tombstone. Idempotent: archiving an
// already-archived note leaves archived_at unchanged and records no new event.
notesRouter.delete('/:id', async (req, res) => {
  const archived = await withSyncTxn(async (client) => {
    const result = await client.query(
      `UPDATE note SET archived_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL
        RETURNING *`,
      [WORKSPACE_ID, req.params.id],
    );
    if (result.rowCount === 0) return null; // not found, or already archived
    const row = result.rows[0];
    await recordEvent(client, {
      entityType: 'note',
      entityId: row.id,
      operation: 'note.archived',
      payload: { id: row.id, workspace_id: row.workspace_id, archived_at: row.archived_at },
    });
    return row;
  });
  res.json({ archived: archived ? 1 : 0 });
});
