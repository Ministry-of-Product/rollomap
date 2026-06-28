import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID, pool } from '../db.js';
import { recordEvent } from '../sync/events.js';
import { assertField } from '../sync/assertions.js';
import {
  listConnections,
  createConnection,
  pauseConnection,
  resumeConnection,
  disconnectConnection,
  resyncConnection,
  removeSourceData,
  assertConnectionAcceptsImport,
} from '../sync/connectors.js';
import { withSyncTxn } from '../sync/events.js';

export const sourcesRouter = Router();

// ---------------------------------------------------------------------------
// Source item routes (pre-existing)
// ---------------------------------------------------------------------------

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

// source_item deletion is LOCAL-ONLY (MIN-933): source_items are never emitted
// as sync events — the import path records person/identity/interaction events
// but NOT source_item.created, and apply.ts has no source_item handler — so they
// don't replicate across devices and cannot be resurrected by a peer's stale
// push. There is therefore nothing to tombstone; a hard delete is correct here.
sourcesRouter.delete('/items/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM source_item WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});

// ---------------------------------------------------------------------------
// Connection routes (MIN-937)
// ---------------------------------------------------------------------------

/**
 * GET /connections — list all source connections with counts for traceability.
 *
 * Each connection row includes:
 *   provider, status, last_sync_at, last_sync_status, last_error
 *   source_item_count   — number of source_item rows tied to this connection
 *   source_assertion_count — number of source-backed (user_confirmed=false)
 *                            person_field_assertion rows tied to this connection
 */
sourcesRouter.get('/connections', async (_req, res) => {
  const client = await pool.connect();
  try {
    const connections = await listConnections(client);
    res.json({ connections });
  } finally {
    client.release();
  }
});

/**
 * POST /connections — create a new source connection.
 *
 * Body: { provider: string, config?: object }
 * Response: { connection: ConnectionRow }
 * Status: 201
 */
sourcesRouter.post('/connections', async (req, res) => {
  const Body = z.object({
    provider: z.string().min(1),
    config: z.record(z.unknown()).optional().default({}),
  });
  const { provider, config } = Body.parse(req.body);

  const conn = await withSyncTxn(async (client) => {
    return createConnection(client, provider, config);
  });
  res.status(201).json({ connection: conn });
});

// Helper: parse connection id and run lifecycle transition in a transaction.
function connectionAction(
  fn: (
    client: import('pg').PoolClient,
    id: string,
  ) => Promise<unknown>,
) {
  return async (req: import('express').Request, res: import('express').Response): Promise<void> => {
    const { id } = req.params as { id: string };
    try {
      const result = await withSyncTxn((client) => fn(client, id));
      res.json(result);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      const code = e.statusCode ?? 500;
      res.status(code).json({ error: e.message });
    }
  };
}

/**
 * POST /connections/:id/pause
 *
 * Transitions status active → paused. A paused connection's imports are
 * rejected (409) until the connection is resumed. Returns 409 if not active.
 */
sourcesRouter.post(
  '/connections/:id/pause',
  connectionAction(async (client, id) => {
    const conn = await pauseConnection(client, id);
    return { connection: conn };
  }),
);

/**
 * POST /connections/:id/resume
 *
 * Transitions status paused → active. Cannot resume a disconnected connection
 * (that requires a new POST /connections). Returns 409 if not paused.
 */
sourcesRouter.post(
  '/connections/:id/resume',
  connectionAction(async (client, id) => {
    const conn = await resumeConnection(client, id);
    return { connection: conn };
  }),
);

/**
 * POST /connections/:id/disconnect
 *
 * Transitions status active|paused → disconnected. A disconnected connection
 * cannot be resumed; the user must create a new one. Returns 409 if already
 * disconnected.
 */
sourcesRouter.post(
  '/connections/:id/disconnect',
  connectionAction(async (client, id) => {
    const conn = await disconnectConnection(client, id);
    return { connection: conn };
  }),
);

/**
 * POST /connections/:id/resync
 *
 * Control-model stub: stamps last_sync_at=now() and last_sync_status='ok'.
 * No real data is fetched here — that is the future adapter's job (see
 * docs/source-connectors.md for the adapter contract). Only allowed from
 * 'active' or 'error' status; returns 409 if paused/disconnected.
 */
sourcesRouter.post(
  '/connections/:id/resync',
  connectionAction(async (client, id) => {
    const conn = await resyncConnection(client, id);
    return { connection: conn };
  }),
);

/**
 * POST /connections/:id/remove-data
 *
 * Safely removes all source-derived data for the connection WITHOUT deleting
 * manually-confirmed contact data or person rows.
 *
 * What is deleted:
 *   - Every source_item whose source_connection_id = :id
 *   - Every person_field_assertion where user_confirmed=false AND
 *     source_connection_id = :id
 *
 * What is preserved:
 *   - All person rows (canonical contact records are never deleted)
 *   - All user_confirmed=true assertions (manual edits survive)
 *
 * After deletion, canonical person columns are re-derived so they fall back
 * to remaining/manual assertions (if any) or stay at their last value (if
 * no remaining assertions cover that field).
 *
 * Response: { source_items_removed, assertions_removed, persons_reprocessed }
 */
sourcesRouter.post(
  '/connections/:id/remove-data',
  connectionAction(async (client, id) => {
    return removeSourceData(client, id);
  }),
);

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

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

/**
 * POST /import
 *
 * Bulk-import source items.  Accepts an optional `connection_id` to associate
 * items with a specific source connection.  If provided:
 *   - The connection must exist (404 if not found).
 *   - The connection status must be 'active' or 'error' — a 'paused' or
 *     'disconnected' connection is rejected with HTTP 409.
 *   - Imported source_item rows carry the connection_id as source_connection_id.
 */
sourcesRouter.post('/import', async (req, res) => {
  const Body = z.object({
    items: z.array(ImportItem),
    connection_id: z.string().uuid().optional(),
  });
  const { items, connection_id } = Body.parse(req.body);

  const client = await pool.connect();
  let inserted = 0;
  let people_created = 0;
  try {
    await client.query('BEGIN');

    // Guard: if a connection_id is specified, verify it accepts imports.
    if (connection_id) {
      try {
        await assertConnectionAcceptsImport(client, connection_id);
      } catch (err) {
        await client.query('ROLLBACK');
        const e = err as Error & { statusCode?: number };
        return res.status(e.statusCode ?? 500).json({ error: e.message });
      }
    }

    for (const item of items) {
      const itemRow = await client.query(
        `INSERT INTO source_item (workspace_id, provider, source_type, title, body, author, participants, created_at_source, source_connection_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
        [
          WORKSPACE_ID,
          item.provider,
          item.source_type,
          item.title ?? null,
          item.body ?? null,
          item.author ?? null,
          JSON.stringify(item.participants ?? []),
          item.created_at_source ?? null,
          connection_id ?? null,
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
             VALUES ($1, $2, $3) RETURNING *`,
            [WORKSPACE_ID, email.split('@')[0] ?? email, email],
          );
          personId = created.rows[0].id as string;
          people_created++;
          await recordEvent(client, {
            entityType: 'person',
            entityId: personId,
            operation: 'person.created',
            payload: created.rows[0],
          });
          // Imports create SOURCE-BACKED assertions (MIN-935): user_confirmed=false,
          // tied to the source_item, so a later manual edit (user_confirmed=true)
          // wins the canonical column while this import value stays queryable for
          // provenance. We wire the fields the import actually populates on create —
          // primary_email and display_name. DEFERRED: company/title/linkedin/aliases/
          // phones are not extracted by this import path today, so there is nothing
          // to assert for them yet; wire them here once the importer extracts them.
          await assertField(client, {
            personId,
            fieldName: 'primary_email',
            fieldValue: email,
            sourceItemId: sourceId,
            sourceConnectionId: connection_id ?? null,
            userConfirmed: false,
            confidence: 1.0,
          });
          await assertField(client, {
            personId,
            fieldName: 'display_name',
            fieldValue: created.rows[0].display_name,
            sourceItemId: sourceId,
            sourceConnectionId: connection_id ?? null,
            userConfirmed: false,
            confidence: 1.0,
          });
          const identity = await client.query(
            `INSERT INTO person_identity (workspace_id, person_id, identity_type, identity_value)
             VALUES ($1, $2, 'email', $3) ON CONFLICT DO NOTHING RETURNING *`,
            [WORKSPACE_ID, personId, email.toLowerCase()],
          );
          if (identity.rowCount && identity.rows[0]) {
            await recordEvent(client, {
              entityType: 'person_identity',
              entityId: personId,
              operation: 'identity.added',
              payload: identity.rows[0],
            });
          }
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
           RETURNING *`,
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
        await recordEvent(client, {
          entityType: 'interaction',
          entityId: interactionId,
          operation: 'interaction.created',
          payload: { ...ix.rows[0], participant_ids: participantPersonIds },
        });

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
