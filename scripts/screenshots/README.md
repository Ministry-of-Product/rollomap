# README screenshots

Reproducible screenshots (and an optional GIF) of the RolloMap webapp, captured
with [Playwright](https://playwright.dev/) against a **throwaway demo stack**
seeded with synthetic data.

> **Never capture against your real data.** RolloMap holds real people's
> information. These scripts run an isolated Postgres seeded from
> [`db/demo-seed.sql`](../../db/demo-seed.sql) (fictional people only) so nothing
> personal ends up in the repo.

## One-time setup

```bash
npm install                 # includes @playwright/test (devDependency)
npx playwright install chromium
```

## Bring up an isolated demo stack

Use ports that don't collide with a running dev stack (Postgres `5544`, API
`4100`, webapp `5273`):

```bash
# 1. Ephemeral Postgres (no volume => wiped on rm)
docker run -d --name rollomap-demo-pg \
  -e POSTGRES_USER=rollomap -e POSTGRES_PASSWORD=rollomap -e POSTGRES_DB=rollomap \
  -p 5544:5432 postgres:16

# 2. Schema + demo data
for f in db/migrations/*.sql; do docker exec -i rollomap-demo-pg psql -q -U rollomap -d rollomap < "$f"; done
docker exec -i rollomap-demo-pg psql -q -U rollomap -d rollomap < db/demo-seed.sql

# 3. API against the demo DB
DATABASE_URL=postgres://rollomap:rollomap@localhost:5544/rollomap API_PORT=4100 \
  WORKSPACE_ID=00000000-0000-0000-0000-000000000001 npm run dev:api &

# 4. Webapp pointed at the demo API
VITE_API_URL=http://localhost:4100 npm --workspace @rollomap/webapp run dev -- --port 5273 --host &
```

## Capture

```bash
BASE_URL=http://localhost:5273 OUT_DIR=docs/assets node scripts/screenshots/capture.mjs
```

Writes `people.png`, `person-profile.png`, `topics.png`, `interactions.png`,
and `open-loops.png` to `docs/assets/`.

## Tear down

```bash
docker rm -f rollomap-demo-pg
# stop the backgrounded `npm run dev:api` / webapp dev servers (jobs -l; kill …)
```
