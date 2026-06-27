/**
 * Contact group + snapshot sharing routes (MIN-938).
 *
 * Thin route layer — business logic lives in sync/sharing.ts (buildBundle,
 * importBundle). All mutations use withSyncTxn so the data change and its
 * sync event are atomic.
 *
 * Route order matters: POST /import is registered BEFORE /:id routes so the
 * literal path segment 'import' is not captured as a group id.
 */

import { Router } from 'express';
import { z } from 'zod';
import { query, pool, WORKSPACE_ID } from '../db.js';
import { withSyncTxn, recordEvent } from '../sync/events.js';
import { buildBundle, importBundle } from '../sync/sharing.js';

export const groupsRouter = Router();

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateGroupBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const AddMembersBody = z.object({
  /** One or more person UUIDs to add. Existing members are silently skipped. */
  person_ids: z.array(z.string().uuid()).min(1),
});

const ExportBody = z.object({
  exclude_fields: z.array(z.string()).optional(),
  include_sensitive: z.boolean().optional(),
  /** Free-form identifier for the sharer embedded in the bundle. */
  shared_by: z.string().optional(),
});

const BundlePersonSchema = z.object({
  external_id: z.string().optional(),
  fields: z.record(z.unknown()),
  topics: z.array(z.string()).optional(),
});

const BundleSchema = z.object({
  version: z.literal('1'),
  mode: z.literal('snapshot'),
  shared_by: z.string(),
  shared_at: z.string(),
  source_workspace_id: z.string(),
  people: z.array(BundlePersonSchema),
});

// ─── POST /api/groups — create a group ───────────────────────────────────────

groupsRouter.post('/', async (req, res) => {
  const body = CreateGroupBody.parse(req.body);
  const group = await withSyncTxn(async (client) => {
    const r = await client.query(
      `INSERT INTO contact_group (workspace_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [WORKSPACE_ID, body.name, body.description ?? null],
    );
    const row = r.rows[0];
    await recordEvent(client, {
      entityType: 'contact_group',
      entityId: row.id as string,
      operation: 'group.created',
      payload: row,
    });
    return row;
  });
  res.status(201).json({ group });
});

// ─── GET /api/groups — list groups with member counts ────────────────────────

groupsRouter.get('/', async (_req, res) => {
  const result = await query(
    `SELECT g.*, count(cgm.person_id)::int AS member_count
       FROM contact_group g
       LEFT JOIN contact_group_member cgm ON cgm.group_id = g.id
      WHERE g.workspace_id = $1
      GROUP BY g.id
      ORDER BY g.created_at DESC`,
    [WORKSPACE_ID],
  );
  res.json({ groups: result.rows });
});

// ─── POST /api/groups/import — import a share bundle ─────────────────────────
// Registered BEFORE /:id routes so 'import' is not captured as a group id.

groupsRouter.post('/import', async (req, res) => {
  const bundle = BundleSchema.parse(req.body);
  const result = await withSyncTxn((client) => importBundle(client, bundle));
  res.json(result);
});

// ─── POST /api/groups/:id/members — add people to a group ───────────────────

groupsRouter.post('/:id/members', async (req, res) => {
  const body = AddMembersBody.parse(req.body);
  const groupId = req.params.id;

  // Verify group exists in this workspace
  const check = await query(
    `SELECT id FROM contact_group WHERE id = $1 AND workspace_id = $2`,
    [groupId, WORKSPACE_ID],
  );
  if (!check.rowCount) return res.status(404).json({ error: 'not_found' });

  const added: unknown[] = [];
  await withSyncTxn(async (client) => {
    for (const personId of body.person_ids) {
      const r = await client.query(
        `INSERT INTO contact_group_member (group_id, person_id)
         VALUES ($1, $2)
         ON CONFLICT (group_id, person_id) DO NOTHING
         RETURNING *`,
        [groupId, personId],
      );
      if (r.rowCount && r.rows[0]) {
        await recordEvent(client, {
          entityType: 'contact_group',
          entityId: groupId,
          operation: 'group.member_added',
          payload: { group_id: groupId, person_id: personId },
        });
        added.push(r.rows[0]);
      }
    }
  });

  res.status(201).json({ added });
});

// ─── DELETE /api/groups/:id/members/:personId — remove a member ──────────────

groupsRouter.delete('/:id/members/:personId', async (req, res) => {
  const { id: groupId, personId } = req.params;
  // Workspace guard via sub-select on contact_group
  const result = await query(
    `DELETE FROM contact_group_member
      WHERE group_id  = $1
        AND person_id = $2
        AND group_id IN (
          SELECT id FROM contact_group WHERE workspace_id = $3
        )`,
    [groupId, personId, WORKSPACE_ID],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});

// ─── POST /api/groups/:id/export — build + return a share bundle ─────────────
// Pure read — see docs/contact-sharing.md for why no sync event is emitted here.

groupsRouter.post('/:id/export', async (req, res) => {
  const body = ExportBody.parse(req.body);
  const groupId = req.params.id;

  const check = await query(
    `SELECT id FROM contact_group WHERE id = $1 AND workspace_id = $2`,
    [groupId, WORKSPACE_ID],
  );
  if (!check.rowCount) return res.status(404).json({ error: 'not_found' });

  const bundle = await buildBundle(pool, groupId, body);
  res.json(bundle);
});
