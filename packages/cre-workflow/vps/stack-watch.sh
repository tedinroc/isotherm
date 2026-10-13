#!/usr/bin/env bash
# Stack watchdog for the judging period (to 2026-10-31), run on the settlement VPS every 10 min by isotherm-watch.timer.
# READ-ONLY against everything live: four HTTP GETs of the public API and a few `cast` read calls (balances; and
# Resolver.resultOf only for a ladder past day end + 5 h without a result). It never sends a transaction, never POSTs,
# holds no key, and never touches the settlement job's var/ files, the CRE login or isotherm-settle.timer.
# Why: the maker Worker's own alert pushes fail (ntfy answers 401/429 to Cloudflare's shared IPs); this VPS pushes
# through ntfy from its own IP (vps/lib.sh push_alert, the same URL file as the settlement job; never printed).
#
#   bash ~/isotherm/packages/cre-workflow/vps/stack-watch.sh [--dry-run] [--fixtures DIR] [--now EPOCH] [--force]
#   bash ~/isotherm/packages/cre-workflow/vps/stack-watch.sh --snooze HOURS
#     --dry-run       print what would be pushed; push nothing, save no state
#     --fixtures DIR  read health/snapshot/settlements/stats.json, balance-<role>.txt and result-<ST>-<date>.txt from
#                     DIR instead of the network (tests); a missing file = a failed read
#     --now EPOCH     the time to evaluate at (tests)
#     --force         run even at minutes :03-:09 (next to the :05 settlement run, which the timer never hits)
#     --snooze HOURS  hold the maker checks (MAKER STALLED, BOOKS EMPTY, LADDER NOT OPENED, NO ACTIVE LADDER) for 1-72 h,
#                     for a deliberate pause of the maker (control.mjs pull / disarm, docs/OPERATIONS.md 8.4); 0 ends it.
#                     Writes var/watch/snooze-until only; runs no check.
#
# Checks (thresholds and their reasons: vps/stack-watch.mjs; vps/README.md "Stack watchdog"), titles "ISOTHERM WATCH:":
#   MAKER STALLED (snapshot > 15 min old on 2 runs, or 25 min) | BOOKS EMPTY (fair 0.10-0.90, a side missing > 60 min,
#   not around a close) | LADDER NOT OPENED (tomorrow's ladder not active by 13:00 local) | NO ACTIVE LADDER (20 min)
#   API UNHEALTHY / DRIP DOWN / RELAY DOWN (> 20 min) | RELAYER LOW (< 15 MON) | AUSD FLOAT LOW (< 5 drips, > 20 min)
#   DRIP / RELAY CAP USED EARLY (cap used before 08:00 UTC; once a day; later: CAP REACHED, low) | TREASURY LOW (< 20)
#   MAKER LOW (< 1.0, > 20 min) | OPERATOR LOW (< 0.9, > 20 min) | SETTLEMENT OVERDUE (no result by day end + 5 h)
#   WATCH CANNOT REACH THE API (3 runs) | a daily digest at 01:00 UTC (09:00 Taipei), which doubles as the heartbeat:
#   no digest = the watchdog is down.
# A push repeats at most every 3 h (balances 6 h). A problem is over only after 30 min without it; then a pushed one
# sends one low-priority CLEARED push. One-off pushes (digest, caps, CLEARED) are re-sent until delivered (24 h max).
# State: var/watch/ only (state.json, snooze-until, alerts/ with the dedupe stamps and ALERTS.log). Env:
# ISOTHERM_WATCH_DIR (default var/watch), ISOTHERM_CAST (cast binary), ISOTHERM_WATCH_RPCS, ISOTHERM_ALERT_URL_FILE (lib.sh).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
DRY=0; FIX=""; NOW=""; FORCE=0; SNOOZE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --fixtures) FIX=${2:-}; [ -n "$FIX" ] || { echo "--fixtures needs a directory" >&2; exit 2; }; shift ;;
    --now) NOW=${2:-}; shift ;;
    --force) FORCE=1 ;;
    --snooze) SNOOZE=${2:-}; [ -n "$SNOOZE" ] || { echo "--snooze needs a number of hours (0 ends a snooze)" >&2; exit 2; }; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$NOW" in '') NOW=$(date +%s) ;; *[!0-9]*) echo "--now takes a unix time in seconds" >&2; exit 2 ;; esac
[ -z "$FIX" ] || [ -d "$FIX" ] || { echo "no fixtures directory $FIX" >&2; exit 2; }
wlog() { echo "[$(date -u +%FT%TZ)] [watch] $*"; }

# lib.sh's STATE (push_alert's dedupe stamps and ALERTS.log) is the watch's own directory, never the settlement job's
# var/: an inherited ISOTHERM_STATE_DIR (the settlement unit's) is overridden on purpose.
WATCH=${ISOTHERM_WATCH_DIR:-$PKG/var/watch}
mkdir -p "$WATCH"
ISOTHERM_STATE_DIR=$WATCH; export ISOTHERM_STATE_DIR
# shellcheck source=lib.sh
. "$PKG/vps/lib.sh"

# --snooze: write (or remove) var/watch/snooze-until, the time until which the maker checks are held; nothing else.
if [ -n "$SNOOZE" ]; then
  case "$SNOOZE" in *[!0-9]*) echo "--snooze takes whole hours, 0-72 (0 ends a snooze)" >&2; exit 2 ;; esac
  SNOOZE=$((10#$SNOOZE)); [ "$SNOOZE" -le 72 ] || { echo "--snooze takes whole hours, 0-72 (0 ends a snooze)" >&2; exit 2; }
  if [ "$SNOOZE" = 0 ]; then
    if [ "$DRY" = 1 ]; then wlog "DRY RUN: would end the snooze"; else rm -f "$WATCH/snooze-until"; wlog "snooze ended: the maker checks run again from the next run"; fi
  else
    UNTIL=$((NOW + SNOOZE * 3600))
    if [ "$DRY" = 1 ]; then wlog "DRY RUN: would snooze the maker checks until $(iso_of "$UNTIL" | cut -c1-16)Z"
    else
      echo "$UNTIL" >"$WATCH/snooze-until.tmp" && mv -f "$WATCH/snooze-until.tmp" "$WATCH/snooze-until"
      wlog "MAKER STALLED, BOOKS EMPTY, LADDER NOT OPENED and NO ACTIVE LADDER snoozed until $(iso_of "$UNTIL" | cut -c1-16)Z ($SNOOZE h); the other checks keep running; --snooze 0 ends it"
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

# ---- the reads: four GETs (or the fixtures)
if [ -n "$FIX" ]; then IN=$FIX
else
  IN=$RUN
  for e in health snapshot settlements stats; do
    code=$(curl -sS --max-time 10 -A isotherm-stack-watch/1 -H 'accept: application/json' \
      -o "$IN/$e.json" -w '%{http_code}' "https://isotherm.pages.dev/api/$e" 2>/dev/null) || code=${code:-000}
    echo "$code" >"$IN/$e.code"
    [ "$code" = 200 ] || rm -f "$IN/$e.json"
  done
fi

# ---- the evaluation (vps/stack-watch.mjs: the checks, cast reads, first-seen state, the digest)
STATE_FILE=$WATCH/state.json
NEW_STATE=$WATCH/state.json.new; [ "$DRY" = 1 ] && NEW_STATE=$RUN/state.json   # a dry run's state is thrown away
"$NODE" "$PKG/vps/stack-watch.mjs" --in "$IN" --state "$STATE_FILE" --out-state "$NEW_STATE" --now "$NOW" \
  --watch "$STATE" --push "$PUSHOK" ${FIX:+--fixtures} \
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
