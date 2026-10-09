#!/usr/bin/env bash
# Run on the MAC by the owner: moves the hourly settlement job back from the VPS to this Mac (reverse of cutover.sh).
#
#   packages/cre-workflow/vps/rollback.sh <vps>              DRY RUN (default): state of both sides and the plan
#   packages/cre-workflow/vps/rollback.sh <vps> --execute
#     R1  VPS FIRST: `isotherm-vps.sh release` disables + stops isotherm-settle.timer, waits for a running job, removes
#         var/writer.claim and writes var/writer.released (its run-official.sh then refuses to sign). It answers with the
#         VPS's last run.
#     R2  Mac: var/last-run of the runtime copy := the later of the Mac's and the VPS's last run, so the Mac's own
#         30-min spacing guard (unchanged launchd code) also covers the switch; var/writer.released removed.
#     R3  Mac: launchctl enable + bootstrap xyz.isotherm.cre-settle (plist rendered from the runtime copy if missing);
#         verified loaded. Its next :05 run settles (official path with the Mac's own `cre login`, else the harness).
#   The Mac job is never re-enabled while the VPS may still hold the claim: if R1 fails, nothing changes on the Mac.
#
#   packages/cre-workflow/vps/rollback.sh <vps> --execute --vps-unreachable
#     only when the VPS cannot be reached AND has been powered off (or destroyed) at the provider: the script asks you to
#     type "THE VPS IS OFF". A VPS that is merely unreachable may still run its timer, and two writers would sign.
#     The Mac's spacing guard then counts from now (30 min).
# Env: ISOTHERM_RUNTIME (default ~/isotherm-live), ISOTHERM_VPS_DIR, ISOTHERM_VPS_SSH_OPTS.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
DEST=${1:?usage: vps/rollback.sh <vps> [--execute] [--vps-unreachable]}; shift
# shellcheck source=lib-mac.sh
. "$PKG/vps/lib-mac.sh"
MODE=dry; UNREACHABLE=0; CONFIRM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) MODE=execute ;; --dry-run) MODE=dry ;; --vps-unreachable) UNREACHABLE=1 ;;
    --confirm-vps-off) CONFIRM="THE VPS IS OFF" ;;   # non-interactive form of the typed confirmation
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Darwin ] || { echo "run this on the Mac (it reloads the Mac's launchd job)" >&2; exit 2; }
mkdir -p "$PKG/var/vps"; LOGF="$PKG/var/vps/rollback-$(date -u +%Y%m%dT%H%M%SZ).log"
say "vps rollback: mode=$MODE, VPS $DEST:$VPS_PKG, Mac runtime copy ${RT/#$HOME/~}"

CHECK=$(vps check 2>/dev/null | tail -n1 || true)
if [ -n "$CHECK" ] && [ -n "$(jq_ "$CHECK" creVersion)" ]; then
  say "VPS: claim=$(jq_ "$CHECK" claim || echo none) released=$(jq_ "$CHECK" released || echo none) timer=$(jq_ "$CHECK" timer) conflict=$(jq_ "$CHECK" conflict || echo none)"
  REACH=1
else
  say "VPS: NOT reachable over ssh"; REACH=0
fi
say "Mac: $LABEL loaded=$(mac_job_loaded && echo yes || echo no) disabled=$(mac_job_disabled && echo yes || echo no); plist $([ -f "$PLIST" ] && echo present || echo missing); writer.released $([ -f "$RTV/writer.released" ] && cat "$RTV/writer.released" || echo absent)"
say "plan:"
say "  R1. ssh $DEST isotherm-vps.sh release   (timer off, claim removed, writer.released; returns the VPS's last run)"
say "  R2. ${RTV/#$HOME/~}/last-run := max(Mac, VPS last run); remove ${RTV/#$HOME/~}/writer.released"
say "  R3. launchctl enable gui/$UIDN/$LABEL ; launchctl bootstrap gui/$UIDN ${PLIST/#$HOME/~}"
# The role must come back from the VPS it went to: a rollback against another destination (above all with
# --vps-unreachable) would reload the Mac while that VPS may still hold the claim.
RD=""; [ -f "$RTV/writer.released" ] && RD=$(jq_ "$(cat "$RTV/writer.released")" dest)
if [ -n "$RD" ] && [ "$RD" != "$DEST" ]; then
  say "REFUSED: the Mac handed the writer role to '$RD', not '$DEST'. Run: vps/rollback.sh $RD ... (the same destination as at the cutover). Nothing changed."
  exit 2
fi
if [ "$MODE" = dry ]; then say "DRY RUN: nothing changed. Re-run with --execute."; exit 0; fi

# R1
VPS_LAST=0
if [ "$REACH" = 1 ]; then
  OUT=$(vssh "bash $VPS_PKG/vps/isotherm-vps.sh release" 2>&1) || { say "R1 FAILED on the VPS: $(echo "$OUT" | tail -n 3). Nothing changed on the Mac."; exit 1; }
  REL=$(echo "$OUT" | tail -n1)
  [ "$(jq_ "$REL" released)" = true ] || { say "R1: unexpected answer from the VPS: $REL. Nothing changed on the Mac."; exit 1; }
  case "$(jq_ "$REL" timer)" in disabled/*|no-systemd*|not-installed*) ;; *) say "R1: the VPS timer still reads '$(jq_ "$REL" timer)'. Nothing changed on the Mac."; exit 1 ;; esac
  VPS_LAST=$(jq_ "$REL" lastRunEpoch); VPS_LAST=${VPS_LAST:-0}
  say "R1 done: the VPS released the writer role; its last run $VPS_LAST (epoch), timer $(jq_ "$REL" timer)"
elif [ "$UNREACHABLE" = 1 ]; then
  if [ -z "$CONFIRM" ]; then
    [ -t 0 ] || { say "REFUSED: --vps-unreachable needs the typed confirmation (or --confirm-vps-off)"; exit 2; }
    read -r -p "Power the VPS off (or destroy it) at the provider first. Type THE VPS IS OFF to continue: " CONFIRM
  fi
  [ "$CONFIRM" = "THE VPS IS OFF" ] || { say "REFUSED: not confirmed"; exit 2; }
  VPS_LAST=$(date +%s)
  say "R1 skipped: the VPS is unreachable and confirmed powered off; the Mac's spacing guard counts from now"
else
  say "REFUSED: the VPS is not reachable. If it is powered off at the provider, re-run with --vps-unreachable. Nothing changed."
  exit 2
fi
# R2
mkdir -p "$RTV"
MAC_LAST=$(cat "$RTV/last-run" 2>/dev/null || echo 0)
if [ "$VPS_LAST" -gt "${MAC_LAST:-0}" ]; then echo "$VPS_LAST" >"$RTV/last-run"; say "R2: ${RTV/#$HOME/~}/last-run := $VPS_LAST (the VPS's last run)"; fi
rm -f "$RTV/writer.released"
say "R2 done"
# R3
if [ ! -f "$PLIST" ]; then
  [ -f "$RT/packages/cre-workflow/scripts/install-launchd.sh" ] || { say "R3: no installed plist and no runtime copy: run scripts/deploy-runtime.sh --load"; exit 1; }
  bash "$RT/packages/cre-workflow/scripts/install-launchd.sh" >/dev/null   # render only
  mkdir -p "$(dirname "$PLIST")"; cp "$RT/packages/cre-workflow/var/launchd/$LABEL.plist" "$PLIST"
fi
R3_FAIL="NEITHER host settles now (the VPS released). Load the Mac job by hand: launchctl enable gui/$UIDN/$LABEL ; launchctl bootstrap gui/$UIDN ${PLIST/#$HOME/~}"
launchctl enable "gui/$UIDN/$LABEL" || { say "R3 FAILED: launchctl enable. $R3_FAIL"; exit 1; }
launchctl bootout "gui/$UIDN/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UIDN" "$PLIST" || { say "R3 FAILED: launchctl bootstrap. $R3_FAIL"; exit 1; }
mac_job_loaded || { say "R3 FAILED: $LABEL is not loaded. $R3_FAIL"; exit 1; }
say "R3 done: $LABEL loaded and enabled; next run at :05"
say "DONE: settlement is back on the Mac. Keep the VPS released (its timer stays off; vps/cutover.sh hands it over again). log: ${LOGF/#$HOME/~}"
