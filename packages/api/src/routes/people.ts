import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID } from '../db.js';

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
  let where = 'p.workspace_id = $1';

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

peopleRouter.get('/:id', async (req, res) => {
  const { id } = req.params;
  const person = await query(
    `SELECT * FROM person WHERE workspace_id = $1 AND id = $2`,
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
  const result = await query(
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
  res.status(201).json({ person: result.rows[0] });
});

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
  const result = await query(
    `UPDATE person SET ${fields.join(', ')} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
    params,
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ person: result.rows[0] });
});

peopleRouter.delete('/:id', async (req, res) => {
  const result = await query(
    `DELETE FROM person WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, req.params.id],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});

// Attach a topic to a person.
peopleRouter.post('/:id/topics', async (req, res) => {
  const Body = z.object({ topic_id: z.string().uuid().optional(), topic_name: z.string().optional(), confidence: z.number().min(0).max(1).optional(), user_confirmed: z.boolean().optional() })
    .refine(b => b.topic_id || b.topic_name, { message: 'topic_id or topic_name required' });
  const body = Body.parse(req.body);

  let topicId = body.topic_id;
  if (!topicId && body.topic_name) {
    const existing = await query(
      `SELECT id FROM topic WHERE workspace_id = $1 AND lower(name) = lower($2)`,
      [WORKSPACE_ID, body.topic_name],
    );
    if (existing.rowCount && existing.rows[0]) {
      topicId = existing.rows[0].id as string;
    } else {
      const created = await query(
        `INSERT INTO topic (workspace_id, name) VALUES ($1, $2) RETURNING id`,
        [WORKSPACE_ID, body.topic_name],
      );
      topicId = created.rows[0]!.id as string;
    }
  }

  const result = await query(
    `INSERT INTO person_topic (workspace_id, person_id, topic_id, confidence, user_confirmed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, person_id, topic_id) DO UPDATE SET
       confidence = EXCLUDED.confidence,
       user_confirmed = EXCLUDED.user_confirmed,
       updated_at = now()
     RETURNING *`,
    [WORKSPACE_ID, req.params.id, topicId, body.confidence ?? 0.7, body.user_confirmed ?? true],
  );
  res.status(201).json({ person_topic: result.rows[0] });
});

peopleRouter.delete('/:id/topics/:topicId', async (req, res) => {
  const result = await query(
    `DELETE FROM person_topic WHERE workspace_id = $1 AND person_id = $2 AND topic_id = $3`,
    [WORKSPACE_ID, req.params.id, req.params.topicId],
  );
  res.json({ deleted: result.rowCount ?? 0 });
});

// Merge: move all references from `source_id` into `target_id`, then delete source.
peopleRouter.post('/merge', async (req, res) => {
  const Body = z.object({ target_id: z.string().uuid(), source_id: z.string().uuid() });
  const { target_id, source_id } = Body.parse(req.body);
  if (target_id === source_id) return res.status(400).json({ error: 'same_id' });

  const client = await (await import('../db.js')).pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO user_correction (workspace_id, entity_type, entity_id, correction_type, before_value)
       VALUES ($1,'person',$2,'merge',$3::jsonb)`,
      [WORKSPACE_ID, target_id, JSON.stringify({ merged_from: source_id })],
    );
    await client.query(
      `UPDATE interaction_participant SET person_id = $1 WHERE workspace_id = $3 AND person_id = $2`,
      [target_id, source_id, WORKSPACE_ID],
    );
    await client.query(
      `UPDATE note SET person_id = $1 WHERE workspace_id = $3 AND person_id = $2`,
      [target_id, source_id, WORKSPACE_ID],
    );
    await client.query(
      `UPDATE commitment SET person_id = $1 WHERE workspace_id = $3 AND person_id = $2`,
      [target_id, source_id, WORKSPACE_ID],
    );
    await client.query(
      `UPDATE person_identity SET person_id = $1 WHERE workspace_id = $3 AND person_id = $2`,
      [target_id, source_id, WORKSPACE_ID],
    );
    // Topics: ON CONFLICT keeps the higher confidence
    await client.query(
      `INSERT INTO person_topic (workspace_id, person_id, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed)
         SELECT workspace_id, $1, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed
           FROM person_topic WHERE workspace_id = $3 AND person_id = $2
       ON CONFLICT (workspace_id, person_id, topic_id) DO UPDATE
         SET confidence = GREATEST(person_topic.confidence, EXCLUDED.confidence),
             evidence_count = person_topic.evidence_count + EXCLUDED.evidence_count`,
      [target_id, source_id, WORKSPACE_ID],
    );
    await client.query(
      `DELETE FROM person_topic WHERE workspace_id = $1 AND person_id = $2`,
      [WORKSPACE_ID, source_id],
    );
    await client.query(
      `DELETE FROM person WHERE workspace_id = $1 AND id = $2`,
      [WORKSPACE_ID, source_id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});
