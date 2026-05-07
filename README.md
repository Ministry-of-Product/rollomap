# RolloMap

A private, local-first relationship intelligence system. RolloMap ingests
manually entered or imported text sources (emails, notes, meetings) and builds
a queryable map of the people in your network. Every claim links back to
source evidence.

This repo is the **first local v1**:

- Postgres for structured data (full-text search via `tsvector`)
- A Node REST API used by the web app
- A Model Context Protocol (MCP) server that exposes tools to AI agents
- A React/Vite web app to browse, search, and edit the graph

There are no OAuth connectors yet (Gmail/Drive/Calendar come later); v1
expects manual entry or JSON import.

## Layout

```
docs/                      Product spec
db/migrations/             Postgres schema (auto-applied on first boot)
db/seed.sql                Sample data
packages/api/              Node + Express REST API   (port 4000)
packages/mcp-server/       MCP server (stdio)
packages/webapp/           React + Vite UI           (port 5173)
docker-compose.yml         postgres + api + webapp
```

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up --build
```

Then open <http://localhost:5173>.

The Postgres schema is applied automatically on the first boot (the migrations
directory is mounted into `/docker-entrypoint-initdb.d`).

To load sample data:

```bash
docker compose exec -T postgres psql -U rollomap -d rollomap < db/seed.sql
```

## Quick start (mixed: Postgres in Docker, app in Node)

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run seed                 # optional: load sample data
npm run dev:api              # in one terminal
npm run dev:webapp           # in another terminal
```

Webapp: <http://localhost:5173> · API: <http://localhost:4000/health>

## Resetting the database

```bash
npm run db:reset             # drops the volume and re-applies migrations
npm run seed                 # reload sample data
```

## MCP server

The MCP server speaks stdio and connects to the same Postgres database. Add
this to your MCP client config (e.g. Claude Desktop's
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rollomap": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/rollomap/packages/mcp-server/src/index.ts"],
      "env": {
        "DATABASE_URL": "postgres://rollomap:rollomap@localhost:5432/rollomap",
        "WORKSPACE_ID": "00000000-0000-0000-0000-000000000001"
      }
    }
  }
}
```

You can also run it directly to verify it boots:

```bash
scripts/launch-mcp.sh
```

The launcher reads `.env` if present, falls back to the local Postgres defaults,
and keeps stdout reserved for the MCP protocol. For MCP client config, prefer
calling the script directly:

```json
{
  "mcpServers": {
    "rollomap": {
      "command": "/absolute/path/to/rollomap/scripts/launch-mcp.sh"
    }
  }
}
```

### Tools exposed

| Tool                            | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `search_people`                 | Search people by name, email, company, role, or summary.     |
| `brief_person`                  | Evidence-backed briefing for a person (by id or name).       |
| `find_people_for_idea`          | Rank people in your network for an idea/opportunity.         |
| `get_relationship_history`      | Chronological interaction timeline for a person.             |
| `search_interactions`           | Full-text search over interactions.                          |
| `list_open_loops`               | List open follow-ups / commitments.                          |
| `find_neglected_relationships`  | Surface high-strength contacts you haven't seen in N days.   |
| `add_note`                      | Attach a manual note to a person.                            |
| `update_person`                 | Edit a person's editable fields (logged as a correction).    |
| `add_interaction`               | Log a meeting, email summary, or call.                       |
| `list_topics`                   | List topics with associated person counts.                   |

All tool calls are scoped to the workspace `WORKSPACE_ID` and never aggregate
across workspaces (per the PRD's privacy principle).

## REST API

A minimal REST surface for the webapp. See `packages/api/src/routes/` for the
full set. Highlights:

- `GET    /api/people?q=…&topic=…`
- `GET    /api/people/:id`        — full profile (topics, interactions, notes, commitments)
- `POST   /api/people`            — create
- `PATCH  /api/people/:id`        — update
- `POST   /api/people/merge`      — merge two people (reversible via `user_correction`)
- `POST   /api/people/:id/topics` — link a topic
- `GET    /api/interactions`
- `POST   /api/interactions`
- `GET    /api/topics`
- `POST   /api/notes`
- `GET    /api/commitments?status=open`
- `GET    /api/sources/items`
- `POST   /api/sources/import`    — bulk import source items + auto-create people
- `POST   /api/query/people-for-idea`
- `POST   /api/query/person-briefing`
- `POST   /api/query/search`
- `GET    /api/query/neglected?days=90`

## Importing data

Until OAuth connectors land, use `POST /api/sources/import` (or the **Sources**
page in the webapp) with a JSON payload like:

```json
{
  "items": [
    {
      "source_type": "email",
      "title": "Re: meal planning chaos",
      "body": "Honestly the meal planning thing is killing us...",
      "person_emails": ["jane@example.com"],
      "created_at_source": "2026-04-20"
    }
  ]
}
```

People with new emails will be auto-created and linked as participants of an
interaction tied to the imported source.

## Webapp pages

- **Ask** — ranked "who would be interested in this?" with evidence cards
- **People** — searchable list, add new people, click into a profile
- **Person profile** — summary, topics, open loops, notes, interactions, edit/merge/delete
- **Topics** — list/create topics, drill into the people associated
- **Interactions** — searchable list, log a new interaction
- **Open loops** — your pending commitments; mark done / dismiss / reopen
- **Review** — neglected relationships
- **Sources** — recent ingested items + JSON importer

## Privacy

Per the PRD, this is a single-user, single-workspace local setup. There is
no auth and no cross-workspace aggregation; the schema is workspace-scoped
end-to-end so multi-tenant isolation can be added later without restructuring.

## License

Personal use; not yet licensed for distribution.
