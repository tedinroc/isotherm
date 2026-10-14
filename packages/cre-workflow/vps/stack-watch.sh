#!/usr/bin/env bash
# Stack watchdog for the judging period (to 2026-10-31), run on the settlement VPS every 10 min by isotherm-watch.timer.
# READ-ONLY against everything live: four HTTP GETs of the public API; the web app's RPC read as a browser reads it
# (one eth_blockNumber, a JSON-RPC read sent as a POST, and its CORS preflight, an OPTIONS); one GET of the site's
# index.html (and of its main script when that changes) to learn which fallback RPCs the deployed build has, each read
# the same way; and a few `cast` read calls (balances; and Resolver.resultOf only for a ladder past day end + 5 h
# without a result). It never sends a transaction, never POSTs to the API, holds no key, and never writes the
# settlement job's var/ files (it reads var/evidence/settle-runs.jsonl for the digest's CRE line), never touches the
# CRE login (~/.cre) or isotherm-settle.timer.
# Why: the maker Worker's own alert pushes fail (ntfy answers 401/429 to Cloudflare's shared IPs); this VPS pushes
# through ntfy from its own IP (vps/lib.sh push_alert, the same URL file as the settlement job; never printed).
#
#   bash ~/isotherm/packages/cre-workflow/vps/stack-watch.sh [--dry-run] [--fixtures DIR] [--now EPOCH] [--force]
#   bash ~/isotherm/packages/cre-workflow/vps/stack-watch.sh --snooze HOURS | --snooze-web HOURS
#     --dry-run       print what would be pushed; push nothing, save no state
#     --fixtures DIR  read health/snapshot/settlements/stats.json, webrpc.json/.code/.headers/-pre.code/-pre.headers,
#                     webbuild, webfb<N>.*, balance-<role>.txt and result-<ST>-<date>.txt from DIR instead of the
#                     network (tests); a missing file = a failed read
#     --now EPOCH     the time to evaluate at (tests)
#     --force         run even at minutes :03-:09 (next to the :05 settlement run, which the timer never hits)
#     --snooze HOURS  hold the maker checks (MAKER STALLED, BOOKS EMPTY, LADDER NOT OPENED, NO ACTIVE LADDER) for 1-72 h,
#                     for a deliberate pause of the maker (control.mjs pull / disarm, docs/OPERATIONS.md 8.4); 0 ends it.
#                     Writes var/watch/snooze-until only; runs no check.
#     --snooze-web HOURS  hold WEB RPC DOWN for 1-72 h (an outage you cannot fix, or one only this VPS sees); 0 ends
#                     it. Writes var/watch/snooze-web-until only; runs no check.
#
# Checks (thresholds and their reasons: vps/stack-watch.mjs; vps/README.md "Stack watchdog"), titles "ISOTHERM WATCH:":
#   MAKER STALLED (snapshot > 15 min old on 2 runs, or 25 min) | BOOKS EMPTY (fair 0.10-0.90, a side missing > 60 min,
#   not around a close) | LADDER NOT OPENED (tomorrow's ladder not active by 13:00 local) | NO ACTIVE LADDER (20 min)
#   API UNHEALTHY / DRIP DOWN / RELAY DOWN (> 20 min) | RELAYER LOW (< 15 MON) | AUSD FLOAT LOW (< 5 drips, > 20 min)
#   DRIP / RELAY CAP USED EARLY (cap used before 08:00 UTC; once a day; later: CAP REACHED, low) | TREASURY LOW (< 20)
#   MAKER LOW (< 1.0, > 20 min) | OPERATOR LOW (< 0.9, > 20 min) | GUARDIAN LOW (< 0.03, > 20 min)
#   ATTESTER LOW (< 0.08, > 20 min) | SETTLEMENT OVERDUE (no result by day end + 5 h) | WEB RPC DOWN (the web app's
#   RPC fails eth_blockNumber or its CORS preflight with the site's Origin, or is stuck, 3 runs in a row; high, or
#   default while a fallback RPC of the deployed build answers) | WATCH CANNOT REACH THE API (3 runs)
#   | a daily digest at 01:00 UTC (09:00 Taipei), with the CRE line from the settlement records, which doubles
#   as the heartbeat: no digest = the watchdog is down.
# A push repeats at most every 3 h (balances 6 h). A problem is over only after 30 min without it; then a pushed one
# sends one low-priority CLEARED push. One-off pushes (digest, caps, CLEARED) are re-sent until delivered (24 h max).
# State: var/watch/ only (state.json, snooze-until, snooze-web-until, web-build, alerts/ with the dedupe stamps and
# ALERTS.log). Env: ISOTHERM_WATCH_DIR (default var/watch), ISOTHERM_CAST (cast binary), ISOTHERM_WATCH_RPCS,
# ISOTHERM_ALERT_URL_FILE (lib.sh), ISOTHERM_STATE_DIR (the settlement job's var/, read for the CRE line; default var/).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
DRY=0; FIX=""; NOW=""; FORCE=0; SNOOZE=""; SNZ=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --fixtures) FIX=${2:-}; [ -n "$FIX" ] || { echo "--fixtures needs a directory" >&2; exit 2; }; shift ;;
    --now) NOW=${2:-}; shift ;;
    --force) FORCE=1 ;;
    --snooze|--snooze-web) SNZ=$1; SNOOZE=${2:-}; [ -n "$SNOOZE" ] || { echo "$1 needs a number of hours (0 ends a snooze)" >&2; exit 2; }; shift ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/p;}' "$0"; exit 0 ;;   # the header comment, up to the first line of code
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$NOW" in '') NOW=$(date +%s) ;; *[!0-9]*) echo "--now takes a unix time in seconds" >&2; exit 2 ;; esac
[ -z "$FIX" ] || [ -d "$FIX" ] || { echo "no fixtures directory $FIX" >&2; exit 2; }
wlog() { echo "[$(date -u +%FT%TZ)] [watch] $*"; }

# lib.sh's STATE (push_alert's dedupe stamps and ALERTS.log) is the watch's own directory, never the settlement job's
# var/: an inherited ISOTHERM_STATE_DIR (the settlement unit's) is overridden on purpose. That var/ is only read, for
# its evidence records (the digest's CRE line).
SETTLE_VAR=${ISOTHERM_STATE_DIR:-$PKG/var}
WATCH=${ISOTHERM_WATCH_DIR:-$PKG/var/watch}
mkdir -p "$WATCH"
ISOTHERM_STATE_DIR=$WATCH; export ISOTHERM_STATE_DIR
# shellcheck source=lib.sh
. "$PKG/vps/lib.sh"

# --snooze / --snooze-web: write (or remove) var/watch/snooze-until (the maker checks) or snooze-web-until (WEB RPC
# DOWN), the time until which those checks are held; nothing else.
if [ -n "$SNOOZE" ]; then
  if [ "$SNZ" = --snooze ]; then SF=snooze-until; WHAT="MAKER STALLED, BOOKS EMPTY, LADDER NOT OPENED and NO ACTIVE LADDER"; LABEL="the maker checks"
  else SF=snooze-web-until; WHAT="WEB RPC DOWN"; LABEL="WEB RPC DOWN"; fi
  case "$SNOOZE" in *[!0-9]*) echo "$SNZ takes whole hours, 0-72 (0 ends a snooze)" >&2; exit 2 ;; esac
  SNOOZE=$((10#$SNOOZE)); [ "$SNOOZE" -le 72 ] || { echo "$SNZ takes whole hours, 0-72 (0 ends a snooze)" >&2; exit 2; }
  if [ "$SNOOZE" = 0 ]; then
    if [ "$DRY" = 1 ]; then wlog "DRY RUN: would end the snooze of $LABEL"; else rm -f "$WATCH/$SF"; wlog "snooze ended: $LABEL run again from the next run"; fi
  else
    UNTIL=$((NOW + SNOOZE * 3600))
    if [ "$DRY" = 1 ]; then wlog "DRY RUN: would snooze $LABEL until $(iso_of "$UNTIL" | cut -c1-16)Z"
    else
      echo "$UNTIL" >"$WATCH/$SF.tmp" && mv -f "$WATCH/$SF.tmp" "$WATCH/$SF"
      wlog "$WHAT snoozed until $(iso_of "$UNTIL" | cut -c1-16)Z ($SNOOZE h); the other checks keep running; $SNZ 0 ends it"
    fi
  fi
  exit 0
fi

# Never next to the hourly :05 settlement run (a Persistent catch-up after a reboot could land there).
MIN=$(( (NOW / 60) % 60 ))
if [ "$FORCE" = 0 ] && [ "$MIN" -ge 3 ] && [ "$MIN" -le 9 ]; then
  wlog "skipped: minute :$(printf %02d "$MIN") is next to the :05 settlement run (the timer runs at :00/:10/...; --force runs anyway)"
  exit 0
fi
NODE=$(command -v node) || { wlog "node not found"; exit 1; }
PUSHOK=0; [ -r "$ALERT_URL_FILE" ] && PUSHOK=1
[ "$DRY" = 1 ] && wlog "DRY RUN: nothing is pushed and no state is saved (--dry-run hands nothing to push_alert)$([ "$PUSHOK" = 1 ] && echo "; an alert URL file is readable" || echo "; no alert URL file")"

RUN=$(mktemp -d "${TMPDIR:-/tmp}/isotherm-watch.XXXXXX") || { wlog "mktemp failed"; exit 1; }
LOCKED=0
# shellcheck disable=SC2317  # called by the EXIT trap
cleanup() { rm -rf "$RUN"; [ "$LOCKED" = 1 ] && rmdir "$WATCH/run.lock" 2>/dev/null; return 0; }
trap cleanup EXIT
if [ "$DRY" = 0 ]; then   # one run at a time (the timer's oneshot unit never overlaps itself; a manual run could)
  if ! mkdir "$WATCH/run.lock" 2>/dev/null; then
    if [ -n "$(find "$WATCH/run.lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$WATCH/run.lock" 2>/dev/null; mkdir "$WATCH/run.lock" 2>/dev/null || exit 0
    else wlog "another run holds $WATCH/run.lock; skipped"; exit 0; fi
  fi
  LOCKED=1
fi

# ---- the reads: four GETs; alongside them the web app's RPC as a browser reads it, and the deployed build's fallback
# RPCs (or the fixtures)
SITE=https://isotherm.pages.dev
WEB_RPC=https://testnet-rpc.monad.xyz   # the web app's RPC (apps/web/src/config.ts RPC_URL)
WEB_FALLBACKS="https://rpc.ankr.com/monad_testnet https://10143.rpc.thirdweb.com"   # = apps/web FALLBACK_RPC_URLS
UA=isotherm-stack-watch/1
# rpcprobe <name> <url> (run it in a subshell): the RPC read as the site's browser code reads it. eth_blockNumber, JSON
# with the site's Origin (the only POST here, a read-only method) -> <name>.code/.json/.headers; alongside it the CORS
# preflight a browser sends first (an OPTIONS: a JSON content type is not a "simple" request) -> <name>-pre.code/.headers
rpcprobe() {
  ( code=$(curl -sS --max-time 10 -A "$UA" -X OPTIONS -H "Origin: $SITE" -H 'Access-Control-Request-Method: POST' \
      -H 'Access-Control-Request-Headers: content-type' -D "$IN/$1-pre.headers" -o /dev/null -w '%{http_code}' "$2" 2>/dev/null) || code=${code:-000}
    echo "$code" >"$IN/$1-pre.code" ) &
  code=$(curl -sS --max-time 10 -A "$UA" -H 'content-type: application/json' -H "Origin: $SITE" \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
    -D "$IN/$1.headers" -o "$IN/$1.json" -w '%{http_code}' "$2" 2>/dev/null) || code=${code:-000}
  echo "$code" >"$IN/$1.code"
  [ "$code" = 200 ] || rm -f "$IN/$1.json"
  wait
}
# webbuild: which fallback RPCs the deployed site has -> $IN/webbuild: the path of its main script (index.html names
# it), then each WEB_FALLBACKS URL that script lists. Cached in var/watch/web-build by that path (a new build has a new
# name), so the script (~0.6 MB) is read once per deploy. Unknown (the site unreadable, or a script that does not even
# list WEB_RPC): no file, so no fallback is assumed and WEB RPC DOWN stays high.
webbuild() {
  local js code f
  js=$(curl -sS --max-time 10 -A "$UA" "$SITE/" 2>/dev/null | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -n 1)
  [ -n "$js" ] || return 0
  if [ "$(head -n 1 "$WATCH/web-build" 2>/dev/null)" = "$js" ]; then cp "$WATCH/web-build" "$IN/webbuild"; return 0; fi
  code=$(curl -sS --max-time 20 -A "$UA" -o "$RUN/site.js" -w '%{http_code}' "$SITE$js" 2>/dev/null) || code=000
  if [ "$code" != 200 ] || ! grep -qF "$WEB_RPC" "$RUN/site.js"; then rm -f "$RUN/site.js"; return 0; fi
  { echo "$js"; for f in $WEB_FALLBACKS; do if grep -qF "$f" "$RUN/site.js"; then echo "$f"; fi; done; } >"$IN/webbuild"
  rm -f "$RUN/site.js"
  [ "$DRY" = 1 ] || { cp "$IN/webbuild" "$WATCH/web-build.tmp" && mv -f "$WATCH/web-build.tmp" "$WATCH/web-build"; }
}
if [ -n "$FIX" ]; then IN=$FIX
else
  IN=$RUN
  ( rpcprobe webrpc "$WEB_RPC" ) &
  ( webbuild; i=0
    for f in $(tail -n +2 "$IN/webbuild" 2>/dev/null); do i=$((i + 1)); ( rpcprobe "webfb$i" "$f" ) & done
    wait ) &
  for e in health snapshot settlements stats; do
    code=$(curl -sS --max-time 10 -A "$UA" -H 'accept: application/json' \
      -o "$IN/$e.json" -w '%{http_code}' "$SITE/api/$e" 2>/dev/null) || code=${code:-000}
    echo "$code" >"$IN/$e.code"
    [ "$code" = 200 ] || rm -f "$IN/$e.json"
  done
  wait   # the web RPC reads (each 10 s at most; a new build's script 20 s) end inside the GETs' 40 s
fi

# ---- the digest's CRE line: the settlement job's evidence records (its last 1000 runs), classified with lib.sh's own
# rule (CRE_LAPSE_JS, as isotherm-vps.sh status and the CRE LOGIN NEEDED push). Read only; never ~/.cre. No records
# (no settlement job on this host): no line. Parsed only on a run that may send the digest (from 01:00 UTC, = the
# evaluator's T.digestHourUtc less its 30 s jitter, until state.json holds a digest sent today), not on the other ~140.
SETTLE_RUNS=$SETTLE_VAR/evidence/settle-runs.jsonl
STATE_FILE=$WATCH/state.json
DAY0=$((NOW - NOW % 86400))
DIGAT=$(sed -n 's/.*"digest":{"day":"[0-9-]*","at":\([0-9]*\).*/\1/p' "$STATE_FILE" 2>/dev/null | head -n 1)
if [ $((NOW - DAY0)) -lt 3570 ] || { [ -n "$DIGAT" ] && [ "$DIGAT" -ge "$DAY0" ]; }; then :   # no digest on this run
elif [ -s "$SETTLE_RUNS" ]; then
  # shellcheck disable=SC2016  # JavaScript template literals, not shell expansions
  tail -n 1000 "$SETTLE_RUNS" | "$NODE" -e "$CRE_LAPSE_JS"'
    const runs = [];
    for (const l of require("fs").readFileSync(0, "utf8").split("\n")) {
      let r; try { r = JSON.parse(l) } catch { continue }
      if (!r || typeof r !== "object" || r.dryRun) continue;
      runs.push({ at: r.startedAt || r.finishedAt || null, path: r.path === "official" ? "official" : "harness", exit: r.exitCode ?? null,
        meaning: String(r.exitMeaning || "").slice(0, 80), login: lapsed(r) ? "missed" : loginOk(r) ? "ok" : "other",
        stoodDown: r.stoodDownForDon ? "don" : r.stoodDownForWriter ? "writer" : null, why: String(r.pathReason || "").slice(0, 160),
        sent: (Array.isArray(r.reportsSent) ? r.reportsSent : []).map((o) => ({ station: o.station, date: o.date, action: o.action, tmaxC: o.tmaxC ?? null, confirmed: o.confirmed ?? null })) });
    }
    console.log(JSON.stringify(runs))' >"$RUN/cre-runs.json" 2>/dev/null || echo null >"$RUN/cre-runs.json"
fi

# ---- the evaluation (vps/stack-watch.mjs: the checks, cast reads, first-seen state, the digest)
NEW_STATE=$WATCH/state.json.new; [ "$DRY" = 1 ] && NEW_STATE=$RUN/state.json   # a dry run's state is thrown away
"$NODE" "$PKG/vps/stack-watch.mjs" --in "$IN" --state "$STATE_FILE" --out-state "$NEW_STATE" --now "$NOW" \
  --watch "$STATE" --push "$PUSHOK" ${FIX:+--fixtures} --cre-runs "$RUN/cre-runs.json" --cre-after "$CRE_NEEDED_AFTER" \
  >"$RUN/actions" 2>"$RUN/eval.err"
RC=$?
if [ "$RC" != 0 ]; then
  wlog "evaluator failed (exit $RC): $(tr '\n' ' ' <"$RUN/eval.err" | cut -c1-300)"
  [ "$DRY" = 1 ] || push_alert "ISOTHERM WATCH: WATCH ERROR" "vps/stack-watch.mjs failed (exit $RC), so no check runs. On the VPS: journalctl --user -u isotherm-watch -n 30 -o cat" default 21600
  exit 1
fi

# ---- the actions
NP=0
held() { # held <title> <dedupe s>: why push_alert would not repeat it now (dry run only)
  local last
  [ "$2" -gt 0 ] || return 0
  last=$(cat "$STATE/alerts/$(alert_slug "$1").last" 2>/dev/null) || return 0
  [ $(( $(date +%s) - last )) -lt "$2" ] && printf '; held back: pushed %s min ago' "$(( ($(date +%s) - last) / 60 ))"
  return 0
}
while IFS=$'\t' read -r KIND A B C D; do
  case "$KIND" in
    LOG) wlog "$A" ;;
    PUSH)
      NP=$((NP + 1)); BODY=$(printf '%s' "$D" | tr '\037' '\n')
      if [ "$DRY" = 1 ]; then
        echo "WOULD PUSH [priority $A, repeat $([ "$B" -gt 0 ] && echo "after $((B / 60)) min" || echo "not limited")$(held "$C" "$B")] $C"
        printf '%s\n' "$BODY" | sed 's/^/    /'
      else push_alert "$C" "$BODY" "$A" "$B"; fi
      ;;
    UNSTAMP) if [ "$DRY" = 1 ]; then echo "(would reset the repeat timer of '$A')"; else rm -f "$STATE/alerts/$(alert_slug "$A").last"; fi ;;
  esac
done <"$RUN/actions"
if [ "$DRY" = 1 ]; then wlog "dry run done: $NP push(es) would be sent; nothing pushed, no state saved"
else mv -f "$NEW_STATE" "$STATE_FILE"; wlog "run done: $NP push(es) handed to push_alert (each title at most once per its repeat window)"; fi
exit 0
