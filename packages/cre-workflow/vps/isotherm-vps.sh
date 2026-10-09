#!/usr/bin/env bash
# VPS-side helper for the settlement job. Run on the VPS as the job's user:
#   bash ~/isotherm/packages/cre-workflow/vps/isotherm-vps.sh <command>
#
#   status               writer role, timer, last runs, CRE login (yes/no only), attester balance. Read-only.
#   check                the same facts as one JSON line (vps/cutover.sh reads it over SSH). Read-only.
#   preflight            scripts/run-official.sh --harness --preflight-only: key file, attester == Resolver.attester(),
#                        pause flag, sender balance. Chain reads only; nothing signed.
#   dry-run              ISOTHERM_SETTLE_DRY=1 settle-job.sh in var/dry: the full job (path choice, reads, decisions,
#                        evidence) without sending; its own state dir, so it never uses up the real 30-min slot.
#   login                `cre login` through an SSH tunnel (vps/README.md section 4), then `cre whoami` (yes/no).
#   test-alert           one TEST ALERT through the phone push (needs ~/.config/isotherm/alert-webhook.url).
#   clear-conflict [--yes]   after a WRITER CONFLICT, once a single host settles again: re-baseline and resume.
#   logs [N]             the last N journal lines of isotherm-settle (default 60) and the latest evidence record.
# Called by the Mac scripts over SSH (not by hand):
#   claim [--no-timer]   stdin: the previous writer's last-run record (JSON, may be empty). Writes var/writer.claim and
#                        var/peer-last-run.json, re-baselines the tripwire (var/writer-nonce), removes
#                        var/writer.released, enables + starts isotherm-settle.timer.
#   release [--no-timer] disables + stops the timer, waits for a running job, removes the claim, writes
#                        var/writer.released; prints this host's last run as JSON for the Mac.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
. "$PKG/vps/lib.sh"
CMD=${1:-status}; shift || true

has_systemd_user() { systemctl --user show-environment >/dev/null 2>&1; }
cre_login() { # yes / apikey / no; never prints the account details
  if [ -n "${CRE_API_KEY:-}" ] || [ -r "${ISOTHERM_CRE_API_KEY_FILE:-$HOME/.config/isotherm/cre-api-key}" ]; then echo apikey
  elif perl -e 'alarm shift; exec @ARGV' 45 cre whoami </dev/null >/dev/null 2>&1; then echo yes
  else echo no; fi
}
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
last_run_epoch() { cat "$STATE/last-run" 2>/dev/null || echo 0; }
timer_state() { # <enabled|disabled|not-installed>/<active|inactive>
  has_systemd_user || { echo "no-systemd-user-manager"; return; }
  local e a
  e=$(systemctl --user is-enabled "$UNIT.timer" 2>/dev/null | head -n1); a=$(systemctl --user is-active "$UNIT.timer" 2>/dev/null | head -n1)
  echo "${e:-not-installed}/${a:-inactive}"
}
hashes() { (cd "$PKG" && sha256sum scripts/run-official.sh scripts/settle-job.sh scripts/lib-don.sh settle/e2e/evidence-record.ts vps/settle-vps.sh vps/lib.sh vps/isotherm-vps.sh 2>/dev/null | awk '{print $1 "  " $2}'); }

case "$CMD" in
  check)
    PRE=$(bash "$PKG/scripts/run-official.sh" --harness --preflight-only 2>&1); PRE_RC=$?
    LINGER=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)
    node -e '
      const [cre, bun, cast, timer, linger, login, keyMode, preRc, pre, claim, released, conflict, hashes, src] = process.argv.slice(1);
      console.log(JSON.stringify({ creVersion: cre, bun, cast, timer, linger, creLogin: login, keyMode,
        preflight: { rc: Number(preRc), last: pre.trim().split("\n").filter(Boolean).slice(-1)[0] || "" },
        claim: claim || null, released: released || null, conflict: conflict || null,
        hashes: Object.fromEntries(hashes.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/).reverse())),
        source: src || null }))' \
      "$(cre version 2>/dev/null | head -1)" "$(bun --version 2>/dev/null)" "$(cast --version 2>/dev/null | head -1)" \
      "$(timer_state)" "$LINGER" "$(cre_login)" "$(file_mode "$TX_KEY_FILE" 2>/dev/null || echo missing)" "$PRE_RC" "$PRE" \
      "$(cat "$STATE/writer.claim" 2>/dev/null)" "$(cat "$STATE/writer.released" 2>/dev/null)" "$(cat "$STATE/writer-conflict" 2>/dev/null)" \
      "$(hashes)" "$(cat "$PKG/../../SOURCE" 2>/dev/null)"
    ;;
  status)
    echo "package     $PKG ($(cat "$PKG/../../SOURCE" 2>/dev/null || echo 'source unknown'))"
    echo "state       $STATE"
    if [ -f "$STATE/writer.claim" ]; then echo "writer      CLAIMED: $(cat "$STATE/writer.claim")"
    elif [ -f "$STATE/writer.released" ]; then echo "writer      released: $(cat "$STATE/writer.released")"
    else echo "writer      not claimed (before the cutover: vps/cutover.sh on the Mac)"; fi
    [ -f "$STATE/writer-conflict" ] && echo "CONFLICT    $(cat "$STATE/writer-conflict")"
    [ -f "$STATE/peer-last-run.json" ] && echo "peer        $(jfield "$STATE/peer-last-run.json" from) last ran $(iso_of "$(jfield "$STATE/peer-last-run.json" lastRunEpoch)") (handover record)"
    TS=$(timer_state); echo "timer       $TS"
    case "$TS" in enabled/active) systemctl --user list-timers "$UNIT.timer" --no-pager 2>/dev/null | sed -n '2p' | sed 's/^/            next: /' ;; esac
    LR=$(last_run_epoch); [ "$LR" != 0 ] && echo "last run    $(iso_of "$LR") (the 30-min spacing guard counts from here)"
    [ -f "$STATE/writer-nonce" ] && echo "tripwire    $(cat "$STATE/writer-nonce")"
    L="$STATE/evidence/LATEST.json"
    [ -f "$L" ] && echo "evidence    $(jfield "$L" finishedAt) path=$(jfield "$L" path) exit=$(jfield "$L" exitCode) ($(jfield "$L" exitMeaning)); reports sent: $(jfield "$L" reportsSent)"
    [ -f "$STATE/evidence/writer-guard.jsonl" ] && echo "guard       $(tail -n1 "$STATE/evidence/writer-guard.jsonl")"
    echo "cre login   $(cre_login)   (cre $(cre version 2>/dev/null | head -1 | grep -oE 'v[0-9.]+' || echo '?'))"
    S=$(tx_sender || true)
    [ -n "$S" ] && echo "tx sender   $S: $(cast balance "$S" --ether --rpc-url "$RPC" 2>/dev/null || echo '?') MON (0.0204 per report)"
    [ -r "$ALERT_URL_FILE" ] && echo "phone push  on ($(basename "$ALERT_URL_FILE"), mode $(file_mode "$ALERT_URL_FILE"))" || echo "phone push  off"
    ;;
  preflight) exec bash "$PKG/scripts/run-official.sh" --harness --preflight-only ;;
  dry-run)
    mkdir -p "$STATE/dry"; rm -f "$STATE/dry/last-run"
    ISOTHERM_SETTLE_DRY=1 ISOTHERM_STATE_DIR="$STATE/dry" ISOTHERM_HOST_LABEL=vps ISOTHERM_JOB_LABEL=isotherm-vps.sh-dry-run \
      bash "$PKG/scripts/settle-job.sh"
    ;;
  login)
    [ -t 0 ] || { echo "run this in an interactive SSH session (ssh -t ...)" >&2; exit 2; }
    cat <<'MSG'
CRE login on a headless VPS (the CLI waits for the browser on http://localhost:53682/callback ON THIS VPS):
  1. This SSH session must carry the tunnel. If it does not, exit and reconnect from the Mac with:
       ssh -t -L 53682:127.0.0.1:53682 <vps> bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh login
     (nothing else on the Mac may listen on 53682, e.g. a `cre login` running there at the same time)
  2. The CLI prints "Opening browser to: https://login.chain.link/authorize?..." and "Could not open browser
     automatically". Copy that URL into the Mac's browser and sign in (password + authenticator code). The browser is
     sent back to localhost:53682, which the tunnel carries to this VPS.
  3. The session is stored in ~/.cre/ on this VPS. The Mac keeps its own session for the rollback.
MSG
    cre login; echo "cre whoami: $(cre_login)"
    ;;
  test-alert) push_alert "ISOTHERM VPS: TEST ALERT $(date -u +%FT%TZ)" "Phone push from the settlement VPS works. No action needed." default 0 ;;
  clear-conflict)
    [ -f "$STATE/writer-conflict" ] || { echo "no writer conflict standing"; exit 0; }
    echo "standing conflict: $(cat "$STATE/writer-conflict")"
    S=$(tx_sender || true); N=$( [ -n "$S" ] && chain_nonce "$S")
    echo "tx sender $S, on-chain nonce now ${N:-?}"
    if [ "${1:-}" != --yes ]; then
      [ -t 0 ] || { echo "confirm with --yes (non-interactive)" >&2; exit 2; }
      read -r -p "Only one host settles now (the Mac job is unloaded AND disabled, no other copy of the key runs)? Type CLEAR: " A
      [ "$A" = CLEAR ] || { echo "not cleared"; exit 2; }
    fi
    mv "$STATE/writer-conflict" "$STATE/evidence/writer-conflict.cleared-$(date -u +%Y%m%dT%H%M%SZ)"
    [ -n "$N" ] && echo "$S $N $(date +%s)" >"$STATE/writer-nonce"
    guard_record cleared "writer conflict cleared by hand; re-baselined at nonce ${N:-?}"
    echo "cleared; the next :05 run settles again"
    ;;
  claim)
    PEER=$(cat || true)
    if [ -n "${PEER// /}" ]; then
      printf '%s\n' "$PEER" | node -e 'const s = require("fs").readFileSync(0, "utf8"); JSON.parse(s); process.stdout.write(s)' >"$STATE/peer-last-run.json" \
        || { echo "claim: the peer record is not JSON" >&2; exit 2; }
    fi
    # timer first, claim last: a failure leaves no claim behind (a timer run without the claim only refuses)
    if [ "${1:-}" != --no-timer ]; then
      if ! { systemctl --user daemon-reload && systemctl --user enable --now "$UNIT.timer"; }; then
        systemctl --user disable --now "$UNIT.timer" >/dev/null 2>&1 || true
        echo "claim: could not enable $UNIT.timer; no claim written" >&2; exit 3
      fi
    fi
    # re-baseline the tripwire BEFORE the claim exists: what the previous writer sent while it held the role (the Mac
    # after a rollback) is not a conflict; anything sent from now on is. If the nonce cannot be read, the old record is
    # removed and the first run sets the baseline.
    S=$(tx_sender || true); N=""; [ -n "$S" ] && N=$(chain_nonce "$S")
    if [ -n "$N" ]; then echo "$S $N $(date +%s)" >"$STATE/writer-nonce"; else rm -f "$STATE/writer-nonce"; fi
    json_line at "$(date -u +%FT%TZ)" from "$(jfield "$STATE/peer-last-run.json" from || true)" by vps/cutover.sh >"$STATE/writer.claim"
    rm -f "$STATE/writer.released"
    guard_record claimed "writer role claimed; peer last run $(jfield "$STATE/peer-last-run.json" lastRunEpoch || echo none); tripwire baseline ${N:-none (the first run sets it)}"
    bash "$0" check
    ;;
  release)
    if [ "${1:-}" != --no-timer ] && has_systemd_user; then
      systemctl --user disable --now "$UNIT.timer" >/dev/null 2>&1 || true
      # a running oneshot unit is "activating" (`is-active` answers non-zero for that state, so it cannot be used here)
      for _ in $(seq 1 240); do
        case "$(systemctl --user show "$UNIT.service" -p ActiveState --value 2>/dev/null)" in activating|deactivating|reloading) sleep 5 ;; *) break ;; esac
      done
    fi
    for _ in $(seq 1 240); do pgrep -f "$PKG/scripts/settle-job.sh" >/dev/null || break; sleep 5; done
    json_line at "$(date -u +%FT%TZ)" to mac by vps/rollback.sh >"$STATE/writer.released"
    rm -f "$STATE/writer.claim"
    guard_record released "writer role released to the Mac"
    node -e '
      const fs = require("fs"); let latest = null; try { latest = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) } catch {}
      console.log(JSON.stringify({ from: "vps", lastRunEpoch: Number(process.argv[1]) || 0, finishedAt: latest?.finishedAt ?? null,
        path: latest?.path ?? null, exitCode: latest?.exitCode ?? null, timer: process.argv[3], released: true }))' \
      "$(last_run_epoch)" "$STATE/evidence/LATEST.json" "$(timer_state)"
    ;;
  logs)
    has_systemd_user && journalctl --user -u "$UNIT" -n "${1:-60}" --no-pager 2>/dev/null
    [ -f "$STATE/evidence/LATEST.json" ] && cat "$STATE/evidence/LATEST.json"
    ;;
  -h|--help|help) sed -n '2,20p' "$0" ;;
  *) echo "unknown command $CMD (see --help)" >&2; exit 2 ;;
esac
