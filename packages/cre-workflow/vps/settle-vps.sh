#!/usr/bin/env bash
# systemd entry on the VPS: isotherm-settle.service, started hourly at :05 by isotherm-settle.timer.
#
# The settlement itself is scripts/settle-job.sh, UNCHANGED from the Mac: the OFFICIAL path
# `cre workflow simulate ./settle -T testnet --broadcast` (CLI v1.37.0) when `cre whoami` succeeds, otherwise the
# labelled SDK-harness fallback, with run-official.sh's lock, 30-min spacing guard, preflight, receipt confirmation and
# the DON stand-down, plus one evidence record per run. This wrapper adds the single-writer safeguard and the alerts:
#
#   1. claim     refuse unless var/writer.claim exists. Only vps/cutover.sh (run on the Mac) writes it, after the Mac
#                job is unloaded and disabled; vps/rollback.sh removes it before the Mac job comes back.
#   2. conflict  refuse while var/writer-conflict exists (step 4 fired). Sticky: a human clears it
#                (vps/isotherm-vps.sh clear-conflict), so this host yields and the other writer keeps settling.
#   3. peer      refuse while the previous writer's last run (var/peer-last-run.json, copied at the handover) is less
#                than 50 min old.
#   4. tripwire  the tx sender's on-chain nonce (one eth_getTransactionCount, 0 MON) before and after the job, against
#                the value this host recorded after its previous run (or at the claim). A nonce this host did not use
#                means another host sent from the same key: var/writer-conflict + alert, and this host stops signing.
#                A report that failed without a logged hash may have used a nonce: it is allowed, and the next run
#                re-baselines.
#   5. alerts    optional ntfy push (~/.config/isotherm/alert-webhook.url): failures, a writer conflict, the harness
#                fallback, a low attester balance, and every report sent.
#
# Env (set by the unit): ISOTHERM_STATE_DIR, ISOTHERM_HOST_LABEL=vps, ISOTHERM_JOB_LABEL=isotherm-settle.service,
#   ISOTHERM_WRITER_CLAIM_REQUIRED (default 1). Optional: ISOTHERM_CRE_API_KEY_FILE (default
#   ~/.config/isotherm/cre-api-key; read only if present, see vps/README.md section 4), ISOTHERM_ALERT_URL_FILE.
#   Fork tests only: ISOTHERM_RPC, ISOTHERM_ATTESTER_KEY_FILE, ISOTHERM_TX_KEY_FILE, ISOTHERM_TEST_RELABEL.
# Exit: the settle job's exit code; 0 for a refusal by steps 1 and 3 (expected states), 1 for a writer conflict.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
. "$PKG/vps/lib.sh"
export ISOTHERM_STATE_DIR=$STATE
export ISOTHERM_HOST_LABEL=${ISOTHERM_HOST_LABEL:-vps}
export ISOTHERM_JOB_LABEL=${ISOTHERM_JOB_LABEL:-isotherm-settle.service}
START=$(date +%s)

refuse() { vlog "REFUSED ($1): $2"; guard_record "$1" "$2"; }
conflict() { # conflict <detail>: sticky stop + high-priority alert
  json_line at "$(date -u +%FT%TZ)" sender "${SENDER:-?}" detail "$1" >"$STATE/writer-conflict"
  refuse conflict "$1"
  push_alert "ISOTHERM VPS: WRITER CONFLICT, settlement stopped on the VPS" \
    "$1. Another host is settling with the same key (the Mac job back on, or a second VPS). This VPS no longer signs. Find and stop the extra writer, then on the VPS: bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh clear-conflict" high 0
}

# ---- 0. optional CRE API key instead of a `cre login` session (UNVERIFIED for simulate; see vps/README.md section 4)
KF=${ISOTHERM_CRE_API_KEY_FILE:-$HOME/.config/isotherm/cre-api-key}
if [ -z "${CRE_API_KEY:-}" ] && [ -r "$KF" ]; then CRE_API_KEY=$(tr -d '[:space:]' <"$KF"); export CRE_API_KEY; fi

# ---- 1. claim
if [ "${ISOTHERM_WRITER_CLAIM_REQUIRED:-1}" = 1 ] && [ ! -f "$STATE/writer.claim" ]; then
  if [ -f "$STATE/writer.released" ]; then refuse no-claim "this host released the settlement writer role ($(head -c 200 "$STATE/writer.released")); nothing signed"
  else refuse no-claim "this host does not hold the settlement writer claim yet ($STATE/writer.claim); vps/cutover.sh hands it over from the Mac"; fi
  exit 0
fi
# ---- 2. a standing conflict
if [ -f "$STATE/writer-conflict" ]; then
  refuse conflict-standing "writer conflict still standing: $(head -c 400 "$STATE/writer-conflict")"
  push_alert "ISOTHERM VPS: settlement still stopped (writer conflict)" \
    "Cleared only by hand once a single host settles: bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh clear-conflict" high 21600
  exit 1
fi
# ---- 3. the previous writer's last run (handover spacing)
if [ -f "$STATE/peer-last-run.json" ]; then
  PEER_AT=$(node -e 'const p = require(process.argv[1]); console.log(Math.max(Number(p.lastRunEpoch) || 0, Math.floor((Date.parse(p.finishedAt || "") || 0) / 1000)))' "$STATE/peer-last-run.json" 2>/dev/null || echo 0)
  if [ "${PEER_AT:-0}" -gt 0 ] && [ $((START - PEER_AT)) -lt "$PEER_MIN_SEC" ]; then
    refuse peer-recent "the previous writer ($(jfield "$STATE/peer-last-run.json" from)) last ran at $(iso_of "$PEER_AT"), $(((START - PEER_AT) / 60)) min ago (< $((PEER_MIN_SEC / 60)) min); this host signs from $(iso_of $((PEER_AT + PEER_MIN_SEC))) on"
    exit 0
  fi
fi
# ---- 4a. tripwire, before: has anyone else sent from the key since this host's last run?
SENDER=$(tx_sender || true)
N0=""; [ -n "$SENDER" ] && N0=$(chain_nonce "$SENDER")
if [ -z "$N0" ]; then vlog "tripwire: no nonce read (key file unreadable or RPC error); the job's preflight decides"
else
  R_ADDR=""; R_NONCE=0; R_AT=0
  [ -f "$STATE/writer-nonce" ] && read -r R_ADDR R_NONCE R_AT _ <"$STATE/writer-nonce"
  if [ "$R_ADDR" = pending ]; then vlog "tripwire: the previous run did not record its final nonce (crash or RPC error); re-baselining at $N0"
  elif [ "$R_ADDR" = "$SENDER" ] && [ "$N0" -gt "$R_NONCE" ]; then
    conflict "tx sender $SENDER: on-chain nonce $N0, but this host recorded $R_NONCE after its last run at $(iso_of "$R_AT"): another host sent $((N0 - R_NONCE)) tx(s) from this key since"
    exit 1
  fi
  echo "pending $N0 $START" >"$STATE/writer-nonce"
fi

# ---- the settlement job (unchanged path selection, lock, spacing guard, evidence)
OUT="$STATE/logs/vps-$(date -u +%Y%m%dT%H%M%SZ).log"
bash "$PKG/scripts/settle-job.sh" 2>&1 | tee "$OUT"
RC=${PIPESTATUS[0]}

# ---- 4b. tripwire, after: every nonce used during the run must be one of this run's own transactions
OWN=$(grep -oE 'tx 0x[0-9a-f]{64}( ->| status=)' "$OUT" | grep -oE '0x[0-9a-f]{64}' | grep -v '^0x0*$' | sort -u | wc -l | tr -d ' ')
# A report whose delivery failed logs no hash (official path: "<ICAO> <date>: writeReport <status>"; harness: "send-report
# failed"), but its transaction may have used a nonce (mined and reverted, or a receipt that never came). Such a run
# allows one extra nonce per failed report, and records no baseline: the next run re-baselines.
UNSURE=$(grep -cE '\[USER LOG\] .*: writeReport |send-report failed' "$OUT")
if [ -n "$N0" ]; then
  N1=$(chain_nonce "$SENDER")
  if [ -z "$N1" ]; then vlog "tripwire: no nonce read after the run; the next run re-baselines"
  elif [ $((N1 - N0)) -gt $((OWN + UNSURE)) ]; then
    conflict "during this run the nonce of $SENDER went $N0 -> $N1, but this run sent $OWN tx(s)$([ "$UNSURE" -gt 0 ] && echo " (and $UNSURE failed report(s) that may have used a nonce)"): another host sent from this key at the same time"
    [ "$RC" = 0 ] && RC=1
  elif [ "$UNSURE" -gt 0 ]; then
    vlog "tripwire: nonce $N0 -> $N1, own txs $OWN, $UNSURE failed report(s) that may have used a nonce: no baseline recorded; the next run re-baselines"
  else
    # a tx of this run that is not mined yet still counts as this host's: record at least N0 + own txs
    REC=$N1; [ $((N0 + OWN)) -gt "$REC" ] && REC=$((N0 + OWN))
    echo "$SENDER $REC $(date +%s)" >"$STATE/writer-nonce"; vlog "tripwire: nonce $N0 -> $N1, own txs $OWN: single writer"
  fi
fi

# ---- 5. alerts from this run's evidence record (LATEST.json written by settle-job.sh)
LATEST="$STATE/evidence/LATEST.json"
FRESH=$(node -e 'try { const r = require(process.argv[1]); console.log(Date.parse(r.startedAt) >= (Number(process.argv[2]) - 5) * 1000 ? 1 : 0) } catch { console.log(0) }' "$LATEST" "$START" 2>/dev/null || echo 0)
if [ "$FRESH" = 1 ]; then
  # one alert per line: priority <TAB> dedupe seconds <TAB> title <TAB> body
  # shellcheck disable=SC2016  # JavaScript template literals, not shell expansions
  node -e '
    const r = require(process.argv[1]); const out = [];
    const tab = (p, d, t, b) => out.push([p, d, t, String(b).replace(/[\t\n]+/g, " ")].join("\t"));
    for (const s of r.reportsSent || [])
      tab("default", 0, `ISOTHERM VPS: report sent ${s.station} ${s.date}`, `${s.action}${s.tmaxC != null ? ` tmaxC=${s.tmaxC}` : ""} confirmed=${s.confirmed ?? "?"} tx ${s.txHash} (path ${r.path})`);
    if (r.exitCode !== 0) tab("high", 10800, `ISOTHERM VPS: settle job exit ${r.exitCode}`, `${r.exitMeaning}; path ${r.path}. ${(r.runner || []).slice(-2).join(" | ")}. Logs: journalctl --user -u isotherm-settle`);
    if (r.path !== "official" && !r.dryRun && !r.stoodDownForDon && !r.stoodDownForWriter)
      tab("default", 43200, "ISOTHERM VPS: harness fallback ran (official CRE path unavailable)", `${r.pathReason}. Log in again on the VPS (vps/README.md section 4).`);
    const bal = (r.runner || []).map((l) => l.match(/tx sender (0x[0-9a-fA-F]{40}) has ([0-9.]+) MON/)).find(Boolean);
    if (bal && Number(bal[2]) < 0.1) tab("default", 86400, "ISOTHERM VPS: attester low on MON", `${bal[1]} holds ${Number(bal[2]).toFixed(4)} MON, about ${Math.floor(Number(bal[2]) / 0.0204)} reports at 0.0204 MON. Fund it (docs/OPERATIONS.md section 4).`);
    console.log(out.join("\n"));
  ' "$LATEST" 2>/dev/null | while IFS=$'\t' read -r P D T B; do [ -n "$T" ] && push_alert "$T" "$B" "$P" "$D"; done
elif [ "$RC" != 0 ]; then
  push_alert "ISOTHERM VPS: settle job exit $RC" "no evidence record was written for this run; see $OUT and journalctl --user -u isotherm-settle" high 10800
fi
exit "$RC"
