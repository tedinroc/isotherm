#!/bin/bash
# Render the launchd templates for this Mac. By default it only writes launchd/rendered/*.plist for review.
#   launchd/install.sh            render
#   launchd/install.sh --load     render, copy to ~/Library/LaunchAgents and bootstrap them (go-live step only)
#   launchd/install.sh --unload   bootout and remove them
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(cd "$HERE/.." && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"; NODE_DIR="$(dirname "$NODE")"
LOGDIR="$PKG/var/log"; mkdir -p "$LOGDIR" "$HERE/rendered"
LABELS="xyz.isotherm.maker xyz.isotherm.roll xyz.isotherm.watchdog"
for l in $LABELS; do
  sed -e "s#__PKG__#$PKG#g" -e "s#__NODE__#$NODE#g" -e "s#__NODE_DIR__#$NODE_DIR#g" -e "s#__LOGDIR__#$LOGDIR#g" "$HERE/$l.plist.template" > "$HERE/rendered/$l.plist"
  plutil -lint "$HERE/rendered/$l.plist" >/dev/null
done
echo "rendered: $HERE/rendered (node $NODE)"
if [ "${1:-}" = "--load" ]; then
  ENV_FILE="$HOME/.config/isotherm/maker.env"
  [ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (ISOTHERM_ALLOW_LIVE=1, ISOTHERM_API_URL, ISOTHERM_SNAPSHOT_TOKEN); chmod 600 it"; exit 1; }
  for l in $LABELS; do
    cp "$HERE/rendered/$l.plist" "$HOME/Library/LaunchAgents/$l.plist"
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$l.plist"
  done
  launchctl list | grep xyz.isotherm || true
elif [ "${1:-}" = "--unload" ]; then
  for l in $LABELS; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$l.plist"; done
fi
