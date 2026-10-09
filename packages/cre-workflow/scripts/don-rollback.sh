#!/usr/bin/env bash
# Rolls settlement back from the Chainlink DON to the Mac path (the reverse of scripts/don-cutover.sh). Use it when the
# DON misses a settlement (no LadderResolved by 19:40 UTC for an 18:00 UTC attempt) or misbehaves. DON-CUTOVER.md.
#
#   scripts/don-rollback.sh               DRY RUN (default): prints the current state and the exact steps. Sends nothing.
#   scripts/don-rollback.sh --execute     owner only, confirmed by typing the owner address:
#     R1. cre workflow pause ./settle -T testnet-don --yes     (stop DON executions; a failure here does not stop R2-R5)
#     R2. Resolver.setExpectedWorkflow(0x00…00, 0x00…00)      MANDATORY before R3: the mock's fixed owner 0xaa…aa
#                                                              fails any owner pin
#     R3. Resolver.setForwarder(0xB9F79d863261869B234c481D1f9A7af84AeAd192)   (the MockKeystoneForwarder)
#     R4. eth_call checks (mock accepted, production forwarder rejected); activeForwarder -> mock in deployments/testnet.json
#     R5. reload ONLY the Mac job xyz.isotherm.cre-settle (launchctl bootstrap of its installed plist). The challenge
#         watcher stays on the Cloudflare Worker; scripts/deploy-runtime.sh --load would also start the Mac watcher.
#         Before the reload, the runtime copy's deployments/testnet.json gets activeForwarder = mock as well (the
#         harness fallback delivers to activeForwarder).
#         If this Mac handed settlement to the VPS (var/writer.released in the runtime copy, vps/cutover.sh), R5 does NOT
#         reload the Mac job: the VPS job stands down only while the forwarder is not the mock, so its next :05 run
#         settles by itself (vps/README.md, "With the Chainlink DON").
# The Mac job's next :05 run then settles anything due through the MockKeystoneForwarder (same attester key).
# No time-window gate: this is the emergency path. Owner calls work while the Resolver is paused.
# Options: --confirm-owner 0x…, --rpc URL, --no-cre-pause (skip R1), --no-reload (skip R5)
# Fork rehearsal only (refused on live testnet): --fork-unlocked (impersonate the owner), --facts FILE (no CRE/launchd)
# Env: ISOTHERM_OWNER_KEY_FILE (default ~/.config/isotherm/deployer.key; read only with --execute, never printed)
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin:/opt/homebrew/bin:/usr/local/bin"
MODE=dry; RPC=https://testnet-rpc.monad.xyz; FORK_UNLOCKED=0; FACTS=""; CONFIRM_OWNER=""; CRE_PAUSE=1; RELOAD=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry ;;
    --execute) MODE=execute ;;
    --rpc) RPC=$2; shift ;;
    --confirm-owner) CONFIRM_OWNER=$2; shift ;;
    --no-cre-pause) CRE_PAUSE=0 ;;
    --no-reload) RELOAD=0 ;;
    --fork-unlocked) FORK_UNLOCKED=1 ;;
    --facts) FACTS=$2; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p var/don
LOG="$PKG/var/don/rollback-$(date -u +%Y%m%dT%H%M%SZ).log"
# shellcheck source=lib-don.sh
. "$PKG/scripts/lib-don.sh"
say "don-rollback: mode=$MODE"
require_network
PLIST="$HOME/Library/LaunchAgents/xyz.isotherm.cre-settle.plist"
RT_PKG="${ISOTHERM_RUNTIME:-$HOME/isotherm-live}/packages/cre-workflow"

G=$(ops_json gates --rpc "$RPC" --now-from "$([ "$IS_FORK" = 1 ] && echo chain || echo clock)")
[ -n "$G" ] || { say "REFUSED: chain reads failed"; exit 2; }
ONCHAIN_OWNER=$(jq -r .resolver.owner <<<"$G")
FWD=$(jq -r .resolver.forwarder <<<"$G")
EXP_ID=$(jq -r .resolver.expectedWorkflowId <<<"$G")
EXP_OWNER=$(jq -r .resolver.expectedWorkflowOwner <<<"$G")
NEED_EXP=1; NEED_FWD=1
[ "$(lc "$EXP_ID")" = "$ZERO32" ] && [ "$(lc "$EXP_OWNER")" = "$ZERO20" ] && NEED_EXP=0
[ "$(lc "$FWD")" = "$(lc "$MOCK")" ] && NEED_FWD=0
[ "$(jq -r .window.ok <<<"$G")" = true ] || say "note: $(jq -r .window.reason <<<"$G") (rollback is not gated on time)"
[ "$(jq -r .resolver.paused <<<"$G")" = true ] && say "note: the Resolver is PAUSED; owner calls still work, the Mac job will skip until the owner unpauses"

PLAN_FROM=$ONCHAIN_OWNER
say "rollback steps (owner $ONCHAIN_OWNER):"
say "  R1. cre workflow pause ./settle -T testnet-don --yes$([ "$CRE_PAUSE" = 0 ] && echo '   [skipped: --no-cre-pause]')"
if [ "$NEED_EXP" = 1 ]; then plan_line R2 'setExpectedWorkflow(bytes32,address)' "$ZERO32,$ZERO20"; else say "  R2. setExpectedWorkflow(0,0): already zero, skipped"; fi
if [ "$NEED_FWD" = 1 ]; then plan_line R3 'setForwarder(address)' "$MOCK"; else say "  R3. setForwarder(mock): already the mock, skipped"; fi
say "  R4. eth_call checks + deployments/testnet.json activeForwarder -> $MOCK"
VPS_WRITER=0; [ -f "$RT_PKG/var/writer.released" ] && VPS_WRITER=1
if [ "$VPS_WRITER" = 1 ]; then
  say "  R5. the settlement writer is the VPS ($RT_PKG/var/writer.released): the Mac job is NOT reloaded; the VPS job resumes at its next :05 run"
else
  say "  R5. runtime copy activeForwarder -> mock, then launchctl bootstrap gui/\$(id -u) $PLIST   (only xyz.isotherm.cre-settle)$([ "$RELOAD" = 0 ] && echo '   [skipped: --no-reload]')"
fi

if [ "$MODE" = dry ]; then say "DRY RUN: nothing was sent and nothing was reloaded. Re-run with --execute as the owner."; exit 0; fi

resolve_signer "$ONCHAIN_OWNER"
[ "$GATES_FAILED" = 0 ] || { say "REFUSED: $GATES_FAILED gate(s) failed; nothing was sent"; exit 10; }

# R1
if [ "$CRE_PAUSE" = 1 ]; then
  if [ -n "$FACTS" ]; then say "R1 (rehearsal): would run: cre workflow pause ./settle -T testnet-don --yes"
  elif perl -e 'alarm shift; exec @ARGV' 120 cre workflow pause ./settle -T testnet-don --yes --non-interactive </dev/null 2>&1 | tee -a "$LOG"; then say "R1 done: DON workflow paused"
  else say "R1 FAILED (CRE unreachable or not logged in?): continuing; after R3 any DON report fails InvalidSender and changes nothing"; fi
fi
# R2, R3
[ "$NEED_EXP" = 0 ] || owner_send 'setExpectedWorkflow(bytes32,address)' "$ZERO32,$ZERO20" || { say "R2 did not confirm: re-run the rollback (it re-reads the Resolver and skips what is already done)"; exit 1; }
[ "$NEED_FWD" = 0 ] || owner_send 'setForwarder(address)' "$MOCK" || { say "R3 did not confirm after R2: re-run the rollback (DON reports are still accepted meanwhile, without the owner pin)"; exit 1; }
# R4
ops postcheck --rpc "$RPC" --mode mock 2>&1 | tee -a "$LOG" || { say "R4 POSTCHECK FAILED"; exit 1; }
DEP_OUT=$DEP
if [ "$IS_FORK" = 1 ]; then DEP_OUT="$PKG/var/don/rehearsal-deployments.json"; [ -f "$DEP_OUT" ] || cp "$DEP" "$DEP_OUT"; fi
ops set-active-forwarder --file "$DEP_OUT" --forwarder "$MOCK" 2>&1 | tee -a "$LOG" >/dev/null
# R5
if [ "$RELOAD" = 1 ] && [ "$VPS_WRITER" = 1 ]; then
  say "R5: not reloading the Mac job: this Mac released the settlement writer role to the VPS ($(tr -d '\n' <"$RT_PKG/var/writer.released" | cut -c1-160))."
  say "R5: the VPS job's next :05 run settles through the mock. Its deployments/testnet.json must say activeForwarder = mock for the harness fallback: if it was pushed during the DON period, run vps/push.sh <vps> again. Check: ssh <vps> bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh status"
elif [ "$RELOAD" = 1 ]; then
  if [ -n "$FACTS" ]; then say "R5 (rehearsal): would run: launchctl bootstrap gui/\$(id -u) $PLIST"
  else
    if [ ! -f "$PLIST" ]; then
      [ -x "$RT_PKG/scripts/install-launchd.sh" ] || { say "R5: no installed plist and no runtime copy at $RT_PKG: run scripts/deploy-runtime.sh first"; exit 1; }
      bash "$RT_PKG/scripts/install-launchd.sh" >/dev/null   # render only (no load)
      cp "$RT_PKG/var/launchd/xyz.isotherm.cre-settle.plist" "$PLIST"
    fi
    RT_DEP="$RT_PKG/../../deployments/testnet.json"
    if [ -f "$RT_DEP" ] && [ "$(lc "$(jq -r .activeForwarder "$RT_DEP")")" != "$(lc "$MOCK")" ]; then
      ops set-active-forwarder --file "$RT_DEP" --forwarder "$MOCK" 2>&1 | tee -a "$LOG" >/dev/null
      say "R5: runtime copy deployments/testnet.json activeForwarder -> $MOCK"
    fi
    launchctl bootout "gui/$(id -u)/xyz.isotherm.cre-settle" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    say "R5 done: xyz.isotherm.cre-settle loaded; next run at :05 ($(launchctl print "gui/$(id -u)/xyz.isotherm.cre-settle" 2>/dev/null | grep -E $'^\tstate =' | tr -d '\t'))"
  fi
fi
say "DONE: settlement is back on the $([ "$VPS_WRITER" = 1 ] && echo "VPS's" || echo Mac) path (MockKeystoneForwarder + attestation). activeForwarder updated in $DEP_OUT. log: $LOG"
