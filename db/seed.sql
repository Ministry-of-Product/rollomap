-- Sample data for the default workspace.
-- Idempotent: safe to re-run.

DO $$
DECLARE
  ws CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
  p_jane UUID;
  p_alex UUID;
  p_priya UUID;
  t_ai UUID;
  t_proptech UUID;
  t_meal UUID;
  t_fundraising UUID;
  s_email1 UUID;
  s_doc1 UUID;
  s_meeting1 UUID;
  i_intro UUID;
  i_meeting UUID;
  i_email UUID;
BEGIN
  -- People
  INSERT INTO person (workspace_id, display_name, primary_email, company, title, summary, how_known, first_seen_at, last_seen_at, interaction_count, relationship_strength, confidence)
  VALUES (ws, 'Jane Doe', 'jane@example.com', 'Forkful', 'Founder',
          'Working on AI tools for family meal planning. Mentioned challenges with weekly planning routines.',
          'Met at AI dinner in SF, March 2025.',
          '2025-03-12', '2026-04-20', 4, 0.62, 0.95)
  RETURNING id INTO p_jane;

  INSERT INTO person (workspace_id, display_name, primary_email, company, title, summary, how_known, first_seen_at, last_seen_at, interaction_count, relationship_strength, confidence)
  VALUES (ws, 'Alex Chen', 'alex.chen@example.com', 'Northbridge Capital', 'Partner',
          'Investor focused on proptech and vertical SaaS. Has a portfolio of real-estate technology companies.',
          'Introduced via email by Priya in 2024.',
          '2024-09-02', '2026-02-11', 3, 0.45, 0.9)
  RETURNING id INTO p_alex;

  INSERT INTO person (workspace_id, display_name, primary_email, company, title, summary, how_known, first_seen_at, last_seen_at, interaction_count, relationship_strength, confidence)
  VALUES (ws, 'Priya Shah', 'priya@example.com', 'OpenLedger', 'CTO',
          'CTO who has expressed strong interest in AI agents and developer tooling. Has hired engineers I have referred.',
          'Worked together at a previous company; close professional friend.',
          '2021-05-10', '2026-04-30', 12, 0.85, 0.99)
  RETURNING id INTO p_priya;

  -- Topics
  INSERT INTO topic (workspace_id, name, description) VALUES (ws, 'AI agents', 'Autonomous LLM-driven systems and agent tooling.') RETURNING id INTO t_ai;
  INSERT INTO topic (workspace_id, name, description) VALUES (ws, 'Proptech', 'Real estate and property technology.') RETURNING id INTO t_proptech;
  INSERT INTO topic (workspace_id, name, description) VALUES (ws, 'Meal planning', 'Tools and habits for planning meals, especially for families.') RETURNING id INTO t_meal;
  INSERT INTO topic (workspace_id, name, description) VALUES (ws, 'Fundraising', 'Startup fundraising, term sheets, investor intros.') RETURNING id INTO t_fundraising;

  INSERT INTO person_topic (workspace_id, person_id, topic_id, confidence, evidence_count, last_evidence_at, user_confirmed)
  VALUES
    (ws, p_jane, t_ai, 0.7, 2, '2026-04-20', false),
    (ws, p_jane, t_meal, 0.95, 3, '2026-04-20', true),
    (ws, p_alex, t_proptech, 0.9, 2, '2026-02-11', true),
    (ws, p_alex, t_fundraising, 0.6, 1, '2026-02-11', false),
    (ws, p_priya, t_ai, 0.95, 5, '2026-04-30', true),
    (ws, p_priya, t_fundraising, 0.4, 1, '2025-12-01', false);

  -- Source items
  INSERT INTO source_item (workspace_id, provider, source_type, title, body, author, participants, created_at_source)
  VALUES (ws, 'manual', 'email', 'Re: weekly meal chaos',
          'Honestly the meal planning thing is killing us. I keep thinking some AI assistant could just look at the fridge and propose the week. -- Jane',
          'jane@example.com',
          '["jane@example.com","me@example.com"]'::jsonb,
          '2026-04-20')
  RETURNING id INTO s_email1;

  INSERT INTO source_item (workspace_id, provider, source_type, title, body, author, participants, created_at_source)
  VALUES (ws, 'manual', 'doc', 'Proptech market notes',
          'Met with Alex from Northbridge. He is actively investing in proptech and is interested in AI-assisted ops for property managers.',
          'me',
          '["me@example.com","alex.chen@example.com"]'::jsonb,
          '2026-02-11')
  RETURNING id INTO s_doc1;

  INSERT INTO source_item (workspace_id, provider, source_type, title, body, author, participants, created_at_source)
  VALUES (ws, 'manual', 'meeting_note', '1:1 with Priya',
          'Caught up with Priya. She is hiring two AI engineers and asked if I knew anyone working on agent frameworks. She also mentioned wanting to start raising in Q3.',
          'me',
          '["me@example.com","priya@example.com"]'::jsonb,
          '2026-04-30')
  RETURNING id INTO s_meeting1;

  -- Interactions
  INSERT INTO interaction (workspace_id, source_item_id, interaction_type, title, summary, body, occurred_at, topics)
  VALUES (ws, s_email1, 'email', 'Re: weekly meal chaos',
          'Jane vented about meal planning and floated the idea of an AI assistant that proposes weekly menus.',
          'Honestly the meal planning thing is killing us...',
          '2026-04-20', '["Meal planning","AI agents"]'::jsonb)
  RETURNING id INTO i_email;

  INSERT INTO interaction (workspace_id, source_item_id, interaction_type, title, summary, body, occurred_at, topics)
  VALUES (ws, s_doc1, 'meeting', 'Coffee with Alex Chen',
          'Discussed Northbridge proptech thesis and AI tooling for property ops.',
          'Met with Alex from Northbridge...',
          '2026-02-11', '["Proptech","AI agents"]'::jsonb)
  RETURNING id INTO i_meeting;

  INSERT INTO interaction (workspace_id, source_item_id, interaction_type, title, summary, body, occurred_at, topics)
  VALUES (ws, s_meeting1, 'meeting', '1:1 with Priya',
          'Priya is hiring AI engineers and considering a Q3 raise.',
          'Caught up with Priya...',
          '2026-04-30', '["AI agents","Fundraising"]'::jsonb)
  RETURNING id INTO i_intro;

  INSERT INTO interaction_participant (workspace_id, interaction_id, person_id, role) VALUES
    (ws, i_email, p_jane, 'participant'),
    (ws, i_meeting, p_alex, 'participant'),
    (ws, i_intro, p_priya, 'participant');

  -- Evidence
  INSERT INTO evidence (workspace_id, claim_type, claim_id, source_item_id, interaction_id, quote, summary)
  VALUES
    (ws, 'person_topic', (SELECT id FROM person_topic WHERE person_id=p_jane AND topic_id=t_meal),
     s_email1, i_email,
     'the meal planning thing is killing us... AI assistant could just look at the fridge and propose the week',
     'Jane explicitly raised meal planning pain.'),
    (ws, 'person_topic', (SELECT id FROM person_topic WHERE person_id=p_alex AND topic_id=t_proptech),
     s_doc1, i_meeting,
     'actively investing in proptech',
     'Alex confirmed proptech focus during coffee.'),
    (ws, 'person_topic', (SELECT id FROM person_topic WHERE person_id=p_priya AND topic_id=t_ai),
     s_meeting1, i_intro,
     'hiring two AI engineers and asked if I knew anyone working on agent frameworks',
     'Priya is actively building in agent space.');

  -- Commitments / open loops
  INSERT INTO commitment (workspace_id, person_id, interaction_id, description, status, due_date)
  VALUES
    (ws, p_priya, i_intro, 'Send Priya a list of AI engineers I think highly of.', 'open', '2026-05-15'),
    (ws, p_jane, i_email, 'Share the meal-planning prototype demo with Jane.', 'open', NULL),
    (ws, p_alex, i_meeting, 'Send Alex the proptech market memo.', 'done', NULL);

  -- Notes
  INSERT INTO note (workspace_id, person_id, body) VALUES
    (ws, p_jane, 'Vegetarian. Two kids (8 and 11). Allergic to shellfish.'),
    (ws, p_priya, 'Prefers async DMs over email. Mention her dog Bowie.');
END $$;
