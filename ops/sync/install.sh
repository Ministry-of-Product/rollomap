#!/bin/bash
# Install the RolloMap 15-min cloud auto-sync launchd agent (macOS).
# Idempotent: re-running refreshes the installed script and reloads the agent.
#
# NOTE: the script is COPIED out of the repo to ~/.rollomap before install.
# macOS TCC blocks launchd agents from executing files under ~/Documents,
# ~/Desktop, ~/Downloads (you would see "Operation not permitted", exit 126),
# and this repo commonly lives under ~/Documents. Running from ~/.rollomap
# avoids that entirely.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.rollomap.sync"
INSTALL_DIR="$HOME/.rollomap"
SCRIPT="$INSTALL_DIR/rollomap-sync.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/rollomap-sync.launchd.log"

mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$HERE/rollomap-sync.sh" "$SCRIPT"
chmod +x "$SCRIPT"

sed -e "s|__SCRIPT_PATH__|$SCRIPT|g" -e "s|__LOG_PATH__|$LOG|g" \
    "$HERE/com.rollomap.sync.plist.template" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $LABEL -> POST /api/cloud/sync every 15 min (runs $SCRIPT)."
echo "Result log: $HOME/Library/Logs/rollomap-sync.log"
