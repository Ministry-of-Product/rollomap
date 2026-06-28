#!/usr/bin/env bash
# Reset the throwaway test database (rollomap_test) and apply ALL migrations.
#
# Used by `npm --workspace @rollomap/api run pretest` so the sync integration
# tests (node:test) run against a clean schema that includes every numbered
# migration in db/migrations/. The live `rollomap` database is never touched.
#
# Assumes the local docker stack is up (container: rollomap-postgres).
set -euo pipefail

CONTAINER="${ROLLOMAP_PG_CONTAINER:-rollomap-postgres}"
DB="${ROLLOMAP_TEST_DB:-rollomap_test}"
USER="${POSTGRES_USER:-rollomap}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[reset-test-db] dropping and recreating ${DB}"
docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE);" >/dev/null
docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "CREATE DATABASE ${DB};" >/dev/null

for f in "$ROOT"/db/migrations/*.sql; do
  echo "[reset-test-db] applying $(basename "$f")"
  docker exec -i "$CONTAINER" psql -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 < "$f" >/dev/null
done

echo "[reset-test-db] done — ${DB} is clean and fully migrated"
