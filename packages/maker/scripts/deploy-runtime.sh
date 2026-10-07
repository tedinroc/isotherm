#!/bin/bash
# Copy the maker (and what it imports) to a runtime directory OUTSIDE ~/Documents, then (re)load the launchd jobs
# from there. Why: launchd-started bash/node cannot read ~/Documents (macOS privacy/TCC; exit 126 "Operation not
# permitted"). Live state stays in $RT/packages/maker/var; config/local.json points both copies at those absolute
# paths, so the single-writer lock covers the repo copy too.
#   scripts/deploy-runtime.sh            sync code only (running jobs keep the old code until restarted)
#   scripts/deploy-runtime.sh --load     sync + render + bootstrap the 3 launchd jobs from the runtime copy
#   scripts/deploy-runtime.sh --restart  sync + restart the loop (launchctl kickstart -k)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RT="${ISOTHERM_RUNTIME:-$HOME/isotherm-live}"
case "$RT" in "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*) echo "runtime dir must be outside TCC-protected folders: $RT"; exit 1;; esac
mkdir -p "$RT/packages/maker/var/log" "$RT/packages/forecast" "$RT/packages/abi" "$RT/deployments"
rsync -a --delete --exclude 'var/' --exclude 'evidence/' --exclude 'launchd/rendered/' "$REPO/packages/maker/" "$RT/packages/maker/"
rsync -a --exclude 'data/cache/' "$REPO/packages/forecast/" "$RT/packages/forecast/"
rsync -a "$REPO/packages/forecast/data/cache/" "$RT/packages/forecast/data/cache/" 2>/dev/null || true
rsync -a --delete "$REPO/packages/abi/" "$RT/packages/abi/"
cp "$REPO/deployments/testnet.json" "$RT/deployments/testnet.json"
printf '%s\n' "$REPO" > "$RT/REPO_PATH"
echo "synced $REPO -> $RT"
case "${1:-}" in
  --load) bash "$RT/packages/maker/launchd/install.sh" --load ;;
  --restart) launchctl kickstart -k "gui/$(id -u)/xyz.isotherm.maker" && echo "restarted xyz.isotherm.maker" ;;
esac
