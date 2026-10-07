#!/usr/bin/env bash
# Renders launchd/com.isotherm.cre-settle.plist.template for this checkout and validates it with plutil.
# By default it only writes var/com.isotherm.cre-settle.plist and prints the commands; installing a LaunchAgent is a
# persistent change to this Mac, so a human runs it with --install (or the printed commands).
#   scripts/install-launchd.sh             # render + lint only
#   scripts/install-launchd.sh --install   # copy to ~/Library/LaunchAgents and load it (human action)
#   ... --install --harness-fallback       # same, but fall back to the SDK-harness runner while not logged in to CRE
#   scripts/install-launchd.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
LABEL=com.isotherm.cre-settle
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p var/logs
FLAG=--official
for a in "$@"; do [ "$a" = --harness-fallback ] && FLAG=--harness-if-no-login; done
sed -e "s#__PKG__#$PKG#g" -e "s#__HOME__#$HOME#g" -e "s#__MODE_FLAG__#$FLAG#g" launchd/$LABEL.plist.template > "var/$LABEL.plist"
plutil -lint "var/$LABEL.plist"
case "${1:-}" in
  --install)
    ./scripts/run-official.sh "$FLAG" --preflight-only
    cp "var/$LABEL.plist" "$DEST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$DEST"
    launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|path|last exit" || true
    echo "installed: runs at minute 35 every hour; logs in $PKG/var/logs/ (run-*.log, launchd.*.log)"
    echo "run now once:  launchctl kickstart gui/$(id -u)/$LABEL" ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$DEST"; echo "removed $DEST" ;;
  *)
    echo "rendered var/$LABEL.plist (not installed). To install (human action, after 'cre login'):"
    echo "  $PKG/scripts/install-launchd.sh --install" ;;
esac
