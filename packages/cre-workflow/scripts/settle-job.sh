#!/bin/bash
# launchd entry for xyz.isotherm.cre-settle (hourly at minute 05). Picks the settlement path, runs it through
# scripts/run-official.sh (preflight, lock, 30-min spacing guard, receipt confirmation) and appends an EVIDENCE RECORD
# that states which path was used.
#
#   path 1  OFFICIAL  when `cre whoami` succeeds: `cre workflow simulate ./settle -T testnet --broadcast`
#                      (the CRE engine runs the compiled WASM; reports go through the MockKeystoneForwarder).
#   path 2  HARNESS FALLBACK otherwise: the same handler (same decide() rule, same v1 EIP-712 attestation, same
#                      MockKeystoneForwarder call) under Bun in the CRE SDK test harness. NOT the CRE engine.
#   If the previous OFFICIAL run failed before anything was sent (an exit code other than 0/2/4), this run uses the
#   harness and the next one tries OFFICIAL again, so a broken login/toolchain cannot stall settlement for long.
#
# Must run from the runtime copy (~/isotherm-live/packages/cre-workflow): launchd-started bash cannot read ~/Documents
# (macOS TCC, exit 126). scripts/deploy-runtime.sh makes the copy and installs the job.
#
# Env (all optional): ISOTHERM_SETTLE_MODE=auto|official|harness (default auto), ISOTHERM_SETTLE_DRY=1 (pass
#   --no-broadcast: reads + decisions only), ISOTHERM_RPC / ISOTHERM_STATE_DIR / key-file vars (see run-official.sh;
#   fork tests only), ISOTHERM_TEST_RELABEL (fork only).
# Evidence: $STATE/evidence/settle-runs.jsonl (one JSON line per run), $STATE/evidence/LATEST.json,
#           $STATE/evidence/settlement-<ICAO>-<date>-<path>.json for every run that sent a report.
set -uo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$HOME/.foundry/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LIVE_RPC=https://testnet-rpc.monad.xyz
RPC=${ISOTHERM_RPC:-$LIVE_RPC}
RUNTIME_STATE="${ISOTHERM_RUNTIME:-$HOME/isotherm-live}/packages/cre-workflow/var"
if [ -n "${ISOTHERM_STATE_DIR:-}" ]; then STATE=$ISOTHERM_STATE_DIR
elif [ "$RPC" = "$LIVE_RPC" ] && [ -d "$RUNTIME_STATE" ]; then STATE=$RUNTIME_STATE
else STATE=$PKG/var; fi
export ISOTHERM_STATE_DIR=$STATE
mkdir -p "$STATE/evidence" "$STATE/logs"
STARTED=$(date -u +%FT%TZ)
JOBLOG="$STATE/logs/job-$(date -u +%Y%m%dT%H%M%SZ).log"
note() { echo "[$(date -u +%FT%TZ)] [settle-job] $*" | tee -a "$JOBLOG"; }

# ---- path choice
MODE=${ISOTHERM_SETTLE_MODE:-auto}
LOGIN=no
if [ -n "${CRE_API_KEY:-}" ] || perl -e 'alarm shift; exec @ARGV' 45 cre whoami </dev/null >/dev/null 2>&1; then LOGIN=yes; fi
case "$MODE" in
  official) WHY="ISOTHERM_SETTLE_MODE=official" ;;
  harness)  WHY="ISOTHERM_SETTLE_MODE=harness" ;;
  auto)
    if [ "$LOGIN" = yes ]; then MODE=official; WHY="cre whoami succeeded"
    else MODE=harness; WHY="cre whoami failed (not logged in to CRE)"; fi
    if [ "$MODE" = official ] && [ -f "$STATE/official-failed" ]; then
      MODE=harness; WHY="cre whoami succeeded, but the previous OFFICIAL run failed ($(cat "$STATE/official-failed")); this run uses the harness, the next one retries OFFICIAL"
      rm -f "$STATE/official-failed"
    fi ;;
  *) note "bad ISOTHERM_SETTLE_MODE=$MODE"; exit 2 ;;
esac
EXTRA=()
[ "${ISOTHERM_SETTLE_DRY:-0}" = 1 ] && EXTRA+=(--no-broadcast)
note "path=$MODE ($WHY); rpc=$RPC; state=$STATE; dry=${ISOTHERM_SETTLE_DRY:-0}"

run() { ./scripts/run-official.sh "--$1" ${EXTRA[@]+"${EXTRA[@]}"} 2>&1 | tee -a "$JOBLOG"; return "${PIPESTATUS[0]}"; }
run "$MODE"; RC=$?
if [ "$MODE" = official ] && [ "$RC" = 3 ]; then
  # run-official.sh checks the login BEFORE anything is signed: nothing exists to overlap with, fall back right away.
  note "official path exited 3 (login vanished between checks): running the harness fallback now"
  MODE=harness; WHY="$WHY; then run-official.sh reported no login (exit 3) before signing"
  run harness; RC=$?
elif [ "$MODE" = official ] && [ "$RC" != 0 ] && [ "$RC" != 2 ] && [ "$RC" != 4 ]; then
  echo "rc=$RC at $(date -u +%FT%TZ)" > "$STATE/official-failed"
elif [ "$MODE" = official ] && grep -qE '\[USER LOG\] .*(: writeReport |-> not-accepted)' "$JOBLOG"; then
  echo "writeReport failed inside the engine at $(date -u +%FT%TZ)" > "$STATE/official-failed"
fi
note "exit $RC"

# ---- evidence record (never fails the job)
(cd settle && bun e2e/evidence-record.ts --log "$JOBLOG" --path "$MODE" --why "$WHY" --login "$LOGIN" --rpc "$RPC" \
  --rc "$RC" --started "$STARTED" --out "$STATE/evidence" --dry "${ISOTHERM_SETTLE_DRY:-0}") 2>&1 | tee -a "$JOBLOG" || true
exit "$RC"
