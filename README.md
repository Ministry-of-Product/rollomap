# RolloMap

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

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

![RolloMap walkthrough — browsing people, a person profile, topics, and open loops](docs/assets/demo.gif)

<p align="center">
  <img src="docs/assets/people.png" alt="People directory" width="49%" />
  <img src="docs/assets/person-profile.png" alt="Person profile with timeline, topics, notes, and open loops" width="49%" />
</p>

<sub>Screens show synthetic demo data (`db/demo-seed.sql`) — no real people. See
[`scripts/screenshots/`](scripts/screenshots/) to regenerate.</sub>

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

## Cloud sync

A local client can run as a local-first replica that pairs to a cloud server
(`https://rollomap.com`) and replicates its graph both ways. Sync is driven by
the API: `POST /api/cloud/sync` pushes local changes and pulls peers'. Trigger
one by hand with:

> For exactly which entities and fields replicate (and which are local-only),
> see [`docs/sync-field-coverage.md`](docs/sync-field-coverage.md).

```bash
curl -X POST http://localhost:4000/api/cloud/sync
```

### Always-on auto-sync (macOS)

Nothing syncs on a schedule by default — `POST /api/cloud/sync` only runs when
called. To push local changes (and pull peers') every 15 minutes hands-free,
install the launchd agent:

```bash
ops/sync/install.sh          # installs com.rollomap.sync (runs every 15 min)
ops/sync/uninstall.sh        # removes it
```

`install.sh` copies the sync script to `~/.rollomap` and points a launchd agent
at it. The copy is deliberate: macOS TCC blocks launchd from executing scripts
under `~/Documents`/`~/Desktop`/`~/Downloads` (`Operation not permitted`), and
this repo commonly lives under `~/Documents`. Results are logged to
`~/Library/Logs/rollomap-sync.log`.

**Boot race:** right after a reboot the first tick may fire before the API is
ready and log `http=000`; the next tick recovers, so the first post-boot sync
can lag up to ~15 min. Background and rationale: MIN-1130. A cleaner
API-internal replacement for this agent is tracked in MIN-1131.

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
| `get_profile`                   | Read the workspace profile (owner identity, interests, import recipes, journal skip-phrases). |
| `update_profile`                | Update the workspace profile.                                |

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
- `GET    /api/profile`           — read the workspace profile
- `PUT    /api/profile`           — update the workspace profile

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

## Personalization

Per-workspace personalization (owner identity, interests, saved CSV import
recipes, and journal skip-phrases used by the ingest skill) lives in the
`workspace_profile` table, managed via `PUT /api/profile` (REST) or the MCP
`update_profile` tool — read it back with `GET /api/profile` / `get_profile`.
Nothing personal is hardcoded in the repo; scripts and skills read
personalization from the profile at runtime, falling back to generic
defaults (or the `USER_INTERESTS` / `INGEST_SKIP_EMAIL` / `INGEST_SKIP_NAME`
env vars — see `.env.example`) when the profile has nothing set. For
example, `research_person`-style topic-overlap detection is sourced from
`profile.interests`, and the ingest skill's `extract-dated-interactions.py`
reads `profile.journalSkipPhrases` to recognize source-specific journal
section titles to skip.

## Privacy

Per the PRD, this is a single-user, single-workspace local setup. There is
no auth and no cross-workspace aggregation; the schema is workspace-scoped
end-to-end so multi-tenant isolation can be added later without restructuring.

## Why RolloMap?

Your relationships are among the most valuable things you have, but the memory of
them is scattered and lossy. Most tools that promise to help do it by uploading
your contacts and inbox to their servers. RolloMap takes the opposite stance:
it runs on your machine, against your database, and **you own your data**. Every
claim links back to source evidence, nothing is aggregated across users, and the
whole thing is open source so you can verify exactly what it does.

Read more in [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md).

## Contributing

Contributions are welcome — bug reports, features, docs, and ideas. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to build and submit changes, and
[good first issues](https://github.com/Ministry-of-Product/rollomap/labels/good%20first%20issue)
for a place to start.

- [Contributing guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md) — report vulnerabilities privately
- [Discussions](https://github.com/Ministry-of-Product/rollomap/discussions) — questions and ideas
- [Documentation](docs/README.md)

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 The RolloMap
Authors. See [NOTICE](NOTICE) for attribution.
