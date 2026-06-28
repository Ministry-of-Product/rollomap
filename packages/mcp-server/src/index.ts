#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pool, query, WORKSPACE_ID, tsQuery } from './db.js';
import { recordEvent, withSyncTxn } from './sync-events.js';

const server = new McpServer({
  name: 'rollomap',
  version: '0.1.0',
});

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

// ------- create_person -------
server.tool(
  'create_person',
  'Create a new person in the user\'s relationship memory.',
  {
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
  },
  async (data) => {
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
      return row;
    });

    return ok({ person });
  },
);

// ------- search_people -------
server.tool(
  'search_people',
  'Search for people in the user\'s relationship memory by name, email, company, role, or summary text.',
  {
    query: z.string().describe('Free-text query: name, email, company, or topic.'),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async ({ query: q, limit }) => {
    const result = await query(
      `SELECT id, display_name, primary_email, company, title, summary, last_seen_at, relationship_strength
         FROM person
        WHERE workspace_id = $1
          AND (tsv @@ plainto_tsquery('english', $2)
               OR display_name ILIKE '%' || $2 || '%'
               OR primary_email ILIKE '%' || $2 || '%')
        ORDER BY relationship_strength DESC, display_name ASC
        LIMIT $3`,
      [WORKSPACE_ID, q, limit],
    );
    return ok({ query: q, results: result.rows });
  },
);

// ------- brief_person -------
server.tool(
  'brief_person',
  'Generate an evidence-backed briefing for a person (by id or name): how the user knows them, last interaction, key topics, open loops, and notes.',
  {
    person_id: z.string().uuid().optional(),
    name: z.string().optional(),
  },
  async ({ person_id, name }) => {
    if (!person_id && !name) {
      return { isError: true, content: [{ type: 'text', text: 'person_id or name is required' }] };
    }
    const personRow = person_id
      ? await query(`SELECT * FROM person WHERE workspace_id = $1 AND id = $2`, [WORKSPACE_ID, person_id])
      : await query(
          `SELECT * FROM person WHERE workspace_id = $1
             AND (lower(display_name) = lower($2) OR lower(primary_email) = lower($2)
                  OR display_name ILIKE '%' || $2 || '%')
           ORDER BY relationship_strength DESC LIMIT 1`,
          [WORKSPACE_ID, name],
        );
    if (personRow.rowCount === 0) {
      return { isError: true, content: [{ type: 'text', text: 'person_not_found' }] };
    }
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

    return ok({
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
      topics: topics.rows,
      open_loops: openLoops.rows,
      user_notes: notes.rows,
      recent_interactions: interactions.rows,
    });
  },
);

// ------- find_people_for_idea -------
server.tool(
  'find_people_for_idea',
  'Find people in the user\'s network who may care about an idea, product, or opportunity. Returns ranked, evidence-backed candidates.',
  {
    idea: z.string().describe('Description of the idea, product, opportunity, or question.'),
    limit: z.number().int().min(1).max(50).default(10),
    relationship_strength_min: z.number().min(0).max(1).default(0),
  },
  async ({ idea, limit, relationship_strength_min }) => {
    const tsq = tsQuery(idea);
    const result = await query(
      `WITH idea_topics AS (
         SELECT t.id, t.name, ts_rank_cd(t.tsv, to_tsquery('english', $2)) AS topic_rank
           FROM topic t
          WHERE t.workspace_id = $1 AND t.tsv @@ to_tsquery('english', $2)
       ),
       interaction_hits AS (
         SELECT ip.person_id,
                ts_rank_cd(i.tsv, to_tsquery('english', $2)) AS rank,
                i.id AS interaction_id, i.title, i.summary, i.occurred_at,
                row_number() OVER (PARTITION BY ip.person_id ORDER BY ts_rank_cd(i.tsv, to_tsquery('english', $2)) DESC, i.occurred_at DESC) AS rn
           FROM interaction i JOIN interaction_participant ip ON ip.interaction_id = i.id
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
                  'interaction_id', interaction_id, 'title', title, 'summary', summary, 'occurred_at', occurred_at
                )) FILTER (WHERE rn <= 3) AS top_interactions
           FROM interaction_hits GROUP BY person_id
       ),
       summary_score AS (
         SELECT p.id AS person_id, ts_rank_cd(p.tsv, to_tsquery('english', $2)) AS summary_rank
           FROM person p
          WHERE p.workspace_id = $1 AND p.tsv @@ to_tsquery('english', $2)
       )
       SELECT p.id AS person_id, p.display_name, p.company, p.title, p.summary,
              p.relationship_strength, p.last_seen_at,
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
      [WORKSPACE_ID, tsq, relationship_strength_min, limit],
    );

    return ok({
      idea,
      results: result.rows.map(r => ({
        person_id: r.person_id,
        name: r.display_name,
        company: r.company,
        title: r.title,
        relationship_strength: Number(r.relationship_strength),
        score: Number(r.score),
        confidence: r.score > 30 ? 'high' : r.score > 15 ? 'medium' : 'low',
        matched_topics: r.matched_topics,
        evidence: r.evidence_interactions,
      })),
    });
  },
);

// ------- get_relationship_history -------
server.tool(
  'get_relationship_history',
  'Return the chronological interaction timeline for a person.',
  {
    person_id: z.string().uuid(),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ person_id, limit }) => {
    const result = await query(
      `SELECT i.id, i.title, i.summary, i.interaction_type, i.occurred_at, i.body
         FROM interaction i JOIN interaction_participant ip ON ip.interaction_id = i.id
        WHERE ip.person_id = $1
        ORDER BY i.occurred_at DESC
        LIMIT $2`,
      [person_id, limit],
    );
    return ok({ person_id, interactions: result.rows });
  },
);

// ------- search_interactions -------
server.tool(
  'search_interactions',
  'Full-text search over interactions (emails, meetings, notes, etc).',
  {
    query: z.string(),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async ({ query: q, limit }) => {
    const tsq = tsQuery(q);
    const result = await query(
      `SELECT i.id, i.title, i.summary, i.interaction_type, i.occurred_at,
              ts_rank_cd(i.tsv, to_tsquery('english', $2)) AS rank,
              (SELECT json_agg(json_build_object('id', p.id, 'name', p.display_name))
                 FROM interaction_participant ip JOIN person p ON p.id = ip.person_id
                WHERE ip.interaction_id = i.id) AS participants
         FROM interaction i
        WHERE i.workspace_id = $1 AND i.tsv @@ to_tsquery('english', $2)
        ORDER BY rank DESC LIMIT $3`,
      [WORKSPACE_ID, tsq, limit],
    );
    return ok({ query: q, results: result.rows });
  },
);

// ------- list_open_loops -------
server.tool(
  'list_open_loops',
  'List open follow-ups / commitments the user has, optionally filtered by person.',
  {
    person_id: z.string().uuid().optional(),
  },
  async ({ person_id }) => {
    const params: unknown[] = [WORKSPACE_ID];
    let where = `c.workspace_id = $1 AND c.status = 'open'`;
    if (person_id) {
      params.push(person_id);
      where += ` AND c.person_id = $${params.length}`;
    }
    const result = await query(
      `SELECT c.id, c.description, c.due_date, c.created_at,
              p.id AS person_id, p.display_name AS person_name
         FROM commitment c LEFT JOIN person p ON p.id = c.person_id
        WHERE ${where}
        ORDER BY c.due_date NULLS LAST, c.created_at DESC`,
      params,
    );
    return ok({ open_loops: result.rows });
  },
);

// ------- find_neglected_relationships -------
server.tool(
  'find_neglected_relationships',
  'List meaningful relationships the user has not interacted with in N days.',
  {
    days: z.number().int().min(1).max(3650).default(90),
    relationship_strength_min: z.number().min(0).max(1).default(0.3),
  },
  async ({ days, relationship_strength_min }) => {
    const result = await query(
      `SELECT id, display_name, company, title, last_seen_at, relationship_strength, interaction_count
         FROM person
        WHERE workspace_id = $1
          AND interaction_count > 0
          AND (last_seen_at IS NULL OR last_seen_at < now() - ($2 || ' days')::interval)
          AND relationship_strength >= $3
        ORDER BY relationship_strength DESC, last_seen_at ASC NULLS FIRST
        LIMIT 50`,
      [WORKSPACE_ID, days, relationship_strength_min],
    );
    return ok({ days, people: result.rows });
  },
);

// ------- add_note -------
server.tool(
  'add_note',
  'Attach a manual note to a person (user-authored memory).',
  {
    person_id: z.string().uuid(),
    body: z.string().min(1),
  },
  async ({ person_id, body }) => {
    const note = await withSyncTxn(async (client) => {
      const result = await client.query(
        `INSERT INTO note (workspace_id, person_id, body) VALUES ($1, $2, $3) RETURNING *`,
        [WORKSPACE_ID, person_id, body],
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
    return ok({ note });
  },
);

// ------- update_person -------
server.tool(
  'update_person',
  'Update editable fields on a person record. Records the change in the correction log.',
  {
    person_id: z.string().uuid(),
    display_name: z.string().optional(),
    primary_email: z.string().email().optional(),
    company: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    how_known: z.string().optional(),
    user_pinned: z.boolean().optional(),
  },
  async (args) => {
    const { person_id, ...rest } = args;
    const fields: string[] = [];
    const params: unknown[] = [WORKSPACE_ID, person_id];
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined) continue;
      params.push(v);
      fields.push(`${k} = $${params.length}`);
    }
    if (fields.length === 0) {
      return { isError: true, content: [{ type: 'text', text: 'no fields to update' }] };
    }
    const person = await withSyncTxn(async (client) => {
      const result = await client.query(
        `UPDATE person SET ${fields.join(', ')} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        params,
      );
      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      await client.query(
        `INSERT INTO user_correction (workspace_id, entity_type, entity_id, correction_type, after_value)
         VALUES ($1, 'person', $2, 'update', $3::jsonb)`,
        [WORKSPACE_ID, person_id, JSON.stringify(rest)],
      );
      await recordEvent(client, {
        entityType: 'person',
        entityId: row.id,
        operation: 'person.updated',
        payload: row,
      });
      return row;
    });
    if (!person) {
      return { isError: true, content: [{ type: 'text', text: 'person_not_found' }] };
    }
    return ok({ person });
  },
);

// ------- add_interaction -------
server.tool(
  'add_interaction',
  'Log a new interaction (meeting, email summary, conversation note) and link it to one or more people.',
  {
    interaction_type: z.enum(['email', 'meeting', 'meeting_note', 'document_mention', 'note', 'introduction', 'call']),
    title: z.string().optional(),
    summary: z.string().optional(),
    body: z.string().optional(),
    occurred_at: z.string().describe('ISO timestamp'),
    participant_ids: z.array(z.string().uuid()).default([]),
    topics: z.array(z.string()).default([]),
  },
  async ({ interaction_type, title, summary, body, occurred_at, participant_ids, topics }) => {
    const client = await pool.connect();
    const topicNames = Array.from(new Set(topics.map(t => t.trim()).filter(Boolean)));
    try {
      await client.query('BEGIN');
      const ix = await client.query(
        `INSERT INTO interaction (workspace_id, interaction_type, title, summary, body, occurred_at, topics)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
        [WORKSPACE_ID, interaction_type, title ?? null, summary ?? null, body ?? null, occurred_at, JSON.stringify(topicNames)],
      );
      const interaction = ix.rows[0];
      const topicIds: string[] = [];
      for (const topicName of topicNames) {
        const topic = await client.query<{ id: string }>(
          `INSERT INTO topic (workspace_id, name, created_by)
           VALUES ($1, $2, 'agent')
           ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET
             name = topic.name
           RETURNING id`,
          [WORKSPACE_ID, topicName],
        );
        topicIds.push(topic.rows[0]!.id);
      }
      for (const pid of participant_ids) {
        await client.query(
          `INSERT INTO interaction_participant (workspace_id, interaction_id, person_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [WORKSPACE_ID, interaction.id, pid],
        );
        await client.query(
          `UPDATE person SET interaction_count = interaction_count + 1,
                            last_seen_at = GREATEST(coalesce(last_seen_at, $2::timestamptz), $2::timestamptz),
                            first_seen_at = LEAST(coalesce(first_seen_at, $2::timestamptz), $2::timestamptz)
           WHERE workspace_id = $1 AND id = $3`,
          [WORKSPACE_ID, occurred_at, pid],
        );
        for (const topicId of topicIds) {
          await client.query(
            `INSERT INTO person_topic (workspace_id, person_id, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed)
             VALUES ($1, $2, $3, 0.7, 1, $4::timestamptz, false)
             ON CONFLICT (workspace_id, person_id, topic_id) DO UPDATE SET
               confidence = GREATEST(person_topic.confidence, EXCLUDED.confidence),
               evidence_count = person_topic.evidence_count + 1,
               last_evidence_at = GREATEST(
                 coalesce(person_topic.last_evidence_at, EXCLUDED.last_evidence_at),
                 EXCLUDED.last_evidence_at
               ),
               updated_at = now()`,
            [WORKSPACE_ID, pid, topicId, occurred_at],
          );
        }
      }
      await recordEvent(client, {
        entityType: 'interaction',
        entityId: interaction.id,
        operation: 'interaction.created',
        payload: { ...interaction, participant_ids },
      });
      await client.query('COMMIT');
      return ok({ interaction, linked_topics: topicNames });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
);

// ------- list_topics -------
server.tool(
  'list_topics',
  'List topics in the user\'s network with the count of associated people.',
  {},
  async () => {
    const result = await query(
      `SELECT t.id, t.name, t.description,
              (SELECT count(*) FROM person_topic pt WHERE pt.topic_id = t.id) AS person_count
         FROM topic t WHERE t.workspace_id = $1
         ORDER BY person_count DESC, t.name ASC`,
      [WORKSPACE_ID],
    );
    return ok({ topics: result.rows });
  },
);

// Matt's known interests / focus areas — used to flag overlaps during research.
// Source: project memory + zCrowd/Pugetworks/CBRE history. Update as needed.
const MATT_INTERESTS = [
  'product management', 'OKRs', 'AI in education', 'machine learning',
  'startups', 'fundraising', 'crowdsourcing', 'modded Minecraft',
  'community building', 'Seattle tech', 'consulting',
  'commercial real estate', 'EdTech', 'product leadership',
  'electrical engineering', 'team building',
];

// ------- research_person -------
// PREP step: resolves the target, returns context the agent needs to synthesize.
// The agent (Claude) uses its own WebFetch on linkedin_url + any public sources,
// or asks the user to paste profile text, then calls save_person_research.
server.tool(
  'research_person',
  'Prepare to research a person. Resolves them by linkedin_url, person_id, or name; returns their current record (summary, topics, recent interactions, prior research notes), Matt\'s known interest areas for overlap detection, and instructions for the agent. Does NOT fetch the LinkedIn URL itself — the calling agent should WebFetch it (or ask the user to paste profile text), synthesize a 2-3 paragraph synopsis with topics and overlap, then call save_person_research.',
  {
    linkedin_url: z.string().url().optional().describe('LinkedIn profile URL — preferred way to identify someone.'),
    person_id: z.string().uuid().optional(),
    name: z.string().optional(),
  },
  async ({ linkedin_url, person_id, name }) => {
    if (!linkedin_url && !person_id && !name) {
      return { isError: true, content: [{ type: 'text', text: 'Provide one of: linkedin_url, person_id, or name.' }] };
    }

    // Resolve
    let person: Record<string, unknown> | null = null;
    if (person_id) {
      const r = await query(`SELECT * FROM person WHERE workspace_id = $1 AND id = $2`, [WORKSPACE_ID, person_id]);
      person = r.rows[0] ?? null;
    } else if (linkedin_url) {
      // Try exact, then trailing-slash variants
      const variants = [linkedin_url, linkedin_url.replace(/\/$/, ''), linkedin_url + '/'];
      for (const v of variants) {
        const r = await query(`SELECT * FROM person WHERE workspace_id = $1 AND linkedin_url = $2 LIMIT 1`, [WORKSPACE_ID, v]);
        if (r.rowCount && r.rows[0]) { person = r.rows[0]; break; }
      }
    }
    if (!person && name) {
      const r = await query(
        `SELECT * FROM person WHERE workspace_id = $1
           AND (lower(display_name) = lower($2)
                OR display_name ILIKE '%' || $2 || '%')
         ORDER BY relationship_strength DESC LIMIT 1`,
        [WORKSPACE_ID, name],
      );
      person = r.rows[0] ?? null;
    }

    // If still not found, create a stub from whatever we have so save_research has somewhere to land.
    let stub_created = false;
    if (!person) {
      const display_name = name ?? (linkedin_url ? linkedin_url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '') : 'Unknown');
      person = await withSyncTxn(async (client) => {
        const r = await client.query(
          `INSERT INTO person (workspace_id, display_name, linkedin_url, how_known)
           VALUES ($1, $2, $3, 'Created via research_person — not yet enriched.') RETURNING *`,
          [WORKSPACE_ID, display_name, linkedin_url ?? null],
        );
        const row = r.rows[0] ?? null;
        if (row) {
          await recordEvent(client, {
            entityType: 'person',
            entityId: row.id,
            operation: 'person.created',
            payload: row,
          });
        }
        return row;
      });
      stub_created = true;
    }

    if (!person) {
      return { isError: true, content: [{ type: 'text', text: 'Could not resolve or create a person record.' }] };
    }

    const pid = person.id as string;

    // Pull current topics, recent interactions, prior notes (especially research notes)
    const [topicsRes, interactionsRes, notesRes] = await Promise.all([
      query(
        `SELECT t.name, pt.confidence, pt.user_confirmed, pt.last_evidence_at
           FROM person_topic pt JOIN topic t ON t.id = pt.topic_id
          WHERE pt.person_id = $1 ORDER BY pt.confidence DESC LIMIT 25`,
        [pid],
      ),
      query(
        `SELECT i.id, i.title, i.summary, i.interaction_type, i.occurred_at
           FROM interaction i JOIN interaction_participant ip ON ip.interaction_id = i.id
          WHERE ip.person_id = $1 ORDER BY i.occurred_at DESC LIMIT 8`,
        [pid],
      ),
      query(`SELECT body, created_at FROM note WHERE person_id = $1 ORDER BY created_at DESC LIMIT 8`, [pid]),
    ]);

    // Pull prior Deep Dives separately so the agent can see how this person has changed over time.
    const deepDivesRes = await query(
      `SELECT id, body, created_at FROM note
        WHERE person_id = $1 AND kind = 'deep_dive'
        ORDER BY created_at DESC LIMIT 5`,
      [pid],
    );

    return ok({
      person: {
        id: pid,
        display_name: person.display_name,
        primary_email: person.primary_email,
        linkedin_url: person.linkedin_url,
        company: person.company,
        title: person.title,
        summary: person.summary,
        how_known: person.how_known,
        first_seen_at: person.first_seen_at,
        last_seen_at: person.last_seen_at,
        last_researched_at: person.last_researched_at,
        relationship_strength: Number(person.relationship_strength ?? 0),
        interaction_count: person.interaction_count,
        stub_created,
      },
      current_topics: topicsRes.rows,
      recent_interactions: interactionsRes.rows,
      prior_deep_dives: deepDivesRes.rows,
      notes: notesRes.rows,
      matt_interests: MATT_INTERESTS,
      synthesis_instructions: [
        '1. Use WebFetch to retrieve the linkedin_url if present. If LinkedIn returns a login wall or sparse content, ask the user to paste the profile text.',
        '2. Optionally search for and fetch additional sources: personal site (often linked from the LinkedIn profile), Substack/Medium blog, Twitter/X, GitHub for technical folks, podcast/talk transcripts.',
        '3. Synthesize a 2-3 paragraph Deep Dive synopsis: current focus, expertise/track record, what they\'re publicly thinking about lately.',
        '4. Extract 5-15 topics that describe their expertise/interests. Use lowercase canonical forms (e.g. "fintech" not "FinTech").',
        '5. Compute overlap: which of their topics intersect with matt_interests? List those as overlap_topics.',
        '6. Call save_person_research with person_id, synopsis, topics (with confidence 0.5-1.0), overlap_topics, and sources (URLs of what you actually fetched). It will be appended as a dated Deep Dive entry — prior entries are preserved.',
        'If the prior_deep_dives array is non-empty, treat this as a NEW dated entry: write a fresh synopsis that captures what is true now, noting any visible changes from the prior entries. Do not duplicate language verbatim.',
      ],
    });
  },
);

// ------- save_person_research -------
server.tool(
  'save_person_research',
  'Persist a Deep Dive synopsis for a person: appends a new dated entry to their Deep Dive history (note row with kind=\'deep_dive\'), attaches topics + overlap_topics, and sets last_researched_at = now(). Append-only — re-running on the same person creates a new dated entry rather than overwriting. Does NOT modify person.summary.',
  {
    person_id: z.string().uuid(),
    synopsis: z.string().min(50).describe('Full 2-3 paragraph Deep Dive synthesis. Stored as-is (no marker prefix) — date comes from created_at, kind from the column.'),
    topics: z.array(z.object({
      name: z.string().min(1),
      confidence: z.number().min(0).max(1).default(0.7),
    })).default([]).describe('Topics describing the person\'s expertise/interests. Use lowercase canonical names.'),
    overlap_topics: z.array(z.string()).default([]).describe('Subset of topics that overlap with Matt\'s known interests — gets confidence 1.0 and user_confirmed=true.'),
    sources: z.array(z.string()).default([]).describe('URLs / labels of sources actually used to write the synopsis (LinkedIn profile, blog post URLs, etc.).'),
  },
  async ({ person_id, synopsis, topics, overlap_topics, sources }) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify person exists in this workspace
      const personCheck = await client.query(
        `SELECT id, display_name FROM person WHERE workspace_id = $1 AND id = $2`,
        [WORKSPACE_ID, person_id],
      );
      if (personCheck.rowCount === 0) {
        await client.query('ROLLBACK');
        return { isError: true, content: [{ type: 'text', text: 'person_not_found' }] };
      }

      // Build the Deep Dive note body — clean markdown, no marker.
      // Sources and overlap rendered as trailing blocks for readability.
      const overlapBlock = overlap_topics.length ? `\n\n**Overlap with Matt:** ${overlap_topics.join(', ')}` : '';
      const sourcesBlock = sources.length ? `\n\n**Sources:**\n${sources.map(s => `- ${s}`).join('\n')}` : '';
      const noteBody = `${synopsis}${overlapBlock}${sourcesBlock}`;

      const noteRes = await client.query(
        `INSERT INTO note (workspace_id, person_id, body, kind) VALUES ($1, $2, $3, 'deep_dive') RETURNING *`,
        [WORKSPACE_ID, person_id, noteBody],
      );
      await recordEvent(client, {
        entityType: 'note',
        entityId: noteRes.rows[0]!.id,
        operation: 'note.created',
        payload: noteRes.rows[0],
      });

      // Update last_researched_at only — leave person.summary alone so the
      // existing manual / ingest-derived summary is preserved across passes.
      await client.query(
        `UPDATE person SET last_researched_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [WORKSPACE_ID, person_id],
      );

      // Build the merged topic list. Overlap topics get confidence 1.0 + user_confirmed.
      const mergedTopics = new Map<string, { confidence: number; user_confirmed: boolean }>();
      for (const t of topics) {
        const key = t.name.trim().toLowerCase();
        if (!key) continue;
        const existing = mergedTopics.get(key);
        const conf = Math.max(existing?.confidence ?? 0, t.confidence);
        mergedTopics.set(key, { confidence: conf, user_confirmed: existing?.user_confirmed ?? false });
      }
      for (const o of overlap_topics) {
        const key = o.trim().toLowerCase();
        if (!key) continue;
        mergedTopics.set(key, { confidence: 1.0, user_confirmed: true });
      }

      const topicResults: Array<{ name: string; topic_id: string; overlap: boolean }> = [];
      for (const [name, meta] of mergedTopics) {
        // Upsert topic by lowercase name
        const topicUpsert = await client.query<{ id: string }>(
          `INSERT INTO topic (workspace_id, name, created_by)
           VALUES ($1, $2, 'agent')
           ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = topic.name
           RETURNING id`,
          [WORKSPACE_ID, name],
        );
        const tid = topicUpsert.rows[0]!.id;
        // Upsert person_topic
        const ptRes = await client.query(
          `INSERT INTO person_topic (workspace_id, person_id, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed)
           VALUES ($1, $2, $3, $4, 1, now(), $5)
           ON CONFLICT (workspace_id, person_id, topic_id) DO UPDATE SET
             confidence = GREATEST(person_topic.confidence, EXCLUDED.confidence),
             evidence_count = person_topic.evidence_count + 1,
             last_evidence_at = now(),
             user_confirmed = person_topic.user_confirmed OR EXCLUDED.user_confirmed,
             updated_at = now()
           RETURNING *`,
          [WORKSPACE_ID, person_id, tid, meta.confidence, meta.user_confirmed],
        );
        await recordEvent(client, {
          entityType: 'person_topic',
          entityId: person_id,
          operation: 'topic.linked',
          payload: ptRes.rows[0],
        });
        topicResults.push({ name, topic_id: tid, overlap: overlap_topics.map(s => s.toLowerCase()).includes(name) });
      }

      // Audit
      await client.query(
        `INSERT INTO user_correction (workspace_id, entity_type, entity_id, correction_type, after_value)
         VALUES ($1, 'person', $2, 'research', $3::jsonb)`,
        [WORKSPACE_ID, person_id, JSON.stringify({ note_id: noteRes.rows[0]!.id, topic_count: topicResults.length, overlap_count: overlap_topics.length, sources })],
      );

      await client.query('COMMIT');

      return ok({
        person_id,
        person_name: personCheck.rows[0]!.display_name,
        note_id: noteRes.rows[0]!.id,
        topics_attached: topicResults,
        overlap_count: overlap_topics.length,
        sources,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[rollomap-mcp] server connected over stdio');
