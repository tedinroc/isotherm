#!/usr/bin/env bash
# Rehearses the whole DON switch on a fresh anvil fork of LIVE Monad testnet (v1 contracts), end to end:
#   refusals (time window, deploy access, no executions, a failed or silent shadow run, a workflow ID that does not
#   reproduce, Mac job loaded, Mac runtime copy without the stand-down check, wrong signer, wrong confirmation, live
#   RPC) -> cutover as the impersonated Resolver owner
#   -> the Mac path stands down -> a DON-signed report settles the next open vault ladder at its 02:00-local attempt
#   through the production KeystoneForwarder -> evidence record with path "don" -> rollback -> the Mac path settles again
#   through the MockKeystoneForwarder -> the same cutover + rollback signed from a key file (a throwaway owner on the fork).
# The timeline is computed from the fork's own clock (e2e/don-fork-deliver.ts prepare/target), so it can run at any
# time of day; a ladder that falls due on the way is settled through the Mac path first, as the hourly job would.
# No MON, no real key, no CRE login, no launchd: CRE and launchd answers come from facts files, the DON is a throwaway
# signer set registered on the forked forwarder, and the attester is a public test key. Values settled on the fork
# (e.g. 27 C) are test values, not weather.
# Port: ISOTHERM_ANVIL_PORT (default 19342). Output: evidence/don-rehearsal-fork.txt and evidence/don-rehearsal-evidence.jsonl.
set -uo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin"
PORT=${ISOTHERM_ANVIL_PORT:-19342}
RPC="http://127.0.0.1:$PORT"
W="$PKG/var/don/rehearsal"
rm -rf "$W"; mkdir -p "$W/home" evidence
OUT="$PKG/evidence/don-rehearsal-fork.txt"
: >"$OUT"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy" >&2; exit 1; fi
anvil --fork-url "${ISOTHERM_FORK_URL:-https://testnet-rpc.monad.xyz}" --port "$PORT" --silent >"$W/anvil.log" 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done

log() { echo "$*" | sed "s#$PKG/##g" | tee -a "$OUT"; }
FAILS=0
# expect <exit code> <title> <command...>: runs the command (HOME is a scratch dir: nothing reads ~/.cre or ~/isotherm-live)
expect() {
  local want=$1 title=$2; shift 2
  log ""
  log "=== $title"
  log "\$ $*"
  HOME="$W/home" "$@" 2>&1 | sed "s#$PKG/##g" | tee -a "$OUT"
  local rc=${PIPESTATUS[0]}
  if [ "$rc" = "$want" ]; then log "--> exit $rc (expected $want): PASS"; else log "--> exit $rc (expected $want): FAIL"; FAILS=$((FAILS + 1)); fi
}
check() { # check <true|false> <what>
  if [ "$1" = true ]; then log "--> $2: PASS"; else log "--> $2: FAIL"; FAILS=$((FAILS + 1)); fi
}
fork() { (cd settle && bun e2e/don-fork-deliver.ts "$@" --rpc "$RPC") 2>&1 | sed "s#$PKG/##g" | tee -a "$OUT"; }
fork_json() { fork "$@" | sed -n 's/^\[fork\] //p' | tail -1; }
blocktime() { cast block latest -f timestamp --rpc-url "$RPC"; }
iso() { date -u -r "$1" +%FT%TZ; }

OWNER=$(jq -r .roles.owner ../../deployments/testnet.json)
ORG=0x93cf74f0cb2df7a43a8bb8ff1445fc622beaf4f9                      # test organization owner (keccak of a public string)
WFID=0xbd9abc13b7b397df63e738b649aa8610fe70da7e721be5986bf7037a34399ad8  # test workflow id
SHADOW='nothing to settle (ladders=3, due=0, skipped=0)'              # stand-in for a shadow run's summary log line
facts() { # facts <file> <deployAccess> <successes> <lastStatus> <macLoaded> [shadowLog] [idMatches] [runtimeStandsDown]
  jq -n --arg da "$2" --argjson n "$3" --arg last "$4" --argjson mac "$5" --arg org "$ORG" --arg id "${WFID#0x}" \
    --arg sl "${6-$SHADOW}" --argjson idm "${7:-true}" --argjson rt "${8:-true}" \
    '{deployAccess:$da, workflow:{workflow:{name:"isotherm-settle", workflowId:$id, ownerAddress:$org, status:"ACTIVE"}, lastExecution:{uuid:"00000000-0000-4000-8000-000000000000", status:$last}}, successfulExecutions:$n, shadowLog:$sl, shadowNodes:4, workflowIdMatchesCheckout:$idm, macJobLoaded:$mac, runtimeStandsDown:$rt}' >"$1"
}
facts "$W/facts-ok.json" Enabled 2 SUCCESS false
facts "$W/facts-no-access.json" "Not enabled" 0 none false
facts "$W/facts-no-runs.json" Enabled 0 none false
facts "$W/facts-failed-run.json" Enabled 1 FAILURE false
facts "$W/facts-silent-run.json" Enabled 2 SUCCESS false ""
facts "$W/facts-id-mismatch.json" Enabled 2 SUCCESS false "$SHADOW" false
facts "$W/facts-mac-loaded.json" Enabled 2 SUCCESS true
facts "$W/facts-stale-runtime.json" Enabled 2 SUCCESS false "$SHADOW" true false
printf '%s\n' 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 >"$W/test-attester.key"   # anvil #9 (public)
printf '%s\n' 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba >"$W/not-owner.key"      # anvil #5 (public)
printf '%s\n' 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 >"$W/fork-owner.key"     # anvil #3 (public)
chmod 600 "$W"/*.key

log "# $(date -u +%FT%TZ) DON switch rehearsal on an anvil fork of live Monad testnet at block $(cast block-number --rpc-url "$RPC") ($(iso "$(blocktime)") chain time), port $PORT"
log "# test org owner $ORG, test workflow id $WFID; Resolver owner $OWNER is impersonated (no key)"
log ""
log "=== setup (fork only): public test attester; test DON config (donId 1, v1, f=3, 10 signers) on the production forwarder"
fork setup >/dev/null

# ---------------------------------------------------------------- the switch window, from the fork's clock
P=$(fork_json prepare --lead 900)
log "=== next cutover window on the fork: $(jq -c '{now, unsafe, safe, settledOnTheWay: [.settledOnTheWay[] | "\(.station) \(.date) \(.ladderResolved.status // "-") at \(.at)"], ladders}' <<<"$P")"
UNSAFE=$(jq -r .unsafe <<<"$P"); SAFE=$(jq -r .safe <<<"$P")

# ---------------------------------------------------------------- refusals before the switch
fork warp --at "$UNSAFE" >/dev/null
expect 10 "cutover dry run at $UNSAFE: refused by the time window (DON :30 run)" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-ok.json"
fork warp --at "$SAFE" >/dev/null
expect 10 "cutover dry run: deploy access not enabled (today's real state)" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-no-access.json"
expect 10 "cutover dry run: workflow deployed but no successful execution yet" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-no-runs.json"
expect 10 "cutover dry run: latest DON execution failed" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-failed-run.json"
expect 10 "cutover dry run: the shadow run's logs show no chain read" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-silent-run.json"
expect 10 "cutover dry run: the deployed workflow ID does not reproduce with the organization owner" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-id-mismatch.json"
expect 10 "cutover dry run: the Mac job is still loaded" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-mac-loaded.json"
expect 10 "cutover dry run: the installed Mac job has no stand-down check (launchd reloads it at the next login)" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-stale-runtime.json"
expect 2 "fork-only flags are refused on live testnet (one chain-id read, nothing else)" scripts/don-cutover.sh --rpc https://testnet-rpc.monad.xyz --fork-unlocked --facts "$W/facts-ok.json"
expect 0 "cutover dry run at $SAFE: READY; prints the exact owner calls, sends nothing" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-ok.json"
log "    Resolver.forwarder() after the dry run: $(cast call "$(jq -r .resolver ../../deployments/testnet.json)" 'forwarder()(address)' --rpc-url "$RPC") (unchanged)"
expect 10 "cutover --execute signed by a key that is not the owner: refused" env ISOTHERM_OWNER_KEY_FILE="$W/not-owner.key" scripts/don-cutover.sh --execute --rpc "$RPC" --facts "$W/facts-ok.json" --confirm-owner "$OWNER"
expect 10 "cutover --execute with a wrong typed confirmation: refused" scripts/don-cutover.sh --execute --rpc "$RPC" --facts "$W/facts-ok.json" --fork-unlocked --confirm-owner 0x0000000000000000000000000000000000000001

# ---------------------------------------------------------------- the switch
expect 0 "CUTOVER --execute as the impersonated Resolver owner" scripts/don-cutover.sh --execute --rpc "$RPC" --facts "$W/facts-ok.json" --fork-unlocked --confirm-owner "$OWNER"
expect 0 "the Mac job stands down while the DON is active (run-official.sh preflight; harness mode, test attester key)" \
  env ISOTHERM_RPC="$RPC" ISOTHERM_ATTESTER_KEY_FILE="$W/test-attester.key" ISOTHERM_STATE_DIR="$W/state" scripts/run-official.sh --harness --preflight-only
expect 0 "cutover again: nothing to do (idempotent)" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-ok.json"

# ---------------------------------------------------------------- first DON settlement: the next open ladder at 02:00 local
T=$(fork_json target)
ST=$(jq -r .station <<<"$T"); DT=$(jq -r .date <<<"$T"); AT=$(jq -r .attemptAt <<<"$T")
GAS=$(jq -r .gasLimit settle/config.don.json)
fork warp --at "$AT" >/dev/null
log ""
log "=== $AT (its 02:00-local cron + 30 s): a DON-signed report for $ST $DT ($(jq -r 'if .inVault then "the live vault ladder" else "no vault ladder open: next RCSS day" end' <<<"$T"); day end $(jq -r .dayEnd <<<"$T")) through the production forwarder, gas limit $GAS (config.don.json)"
# first, a report from ANOTHER workflow owner (what a wrong owner pin would look like): rejected, and diagnosable
X=$(fork_json don --station "$ST" --date "$DT" --tmax 27 --gas "$GAS" --org-owner 0x1111111111111111111111111111111111111111 --workflow-id "$WFID")
log "$X"
check "$(jq -r '.reportProcessed == false and .ladderResolved == null' <<<"$X")" "a DON report from another workflow owner: ReportProcessed(result=false), nothing settled"
expect 0 "diagnosis of that rejected report (don-evidence.sh --tx): names the owner mismatch and the fix" scripts/don-evidence.sh --rpc "$RPC" --tx "$(jq -r .tx <<<"$X")"
check "$(grep -c 'is not the pinned owner (InvalidWorkflowOwner)' "$OUT" | awk '{print ($1 >= 1) ? "true" : "false"}')" "the diagnosis reports InvalidWorkflowOwner"
log ""
log "=== then the report from our organization's workflow (owner $ORG), same ladder, same gas limit"
D=$(fork_json don --station "$ST" --date "$DT" --tmax 27 --gas "$GAS" --org-owner "$ORG" --workflow-id "$WFID")
log "$D"
check "$(jq -r '.reportProcessed == true and (.ladderResolved.status == 1)' <<<"$D")" "ReportProcessed(result=true) + LadderResolved(Settled)"
expect 0 "evidence record for the DON settlement (path 'don'), read from the chain" scripts/don-evidence.sh --rpc "$RPC" --out "$W/evidence" --no-cre --ladders 3
cp "$W/evidence/don-runs.jsonl" "$PKG/evidence/don-rehearsal-evidence.jsonl"
check "$(jq -s --arg st "$ST" --argjson d "$DT" '[.[] | select(.path == "don" and .station == $st and .date == $d and .reportProcessed == true and .attestation.matches == true and .report.signatures == 4)] | length == 1' "$W/evidence/don-runs.jsonl")" "don-runs.jsonl has the 'don' record (4 DON signatures, attestation by the attester)"

# ---------------------------------------------------------------- rollback
expect 0 "rollback dry run: prints R1-R5, sends nothing" scripts/don-rollback.sh --rpc "$RPC" --facts "$W/facts-ok.json"
expect 0 "ROLLBACK --execute as the impersonated owner (CRE pause and launchd reload are printed, not run, on a fork)" scripts/don-rollback.sh --execute --rpc "$RPC" --facts "$W/facts-ok.json" --fork-unlocked --confirm-owner "$OWNER"
expect 0 "the Mac path is back: run-official.sh preflight passes" \
  env ISOTHERM_RPC="$RPC" ISOTHERM_ATTESTER_KEY_FILE="$W/test-attester.key" ISOTHERM_STATE_DIR="$W/state" scripts/run-official.sh --harness --preflight-only
MT=$(fork_json mock-target --station RJTT)
log ""
log "=== after the rollback: a Mac-path report (simulator header) through the MockKeystoneForwarder settles RJTT $(jq -r .date <<<"$MT") (Tokyo day over at $(jq -r .dayEnd <<<"$MT"), no result)"
M=$(fork_json mock --station RJTT --date "$(jq -r .date <<<"$MT")" --tmax 24 --gas 200000)
log "$M"
check "$(jq -r '.reportProcessed == true and (.ladderResolved.status == 1)' <<<"$M")" "accepted through the MockKeystoneForwarder"
expect 0 "rollback again: nothing left to change (idempotent dry run)" scripts/don-rollback.sh --rpc "$RPC" --facts "$W/facts-ok.json"
expect 10 "cutover dry run right after a settlement: refused (challenge window open, 16:45-18:15 UTC)" scripts/don-cutover.sh --rpc "$RPC" --facts "$W/facts-ok.json"

# ---------------------------------------------------------------- the key-file signing path (throwaway owner on the fork)
log ""
log "=== key-file path: Resolver ownership moved on the fork to anvil #3 (public key), so the signing code path runs without a real key"
fork transfer-owner --to 0x90F79bf6EB2c4f870365E785982E1f101E93b906 >/dev/null
P2=$(fork_json prepare --lead 60)
SAFE2=$(jq -r .safe <<<"$P2")
fork warp --at "$SAFE2" >/dev/null
log "    next cutover window: $SAFE2 (after the challenge window, outside the time blocks)"
expect 0 "CUTOVER --execute signed from a key file (throwaway owner)" env ISOTHERM_OWNER_KEY_FILE="$W/fork-owner.key" scripts/don-cutover.sh --execute --rpc "$RPC" --facts "$W/facts-ok.json" --confirm-owner 0x90F79bf6EB2c4f870365E785982E1f101E93b906
expect 0 "ROLLBACK --execute signed from a key file (throwaway owner)" env ISOTHERM_OWNER_KEY_FILE="$W/fork-owner.key" scripts/don-rollback.sh --execute --rpc "$RPC" --facts "$W/facts-ok.json" --confirm-owner 0x90F79bf6EB2c4f870365E785982E1f101E93b906

log ""
log "# rehearsal finished: $FAILS failure(s)"
exit $(( FAILS > 0 ? 1 : 0 ))
