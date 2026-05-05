import { Router } from 'express';
import { z } from 'zod';
import { query, WORKSPACE_ID } from '../db.js';

export const queryRouter = Router();

// "Who would be interested in this?" — naive ranker over text + topics.
queryRouter.post('/people-for-idea', async (req, res) => {
  const Body = z.object({
    idea: z.string().min(1),
    limit: z.number().int().min(1).max(50).optional(),
    relationship_strength_min: z.number().min(0).max(1).optional(),
  });
  const { idea, limit = 10, relationship_strength_min = 0 } = Body.parse(req.body);

  const tsQuery = idea
    .split(/\s+/)
    .filter(w => w.length > 1)
    .map(w => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
    .map(w => `${w}:*`)
    .join(' | ') || idea;

  const result = await query(
    `WITH idea_topics AS (
       SELECT t.id, t.name,
              ts_rank_cd(t.tsv, to_tsquery('english', $2)) AS topic_rank
         FROM topic t
        WHERE t.workspace_id = $1 AND t.tsv @@ to_tsquery('english', $2)
     ),
     interaction_hits AS (
       SELECT ip.person_id,
              ts_rank_cd(i.tsv, to_tsquery('english', $2)) AS rank,
              i.id AS interaction_id, i.title, i.summary, i.occurred_at,
              row_number() OVER (PARTITION BY ip.person_id ORDER BY ts_rank_cd(i.tsv, to_tsquery('english', $2)) DESC, i.occurred_at DESC) AS rn
         FROM interaction i
         JOIN interaction_participant ip ON ip.interaction_id = i.id
        WHERE i.workspace_id = $1 AND i.tsv @@ to_tsquery('english', $2)
     ),
     person_topic_score AS (
       SELECT pt.person_id, sum(pt.confidence * it.topic_rank) AS topic_score,
              json_agg(DISTINCT it.name) AS matched_topics
         FROM person_topic pt JOIN idea_topics it ON it.id = pt.topic_id
        GROUP BY pt.person_id
     ),
     person_interaction_score AS (
       SELECT person_id, sum(rank) AS interaction_score,
              json_agg(json_build_object(
                'interaction_id', interaction_id,
                'title', title,
                'summary', summary,
                'occurred_at', occurred_at
              )) FILTER (WHERE rn <= 3) AS top_interactions
         FROM interaction_hits
        GROUP BY person_id
     ),
     summary_score AS (
       SELECT p.id AS person_id, ts_rank_cd(p.tsv, to_tsquery('english', $2)) AS summary_rank
         FROM person p
        WHERE p.workspace_id = $1 AND p.tsv @@ to_tsquery('english', $2)
     )
     SELECT p.id AS person_id, p.display_name, p.company, p.title, p.summary,
            p.relationship_strength, p.last_seen_at,
            coalesce(pts.topic_score, 0) AS topic_score,
            coalesce(pis.interaction_score, 0) AS interaction_score,
            coalesce(ss.summary_rank, 0) AS summary_score,
            coalesce(pts.matched_topics, '[]'::json) AS matched_topics,
            coalesce(pis.top_interactions, '[]'::json) AS evidence_interactions,
            (
              30 * least(coalesce(pts.topic_score, 0), 1.0) +
              20 * least(coalesce(pis.interaction_score, 0), 1.0) +
              15 * coalesce(p.relationship_strength, 0) +
              10 * least(coalesce(ss.summary_rank, 0), 1.0) +
              5  * (CASE WHEN p.last_seen_at > now() - interval '180 days' THEN 1 ELSE 0 END)
            ) AS score
       FROM person p
       LEFT JOIN person_topic_score pts ON pts.person_id = p.id
       LEFT JOIN person_interaction_score pis ON pis.person_id = p.id
       LEFT JOIN summary_score ss ON ss.person_id = p.id
      WHERE p.workspace_id = $1
        AND p.relationship_strength >= $3
        AND (pts.topic_score IS NOT NULL OR pis.interaction_score IS NOT NULL OR ss.summary_rank IS NOT NULL)
      ORDER BY score DESC
      LIMIT $4`,
    [WORKSPACE_ID, tsQuery, relationship_strength_min, limit],
  );

  res.json({
    idea,
    results: result.rows.map(r => ({
      person_id: r.person_id,
      name: r.display_name,
      company: r.company,
      title: r.title,
      summary: r.summary,
      relationship_strength: Number(r.relationship_strength),
      last_seen_at: r.last_seen_at,
      score: Number(r.score),
      confidence:
        r.score > 30 ? 'high' :
        r.score > 15 ? 'medium' : 'low',
      matched_topics: r.matched_topics,
      reason: buildReason(r),
      evidence: r.evidence_interactions,
    })),
  });
});

function buildReason(r: Record<string, unknown>): string {
  const parts: string[] = [];
  const matched = (r.matched_topics ?? []) as string[];
  if (Array.isArray(matched) && matched.length) {
    parts.push(`Linked to topics: ${matched.filter(Boolean).join(', ')}`);
  }
  if (Number(r.interaction_score) > 0) {
    parts.push('Past conversations match the idea');
  }
  if (Number(r.summary_score) > 0) {
    parts.push('Profile mentions related themes');
  }
  if (!parts.length) parts.push('Weak match — review evidence before reaching out.');
  return parts.join('. ') + '.';
}

// Person briefing — packages structured data into one payload.
queryRouter.post('/person-briefing', async (req, res) => {
  const Body = z.object({ person_id: z.string().uuid().optional(), name: z.string().optional() })
    .refine(b => b.person_id || b.name, { message: 'person_id or name required' });
  const body = Body.parse(req.body);

  const personRow = body.person_id
    ? await query(`SELECT * FROM person WHERE workspace_id = $1 AND id = $2`, [WORKSPACE_ID, body.person_id])
    : await query(
        `SELECT * FROM person WHERE workspace_id = $1
           AND (lower(display_name) = lower($2) OR lower(primary_email) = lower($2))
         ORDER BY relationship_strength DESC LIMIT 1`,
        [WORKSPACE_ID, body.name],
      );
  if (personRow.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  const person = personRow.rows[0];

  const [topics, interactions, openLoops, notes] = await Promise.all([
    query(
      `SELECT t.name, pt.confidence, pt.user_confirmed
         FROM person_topic pt JOIN topic t ON t.id = pt.topic_id
         WHERE pt.person_id = $1 ORDER BY pt.confidence DESC LIMIT 10`,
      [person.id],
    ),
    query(
      `SELECT i.id, i.title, i.summary, i.interaction_type, i.occurred_at
         FROM interaction i JOIN interaction_participant ip ON ip.interaction_id = i.id
         WHERE ip.person_id = $1 ORDER BY i.occurred_at DESC LIMIT 5`,
      [person.id],
    ),
    query(
      `SELECT id, description, due_date FROM commitment
         WHERE person_id = $1 AND status = 'open' ORDER BY due_date NULLS LAST`,
      [person.id],
    ),
    query(`SELECT body, created_at FROM note WHERE person_id = $1 ORDER BY created_at DESC LIMIT 5`, [person.id]),
  ]);

  const lastInteraction = interactions.rows[0];
  res.json({
    person_id: person.id,
    name: person.display_name,
    company: person.company,
    title: person.title,
    how_known: person.how_known,
    summary: person.summary,
    relationship_strength: Number(person.relationship_strength),
    last_seen_at: person.last_seen_at,
    first_seen_at: person.first_seen_at,
    interaction_count: person.interaction_count,
    last_interaction: lastInteraction ?? null,
    topics: topics.rows,
    open_loops: openLoops.rows,
    user_notes: notes.rows,
    recent_interactions: interactions.rows,
  });
});

// Generic full-text search across people, interactions, topics, notes.
queryRouter.post('/search', async (req, res) => {
  const Body = z.object({ q: z.string().min(1), limit: z.number().int().min(1).max(50).optional() });
  const { q, limit = 10 } = Body.parse(req.body);
  const tsQuery = q.split(/\s+/).filter(Boolean).map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).map(w => `${w}:*`).join(' | ') || q;

  const [people, interactions, topics, notes] = await Promise.all([
    query(
      `SELECT id, display_name, company, title, ts_rank_cd(tsv, to_tsquery('english', $2)) AS rank
         FROM person WHERE workspace_id = $1 AND tsv @@ to_tsquery('english', $2)
         ORDER BY rank DESC LIMIT $3`,
      [WORKSPACE_ID, tsQuery, limit],
    ),
    query(
      `SELECT id, title, summary, occurred_at, interaction_type,
              ts_rank_cd(tsv, to_tsquery('english', $2)) AS rank
         FROM interaction WHERE workspace_id = $1 AND tsv @@ to_tsquery('english', $2)
         ORDER BY rank DESC LIMIT $3`,
      [WORKSPACE_ID, tsQuery, limit],
    ),
    query(
      `SELECT id, name, description, ts_rank_cd(tsv, to_tsquery('english', $2)) AS rank
         FROM topic WHERE workspace_id = $1 AND tsv @@ to_tsquery('english', $2)
         ORDER BY rank DESC LIMIT $3`,
      [WORKSPACE_ID, tsQuery, limit],
    ),
    query(
      `SELECT id, body, person_id FROM note
         WHERE workspace_id = $1 AND to_tsvector('english', body) @@ to_tsquery('english', $2)
         LIMIT $3`,
      [WORKSPACE_ID, tsQuery, limit],
    ),
  ]);

  res.json({
    query: q,
    people: people.rows,
    interactions: interactions.rows,
    topics: topics.rows,
    notes: notes.rows,
  });
});

// Neglected relationships
queryRouter.get('/neglected', async (req, res) => {
  const days = Number((req.query.days as string) || 90);
  const result = await query(
    `SELECT id, display_name, company, title, last_seen_at, relationship_strength, interaction_count
       FROM person
      WHERE workspace_id = $1
        AND interaction_count > 0
        AND (last_seen_at IS NULL OR last_seen_at < now() - ($2 || ' days')::interval)
        AND relationship_strength >= 0.3
      ORDER BY relationship_strength DESC, last_seen_at ASC NULLS FIRST
      LIMIT 50`,
    [WORKSPACE_ID, days],
  );
  res.json({ days, people: result.rows });
});
