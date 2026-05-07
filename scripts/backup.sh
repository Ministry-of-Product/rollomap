#!/usr/bin/env bash
# Interim RolloMap backup. Plaintext custom-format pg_dump to a local folder.
# To be replaced by the encrypted GitHub-hosted version designed in MIN-521.
#
# Usage:
#   ./scripts/backup.sh                    # default destination
#   ./scripts/backup.sh /custom/path       # override destination
#
# Restore (full clean restore into the running container):
#   docker exec -i rollomap-postgres pg_restore -U rollomap -d rollomap \
#     --clean --if-exists --no-owner < <dump-file>
#
# Restore into a different DB name (safer when poking around):
#   docker exec rollomap-postgres createdb -U rollomap rollomap_restore
#   docker exec -i rollomap-postgres pg_restore -U rollomap -d rollomap_restore \
#     --no-owner < <dump-file>

set -euo pipefail

DEST="${1:-/Users/paulin/Desktop/RolloMap}"
KEEP=30
CONTAINER=rollomap-postgres
DB_USER=rollomap
DB_NAME=rollomap

if [[ ! -d "$DEST" ]]; then
  mkdir -p "$DEST"
  echo "created $DEST"
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "error: container '${CONTAINER}' is not running. Start with: docker compose up -d postgres" >&2
  exit 1
fi

ts="$(date +%Y-%m-%d-%H%M%S)"
dump="$DEST/rollomap-${ts}.dump"
manifest="$DEST/rollomap-${ts}.manifest.json"

echo "dumping ${DB_NAME} → ${dump}"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom > "$dump"

dump_bytes=$(stat -f%z "$dump")
sha=$(shasum -a 256 "$dump" | awk '{print $1}')

# Pull row counts directly from Postgres for the manifest
counts_json=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "
SELECT json_build_object(
  'person',       (SELECT count(*) FROM person),
  'interaction',  (SELECT count(*) FROM interaction),
  'note',         (SELECT count(*) FROM note),
  'note_deep_dive', (SELECT count(*) FROM note WHERE kind='deep_dive'),
  'topic',        (SELECT count(*) FROM topic),
  'person_topic', (SELECT count(*) FROM person_topic),
  'commitment',   (SELECT count(*) FROM commitment),
  'workspace_id', '$(echo "${WORKSPACE_ID:-00000000-0000-0000-0000-000000000001}")'
);
")

cat > "$manifest" <<EOF
{
  "timestamp": "${ts}",
  "iso_timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "dump_file": "$(basename "$dump")",
  "dump_bytes": ${dump_bytes},
  "sha256": "${sha}",
  "container": "${CONTAINER}",
  "db_name": "${DB_NAME}",
  "row_counts": ${counts_json}
}
EOF

echo "wrote manifest → ${manifest}"
echo "  size: $(du -h "$dump" | awk '{print $1}')"
echo "  sha256: ${sha}"

# Prune older dumps + manifests, keep the newest $KEEP pairs.
echo "pruning to keep newest ${KEEP} backups…"
ls -1t "$DEST"/rollomap-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "  rm $(basename "$old")"
  rm -f "$old" "${old%.dump}.manifest.json"
done

echo "done."
