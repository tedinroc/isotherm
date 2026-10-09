#!/usr/bin/env bash
# Run on the MAC by the owner: moves the hourly settlement job (xyz.isotherm.cre-settle) from this Mac to the VPS.
#
#   packages/cre-workflow/vps/cutover.sh <vps>              DRY RUN (default): every gate and the plan; changes nothing
#   packages/cre-workflow/vps/cutover.sh <vps> --execute    the cutover:
#     E1  Mac: launchctl bootout + launchctl disable xyz.isotherm.cre-settle (disable survives logins and reboots);
#         verified: not loaded AND disabled
#     E2  Mac: scripts/deploy-runtime.sh (sync only, no --load) so the runtime copy carries the writer check, then
#         ~/isotherm-live/.../var/writer.released: even a job that comes back by hand stops before signing
#     E3  VPS: `isotherm-vps.sh claim` with the Mac's last run (var/last-run + evidence/LATEST.json) on stdin: writes
#         var/writer.claim and var/peer-last-run.json, enables + starts isotherm-settle.timer. The VPS refuses to sign
#         until 50 min after the Mac's last run.
#     If E3 fails, the VPS is asked to release (timer off, no claim); once it confirms, E2 and E1 are undone (the Mac
#     job is enabled and loaded again). If the VPS cannot confirm, the Mac job stays off and the script says so.
# Gates: time window (not :50-:15, not 16:40-19:20 UTC), the VPS reachable, toolchain pinned, the VPS code
#   byte-identical to this checkout, preflight passes on the VPS (attester key == Resolver.attester(), sender MON),
#   CRE login on the VPS (or --allow-harness), units installed + linger, VPS not yet claimed and no conflict there,
#   no settle job running on this Mac.
# Options: --allow-harness (no CRE login on the VPS yet: it settles through the labelled harness until `cre login`),
#   --no-sync (skip E2's deploy-runtime.sh; the writer.released marker is still written), --any-time (rehearsals only).
# Env: ISOTHERM_RUNTIME (default ~/isotherm-live), ISOTHERM_VPS_DIR, ISOTHERM_VPS_SSH_OPTS.
# Rollback: vps/rollback.sh <vps> --execute.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
DEST=${1:?usage: vps/cutover.sh <vps> [--execute] [--allow-harness] [--no-sync] [--any-time]}; shift
# shellcheck source=lib-mac.sh
. "$PKG/vps/lib-mac.sh"
MODE=dry; ALLOW_HARNESS=0; SYNC=1; ANY_TIME=0
for a in "$@"; do
  case "$a" in
    --execute) MODE=execute ;; --dry-run) MODE=dry ;; --allow-harness) ALLOW_HARNESS=1 ;; --no-sync) SYNC=0 ;; --any-time) ANY_TIME=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo "run this on the Mac (it stops the Mac's launchd job)" >&2; exit 2; }
mkdir -p "$PKG/var/vps"; LOGF="$PKG/var/vps/cutover-$(date -u +%Y%m%dT%H%M%SZ).log"
say "vps cutover: mode=$MODE, VPS $DEST:$VPS_PKG, Mac runtime copy ${RT/#$HOME/~}"

# ---- gates
HM=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M))); MIN=$((HM % 60))
if [ "$ANY_TIME" = 1 ]; then say "GATE SKIP  time window: --any-time (rehearsal)"
else
  T_OK=1; [ "$MIN" -ge 50 ] || [ "$MIN" -le 15 ] && T_OK=0
  [ "$HM" -ge $((16 * 60 + 40)) ] && [ "$HM" -le $((19 * 60 + 20)) ] && T_OK=0
  gate "$T_OK" "time window" "now $(date -u +%H:%M) UTC; allowed :16-:49, outside 16:40-19:20 UTC (RJTT/RCSS first attempts, challenge windows, retries)"
fi
# The Mac must hold the writer role. A writer.released that names ANOTHER destination means that VPS may still hold the
# claim (roll it back first); the same destination is a re-run (e.g. after "STOPPED SAFE"), and its claim gate below decides.
if [ -f "$RTV/writer.released" ]; then
  RD=$(jq_ "$(cat "$RTV/writer.released")" dest)
  gate "$([ "$RD" = "$DEST" ] && echo 1 || echo 0)" "the Mac holds the writer role, or handed it to $DEST" \
    "the Mac's runtime copy says it handed the role to '${RD:-unknown}'$([ "$RD" = "$DEST" ] && echo ': the same VPS, a re-run' || echo ": run vps/rollback.sh ${RD:-<that vps>} first")"
fi
CHECK=$(vps check 2>/dev/null | tail -n1 || true)
if [ -z "$CHECK" ] || [ -z "$(jq_ "$CHECK" creVersion)" ]; then
  gate 0 "VPS reachable" "ssh $DEST 'bash $VPS_PKG/vps/isotherm-vps.sh check' gave no answer (push.sh + setup.sh done? key-based ssh?)"
  say "REFUSED: $GATES_FAILED gate(s) failed"; exit 10
fi
gate 1 "VPS reachable" "$(jq_ "$CHECK" source)"
CV=$(jq_ "$CHECK" creVersion)
TOOL_OK=0; case "$CV" in *v1.37.0*) TOOL_OK=1 ;; esac   # (no `case` inside $(...): macOS bash 3.2 cannot parse it)
gate "$TOOL_OK" "VPS toolchain" "cre '$CV', bun $(jq_ "$CHECK" bun), $(jq_ "$CHECK" cast)"
CODE_OK=1; CODE_DIFF=""
for f in $CODE_FILES; do
  l=$(cd "$PKG" && shasum -a 256 "$f" | awk '{print $1}')
  r=$(node -e 'try { console.log(JSON.parse(process.argv[1]).hashes[process.argv[2]] || "") } catch { console.log("") }' "$CHECK" "$f")
  [ "$l" = "$r" ] || { CODE_OK=0; CODE_DIFF="$CODE_DIFF $f"; }
done
gate "$CODE_OK" "VPS code == this checkout" "$([ "$CODE_OK" = 1 ] && echo "all of: $CODE_FILES" || echo "differs:$CODE_DIFF (run vps/push.sh $DEST)")"
PRC=$(jq_ "$CHECK" preflight.rc)
gate "$([ "$PRC" = 0 ] && echo 1 || echo 0)" "VPS preflight (key file 600, attester == Resolver.attester(), sender MON)" "rc $PRC: $(jq_ "$CHECK" preflight.last)"
LOGIN=$(jq_ "$CHECK" creLogin)
if [ "$LOGIN" = yes ] || [ "$LOGIN" = apikey ]; then gate 1 "CRE login on the VPS (official path)" "$LOGIN"
elif [ "$ALLOW_HARNESS" = 1 ]; then say "GATE WARN  CRE login on the VPS: '$LOGIN'; --allow-harness: the VPS settles through the labelled HARNESS fallback until 'isotherm-vps.sh login'"
else gate 0 "CRE login on the VPS (official path)" "'$LOGIN': run ssh -t -L 53682:127.0.0.1:53682 $DEST bash $VPS_PKG/vps/isotherm-vps.sh login (or pass --allow-harness)"; fi
TIMER=$(jq_ "$CHECK" timer); LINGER=$(jq_ "$CHECK" linger)
UNITS_OK=1; case "$TIMER" in not-installed*|no-systemd*) UNITS_OK=0 ;; esac
gate "$UNITS_OK" "VPS units installed" "timer $TIMER"
gate "$([ "$LINGER" = yes ] && echo 1 || echo 0)" "VPS linger (timer runs with nobody logged in)" "Linger=$LINGER (sudo loginctl enable-linger <user>)"
gate "$([ -z "$(jq_ "$CHECK" claim)" ] && echo 1 || echo 0)" "VPS not already the writer" "claim: $(jq_ "$CHECK" claim || true)"
gate "$([ -z "$(jq_ "$CHECK" conflict)" ] && echo 1 || echo 0)" "no writer conflict standing on the VPS" "$(jq_ "$CHECK" conflict || echo none)"
if mac_job_running; then gate 0 "no settle job running on this Mac" "a settle-job/run-official process is running; wait for it"
else gate 1 "no settle job running on this Mac" "none"; fi
LOADED=no; mac_job_loaded && LOADED=yes; DISABLED=no; mac_job_disabled && DISABLED=yes
say "Mac job $LABEL: loaded=$LOADED disabled=$DISABLED; runtime state $([ -d "$RTV" ] && echo present || echo 'absent (no Mac run to hand over)')"

# ---- the Mac's last run (handover record for the VPS's 50-min guard); read again right before E3
peer_record() { node -e '
  const fs = require("fs"); const v = process.argv[1];
  let lr = 0; try { lr = Number(fs.readFileSync(v + "/last-run", "utf8").trim()) || 0 } catch {}
  let l = null; try { l = JSON.parse(fs.readFileSync(v + "/evidence/LATEST.json", "utf8")) } catch {}
  console.log(JSON.stringify({ from: "mac", lastRunEpoch: lr, finishedAt: l?.finishedAt ?? null, path: l?.path ?? null,
    exitCode: l?.exitCode ?? null, copiedAt: new Date().toISOString() }))' "$RTV"; }
PEER=$(peer_record)
say "Mac last run: $(jq_ "$PEER" lastRunEpoch) (epoch), last evidence $(jq_ "$PEER" finishedAt || echo none) path=$(jq_ "$PEER" path || echo -)"

say "plan:"
say "  E1. launchctl bootout gui/$UIDN/$LABEL ; launchctl disable gui/$UIDN/$LABEL   (verify: not loaded, disabled)"
say "  E2. $([ "$SYNC" = 1 ] && echo "scripts/deploy-runtime.sh (sync only) ; ")write ${RTV/#$HOME/~}/writer.released"
say "  E3. ssh $DEST isotherm-vps.sh claim  (peer record above; enables isotherm-settle.timer; first signing run >= 50 min after the Mac's last run)"
if [ "$MODE" = dry ]; then
  say "DRY RUN: nothing changed. $([ "$GATES_FAILED" = 0 ] && echo READY || echo "NOT READY: $GATES_FAILED gate(s) failed"). Re-run with --execute."
  exit 0
fi
[ "$GATES_FAILED" = 0 ] || { say "REFUSED: $GATES_FAILED gate(s) failed; nothing changed"; exit 10; }

undo_mac() {
  say "UNDO: restoring the Mac job (the VPS did not take the claim)"
  rm -f "$RTV/writer.released"
  launchctl enable "gui/$UIDN/$LABEL" || true
  if [ "$LOADED" = yes ] && [ -f "$PLIST" ]; then launchctl bootstrap "gui/$UIDN" "$PLIST" || true; fi
  say "UNDO done: $LABEL loaded=$(mac_job_loaded && echo yes || echo no) disabled=$(mac_job_disabled && echo yes || echo no)"
}
# E1
if mac_job_loaded; then launchctl bootout "gui/$UIDN/$LABEL" || true; fi
launchctl disable "gui/$UIDN/$LABEL"
for _ in 1 2 3 4 5 6 7 8 9 10; do mac_job_loaded || break; sleep 1; done
if mac_job_loaded || ! mac_job_disabled; then say "E1 FAILED: $LABEL still loaded or not disabled"; undo_mac; exit 1; fi
say "E1 done: $LABEL not loaded, disabled"
# E2
if [ "$SYNC" = 1 ]; then bash "$PKG/scripts/deploy-runtime.sh" | sed 's/^/  /' || { say "E2 FAILED: deploy-runtime.sh"; undo_mac; exit 1; }; fi
mkdir -p "$RTV"
node -e 'console.log(JSON.stringify({ at: new Date().toISOString(), to: "vps", dest: process.argv[1], by: "vps/cutover.sh" }))' "$DEST" >"$RTV/writer.released"
say "E2 done: ${RTV/#$HOME/~}/writer.released written"
# E3 (the Mac's last run read again: a run started by hand after the gates is covered too)
PEER=$(peer_record)
if ! OUT=$(printf '%s\n' "$PEER" | vssh "bash $VPS_PKG/vps/isotherm-vps.sh claim" 2>&1); then
  say "E3 FAILED on the VPS: $(echo "$OUT" | tail -n 3)"
  # restore the Mac only once the VPS is known not to hold the claim (an ssh drop after the claim was written would
  # otherwise leave two writers)
  if REL=$(vssh "bash $VPS_PKG/vps/isotherm-vps.sh release" 2>/dev/null | tail -n1) && [ "$(jq_ "$REL" released)" = true ]; then
    say "the VPS confirmed it holds no claim (timer $(jq_ "$REL" timer))"; undo_mac
  else
    say "STOPPED SAFE: the VPS could not confirm it holds no claim, so the Mac job stays off: NEITHER host settles now."
    say "Fix the VPS connection, then run vps/cutover.sh again or vps/rollback.sh --execute (the Worker alerts after 3 h)."
  fi
  exit 1
fi
say "E3 done: the VPS holds the claim: $(jq_ "$(echo "$OUT" | tail -n1)" claim)"
say "VPS status:"; vps status 2>&1 | sed 's/^/  /' | tee -a "$LOGF"
FIRST=$(node -e 'const p = Number(process.argv[1]) || 0, n = new Date(); const t = new Date(Math.max(n.getTime(), (p + 3000) * 1000)); t.setUTCSeconds(0, 0); if (t.getUTCMinutes() >= 5) t.setUTCHours(t.getUTCHours() + 1); t.setUTCMinutes(5); console.log(t.toISOString())' "$(jq_ "$PEER" lastRunEpoch)")
say "DONE: the VPS settles from now on; its first signing run is expected at $FIRST. Watch it with: ssh $DEST bash $VPS_PKG/vps/isotherm-vps.sh logs. log: ${LOGF/#$HOME/~}"
