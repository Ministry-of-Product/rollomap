#!/bin/bash
# RolloMap periodic cloud sync (MIN-1130 follow-up).
#
# POSTs /api/cloud/sync on the local API and records the result. Intended to be
# run every 15 min by the launchd agent installed via ./install.sh, but it is
# safe to run by hand at any time.
#
# Override the API endpoint with ROLLOMAP_API_URL if the API is not on :4000.

API_URL="${ROLLOMAP_API_URL:-http://localhost:4000/api/cloud/sync}"
LOG="$HOME/Library/Logs/rollomap-sync.log"
LAST="$HOME/Library/Logs/rollomap-sync-last.json"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

resp="$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$API_URL" 2>/dev/null)"
code="$(printf '%s' "$resp" | tail -n1)"
body="$(printf '%s' "$resp" | sed '$d')"

# http=000 means the API was unreachable (e.g. right after boot, before the
# Docker container is ready); the next 15-min tick recovers automatically.
printf '%s http=%s %s\n' "$TS" "$code" "$body" >> "$LOG"
[ -n "$body" ] && printf '%s\n' "$body" > "$LAST"

# Keep the log bounded (last 500 lines).
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
