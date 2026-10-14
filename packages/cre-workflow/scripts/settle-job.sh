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
#   A failed `cre whoami` (auto mode, live RPC, no CRE_API_KEY) is checked once more after 30 s before the harness is
#   chosen: one CRE API timeout at :05 no longer sends that hour through the fallback.
#
# Must run from the runtime copy (~/isotherm-live/packages/cre-workflow): launchd-started bash cannot read ~/Documents
# (macOS TCC, exit 126). scripts/deploy-runtime.sh makes the copy and installs the job.
# On a Linux VPS the same script is started by systemd through vps/settle-vps.sh (isotherm-settle.timer, hourly at
# :05), which adds the single-writer guard and the optional phone push (vps/README.md).
#
# Env (all optional): ISOTHERM_SETTLE_MODE=auto|official|harness (default auto), ISOTHERM_SETTLE_DRY=1 (pass
#   --no-broadcast: reads + decisions only), ISOTHERM_RPC / ISOTHERM_STATE_DIR / key-file vars (see run-official.sh;
#   fork tests only), ISOTHERM_TEST_RELABEL (fork only), ISOTHERM_HOST_LABEL / ISOTHERM_JOB_LABEL (written into the
#   evidence record; default: the OS name and xyz.isotherm.cre-settle; the VPS unit sets "vps" / isotherm-settle.service).
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
LOGIN=no; AGAIN=""
# `cre whoami` talks to the CRE API: bound it (perl alarm; macOS has no `timeout`) so a hung call cannot stall the job.
cre_whoami() { perl -e 'alarm shift; exec @ARGV' 45 cre whoami </dev/null >/dev/null 2>&1; }
if [ -n "${CRE_API_KEY:-}" ] || cre_whoami; then LOGIN=yes
elif [ "$MODE" = auto ] && [ "$RPC" = "$LIVE_RPC" ]; then
  # One more check before choosing the harness. The CRE API behind `cre whoami` now and then fails for a moment (on the
  # VPS, 2026-10-13 05:05 and 23:05 UTC each took the harness after one failed check, with official runs the hour
  # before and after), and one such failure at 18:05 UTC would settle that day through the fallback. So, as
  # run-official.sh does before its exit 3, wait 30 s and run the identical check once more; only a second failure picks
  # the harness. Nothing is locked, read or signed yet. Auto mode on the live RPC only: an explicit mode does not depend
  # on the answer, and a fork run cannot take the official path anyway (run-official.sh refuses it).
  note "CRE login check: cre whoami failed (often a CRE API timeout); running the identical check once more in 30 s, before choosing the path"
  sleep 30
  if cre_whoami; then LOGIN=yes; AGAIN=" (at the second check, 30 s after a failed one)"; else AGAIN=" twice, 30 s apart"; fi
fi
case "$MODE" in
  official) WHY="ISOTHERM_SETTLE_MODE=official" ;;
  harness)  WHY="ISOTHERM_SETTLE_MODE=harness" ;;
  auto)
    if [ "$LOGIN" = yes ]; then MODE=official; WHY="cre whoami succeeded$AGAIN"
    elif [ -n "$AGAIN" ]; then MODE=harness; WHY="cre whoami failed$AGAIN (no CRE login, or the CRE API did not answer)"
    else MODE=harness; WHY="cre whoami failed (not logged in to CRE)"; fi
    if [ "$MODE" = official ] && [ -f "$STATE/official-failed" ]; then
      MODE=harness; WHY="cre whoami succeeded$AGAIN, but the previous OFFICIAL run failed ($(cat "$STATE/official-failed")); this run uses the harness, the next one retries OFFICIAL"
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
  --rc "$RC" --started "$STARTED" --out "$STATE/evidence" --dry "${ISOTHERM_SETTLE_DRY:-0}" \
  --host "${ISOTHERM_HOST_LABEL:-$(uname -s | tr '[:upper:]' '[:lower:]')}" --job "${ISOTHERM_JOB_LABEL:-xyz.isotherm.cre-settle}") 2>&1 | tee -a "$JOBLOG" || true
exit "$RC"
