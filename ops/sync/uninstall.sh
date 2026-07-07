#!/bin/bash
# Remove the RolloMap auto-sync launchd agent (macOS). Leaves logs in place.
set -euo pipefail

LABEL="com.rollomap.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST" "$HOME/.rollomap/rollomap-sync.sh"
rmdir "$HOME/.rollomap" 2>/dev/null || true
echo "Removed $LABEL."
