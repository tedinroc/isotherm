#!/bin/bash
# Copy the settlement workflow (+ the files it reads) to the runtime directory OUTSIDE ~/Documents, then optionally
# (re)load the two launchd jobs from there. Same pattern as packages/maker/scripts/deploy-runtime.sh: launchd-started
# bash/bun cannot read ~/Documents (macOS TCC; exit 126 "Operation not permitted").
#   scripts/deploy-runtime.sh            sync only (the next scheduled run uses the new code)
#   scripts/deploy-runtime.sh --load     sync + render + bootstrap xyz.isotherm.cre-settle and xyz.isotherm.challenge-watch
#   scripts/deploy-runtime.sh --unload   bootout both jobs (the copy stays)
#   scripts/deploy-runtime.sh --status   launchctl state + next runs + latest evidence
# Layout mirrors the repo, so relative paths keep working:
#   $RT/packages/cre-workflow  (scripts, launchd, settle incl. node_modules, .tools incl. the pinned cre CLI + bun)
#   $RT/packages/abi, $RT/deployments/testnet.json   (shared with the maker's runtime copy; same source files)
# Runtime state (logs, lock, spacing guard, evidence, watcher state) lives in $RT/packages/cre-workflow/var and is
# never overwritten by a sync.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RT="${ISOTHERM_RUNTIME:-$HOME/isotherm-live}"
case "$RT" in "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*) echo "runtime dir must be outside TCC-protected folders: $RT"; exit 1;; esac
SRC="$REPO/packages/cre-workflow"
[ -x "$SRC/.tools/bin/cre" ] && [ -d "$SRC/settle/node_modules" ] || { echo "run $SRC/setup.sh first (cre CLI, bun, npm deps)"; exit 1; }
mkdir -p "$RT/packages/cre-workflow/var" "$RT/packages/abi" "$RT/deployments"
rsync -a --delete --exclude '/var/' --exclude '/evidence/' --exclude '/settle/config.anvil-replay.json' --exclude '/settle/.cre_build_tmp.js' \
  "$SRC/" "$RT/packages/cre-workflow/"
rsync -a "$REPO/packages/abi/" "$RT/packages/abi/"
cmp -s "$REPO/deployments/testnet.json" "$RT/deployments/testnet.json" || cp "$REPO/deployments/testnet.json" "$RT/deployments/testnet.json"
xattr -c "$RT/packages/cre-workflow/.tools/bin/cre" 2>/dev/null || true
[ -f "$RT/REPO_PATH" ] || printf '%s\n' "$REPO" > "$RT/REPO_PATH"
echo "synced $SRC -> $RT/packages/cre-workflow ($(du -sh "$RT/packages/cre-workflow" | cut -f1))"
case "${1:-}" in
  --load) bash "$RT/packages/cre-workflow/scripts/install-launchd.sh" --load ;;
  --unload) bash "$RT/packages/cre-workflow/scripts/install-launchd.sh" --unload ;;
  --status) bash "$RT/packages/cre-workflow/scripts/install-launchd.sh" --status ;;
esac
