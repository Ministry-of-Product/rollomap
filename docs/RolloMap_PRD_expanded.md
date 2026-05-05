# RolloMap Product Requirements & System Design

## 1. Executive Summary

RolloMap is a private, evidence-backed relationship intelligence system. It helps a user understand, remember, search, and act on their personal network by ingesting their own relationship data from email, Google Docs, meeting notes, calendar events, LinkedIn exports, voice notes, and manual notes.

RolloMap is not a social network, CRM, surveillance product, or pooled reputation graph. It is a personal relationship memory layer owned by the user. Each user’s relationship graph is isolated. The platform must not cross-compare, combine, or synthesize relationship graphs across users.

The product exposes its capabilities through a web app, mobile apps, APIs, and an MCP server so AI agents can query the user’s private relationship memory with permission.

## 2. Product Thesis

People accumulate deep context about other people through emails, meetings, introductions, notes, collaborations, ideas, and shared work. That knowledge is scattered and usually lost. Existing systems fail because they are either:

- Public and performative, like LinkedIn or Facebook.
- Company-owned and transactional, like CRMs.
- Passive archives, like Gmail or Google Drive.
- Too manual to maintain.

RolloMap gives the user a private, portable, AI-native map of their real relationships.

## 3. Product Positioning

### One-line positioning

RolloMap is your private AI-powered map of people, conversations, and relationship context.

### Longer positioning

RolloMap helps you remember who people are, how you know them, what they care about, what you discussed, what you promised, and who in your network may care about a product, idea, opportunity, or problem.

### What RolloMap is

- A personal relationship memory system.
- A private people-context layer.
- A queryable map of interactions and evidence.
- A data product the user owns.
- An MCP-compatible relationship context server for AI agents.

### What RolloMap is not

- A social network.
- A public profile system.
- A reputation graph.
- A company CRM.
- A surveillance database.
- A system for scoring people.
- A system that aggregates multiple users’ opinions about the same person.

## 4. Core Principles

### 4.1 User-owned

The user owns their data, generated summaries, relationship graph, exports, and deletion rights.

### 4.2 Private by default

No profile is public. No data is visible to other users unless explicitly exported or shared by the owner.

### 4.3 No cross-user synthesis

The system must not merge multiple users’ perspectives into a shared “truth” about a person.

### 4.4 Evidence-backed

Every material claim should trace back to source evidence: email, note, doc, meeting, calendar event, or manual user assertion.

### 4.5 Perspective-aware

RolloMap stores “what this user appears to know or believe from their interactions,” not objective facts about another person.

### 4.6 Portable

The user can export their graph, summaries, embeddings references, and source metadata.

### 4.7 Agent-accessible

The product should expose controlled tools through MCP so the user’s agents can use relationship context.

### 4.8 Respectful

The product should help the user show up better in relationships. It should not frame people as targets, leads, marks, or profiles to exploit.

## 5. Target Users

### 5.1 Primary user: Builder / founder / operator

A person with a large network who regularly needs to know who would care about a product, idea, candidate, investment, event, or partnership.

### 5.2 Secondary user: Executive / senior IC

A professional who has hundreds or thousands of weak and strong ties across companies, projects, and communities.

### 5.3 Secondary user: Creator / community builder

A person who builds relationships through content, events, introductions, and recurring conversations.

### 5.4 Secondary user: Investor / advisor

A person who needs to remember founders, operators, themes, markets, and deal context over long time horizons.

## 6. Jobs To Be Done

### 6.1 Find relevant people

When I have an idea, product, question, event, role, or problem, I want to find people in my network who may care so I can reach out intelligently.

### 6.2 Prepare for interactions

When I am about to meet someone, I want a concise, evidence-backed briefing so I can remember context and show up well.

### 6.3 Reconstruct history

When I need to remember how I met someone or what we discussed, I want a timeline so I can understand the relationship.

### 6.4 Maintain relationships

When relationships decay because I am busy, I want to identify people I should reconnect with so I do not lose important connections.

### 6.5 Ask my personal network questions

When I ask broad questions like “Who do I know in proptech?” or “Who has talked to me about AI agents?”, I want RolloMap to answer from my own data.

## 7. Product Scope

## 7.1 MVP Scope

The MVP should prove the core loop:

1. Ingest user-owned text sources.
2. Identify people and interactions.
3. Build person profiles.
4. Answer relationship queries with evidence.
5. Allow user correction.
6. Expose basic MCP tools.

### MVP data sources

- Gmail
- Google Drive / Google Docs
- Google Calendar
- Manual notes
- CSV/JSON import for LinkedIn export data

### MVP query types

- “Who would be interested in this?”
- “Brief me on this person.”
- “How do I know this person?”
- “What did I last discuss with this person?”
- “Who do I know in this topic/company/domain?”
- “What follow-ups did I promise?”

### MVP non-goals

- Public profiles.
- Shared relationship graphs.
- Cross-user recommendations.
- Automatic outbound messaging.
- Sentiment scoring.
- Personality scoring.
- Scraping LinkedIn.
- Mobile-first native apps.
- Enterprise admin features.

## 7.2 V1 Scope

V1 expands from personal utility into a durable personal data product.

- Robust ingestion jobs.
- User-controlled evidence viewer.
- Identity merge/split UI.
- Contact confidence scoring.
- Relationship timeline.
- People/topic graph.
- MCP server with permissioned tools.
- Local-first or encrypted cloud architecture options.
- Export/import.
- Basic Android/iOS companion apps.
- Scheduled briefings.

## 7.3 Future Scope

- Voice note ingestion.
- Meeting transcript ingestion.
- Browser extension.
- Contact enrichment from user-authorized exports.
- Smart outreach drafting.
- Personal CRM workflows.
- Agent OS integration.
- Local model mode for highly private users.
- Team mode with strict separation of personal and company contexts.
- Plugin ecosystem.

## 8. Functional Requirements

## 8.1 Account and Workspace

### Requirements

- User can create an account.
- User has a private workspace.
- Workspace contains all sources, people, interactions, topics, evidence, and generated summaries.
- Each workspace is isolated.
- No person profile is shared across workspaces.

### Important distinction

If two users both know “Jane Smith,” RolloMap treats them as two separate person objects in two separate workspaces. There is no global Jane Smith record.

## 8.2 Data Source Connections

### Gmail connector

The user can connect Gmail and grant selected scopes. RolloMap can ingest email metadata, participants, subject, timestamps, snippets, and full bodies where permitted.

### Google Drive / Docs connector

The user can connect Google Drive and ingest selected folders, docs, or files. RolloMap can parse docs, meeting notes, strategy documents, and exported notes.

### Google Calendar connector

The user can connect Calendar and ingest events, attendees, titles, descriptions, locations, and timestamps.

### LinkedIn export import

The user can upload LinkedIn export files. RolloMap parses connection names, companies, titles, connection dates, and profile URLs if available.

### Manual notes

The user can add a note about a person, topic, interaction, or idea.

### Voice notes

Future feature. User can upload or record voice notes. System transcribes and processes them.

## 8.3 Ingestion Pipeline

### Requirements

- Ingestion must be incremental.
- Each source item must receive a durable source ID.
- Raw source data must be stored separately from generated summaries.
- The system must preserve source references for evidence.
- The pipeline must detect people, organizations, topics, commitments, dates, and interaction types.
- The pipeline must support reprocessing when extraction models change.
- User can pause, resume, or delete a source.

### Pipeline stages

1. Source discovery
2. Source permission check
3. Raw data fetch
4. Source normalization
5. Text extraction
6. Chunking
7. Entity extraction
8. Identity resolution
9. Topic extraction
10. Interaction creation
11. Evidence linking
12. Embedding generation
13. Person summary generation
14. Index update
15. User review queue creation

## 8.4 Identity Resolution

### Goal

Resolve many references into a single user-local person record.

### Signals

- Email address
- Name
- Organization
- Calendar attendee metadata
- Email signature
- LinkedIn export row
- Document mentions
- Co-occurrence with known entities
- User manual merge/split actions

### Requirements

- The system must never assume high-confidence identity matches without evidence.
- Ambiguous matches go into a review queue.
- User can merge people.
- User can split incorrectly merged people.
- Merges and splits must be reversible.
- Identity resolution must be local to a workspace.

## 8.5 Person Profile

Each person profile should contain:

- Display name
- Known aliases
- Email addresses
- Phone numbers if available
- LinkedIn URL if imported
- Current or last known company
- Current or last known role/title
- Relationship summary
- How the user knows them
- Topics of interest
- Shared projects
- Introductions
- Last interaction
- First interaction
- Interaction count
- Relationship strength estimate
- Follow-up commitments
- User notes
- Source-backed evidence
- Confidence metadata
- Privacy flags
- Sensitive-information flags
- User correction history

### Profile must distinguish

- User-entered facts.
- Extracted facts.
- Inferred facts.
- Low-confidence suggestions.

## 8.6 Interaction Timeline

An interaction represents a meaningful contact between the user and one or more people.

### Interaction types

- Email thread
- Calendar meeting
- Document mention
- Meeting note
- Manual note
- Voice note
- LinkedIn import
- Introduction
- Follow-up/task
- Unknown

### Interaction fields

- Interaction ID
- Workspace ID
- Source item ID
- Participants
- Timestamp
- Interaction type
- Summary
- Extracted topics
- Commitments
- Evidence links
- Embedding reference
- Sensitivity level
- Confidence level

## 8.7 Topic Graph

RolloMap should maintain a user-local topic graph.

### Topic examples

- AI agents
- Proptech
- Real estate investing
- Android development
- Workout programming
- Menu planning
- Fundraising
- Hiring
- Robotics
- WebRTC

### Requirements

- Topics can be extracted automatically.
- User can create, rename, merge, or delete topics.
- People can be associated with topics based on evidence.
- Each topic-person association must include evidence and confidence.
- Topics should support aliases and related terms.

## 8.8 Query and Answering

### Core query flow

1. User asks a question.
2. Query planner classifies intent.
3. Retrieval layer searches structured data and vector index.
4. Candidate people/interactions are ranked.
5. Answer generator produces grounded response.
6. Evidence citations are attached.
7. User can correct, save, or act.

### Required query intents

- Person briefing
- People search by topic
- Product/idea audience matching
- Follow-up retrieval
- Relationship history
- Intro path discovery
- Neglected relationship detection
- Meeting prep
- Source search
- Profile update

## 8.9 “Who Would Be Interested In This?” Ranking

This is the flagship query.

### Inputs

- User’s product/idea/problem description
- Optional target audience
- Optional excluded people
- Optional relationship strength filter
- Optional recency filter
- Optional topic filter
- Optional company/domain filter

### Ranking signals

- Topic match
- Past expressed interest
- Shared project relevance
- Company/role relevance
- Relationship strength
- Recency
- Interaction quality
- Direct evidence strength
- Prior introductions
- User-labeled importance
- Negative signals, such as stale relationship or conflicting interests

### Output

For each recommended person:

- Name
- Short reason
- Evidence bullets
- Relationship context
- Suggested outreach angle
- Confidence level
- Last interaction
- Source links

### Guardrails

The answer must not invent interests, roles, relationships, or personal traits. It should say “may be interested because...” instead of presenting uncertain inferences as facts.

## 8.10 Person Briefing

A briefing should include:

- Who this person is
- How the user knows them
- Last interaction
- Key topics
- Open loops
- Relevant personal preferences only when appropriate and evidence-backed
- Suggested conversation starters
- Things to avoid mentioning if source evidence indicates sensitivity
- Evidence links

## 8.11 Follow-up and Commitment Extraction

The system should extract possible commitments:

- “I’ll send you...”
- “Let’s reconnect...”
- “Can you introduce me to...”
- “I owe you...”
- “Please follow up...”

### Requirements

- Commitments are suggestions until confirmed.
- User can mark complete, dismiss, or assign a date.
- Commitments link to source evidence.

## 8.12 User Correction and Feedback

Users must be able to correct:

- Person identity
- Name
- Role
- Company
- Topic association
- Relationship summary
- Interaction summary
- Incorrect evidence
- Ranking feedback
- Sensitive information

Corrections should update future summaries and retrieval ranking.

## 8.13 Privacy Controls

### User controls

- Delete source
- Delete person
- Delete interaction
- Delete generated profile
- Exclude source/folder/thread
- Mark item sensitive
- Disable AI processing for source
- Export data
- Revoke connector access
- Local-only mode, future

### Platform rules

- No training on user data unless explicitly opted in.
- No cross-user aggregation.
- No external enrichment without explicit user action.
- No social graph resale.
- No people scoring as a platform feature.

## 8.14 Export and Portability

Export formats:

- JSON
- Markdown
- CSV
- SQLite bundle, future
- Graph format, future
- MCP-compatible local data bundle, future

Export should include:

- People
- Interactions
- Topics
- Evidence references
- Summaries
- User corrections
- Source metadata
- Audit logs where appropriate

## 8.15 MCP Server

RolloMap should expose an MCP server for user-authorized agents.

### Example tools

- `search_people`
- `brief_person`
- `find_people_for_idea`
- `get_relationship_history`
- `search_interactions`
- `list_open_loops`
- `add_note`
- `update_person`
- `mark_sensitive`
- `create_outreach_draft`

### MCP principles

- Read operations should be permissioned by scope.
- Write operations require explicit user authorization.
- Sensitive data access should be limited.
- All MCP calls should be logged.
- Agents should receive evidence-backed results, not unrestricted raw data by default.

## 9. Non-Functional Requirements

## 9.1 Security

- Encrypt data at rest.
- Encrypt data in transit.
- Separate tenant data by workspace.
- Store OAuth tokens securely.
- Support token revocation.
- Audit access to sensitive resources.
- Apply least-privilege scopes.
- Protect against prompt injection from ingested documents and emails.

## 9.2 Privacy

- Do not pool person data across users.
- Do not create global people profiles.
- Do not use user content for platform-wide learning without explicit opt-in.
- Make deletion real and understandable.
- Provide clear source-level controls.

## 9.3 Reliability

- Ingestion jobs must be retryable.
- Source failures should not corrupt the graph.
- Duplicate ingestion must be idempotent.
- User must see ingestion status.

## 9.4 Performance

- Person briefing should return in under 5 seconds for warm data.
- People search should return in under 10 seconds for normal accounts.
- Ingestion can run asynchronously but must show progress.
- Large imports should be resumable.

## 9.5 Explainability

- All important claims must include evidence.
- Confidence levels must be visible.
- Inferred facts must be labeled.

## 9.6 Compliance Readiness

Likely relevant areas:

- GDPR-style export/delete principles.
- CCPA-style access/delete principles.
- OAuth provider requirements.
- Google API restricted scope review if using sensitive Gmail scopes.
- Data processing agreements for enterprise use.
- Terms prohibiting use for harassment, discrimination, or covert surveillance.

This document is not legal advice. Formal legal review is required before launch.

## 10. System Architecture

## 10.1 High-Level Architecture

RolloMap consists of:

1. Client apps
2. API gateway
3. Auth service
4. Connector services
5. Ingestion workers
6. Extraction and summarization services
7. Identity resolution service
8. Relationship graph service
9. Query/retrieval service
10. MCP server
11. Storage layer
12. Observability and audit layer

## 10.2 Client Apps

### Web app

Primary MVP interface.

Features:

- Connect sources
- View ingestion status
- Search people
- Ask questions
- View person profiles
- Review merges
- Correct facts
- Export data

### Mobile apps

Later-stage companion apps.

Features:

- Quick person briefing
- Voice notes
- Contact lookup
- Meeting prep
- Reconnect reminders

## 10.3 API Gateway

Responsibilities:

- Authenticate requests
- Route requests
- Rate limit
- Enforce workspace boundary
- Log access
- Validate request schemas

## 10.4 Auth Service

Responsibilities:

- User account management
- Workspace membership
- OAuth connector authorization
- Token storage
- Session management
- API key and MCP token issuance

## 10.5 Connector Services

Each connector handles source-specific fetching and normalization.

### Gmail connector

- OAuth consent
- Incremental sync
- Thread fetching
- Participant extraction
- Label/folder filtering
- Source item creation

### Google Drive connector

- Folder and file selection
- Docs export
- File metadata
- Incremental sync
- Permission changes

### Calendar connector

- Event sync
- Attendee extraction
- Meeting metadata
- Recurring event handling

### LinkedIn import connector

- File upload
- CSV parsing
- Profile/contact import
- No scraping in MVP

## 10.6 Ingestion Workers

Workers handle long-running jobs.

Responsibilities:

- Pull source items
- Normalize text
- Chunk documents
- Run extraction
- Create interactions
- Generate embeddings
- Update graph
- Emit progress events

## 10.7 Extraction Service

Responsibilities:

- Named entity recognition
- People extraction
- Organization extraction
- Topic extraction
- Commitment extraction
- Relationship clue extraction
- Sensitivity detection
- Summary generation

## 10.8 Identity Resolution Service

Responsibilities:

- Match people references to existing person records
- Create candidate matches
- Score confidence
- Queue ambiguous cases
- Apply user merge/split feedback
- Maintain identity history

## 10.9 Relationship Graph Service

Stores and serves graph relationships:

- Person-to-interaction
- Person-to-topic
- Person-to-organization
- Person-to-person
- Interaction-to-source
- Topic-to-evidence
- Commitment-to-interaction

## 10.10 Query/Retrieval Service

Responsibilities:

- Query classification
- Structured search
- Vector search
- Hybrid retrieval
- Ranking
- Evidence selection
- Answer generation
- Confidence scoring

## 10.11 MCP Server

Responsibilities:

- Expose approved tools to agents
- Enforce permissions
- Return grounded outputs
- Log agent access
- Support user revocation

## 10.12 Storage Layer

### Recommended MVP storage

- PostgreSQL for structured data
- pgvector or a dedicated vector store for embeddings
- Object storage for source snapshots where allowed
- Redis for jobs/cache
- Queue system for ingestion jobs

### Future storage options

- Local-first encrypted store
- SQLite export bundle
- Customer-managed storage
- Bring-your-own-vector-index

## 11. Data Model

## 11.1 Workspace

Fields:

- id
- owner_user_id
- name
- created_at
- updated_at
- privacy_policy_version
- settings

## 11.2 User

Fields:

- id
- email
- display_name
- auth_provider
- created_at
- updated_at

## 11.3 SourceConnection

Fields:

- id
- workspace_id
- provider
- status
- scopes
- encrypted_token_ref
- sync_cursor
- last_sync_at
- created_at
- updated_at

## 11.4 SourceItem

Fields:

- id
- workspace_id
- source_connection_id
- provider
- provider_item_id
- title
- source_type
- source_url
- author
- participants
- created_at_source
- updated_at_source
- ingested_at
- hash
- processing_status
- sensitivity_level

## 11.5 TextChunk

Fields:

- id
- workspace_id
- source_item_id
- chunk_index
- text
- token_count
- embedding_id
- created_at

## 11.6 Person

Fields:

- id
- workspace_id
- display_name
- primary_email
- aliases
- known_emails
- known_phones
- linkedin_url
- company
- title
- summary
- how_known
- first_seen_at
- last_seen_at
- relationship_strength
- confidence
- user_pinned
- sensitivity_level
- created_at
- updated_at

## 11.7 PersonIdentity

Fields:

- id
- workspace_id
- person_id
- identity_type
- identity_value
- source_item_id
- confidence
- verified_by_user
- created_at

## 11.8 Interaction

Fields:

- id
- workspace_id
- source_item_id
- interaction_type
- title
- summary
- occurred_at
- participants
- topics
- commitments
- sensitivity_level
- confidence
- created_at

## 11.9 InteractionParticipant

Fields:

- id
- workspace_id
- interaction_id
- person_id
- role
- confidence
- created_at

## 11.10 Topic

Fields:

- id
- workspace_id
- name
- aliases
- description
- parent_topic_id
- created_by
- created_at
- updated_at

## 11.11 PersonTopic

Fields:

- id
- workspace_id
- person_id
- topic_id
- confidence
- evidence_count
- last_evidence_at
- user_confirmed
- created_at
- updated_at

## 11.12 Evidence

Fields:

- id
- workspace_id
- claim_type
- claim_id
- source_item_id
- text_chunk_id
- quote
- summary
- confidence
- created_at_source
- created_at

## 11.13 Commitment

Fields:

- id
- workspace_id
- person_id
- interaction_id
- description
- status
- due_date
- confidence
- evidence_id
- created_at
- updated_at

## 11.14 UserCorrection

Fields:

- id
- workspace_id
- entity_type
- entity_id
- correction_type
- before_value
- after_value
- created_at

## 11.15 AuditLog

Fields:

- id
- workspace_id
- actor_type
- actor_id
- action
- resource_type
- resource_id
- metadata
- created_at

## 12. Retrieval and Ranking Design

## 12.1 Hybrid Retrieval

Use both structured and vector retrieval.

### Structured retrieval

Best for:

- Person name
- Email
- Company
- Dates
- Known topics
- Commitments
- Calendar events

### Vector retrieval

Best for:

- Idea matching
- Semantic topic matching
- Similar conversation recall
- Fuzzy relationship context

### Graph retrieval

Best for:

- Introductions
- Shared interactions
- Communities
- Relationship paths
- Topic clusters

## 12.2 Candidate Generation

For idea matching:

1. Embed idea/query.
2. Search relevant chunks.
3. Search relevant topics.
4. Search people associated with topics.
5. Search organizations and roles.
6. Gather candidates.
7. Deduplicate.
8. Rank.

## 12.3 Ranking Formula

Example scoring components:

- Semantic relevance: 0-30
- Evidence strength: 0-20
- Relationship strength: 0-15
- Recency: 0-10
- Role/company relevance: 0-10
- User-confirmed topic match: 0-10
- Open loop / current opportunity relevance: 0-5

Final score should be explainable, not hidden magic.

## 12.4 Confidence Levels

- High: direct source evidence and clear identity match.
- Medium: multiple weak signals or inferred topic match.
- Low: weak evidence, ambiguous identity, stale relationship, or broad semantic match.

## 12.5 Evidence Selection

For each answer, choose evidence that is:

- Relevant
- Recent where possible
- Diverse across sources
- Short enough to review
- Non-sensitive unless needed
- Traceable

## 13. AI and LLM Design

## 13.1 LLM Responsibilities

- Summarization
- Topic extraction
- Commitment extraction
- Person briefing generation
- Answer synthesis
- Outreach draft generation
- Ambiguity explanation

## 13.2 LLM Non-Responsibilities

LLMs should not be the source of truth. They should not:

- Invent facts
- Store untraceable claims
- Resolve high-risk identities without evidence
- Make hidden cross-user comparisons
- Classify sensitive attributes unless needed for privacy filtering

## 13.3 Prompt Injection Defense

Ingested emails/docs may contain malicious instructions.

Defenses:

- Treat source content as data, not instructions.
- Use structured extraction prompts.
- Never allow ingested content to override system rules.
- Sanitize tool inputs.
- Limit tool access during source processing.
- Mark suspicious content.

## 13.4 Model Strategy

MVP can use hosted LLMs. Privacy-forward options should be supported later:

- User-selectable model provider
- Local model processing
- Bring-your-own-API-key
- Enterprise model isolation

## 14. UX Design

## 14.1 Main Navigation

- Ask
- People
- Topics
- Sources
- Review
- Briefings
- Open Loops
- Settings

## 14.2 Ask Page

Primary query interface.

Features:

- Natural language query box
- Suggested prompts
- Source filters
- Time filters
- Result cards
- Evidence drawer
- Save answer
- Export answer

## 14.3 People Page

Features:

- Search people
- Filter by topic/company/recency
- Sort by relationship strength
- Person cards
- Merge suggestions
- Recently active people
- Neglected relationships

## 14.4 Person Profile Page

Sections:

- Header
- Summary
- How I know them
- Timeline
- Topics
- Commitments
- Shared people
- Evidence
- User notes
- Corrections

## 14.5 Topic Page

Sections:

- Topic summary
- People associated with topic
- Source evidence
- Related topics
- Recent interactions

## 14.6 Source Page

Features:

- Connected sources
- Sync status
- Folder/thread selection
- Exclusions
- Error handling
- Delete source

## 14.7 Review Page

Items needing user review:

- Possible duplicate people
- Low-confidence topics
- Extracted commitments
- Sensitive items
- Broken source links
- Profile corrections

## 14.8 Meeting Briefing

Before a calendar event, RolloMap can generate:

- Attendee briefings
- Shared history
- Likely topics
- Open loops
- Suggested questions
- Last contact summary

## 15. API Design

## 15.1 REST API Examples

### People

- `GET /people`
- `GET /people/{person_id}`
- `PATCH /people/{person_id}`
- `POST /people/{person_id}/notes`
- `POST /people/merge`
- `POST /people/split`

### Queries

- `POST /query`
- `POST /query/people-for-idea`
- `POST /query/person-briefing`
- `POST /query/open-loops`

### Sources

- `GET /sources`
- `POST /sources/connect`
- `POST /sources/{source_id}/sync`
- `DELETE /sources/{source_id}`

### Export

- `POST /export`
- `GET /export/{export_id}`

## 15.2 MCP Tool Design

### `find_people_for_idea`

Input:

```json
{
  "idea": "AI-powered menu planning for families",
  "filters": {
    "topics": ["AI", "food", "family"],
    "relationship_strength_min": 0.3,
    "limit": 10
  }
}
```

Output:

```json
{
  "results": [
    {
      "person_id": "person_123",
      "name": "Jane Doe",
      "confidence": "medium",
      "reason": "Discussed family meal planning and AI tools in prior conversations.",
      "evidence": [
        {
          "source_type": "email",
          "date": "2025-04-12",
          "summary": "Mentioned struggling with weekly meal planning."
        }
      ],
      "suggested_outreach_angle": "Ask for feedback on family meal planning pain points."
    }
  ]
}
```

### `brief_person`

Input:

```json
{
  "person": "Jane Doe",
  "context": "meeting prep"
}
```

Output:

```json
{
  "person_id": "person_123",
  "briefing": {
    "how_you_know_them": "...",
    "last_interaction": "...",
    "topics": ["AI", "food", "family"],
    "open_loops": [],
    "suggested_questions": []
  },
  "evidence": []
}
```

### `search_relationship_memory`

Input:

```json
{
  "query": "Who has talked to me about WebRTC and Android?",
  "limit": 20
}
```

Output:

```json
{
  "answer": "...",
  "people": [],
  "interactions": [],
  "evidence": []
}
```

## 16. Trust and Safety

## 16.1 Product safety lines

The product must avoid:

- Ranking people by worth.
- Personality diagnosis.
- Sensitive attribute inference.
- Aggregated reputation.
- Cross-user person intelligence.
- Secret monitoring of third parties.
- Encouraging manipulation.

## 16.2 Sensitive information handling

The system may encounter sensitive information. It should:

- Detect potential sensitivity.
- Avoid surfacing sensitive details casually.
- Require explicit user action to view or use sensitive data.
- Allow user to delete or suppress sensitive claims.
- Avoid making sensitive inferences.

## 16.3 Copy and tone

Use language like:

- “Your memory”
- “Your context”
- “Evidence”
- “May be relevant”
- “Based on your interactions”

Avoid language like:

- “Surveillance”
- “Target”
- “Profile them”
- “Exploit”
- “Score”
- “Rank people by value”

## 17. Analytics and Metrics

## 17.1 Product metrics

- Activated users
- Connected sources per user
- Successfully ingested source items
- Number of person profiles created
- Number of corrected identities
- Queries per active user
- Briefings generated
- People-for-idea queries generated
- Saved answers
- Outreach drafts created
- Export events

## 17.2 Quality metrics

- Identity resolution precision
- User correction rate
- Query satisfaction score
- Evidence click-through
- Hallucination reports
- Duplicate person rate
- Failed extraction rate
- Unresolved review queue size

## 17.3 Trust metrics

- Source deletion events
- Privacy setting usage
- Export usage
- Revoked connector events
- Sensitive information suppression rate
- User-reported creepiness or discomfort

## 18. Launch Strategy

## 18.1 Internal alpha

User: founder/developer only.

Goal:

- Ingest personal Google Docs and Gmail.
- Prove “Who would care about this?” works.
- Manually inspect person profiles.

## 18.2 Private beta

Users:

- 10-25 trusted professionals with heavy notes/email use.

Goals:

- Validate onboarding.
- Improve identity resolution.
- Test trust boundaries.
- Measure repeated usage.

## 18.3 Public beta

Positioning:

- Private AI relationship memory.
- Not a CRM.
- Not a social network.

Core offer:

- Connect your docs/email.
- Ask who in your network cares about an idea.
- Get evidence-backed people suggestions.

## 19. Pricing Hypotheses

### Individual Pro

Monthly subscription for personal relationship memory.

### Founder / Operator tier

Higher ingestion volume, advanced query, MCP access.

### Local/private tier

Premium privacy mode.

### Enterprise-adjacent

Careful. Enterprise introduces company ownership tensions. Must preserve user-owned personal graph.

## 20. Risks

## 20.1 Privacy risk

Users may fear the product is creepy.

Mitigation:

- Strong positioning.
- Transparent evidence.
- Private by default.
- No cross-user graph.

## 20.2 Legal risk

Gmail/Google API permissions and LinkedIn data usage may be constrained.

Mitigation:

- Start with user-authorized exports and APIs.
- Avoid scraping.
- Legal review.

## 20.3 Product risk

Too many features dilute the product.

Mitigation:

- Anchor MVP around two magical queries.

## 20.4 Technical risk

Identity resolution is hard.

Mitigation:

- Confidence scoring.
- Review queue.
- User corrections.

## 20.5 Trust risk

Incorrect summaries could damage relationships.

Mitigation:

- Evidence-backed claims.
- User review.
- Conservative phrasing.

## 21. Build Plan

## 21.1 Phase 0: Prototype

- Local ingestion of exported Google Docs.
- Manual upload of meeting notes.
- Basic person extraction.
- Basic vector search.
- Simple CLI or notebook query.

## 21.2 Phase 1: Web MVP

- Auth
- Gmail connector
- Google Drive connector
- Basic ingestion jobs
- Person profiles
- Ask interface
- Evidence viewer
- User corrections

## 21.3 Phase 2: Relationship Intelligence

- People-for-idea ranking
- Person briefing
- Topic graph
- Open loops
- Identity review queue
- Calendar integration

## 21.4 Phase 3: Agent Layer

- MCP server
- Scoped permissions
- Agent logs
- Outreach draft support
- Export/import

## 21.5 Phase 4: Product Expansion

- Mobile apps
- Voice notes
- Scheduled briefings
- Local-first mode
- Browser extension

## 22. Open Questions

1. Should MVP store raw source text or only references and extracted summaries?
2. How much source content should be sent to hosted LLMs?
3. Should embeddings be generated locally or remotely?
4. What is the default retention policy?
5. How should sensitive information be classified?
6. How should the product handle mentions of people who are not contacts?
7. What is the correct balance between automatic profile generation and user review?
8. Should outreach drafting be included in MVP or delayed?
9. What exact Google scopes are required for launch?
10. Should the product have a local-only developer mode from the start?

## 23. MVP Acceptance Criteria

The MVP is successful when the user can:

1. Connect Gmail and Google Drive.
2. Ingest at least 5,000 source items.
3. Generate at least 500 person profiles.
4. Search for people by topic.
5. Ask “Who would be interested in this product?”
6. Receive ranked people recommendations with evidence.
7. Open a person profile and understand how they know the person.
8. Correct a wrong identity merge.
9. Delete a source and associated generated data.
10. Query RolloMap from an MCP-compatible agent.

## 24. North Star

RolloMap succeeds if it helps the user become more thoughtful, prepared, and effective in relationships while preserving privacy, ownership, and personal agency.

The product should feel like a memory upgrade, not a surveillance tool.
