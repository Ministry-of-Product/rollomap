import { Router } from 'express';
import { z } from 'zod';
import { query, pool, WORKSPACE_ID } from '../db.js';
import { recordEvent, withSyncTxn } from '../sync/events.js';
import { tombstoneEntity } from '../sync/tombstone.js';
import { mergePeople, reverseMerge } from '../sync/merge.js';
import { assertField, getAssertions, getFieldConflicts, ASSERTABLE_FIELDS } from '../sync/assertions.js';

// Reads exclude tombstoned people (MIN-933): a deleted person keeps its
// canonical row until compaction, so every read path must filter it out.
const NOT_TOMBSTONED = `NOT EXISTS (
  SELECT 1 FROM entity_tombstone et
   WHERE et.workspace_id = p.workspace_id
     AND et.entity_type = 'person'
     AND et.entity_id = p.id
)`;

export const peopleRouter = Router();

const PersonInput = z.object({
  display_name: z.string().min(1),
  primary_email: z.string().email().nullable().optional(),
  company: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().url().nullable().optional(),
  summary: z.string().nullable().optional(),
  how_known: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional(),
  known_emails: z.array(z.string()).optional(),
  known_phones: z.array(z.string()).optional(),
  user_pinned: z.boolean().optional(),
});

peopleRouter.get('/', async (req, res) => {
  const { q, topic, limit = '100' } = req.query as Record<string, string>;
  const params: unknown[] = [WORKSPACE_ID];
  let where = `p.workspace_id = $1 AND ${NOT_TOMBSTONED}`;

  if (q) {
    params.push(q);
    where += ` AND (p.tsv @@ plainto_tsquery('english', $${params.length}) OR p.display_name ILIKE '%' || $${params.length} || '%' OR p.primary_email ILIKE '%' || $${params.length} || '%')`;
  }
  if (topic) {
    params.push(topic);
    where += ` AND EXISTS (
      SELECT 1 FROM person_topic pt JOIN topic t ON t.id = pt.topic_id
      WHERE pt.person_id = p.id AND lower(t.name) = lower($${params.length})
    )`;
  }
  params.push(Math.min(Number(limit) || 100, 5000));

  const result = await query(
    `SELECT p.*,
            (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'confidence', pt.confidence))
               FROM person_topic pt JOIN topic t ON t.id = pt.topic_id
               WHERE pt.person_id = p.id) AS topics
     FROM person p
     WHERE ${where}
     ORDER BY p.user_pinned DESC, p.relationship_strength DESC, p.display_name ASC
     LIMIT $${params.length}`,
    params,
  );
  res.json({ people: result.rows });
});

// Merge history (MIN-934) — lightest debugging/correction surface: list the
// person_merge records (most recent first), optionally filtered by ?person_id=
// (matches either side of a merge). Registered BEFORE GET /:id so 'merges' is not
// captured as a person id.
peopleRouter.get('/merges', async (req, res) => {
  const { person_id } = req.query as Record<string, string>;
  const params: unknown[] = [WORKSPACE_ID];
  let where = 'workspace_id = $1';
  if (person_id) {
    params.push(person_id);
    where += ` AND (source_person_id = $2 OR target_person_id = $2)`;
  }
  const result = await query(
    `SELECT id, source_person_id, target_person_id, merge_event_id, created_by_device_id,
            created_at, reversed_at, reversed_by_device_id
       FROM person_merge WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
    params,
  );
  res.json({ merges: result.rows });
});

peopleRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  const person = await query(
    `SELECT * FROM person p WHERE p.workspace_id = $1 AND p.id = $2 AND ${NOT_TOMBSTONED}`,
    [WORKSPACE_ID, id],
  );
  if (person.rowCount === 0) return res.status(404).json({ error: 'not_found' });

  const [topics, interactions, notes, deepDives, commitments, identities] = await Promise.all([
    query(
      `SELECT t.id, t.name, pt.confidence, pt.evidence_count, pt.user_confirmed, pt.last_evidence_at
         FROM person_topic pt JOIN topic t ON t.id = pt.topic_id
         WHERE pt.person_id = $1 ORDER BY pt.confidence DESC`,
      [id],
    ),
    query(
      `SELECT i.* FROM interaction i
         JOIN interaction_participant ip ON ip.interaction_id = i.id
         WHERE ip.person_id = $1
         ORDER BY i.occurred_at DESC LIMIT 100`,
      [id],
    ),
    query(
      `SELECT * FROM note WHERE person_id = $1 AND kind = 'note' ORDER BY created_at DESC`,
      [id],
    ),
    query(
      `SELECT * FROM note WHERE person_id = $1 AND kind = 'deep_dive' ORDER BY created_at DESC`,
      [id],
    ),
    query(
      `SELECT * FROM commitment WHERE person_id = $1 ORDER BY status ASC, created_at DESC`,
      [id],
    ),
    query(
      `SELECT * FROM person_identity WHERE person_id = $1`,
      [id],
    ),
  ]);

  res.json({
    person: person.rows[0],
    topics: topics.rows,
    interactions: interactions.rows,
    notes: notes.rows,
    deep_dives: deepDives.rows,
    commitments: commitments.rows,
    identities: identities.rows,
  });
});

peopleRouter.post('/', async (req, res) => {
  const data = PersonInput.parse(req.body);
  const person = await withSyncTxn(async (client) => {
    const result = await client.query(
      `INSERT INTO person (workspace_id, display_name, primary_email, company, title, linkedin_url, summary, how_known, aliases, known_emails, known_phones, user_pinned)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)
       RETURNING *`,
      [
        WORKSPACE_ID,
        data.display_name,
        data.primary_email ?? null,
        data.company ?? null,
        data.title ?? null,
        data.linkedin_url ?? null,
        data.summary ?? null,
        data.how_known ?? null,
        JSON.stringify(data.aliases ?? []),
        JSON.stringify(data.known_emails ?? []),
        JSON.stringify(data.known_phones ?? []),
        data.user_pinned ?? false,
      ],
    );
    const row = result.rows[0];
    await recordEvent(client, {
      entityType: 'person',
      entityId: row.id,
      operation: 'person.created',
      payload: row,
    });
    // Manual edits create user_confirmed assertions (MIN-935): record the provenance
    // of each provided contact field IN ADDITION to the canonical column above. The
    // canonical column is then derived (the just-created user_confirmed assertion
    // wins), so reads are unchanged.
    await assertProvidedFields(client, row.id, data);
    return row;
  });
  res.status(201).json({ person });
});

/**
 * Write a user_confirmed (confidence 1.0, local-device) assertion for each provided
 * contact field of a manual create/edit. Skips null/undefined values so an omitted
 * field doesn't null out (or supersede) a column.
 */
async function assertProvidedFields(
  client: Parameters<typeof assertField>[0],
  personId: string,
  data: Record<string, unknown>,
): Promise<void> {
  for (const field of ASSERTABLE_FIELDS) {
    if (field in data && data[field] !== undefined && data[field] !== null) {
      await assertField(client, {
        personId,
        fieldName: field,
        fieldValue: data[field],
        userConfirmed: true,
        confidence: 1.0,
      });
    }
  }
}

peopleRouter.patch('/:id', async (req, res) => {
  const data = PersonInput.partial().parse(req.body);
  const fields: string[] = [];
  const params: unknown[] = [WORKSPACE_ID, req.params.id];
  for (const [k, v] of Object.entries(data)) {
    params.push(
      ['aliases', 'known_emails', 'known_phones'].includes(k) ? JSON.stringify(v) : v,
    );
    fields.push(`${k} = $${params.length}`);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'no_fields' });
  const person = await withSyncTxn(async (client) => {
    const result = await client.query(
      `UPDATE person SET ${fields.join(', ')} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      params,
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    await recordEvent(client, {
      entityType: 'person',
      entityId: row.id,
      operation: 'person.updated',
      payload: row,
    });
    // Manual edits create user_confirmed assertions (MIN-935) — see POST / above.
    await assertProvidedFields(client, row.id, data);
    return row;
  });
  if (!person) return res.status(404).json({ error: 'not_found' });
  res.json({ person });
});

// Provenance surface (MIN-935): per-field assertions for a person, with their
// source/device/confidence/user_confirmed, sorted by field then winner-first. Lets
// the UI/API show WHERE each contact field came from and which competing values exist.
//
// MIN-936: also returns a computed `conflicts` section — for each single-value
// canonical field with >1 distinct competing values and no user-confirmed winner,
// the deterministic winner + every competing claim, flagged needs_review. (Computed,
// not stored.) Surfaced HERE rather than a separate GET /conflicts so a client gets
// provenance + the "needs review" signal in one round-trip.
peopleRouter.get('/:id/assertions', async (req, res) => {
  const [assertions, conflicts] = await Promise.all([
    getAssertions(pool, req.params.id),
    getFieldConflicts(pool, req.params.id),
  ]);
  res.json({ assertions, conflicts });
});

peopleRouter.delete('/:id', async (req, res) => {
  // Tombstone instead of hard-deleting (MIN-933): keep the canonical row, write
  // an entity_tombstone, and emit a 'person.deleted' (= "tombstoned") event so
  // peers don't resurrect the row. Response shape ({ deleted }) is unchanged:
  // deleted=1 when a live person was tombstoned, 0 if it was missing/already gone.
  const deleted = await withSyncTxn(async (client) => {
    const live = await client.query(
      `SELECT 1 FROM person p WHERE p.workspace_id = $1 AND p.id = $2 AND ${NOT_TOMBSTONED}`,
      [WORKSPACE_ID, req.params.id],
    );
    if ((live.rowCount ?? 0) === 0) return 0;
    await tombstoneEntity(client, { entityType: 'person', entityId: req.params.id });
    return 1;
  });
  res.json({ deleted });
});

// Attach a topic to a person.
peopleRouter.post('/:id/topics', async (req, res) => {
  const Body = z.object({ topic_id: z.string().uuid().optional(), topic_name: z.string().optional(), confidence: z.number().min(0).max(1).optional(), user_confirmed: z.boolean().optional() })
    .refine(b => b.topic_id || b.topic_name, { message: 'topic_id or topic_name required' });
  const body = Body.parse(req.body);

  const personTopic = await withSyncTxn(async (client) => {
    let topicId = body.topic_id;
    if (!topicId && body.topic_name) {
      const existing = await client.query(
        `SELECT id FROM topic WHERE workspace_id = $1 AND lower(name) = lower($2)`,
        [WORKSPACE_ID, body.topic_name],
      );
      if (existing.rowCount && existing.rows[0]) {
        topicId = existing.rows[0].id as string;
      } else {
        const created = await client.query(
          `INSERT INTO topic (workspace_id, name) VALUES ($1, $2) RETURNING id`,
          [WORKSPACE_ID, body.topic_name],
        );
        topicId = created.rows[0]!.id as string;
      }
    }

    const result = await client.query(
      `INSERT INTO person_topic (workspace_id, person_id, topic_id, confidence, user_confirmed)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, person_id, topic_id) DO UPDATE SET
         confidence = EXCLUDED.confidence,
         user_confirmed = EXCLUDED.user_confirmed,
         updated_at = now()
       RETURNING *`,
      [WORKSPACE_ID, req.params.id, topicId, body.confidence ?? 0.7, body.user_confirmed ?? true],
    );
    const row = result.rows[0];
    await recordEvent(client, {
      entityType: 'person_topic',
      entityId: req.params.id,
      operation: 'topic.linked',
      payload: row,
    });
    return row;
  });
  res.status(201).json({ person_topic: personTopic });
});

peopleRouter.delete('/:id/topics/:topicId', async (req, res) => {
  const result = await query(
    `DELETE FROM person_topic WHERE workspace_id = $1 AND person_id = $2 AND topic_id = $3`,
    [WORKSPACE_ID, req.params.id, req.params.topicId],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});

// Merge: move all references from `source_id` into `target_id`, then tombstone the
// source as a redirect (MIN-933/934). Delegates to the shared, reversible,
// sync-safe core in sync/merge.ts (same path apply.ts replays remote merges).
// Response shape ({ ok: true }) is preserved; we additionally return merge_id so
// callers can reverse it.
peopleRouter.post('/merge', async (req, res) => {
  const Body = z.object({ target_id: z.string().uuid(), source_id: z.string().uuid() });
  const { target_id, source_id } = Body.parse(req.body);
  if (target_id === source_id) return res.status(400).json({ error: 'same_id' });

  const { mergeId } = await withSyncTxn((client) =>
    mergePeople(client, { sourceId: source_id, targetId: target_id }),
  );
  res.json({ ok: true, merge_id: mergeId });
});

// Reverse a merge (MIN-934): un-tombstone the source, move its captured references
// back, and emit person.merge_reversed so peers replicate the reversal.
peopleRouter.post('/merges/:id/reverse', async (req, res) => {
  const result = await withSyncTxn((client) => reverseMerge(client, { mergeId: req.params.id }));
  if (!result) return res.status(404).json({ error: 'not_found_or_already_reversed' });
  res.json({ ok: true, source_id: result.sourceId, target_id: result.targetId });
});
