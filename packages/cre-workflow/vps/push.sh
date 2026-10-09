#!/usr/bin/env bash
# Run on the MAC, from the repository. Ships the settlement job's code from this checkout to the VPS:
#   packages/cre-workflow (without var/, .tools/, node_modules/, evidence/, *.wasm, keys or .env files),
#   packages/abi and deployments/testnet.json, into ~/isotherm on the VPS (the repository's layout, so every relative
#   path keeps working). It never sends a key, the Mac's state, the CRE session or the toolchain.
#
#   packages/cre-workflow/vps/push.sh <vps> [--setup] [--force]
#     <vps>     an ssh destination (user@host) or a ~/.ssh/config alias; key-based login (BatchMode)
#     --setup   then run vps/setup.sh on the VPS (asks for the sudo password there)
#     --force   push even at minutes :03-:09 UTC (next to the hourly :05 run)
# Env: ISOTHERM_VPS_DIR (default isotherm), ISOTHERM_VPS_SSH_OPTS (extra ssh options, e.g. "-p 2222").
# Updates later: run it again (state, toolchain and node_modules on the VPS are kept; rsync replaces files atomically).
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
DEST=${1:?usage: vps/push.sh <vps> [--setup] [--force]}; shift
# shellcheck source=lib-mac.sh
. "$PKG/vps/lib-mac.sh"
SETUP=0; FORCE=0
for a in "$@"; do case "$a" in --setup) SETUP=1 ;; --force) FORCE=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
M=$((10#$(date -u +%M)))
if [ "$FORCE" = 0 ] && [ "$M" -ge 3 ] && [ "$M" -le 9 ]; then say "REFUSED: minute :$M is next to the :05 run; push from :10 on (or --force)"; exit 2; fi
vssh "mkdir -p '$VPS_PKG' '$VPS_DIR/packages/abi' '$VPS_DIR/deployments'" || { say "cannot reach the VPS over ssh"; exit 2; }
if command -v rsync >/dev/null && vssh "command -v rsync >/dev/null"; then
  RSH="ssh -o ConnectTimeout=15 -o BatchMode=yes ${ISOTHERM_VPS_SSH_OPTS:-}"
  rsync -az --delete -e "$RSH" \
    --exclude '/var/' --exclude '/.tools/' --exclude 'node_modules/' --exclude '/evidence/' --exclude '/vps/evidence/' \
    --exclude '*.wasm' --exclude '/settle/config.anvil-replay.json' --exclude '/settle/.cre_build_tmp.js' \
    --exclude '*.key' --exclude '.env' --exclude '.env.*' --exclude '.DS_Store' \
    "$PKG/" "$DEST:$VPS_PKG/"
  rsync -az --delete -e "$RSH" --exclude '.DS_Store' "$REPO/packages/abi/" "$DEST:$VPS_DIR/packages/abi/"
  rsync -az -e "$RSH" "$REPO/deployments/testnet.json" "$DEST:$VPS_DIR/deployments/testnet.json"
else
  # first push to a fresh VPS without rsync (vps/setup.sh installs it): a tar stream, same exclusions, no deletions
  say "no rsync on the VPS yet: copying with tar over ssh (later pushes use rsync)"
  COPYFILE_DISABLE=1 tar -C "$PKG" --no-xattrs --exclude './var' --exclude './.tools' --exclude 'node_modules' \
    --exclude './evidence' --exclude './vps/evidence' --exclude '*.wasm' --exclude './settle/config.anvil-replay.json' \
    --exclude './settle/.cre_build_tmp.js' --exclude '*.key' --exclude '.env' --exclude '.env.*' --exclude '.DS_Store' \
    -cf - . | vssh "tar -C '$VPS_PKG' -xf - --no-same-owner"
  COPYFILE_DISABLE=1 tar -C "$REPO/packages/abi" --no-xattrs --exclude '.DS_Store' -cf - . | vssh "tar -C '$VPS_DIR/packages/abi' -xf - --no-same-owner"
  vssh "cat > '$VPS_DIR/deployments/testnet.json'" <"$REPO/deployments/testnet.json"
fi
DIRTY=""; [ -n "$(git -C "$REPO" status --porcelain -- packages/cre-workflow packages/abi deployments 2>/dev/null)" ] && DIRTY=" + uncommitted changes"
printf 'commit %s%s, pushed %s\n' "$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)" "$DIRTY" "$(date -u +%FT%TZ)" | vssh "cat > '$VPS_DIR/SOURCE'"
# shellcheck disable=SC2086
LOCAL=$(sha_local $CODE_FILES | sort)
REMOTE=$(vssh "cd '$VPS_PKG' && sha256sum $CODE_FILES" | awk '{print $2 "=" $1}' | sort)
if [ "$LOCAL" = "$REMOTE" ]; then say "pushed; the job's code on the VPS is byte-identical to this checkout ($(vssh "cat '$VPS_DIR/SOURCE'"))"
else say "WARNING: code on the VPS differs from this checkout after the push:"; diff <(echo "$LOCAL") <(echo "$REMOTE") || true; exit 1; fi
if [ "$SETUP" = 1 ]; then
  ssh -t -o ConnectTimeout=15 ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$DEST" "bash '$VPS_PKG/vps/setup.sh'"
else
  say "next, if the toolchain or settle/bun.lock is new on the VPS: ssh -t $DEST bash $VPS_PKG/vps/setup.sh"
fi
