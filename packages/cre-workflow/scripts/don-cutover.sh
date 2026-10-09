#!/usr/bin/env bash
# Switches settlement of the v1 Resolver from the Mac path (MockKeystoneForwarder 0xB9F7…d192) to the Chainlink DON
# (production KeystoneForwarder 0xF834…4482), once the `testnet-don` workflow is deployed and has run cleanly.
# Runbook and context: DON-CUTOVER.md.
#
#   scripts/don-cutover.sh                 DRY RUN (default): checks every gate and prints the exact owner calls.
#                                          Sends nothing. Exit 0 = READY, 10 = NOT READY.
#   scripts/don-cutover.sh --execute       checks every gate again, then, only when run by the Resolver owner and
#                                          confirmed by typing the owner address, sends from the owner key:
#                                            1. Resolver.setForwarder(0xF8344CFd5c43616a4366C34E3EEE75af79a74482)
#                                            2. Resolver.setExpectedWorkflow(0x00…00, <organization owner>)
#                                          then verifies by eth_call and sets activeForwarder in deployments/testnet.json.
# Options: --confirm-owner 0x…   the typed confirmation (otherwise prompted when run in a terminal)
#          --pin-workflow-id     also pin the workflow ID (default: owner only; any config or binary change moves the ID)
#          --shadow-checked      the operator read the shadow executions' logs by hand (DON-CUTOVER.md step C3);
#                                use only if `cre execution logs` cannot be read by this script
#          --no-launchd-probe    dry run only: do not query launchd (--execute always checks that the Mac job is unloaded)
#          --rpc URL             default https://testnet-rpc.monad.xyz
# Fork rehearsal only (refused on live testnet):
#          --fork-unlocked       impersonate Resolver.owner() on the anvil fork instead of using a key
#          --facts FILE          JSON standing in for the CRE CLI and launchd answers (no CRE login on a fork)
# Env:   ISOTHERM_OWNER_KEY_FILE (default ~/.config/isotherm/deployer.key; read only with --execute, never printed)
#
# Gates (all must pass): CRE deploy access Enabled; the testnet-don workflow ACTIVE with >= 1 SUCCESS execution and a
# successful latest execution whose logs show the chain reads ("nothing to settle (ladders=N…)", N >= 1); the
# deployed workflow ID reproduces from this checkout with the organization owner (so that owner is what the DON puts
# in report metadata); Resolver not paused and still on the MockKeystoneForwarder; no ladder due or due within 1 h,
# no settled ladder inside its challenge window; outside :55-:10, :25-:35 and 16:45-18:15 UTC; the Mac job
# xyz.isotherm.cre-settle unloaded, and its installed runtime copy carries the stand-down check (launchd reloads the
# job at the next login); run by the owner.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin:/opt/homebrew/bin:/usr/local/bin"
MODE=dry; RPC=https://testnet-rpc.monad.xyz; FORK_UNLOCKED=0; FACTS=""; CONFIRM_OWNER=""; PIN_ID=0; PROBE_LAUNCHD=1; SHADOW_CHECKED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry ;;
    --execute) MODE=execute ;;
    --rpc) RPC=$2; shift ;;
    --confirm-owner) CONFIRM_OWNER=$2; shift ;;
    --pin-workflow-id) PIN_ID=1 ;;
    --shadow-checked) SHADOW_CHECKED=1 ;;
    --no-launchd-probe) PROBE_LAUNCHD=0 ;;
    --fork-unlocked) FORK_UNLOCKED=1 ;;
    --facts) FACTS=$2; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$MODE" = execute ] && PROBE_LAUNCHD=1
mkdir -p var/don
LOG="$PKG/var/don/cutover-$(date -u +%Y%m%dT%H%M%SZ).log"
# shellcheck source=lib-don.sh
. "$PKG/scripts/lib-don.sh"
say "don-cutover: mode=$MODE"
require_network
uc() { tr '[:lower:]' '[:upper:]' <<<"$1"; }
cre_t() { perl -e 'alarm shift; exec @ARGV' "$@" </dev/null 2>/dev/null; } # cre_t <seconds> cre …  (bounded, no prompt)

# ---------------------------------------------------------------- 1. CRE side (deploy access, workflow health)
if [ -n "$FACTS" ]; then
  say "CRE and launchd facts from $FACTS (fork rehearsal; the CRE CLI is not called)"
  DEPLOY_ACCESS=$(jq -r .deployAccess "$FACTS")
  WF_JSON=$(jq -c .workflow "$FACTS")
  SUCC=$(jq -r .successfulExecutions "$FACTS")
  SHADOW_LOG=$(jq -r '.shadowLog // ""' "$FACTS")
  SHADOW_NODES=$(jq -r '.shadowNodes // 0' "$FACTS")
  ID_MATCH=$(jq -r 'if .workflowIdMatchesCheckout == false then "no" else "yes" end' "$FACTS")
  LOCAL_HASH="(facts)"
  MAC_JOB=$(jq -r 'if .macJobLoaded then "loaded" else "not loaded" end' "$FACTS")
  RT_STANDDOWN=$(jq -r 'if .runtimeStandsDown == false then "no" else "yes" end' "$FACTS")
else
  case "$(cre version 2>/dev/null | head -1)" in *v1.37.0*) ;; *) say "REFUSED: unexpected CRE CLI (pinned v1.37.0 via ./setup.sh)"; exit 2 ;; esac
  # only the "Deploy Access" line is kept (the account box also shows the login email)
  DEPLOY_ACCESS=$(cre_t 60 cre whoami | sed -n 's/.*Deploy Access:[[:space:]]*\([A-Za-z ]*[A-Za-z]\).*/\1/p' | head -1 || true)
  DEPLOY_ACCESS=${DEPLOY_ACCESS:-unknown (cre whoami failed: not logged in?)}
  # JSON shape (CLI v1.37.0, internal/workflowresolve/workflow_status.go): {workflow:{name,workflowId,ownerAddress,
  # status,…}, deployment:{…}, lastExecution:{uuid,status,startedAt,…}}
  WF_JSON=$(cre_t 90 cre workflow get ./settle -T testnet-don --non-interactive --output json | jq -c . 2>/dev/null || echo null)
  SUCC=0; SHADOW_LOG=""; SHADOW_NODES=0; ID_MATCH=no; LOCAL_HASH=""
  WF_HEX=$(jq -r '.workflow.workflowId // empty' <<<"$WF_JSON"); WF_HEX=${WF_HEX#0x}
  if [ -n "$WF_HEX" ]; then
    # `cre execution list` takes the 64-hex workflow ID without 0x (internal/workflowresolve/ids.go)
    SUCC=$(cre_t 90 cre execution list "$WF_HEX" --status SUCCESS --limit 20 --non-interactive --output json | jq 'length' 2>/dev/null || echo 0)
    LAST_UUID=$(jq -r '.lastExecution.uuid // empty' <<<"$WF_JSON")
    if [ -n "$LAST_UUID" ]; then
      LOGS=$(cre_t 90 cre execution logs "$LAST_UUID" --non-interactive --output json || echo '[]')
      SHADOW_LOG=$(jq -r '[.[] | .message | select(test("nothing to settle \\(ladders="))][0] // ""' <<<"$LOGS" 2>/dev/null || true)
      SHADOW_NODES=$(jq -r '[.[] | select(.message | test("nothing to settle \\(ladders=")) | .nodeID] | unique | length' <<<"$LOGS" 2>/dev/null || echo 0)
    fi
  fi
  if [ "$PROBE_LAUNCHD" = 1 ]; then
    if launchctl print "gui/$(id -u)/xyz.isotherm.cre-settle" >/dev/null 2>&1; then MAC_JOB=loaded; else MAC_JOB="not loaded"; fi
  else
    MAC_JOB="not probed (dry run with --no-launchd-probe)"
  fi
  # `launchctl bootout` does not survive a login: the plist stays in ~/Library/LaunchAgents, so launchd loads the job
  # again after a restart. It must then stand down by itself, i.e. the runtime copy must carry the forwarder check.
  RT_RUN="${ISOTHERM_RUNTIME:-$HOME/isotherm-live}/packages/cre-workflow/scripts/run-official.sh"
  if [ ! -f "$RT_RUN" ]; then RT_STANDDOWN=none
  elif grep -q 'SKIPPED: Resolver.forwarder()' "$RT_RUN"; then RT_STANDDOWN=yes
  else RT_STANDDOWN=no; fi
fi
WF_STATUS=$(jq -r '.workflow.status // "not deployed"' <<<"$WF_JSON")
WF_HEX=$(jq -r '.workflow.workflowId // empty' <<<"$WF_JSON"); WF_HEX=${WF_HEX#0x}
ORG_OWNER=$(jq -r '.workflow.ownerAddress // empty' <<<"$WF_JSON")
LAST_EXEC=$(jq -r '.lastExecution.status // "none"' <<<"$WF_JSON")
gate "$([ "$DEPLOY_ACCESS" = Enabled ] && echo 1 || echo 0)" "CRE deploy access" "$DEPLOY_ACCESS"
gate "$([ "$(uc "$WF_STATUS")" = ACTIVE ] && echo 1 || echo 0)" "testnet-don workflow active" "status $WF_STATUS${WF_HEX:+, workflow ID 0x$WF_HEX}"
gate "$([ "${SUCC:-0}" -ge 1 ] 2>/dev/null && [ "$(uc "$LAST_EXEC")" = SUCCESS ] && echo 1 || echo 0)" "shadow executions" "${SUCC:-0} SUCCESS execution(s); latest execution $LAST_EXEC"
SHADOW_N=$(sed -n 's/.*ladders=\([0-9]*\).*/\1/p' <<<"$SHADOW_LOG" | head -1)
if [ "${SHADOW_N:-0}" -ge 1 ] 2>/dev/null; then
  gate 1 "shadow run read the chain" "latest execution logged '$SHADOW_LOG' on $SHADOW_NODES node(s)"
elif [ "$SHADOW_CHECKED" = 1 ]; then
  gate 1 "shadow run read the chain" "checked by hand by the operator (--shadow-checked); this script found no summary line"
else
  gate 0 "shadow run read the chain" "no 'nothing to settle (ladders=N…)' line with N >= 1 in the latest execution's logs (cre execution logs). Check step C3 by hand, then pass --shadow-checked"
fi
ORG_OK=0
if [ -n "$ORG_OWNER" ] && [ "$(lc "$ORG_OWNER")" != "$ZERO20" ] && [ "$(lc "$ORG_OWNER")" != "0x$(printf 'aa%.0s' $(seq 1 20))" ]; then ORG_OK=1; fi
gate "$ORG_OK" "organization owner (workflow owner in DON report metadata)" "${ORG_OWNER:-unknown}"
if [ -z "$FACTS" ] && [ "$ORG_OK" = 1 ] && [ -n "$WF_HEX" ]; then
  # The workflow ID is keccak-derived from (owner, name, binary, config) (CLI cmd/workflow/hash, the same function
  # `deploy` uses). Reproducing it with ORG_OWNER proves that owner is the one the DON writes into report metadata.
  LOCAL_HASH=$(cre_t 120 cre workflow hash ./settle -T testnet-don --public_key "$ORG_OWNER" | sed -n 's/.*Workflow hash:[[:space:]]*\(0x\)\{0,1\}\([0-9a-fA-F]*\).*/\2/p' | head -1 || true)
  [ -n "$LOCAL_HASH" ] && [ "$(lc "$LOCAL_HASH")" = "$(lc "$WF_HEX")" ] && ID_MATCH=yes
fi
gate "$([ "$ID_MATCH" = yes ] && echo 1 || echo 0)" "deployed workflow ID reproduces from this checkout with that owner" "deployed ${WF_HEX:+0x}${WF_HEX:-?}, local ${LOCAL_HASH:-?}"
case "$MAC_JOB" in
  "not loaded") gate 1 "Mac job xyz.isotherm.cre-settle unloaded" "$MAC_JOB" ;;
  loaded) gate 0 "Mac job xyz.isotherm.cre-settle unloaded" "loaded: launchctl bootout gui/\$(id -u)/xyz.isotherm.cre-settle first" ;;
  *) say "GATE SKIP  Mac job xyz.isotherm.cre-settle unloaded: $MAC_JOB (always checked by --execute)" ;;
esac
case "$RT_STANDDOWN" in
  yes) gate 1 "installed Mac job stands down after the switch" "the runtime copy's run-official.sh checks Resolver.forwarder()" ;;
  none) gate 1 "installed Mac job stands down after the switch" "no runtime copy installed: no Mac job can come back" ;;
  *) gate 0 "installed Mac job stands down after the switch" "the runtime copy runs an older run-official.sh without the forwarder check, and launchd reloads the job at the next login: run scripts/deploy-runtime.sh first (sync only, no --load)" ;;
esac

# ---------------------------------------------------------------- 2. chain side
NOW_FROM=$([ "$IS_FORK" = 1 ] && echo chain || echo clock)
G=$(ops_json gates --rpc "$RPC" --now-from "$NOW_FROM")
[ -n "$G" ] || { say "REFUSED: chain reads failed"; exit 2; }
ONCHAIN_OWNER=$(jq -r .resolver.owner <<<"$G")
FWD=$(jq -r .resolver.forwarder <<<"$G")
if [ "$(lc "$FWD")" = "$(lc "$PROD")" ] && [ -n "$ORG_OWNER" ] && [ "$(lc "$(jq -r .resolver.expectedWorkflowOwner <<<"$G")")" = "$(lc "$ORG_OWNER")" ]; then
  say "nothing to do: the Resolver already points at the production forwarder with the owner pinned"; exit 0
fi
chain_gates() { # chain_gates <gates json>
  gate "$([ "$(jq -r .resolver.paused <<<"$1")" = false ] && echo 1 || echo 0)" "Resolver not paused" "paused=$(jq -r .resolver.paused <<<"$1")"
  gate "$([ "$(lc "$(jq -r .resolver.forwarder <<<"$1")")" = "$(lc "$MOCK")" ] && echo 1 || echo 0)" "Resolver on the MockKeystoneForwarder (the Mac path)" "forwarder $(jq -r .resolver.forwarder <<<"$1")"
  gate "$(jq -r 'if .nothingDue then 1 else 0 end' <<<"$1")" "nothing due" "due $(jq -c .ladders.due <<<"$1"), due within 1 h $(jq -c .ladders.dueSoon <<<"$1")"
  gate "$(jq -r 'if .challengeClear then 1 else 0 end' <<<"$1")" "challenge window clear" "$(jq -c .ladders.challengeOpen <<<"$1")"
  gate "$(jq -r 'if .window.ok then 1 else 0 end' <<<"$1")" "time window" "$(jq -r .now <<<"$1") UTC: $(jq -r .window.reason <<<"$1")"
}
chain_gates "$G"

# ---------------------------------------------------------------- 3. the exact calls
EXPECT_ID=$ZERO32
[ "$PIN_ID" = 1 ] && [ -n "$WF_HEX" ] && EXPECT_ID=0x$WF_HEX
ORG_ARG=${ORG_OWNER:-<organization owner>}
PLAN_FROM=$ONCHAIN_OWNER
say "owner calls (from Resolver.owner() $ONCHAIN_OWNER, in this order):"
plan_line 1 'setForwarder(address)' "$PROD"
if [ "$ORG_OK" = 1 ]; then plan_line 2 'setExpectedWorkflow(bytes32,address)' "$EXPECT_ID,$ORG_OWNER"
else say "  2. Resolver($RESOLVER).setExpectedWorkflow(bytes32,address) args [$EXPECT_ID,$ORG_ARG] (owner unknown until the workflow is deployed)"; fi
say "  then: eth_call checks (production forwarder + org owner accepted, owner 0xaa…aa and the mock rejected) and deployments/testnet.json activeForwarder -> $PROD"

if [ "$MODE" = dry ]; then
  if [ "$GATES_FAILED" = 0 ]; then say "DRY RUN: READY. Nothing was sent. Re-run with --execute as the owner."; exit 0; fi
  say "DRY RUN: NOT READY ($GATES_FAILED gate(s) failed). Nothing was sent."; exit 10
fi

# ---------------------------------------------------------------- 4. execute (owner only)
[ "$GATES_FAILED" = 0 ] || { say "REFUSED: $GATES_FAILED gate(s) failed; nothing was sent"; exit 10; }
resolve_signer "$ONCHAIN_OWNER"
[ "$GATES_FAILED" = 0 ] || { say "REFUSED: $GATES_FAILED gate(s) failed; nothing was sent"; exit 10; }
# the prompt may have taken a while: every chain gate again, right before the first transaction
W=$(ops_json gates --rpc "$RPC" --now-from "$NOW_FROM")
[ -n "$W" ] || { say "REFUSED: chain reads failed; nothing was sent"; exit 2; }
chain_gates "$W"
[ "$GATES_FAILED" = 0 ] || { say "REFUSED: a chain gate closed while confirming; nothing was sent"; exit 10; }
say "EXECUTE: switching the Resolver to the Chainlink DON"
owner_send 'setForwarder(address)' "$PROD" || { say "setForwarder did not confirm. Run the dry run to read Resolver.forwarder(): still the mock = nothing changed, retry later; the production forwarder = it landed late, so send setExpectedWorkflow by hand (the 'by hand' line above) or roll back"; exit 1; }
if ! owner_send 'setExpectedWorkflow(bytes32,address)' "$EXPECT_ID,$ORG_OWNER"; then
  say "setForwarder landed but setExpectedWorkflow did not. DON reports are accepted (attestation still required) without the owner pin. This script will not resume (the Resolver is no longer on the mock): send setExpectedWorkflow by hand (the 'by hand' line above), or roll back with scripts/don-rollback.sh --execute"; exit 1
fi
ops postcheck --rpc "$RPC" --mode don --org-owner "$ORG_OWNER" --workflow-id "$EXPECT_ID" 2>&1 | tee -a "$LOG" || { say "POSTCHECK FAILED: roll back with scripts/don-rollback.sh --execute"; exit 1; }
DEP_OUT=$DEP
if [ "$IS_FORK" = 1 ]; then DEP_OUT="$PKG/var/don/rehearsal-deployments.json"; cp "$DEP" "$DEP_OUT"; fi
ops set-active-forwarder --file "$DEP_OUT" --forwarder "$PROD" 2>&1 | tee -a "$LOG" >/dev/null
say "DONE: settlement now runs on the Chainlink DON. activeForwarder updated in $DEP_OUT"
say "next: watch the first DON settlement (scripts/don-evidence.sh), keep the Mac plist installed but unloaded; rollback: scripts/don-rollback.sh"
say "log: $LOG"
