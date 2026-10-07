#!/usr/bin/env bash
# Settlement runner for LIVE Monad testnet.
#
# OFFICIAL mode (default): the unpatched CRE CLI v1.37.0 (./setup.sh)
#     cre workflow simulate ./settle -T testnet --non-interactive --trigger-index 2 --broadcast
#   The CRE engine runs the compiled WASM, fetches the METAR sources, signs with the attester key (CRE secret
#   ISOTHERM_ATTESTER_KEY) and sends each report through the MockKeystoneForwarder 0xB9F7…d192 from
#   CRE_ETH_PRIVATE_KEY (~0.0204 MON per report: 200k gas limit x 102 gwei). Requires `cre login` (human, once).
# HARNESS mode (--harness, or --harness-if-no-login): FALLBACK that is NOT the CRE engine. The same handler runs in the
#   CRE SDK test harness under Bun (not WASM) and delivers the same attested report through the same forwarder call.
#   Use it only so that live ladders settle while nobody has run `cre login`; label any evidence accordingly.
#
# Usage: scripts/run-official.sh [--official | --harness | --harness-if-no-login] [--no-broadcast] [--force] [--preflight-only]
#   --no-broadcast   do everything but send (official: simulate without --broadcast; harness: stop before sending)
#   --force          skip the 30-min spacing guard (only if the previous run's attestations have expired)
#   --preflight-only key files, attester address == Resolver.attester(), pause flag, tx-sender balance; then exit
# Env:   ISOTHERM_ATTESTER_KEY_FILE (default ~/.config/isotherm/attester.key)
#        ISOTHERM_TX_KEY_FILE       (default: the attester key file; the attester was funded with 0.1 MON for gas)
#        ISOTHERM_RPC               (harness mode only; default live testnet. Refused with the LIVE attester key.)
#        ISOTHERM_STATE_DIR         (spacing guard + lock + logs). Default for the LIVE RPC: the runtime copy's
#                                   ~/isotherm-live/packages/cre-workflow/var when it exists, so a manual run from the
#                                   repo and the launchd job share ONE lock and ONE 30-min spacing guard; otherwise var.
#        HARNESS_EXTRA / HARNESS_AT / ISOTHERM_TEST_RELABEL (harness fork tests only)
# Exit:  0 ok / nothing to do / skipped, 2 preflight failed, 3 not logged in to CRE (official mode),
#        4 a report was sent but not accepted on chain.
#
# Safety: an anvil fork shares the live Resolver's EIP-712 domain, so reports signed there with the LIVE attester key
# would be valid on live testnet too. This script refuses any non-live RPC while the key is the live attester.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin:/opt/homebrew/bin:/usr/local/bin"
LIVE_RPC=https://testnet-rpc.monad.xyz
RPC=${ISOTHERM_RPC:-$LIVE_RPC}
MODE=official
BROADCAST=1
FORCE=0
PREFLIGHT_ONLY=0
TRIGGER=2
while [ $# -gt 0 ]; do
  case "$1" in
    --official) MODE=official ;;
    --harness) MODE=harness ;;
    --harness-if-no-login) MODE=auto ;;
    --no-broadcast) BROADCAST=0 ;;
    --force) FORCE=1 ;;
    --preflight-only) PREFLIGHT_ONLY=1 ;;
    --trigger-index) TRIGGER=$2; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
RUNTIME_STATE="${ISOTHERM_RUNTIME:-$HOME/isotherm-live}/packages/cre-workflow/var"
if [ -z "${ISOTHERM_STATE_DIR:-}" ] && [ "$RPC" = "$LIVE_RPC" ] && [ -d "$RUNTIME_STATE" ]; then STATE=$RUNTIME_STATE; else STATE=${ISOTHERM_STATE_DIR:-var}; fi
mkdir -p "$STATE/logs"
LOG="$STATE/logs/run-$(date -u +%Y%m%dT%H%M%SZ).log"
say() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
DEP="$PKG/../../deployments/testnet.json"
jget() { node -e 'const d=require(process.argv[1]); console.log(process.argv[2].split(".").reduce((o,k)=>o[k],d))' "$1" "$2"; }

# ---- 0. tools
command -v cre >/dev/null && command -v bun >/dev/null || { say "missing tools: run ./setup.sh first"; exit 2; }
case "$(cre version 2>/dev/null | head -1)" in *v1.37.0*) ;; *) say "unexpected CRE CLI (pinned v1.37.0 via ./setup.sh)"; exit 2 ;; esac
case "$(command -v cre)" in *nologin*) say "refusing a patched CLI"; exit 2 ;; esac

# ---- 1. mode + CRE login (the official simulator refuses to run without it)
LOGGED_IN=0
# `cre whoami` talks to the CRE API: bound it (perl alarm; macOS has no `timeout`) so a hung call cannot stall launchd.
if [ -n "${CRE_API_KEY:-}" ] || perl -e 'alarm shift; exec @ARGV' 45 cre whoami </dev/null >/dev/null 2>&1; then LOGGED_IN=1; fi
if [ "$MODE" = auto ]; then if [ "$LOGGED_IN" = 1 ]; then MODE=official; else MODE=harness; fi; fi
if [ "$MODE" = official ] && [ "$RPC" != "$LIVE_RPC" ]; then say "official mode always uses the -T testnet target; ISOTHERM_RPC is for --harness"; exit 2; fi
if [ "$MODE" = official ] && [ "$LOGGED_IN" = 0 ] && [ "$PREFLIGHT_ONLY" = 0 ]; then
  cat <<'MSG' | tee -a "$LOG"
NOT LOGGED IN TO CRE. `cre workflow simulate` (unlike `cre workflow build`) requires a Chainlink CRE account.
One-time human steps:
  1. Create an account: https://app.chain.link/cre/discover -> "Create an account"
     (email + 6-digit code, password, authenticator-app 2FA).
  2. Log in on this Mac (opens a browser, asks for the 2FA code):
       cd <repo>/packages/cre-workflow
       export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
       cre login && cre whoami
  3. Optional, for a real DON deployment later: `cre account access` (request deploy access).
Then re-run: scripts/run-official.sh
Until then: scripts/dry-run.sh shows what a run would do (no login, no MON), and
scripts/run-official.sh --harness settles through the SDK harness (fallback, NOT the CRE engine).
MSG
  exit 3
fi
say "mode=$MODE rpc=$RPC cre-login=$([ $LOGGED_IN = 1 ] && echo yes || echo no) broadcast=$BROADCAST"

# ---- 2. keys (never printed; handed to the child process through its environment or a file path only)
ATT_FILE=${ISOTHERM_ATTESTER_KEY_FILE:-$HOME/.config/isotherm/attester.key}
TX_FILE=${ISOTHERM_TX_KEY_FILE:-$ATT_FILE}
for f in "$ATT_FILE" "$TX_FILE"; do
  [ -r "$f" ] || { say "key file not readable: $f"; exit 2; }
  [ "$(stat -f %Lp "$f")" = "600" ] || { say "key file must be chmod 600: $f"; exit 2; }
done
addr_of() { (cd settle && KEYFILE="$1" bun -e 'import {privateKeyToAccount} from "viem/accounts"; const k=require("fs").readFileSync(process.env.KEYFILE,"utf8").trim(); console.log(privateKeyToAccount((k.startsWith("0x")?k:"0x"+k)).address)'); }
ATT_ADDR=$(addr_of "$ATT_FILE")
TX_ADDR=$(addr_of "$TX_FILE")
RESOLVER=$(jget "$DEP" resolver)
VAULT=$(jget "$DEP" vault)
[ "$RESOLVER" = "$(jget "$PKG/settle/config.testnet.json" resolverAddress)" ] || { say "config.testnet.json resolver != deployments/testnet.json"; exit 2; }
if [ "$RPC" != "$LIVE_RPC" ] && [ "$ATT_ADDR" = "$(jget "$DEP" roles.attester)" ]; then
  say "REFUSED: the LIVE attester key on a non-live RPC ($RPC). Its signatures would be valid on live testnet."; exit 2
fi
[ "$(cast chain-id --rpc-url "$RPC")" = 10143 ] || { say "RPC is not chain 10143"; exit 2; }

# ---- 3. on-chain preflight (eth_call only)
ONCHAIN_ATT=$(cast call "$RESOLVER" 'attester()(address)' --rpc-url "$RPC")
[ "$ONCHAIN_ATT" = "$ATT_ADDR" ] || { say "attester key address $ATT_ADDR != Resolver.attester() $ONCHAIN_ATT"; exit 2; }
[ "$(cast call "$RESOLVER" 'paused()(bool)' --rpc-url "$RPC")" = "false" ] || { say "Resolver is paused: nothing to do"; exit 0; }
BAL=$(cast balance "$TX_ADDR" --rpc-url "$RPC")
say "attester $ATT_ADDR == Resolver.attester(); tx sender $TX_ADDR has $(cast from-wei "$BAL") MON; vault ladders $(cast call "$VAULT" 'ladderCount()(uint256)' --rpc-url "$RPC")"
if [ "$BROADCAST" = 1 ] && ! node -e 'process.exit(BigInt(process.argv[1]) >= 25000000000000000n ? 0 : 1)' "$BAL"; then
  say "tx sender has < 0.025 MON (one report: 200k gas x 102 gwei = 0.0204 MON)"; exit 2
fi
if [ "$PREFLIGHT_ONLY" = 1 ]; then say "preflight OK"; exit 0; fi

# ---- 4. one run at a time, >= 30 min apart (attestation TTL is 25 min: two runs' signatures never overlap)
# A lock older than 20 min is stale (a run takes < 1 min; a crash/reboot mid-run would otherwise block every later run).
if [ -d "$STATE/run.lock" ] && [ -n "$(find "$STATE/run.lock" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then say "removing stale $STATE/run.lock (> 20 min old)"; rmdir "$STATE/run.lock" 2>/dev/null || true; fi
if ! mkdir "$STATE/run.lock" 2>/dev/null; then say "another run holds $STATE/run.lock; skipping"; exit 0; fi
trap 'rmdir "$STATE/run.lock" 2>/dev/null || true' EXIT
NOW=$(date +%s)
LAST=$(cat "$STATE/last-run" 2>/dev/null || echo 0)
if [ "$FORCE" != 1 ] && [ $((NOW - LAST)) -lt 1800 ]; then say "last run $((NOW - LAST)) s ago (< 1800 s spacing); skipping"; exit 0; fi
echo "$NOW" > "$STATE/last-run"

# ---- 5. run
set +e
if [ "$MODE" = official ]; then
  say "OFFICIAL: cre workflow simulate ./settle -T testnet --non-interactive --trigger-index $TRIGGER $([ $BROADCAST = 1 ] && echo --broadcast)"
  CRE_ETH_PRIVATE_KEY="$(tr -d '[:space:]' <"$TX_FILE")" \
  ISOTHERM_ATTESTER_KEY_ALL="$(tr -d '[:space:]' <"$ATT_FILE")" \
    cre workflow simulate ./settle -T testnet --non-interactive --trigger-index "$TRIGGER" $([ $BROADCAST = 1 ] && echo --broadcast) 2>&1 | tee -a "$LOG"
  RC=${PIPESTATUS[0]}
else
  say "HARNESS (fallback, not the CRE engine): settle/e2e/harness-run.ts"
  (cd settle && ISOTHERM_RPC="$RPC" ISOTHERM_ATTESTER_KEY_FILE="$ATT_FILE" ISOTHERM_TX_KEY_FILE="$TX_FILE" HARNESS_BROADCAST="$BROADCAST" \
    bun test --timeout 300000 ./e2e/harness-run.ts) 2>&1 | grep -v "^bun test v\|^$" | tee -a "$LOG"
  RC=${PIPESTATUS[0]}
fi
set -e
[ "$RC" = 0 ] || { say "run exited $RC"; exit "$RC"; }

# ---- 6. confirm on chain (the forwarder never reverts: decode ReportProcessed(result) + LadderResolved)
HASHES=$(grep -oE 'tx 0x[0-9a-f]{64} ->' "$LOG" | grep -oE '0x[0-9a-f]{64}' | grep -v '^0x0*$' | sort -u | tr '\n' ' ' || true)
if [ "$BROADCAST" = 1 ] && [ -n "${HASHES// /}" ]; then
  (cd settle && bun e2e/confirm.ts --rpc "$RPC" $HASHES) 2>&1 | tee -a "$LOG" || { say "a report was sent but NOT accepted on chain (see $LOG)"; exit 4; }
fi
say "done; log: $LOG"
