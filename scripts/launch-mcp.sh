#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgres://rollomap:rollomap@localhost:5432/rollomap}"
export WORKSPACE_ID="${WORKSPACE_ID:-00000000-0000-0000-0000-000000000001}"

cd "$REPO_ROOT"

if [[ -x "$REPO_ROOT/node_modules/.bin/tsx" ]]; then
  exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/packages/mcp-server/src/index.ts"
fi

exec npx -y tsx "$REPO_ROOT/packages/mcp-server/src/index.ts"
