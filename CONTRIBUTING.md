# Contributing to RolloMap

Thanks for your interest in RolloMap! This project is local-first relationship
intelligence — a tool that helps you remember and nurture your relationships,
where **you own your data**. Contributions of all kinds are welcome: bug
reports, features, docs, and ideas.

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open a [bug report](https://github.com/Ministry-of-Product/rollomap/issues/new/choose).
- **Request a feature** — open a [feature request](https://github.com/Ministry-of-Product/rollomap/issues/new/choose).
- **Ask a question / share an idea** — use
  [GitHub Discussions](https://github.com/Ministry-of-Product/rollomap/discussions).
- **Send a change** — see the workflow below. Looking for a place to start? Check
  issues labeled [`good first issue`](https://github.com/Ministry-of-Product/rollomap/labels/good%20first%20issue).

## Project layout

RolloMap is an npm-workspaces monorepo:

| Path | What it is |
| -- | -- |
| `packages/api` | REST API (Node/Express) over Postgres |
| `packages/mcp-server` | MCP server exposing RolloMap tools to MCP clients |
| `packages/webapp` | Web UI |
| `db/` | SQL migrations and seed data |
| `docs/` | Architecture, sync, connectors, and philosophy docs |
| `ops/` | Operational helpers (e.g. cloud auto-sync) |
| `ingest/` | Ingest inbox + the ingest skill under `.claude/skills/ingest` |

## Prerequisites

- **Node.js >= 20** (see `engines` in `package.json`)
- **Docker** (for Postgres, and optionally the full stack)

## Getting set up

```bash
git clone https://github.com/Ministry-of-Product/rollomap.git
cd rollomap
cp .env.example .env
npm install
```

### Run the whole stack in Docker

```bash
docker compose up --build      # webapp on :5173, API on :4000, Postgres on :5432
```

### Or run Postgres in Docker and the apps in Node (nicer for development)

```bash
npm run db:up                  # start Postgres in Docker
npm run seed                   # load sample data
npm run dev:api                # API on http://localhost:4000
npm run dev:webapp             # webapp on http://localhost:5173
npm run dev:mcp                # MCP server (stdio)
```

Reset the database at any time:

```bash
npm run db:reset               # drops the volume and re-creates Postgres
npm run seed                   # reload sample data
```

## Before you open a pull request

Please make sure the workspace typechecks and builds:

```bash
npm run typecheck
npm run build
```

- Keep changes focused; one logical change per PR.
- Match the style and conventions of the surrounding code.
- Update docs (`README.md`, `docs/`) when you change behavior.
- If you add or change a migration in `db/`, note it in your PR description —
  there is no migration-runner table, so migrations may need a manual apply on
  existing databases.
- **Never commit personal data.** RolloMap holds real relationship data locally;
  keep it out of the repo. Local personalization seeds (`*.local.sql`,
  `*.local.json`) are gitignored on purpose.

## Opening the pull request

1. Fork the repo and create a branch off `main`.
2. Make your change, with clear commit messages.
3. Push and open a PR against `main`. The
   [PR template](.github/PULL_REQUEST_TEMPLATE.md) will prompt you for a summary,
   testing notes, and a checklist.
4. A maintainer will review. Please be responsive to feedback — small,
   well-described PRs get merged fastest.

## Reporting security issues

Do **not** open a public issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for how to report them privately.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE), the same license that covers the project.
