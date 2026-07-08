# Changelog

All notable changes to RolloMap are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## v0.1.0 — First public release

**RolloMap is local-first relationship intelligence.** It builds a private,
queryable map of the people in your network from notes, emails, and meetings you
bring to it — and every claim links back to source evidence. It runs on your
machine, against your database. **You own your data.**

This is the first local **v1**: deliberately small, private by default, and open
source under Apache 2.0.

### What's included

- **A local relationship graph.** People, interactions, topics, notes, and
  commitments in Postgres, with full-text search (`tsvector`). Entity resolution
  merges the same person across sources; merges are reversible.
- **Web app.** Browse and search your network, open a person's profile with a
  full interaction timeline, manage topics, review **open loops** (follow-ups you
  owe), and see neglected relationships worth reviving. Pages: Ask, People,
  Person profile, Topics, Interactions, Open loops, Review, Sources, Cloud.
- **REST API.** A clean HTTP surface over the graph (people, interactions,
  topics, notes, commitments, sources, and query endpoints) — see the
  [README](README.md#rest-api).
- **MCP server.** 13 tools that let your own AI agents work with your graph over
  the [Model Context Protocol](https://modelcontextprotocol.io) — including
  `search_people`, `brief_person`, `find_people_for_idea`,
  `get_relationship_history`, `list_open_loops`, `find_neglected_relationships`,
  `add_interaction`, and `add_note`. Every call is workspace-scoped and never
  aggregates across workspaces.
- **Bring-your-own-data import.** Load data via `POST /api/sources/import` or the
  **Sources** page with a simple JSON payload; new people are auto-created and
  linked. No silent harvesting of your accounts.
- **Optional cloud sync.** Pair a client to replicate *your own* graph across
  *your own* devices. It's opt-in and off by default — never a condition of
  using RolloMap. An always-on 15-minute auto-sync agent for macOS ships in
  [`ops/sync/`](ops/sync/).

### Privacy

RolloMap is **private by default**. There is no cross-user aggregation, no shadow
profiles, and no requirement to send your data anywhere. What you share is an
explicit action. See [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md).

### Install

Quickest path (Docker):

```bash
cp .env.example .env
docker compose up --build
# then open http://localhost:5173
```

Full instructions — including a Node-based dev setup and the MCP client config —
are in the [README](README.md#quick-start-docker).

### Known limitations

- **No OAuth connectors yet.** Gmail / Drive / Calendar ingestion comes later; v1
  is manual entry or JSON import.
- **Single-user, single-workspace.** No authentication; the schema is
  workspace-scoped end-to-end so multi-tenant isolation can be added later
  without restructuring.
- **Default dev credentials.** The local stack binds to `localhost` and ships
  with well-known credentials (see `.env.example`) — change them before exposing
  any service beyond your machine.
- **Migrations apply on first boot** and have no runner table; applying a new
  migration to an existing database is a manual step.

### What's next

Consent-based ingestion connectors, richer entity resolution, smarter recall,
and moving cloud auto-sync into the API itself. The through-line stays the same:
**the map of your relationships belongs to you.**

### Get involved

- ⭐ Star the repo if this resonates.
- 🐛 File issues and ideas — we've tagged a few
  [good first issues](https://github.com/Ministry-of-Product/rollomap/labels/good%20first%20issue).
- 🤝 See [CONTRIBUTING.md](CONTRIBUTING.md) to build and submit changes.
- 🔒 Report vulnerabilities privately via [SECURITY.md](SECURITY.md).

**Full license:** [Apache 2.0](LICENSE) · Copyright 2026 The RolloMap Authors.
