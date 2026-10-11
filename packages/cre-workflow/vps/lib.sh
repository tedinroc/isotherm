# shellcheck shell=bash
# shellcheck disable=SC2034  # variables used by the scripts that source this file
# Shared by vps/settle-vps.sh and vps/isotherm-vps.sh (sourced, never run). Expects PKG = packages/cre-workflow.
# Never prints a key or the alert URL.

VPS_LIVE_RPC=https://testnet-rpc.monad.xyz
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$HOME/.foundry/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STATE=${ISOTHERM_STATE_DIR:-$PKG/var}
mkdir -p "$STATE/evidence" "$STATE/logs" "$STATE/alerts"
STATE=$(cd "$STATE" && pwd)
RPC=${ISOTHERM_RPC:-$VPS_LIVE_RPC}
# The other host's last run must be at least this old before this host signs (50 min: longer than the 30-min spacing
# guard plus the 25-min attestation lifetime would need, shorter than the hourly cadence, so :05 -> :05 still works).
PEER_MIN_SEC=${ISOTHERM_PEER_MIN_SEC:-3000}
ALERT_URL_FILE=${ISOTHERM_ALERT_URL_FILE:-$HOME/.config/isotherm/alert-webhook.url}
TX_KEY_FILE=${ISOTHERM_TX_KEY_FILE:-${ISOTHERM_ATTESTER_KEY_FILE:-$HOME/.config/isotherm/attester.key}}
UNIT=isotherm-settle

vlog() { echo "[$(date -u +%FT%TZ)] [vps] $*"; }
is_loopback_rpc() { case "$RPC" in http://127.0.0.1:*|http://localhost:*) return 0 ;; esac; return 1; }
iso_of() { node -e 'console.log(new Date(Number(process.argv[1]) * 1000).toISOString())' "$1"; }
# jfield <file> <dotted.path>: one JSON field, empty when the file or the field is missing
jfield() { node -e 'try { const v = process.argv[2].split(".").reduce((o, k) => o?.[k], require(process.argv[1])); if (v != null) console.log(typeof v === "object" ? JSON.stringify(v) : v) } catch {}' "$1" "$2" 2>/dev/null; }
# json_line k1 v1 k2 v2 ...: one JSON object (string values) on one line
json_line() { node -e 'const a = process.argv.slice(1), o = {}; for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1]; console.log(JSON.stringify(o))' "$@"; }

# Address of the transaction sender's key (the attester key by default). The key goes to bun as a file path only.
tx_sender() {
  [ -r "$TX_KEY_FILE" ] || return 1
  (cd "$PKG/settle" && KEYFILE="$TX_KEY_FILE" bun -e 'import {privateKeyToAccount} from "viem/accounts"; const k=require("fs").readFileSync(process.env.KEYFILE,"utf8").trim(); console.log(privateKeyToAccount((k.startsWith("0x")?k:"0x"+k)).address)' 2>/dev/null)
}
# On-chain nonce (latest block) of an address; empty on any RPC failure.
chain_nonce() { cast nonce "$1" --rpc-url "$RPC" 2>/dev/null | grep -E '^[0-9]+$' || true; }

# One JSON line per refusal of the single-writer guard (evidence; the settle job's own records stay unchanged).
guard_record() { # guard_record <code> <detail>
  json_line at "$(date -u +%FT%TZ)" host "${ISOTHERM_HOST_LABEL:-vps}" code "$1" detail "$2" >>"$STATE/evidence/writer-guard.jsonl"
}

# The file name part of an alert's dedupe stamp ($STATE/alerts/<slug>.last).
alert_slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '_' | cut -c1-80; }

# Phone push through ntfy (optional): the URL comes from ALERT_URL_FILE (chmod 600) and never reaches argv or a log.
# push_alert <title> <body> [priority low|default|high] [dedupe seconds per title, 0 = always]
push_alert() {
  local title=$1 body=$2 prio=${3:-default} dedupe=${4:-0} slug now last url code
  vlog "ALERT: $title | $body"
  printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$title" "$body" >>"$STATE/alerts/ALERTS.log"
  [ -r "$ALERT_URL_FILE" ] || return 0
  slug=$(alert_slug "$title")
  now=$(date +%s)
  if [ "$dedupe" -gt 0 ]; then
    last=$(cat "$STATE/alerts/$slug.last" 2>/dev/null || echo 0)
    if [ $((now - last)) -lt "$dedupe" ]; then vlog "push: '$title' already pushed $(((now - last) / 60)) min ago; not repeated"; return 0; fi
  fi
  url=$(head -n1 "$ALERT_URL_FILE" | tr -d '[:space:]')
  case "$url" in
    https://*) ;;
    http://127.0.0.1:*) is_loopback_rpc || { vlog "push: alert URL ignored (must be https://)"; return 0; } ;;   # fork tests only
    *) vlog "push: alert URL ignored (must be https://)"; return 0 ;;
  esac
  code=$(printf '%s' "$body" | curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "Title: $title" -H "Priority: $prio" -H "Tags: isotherm" --data-binary @- \
    -K <(printf 'url = "%s"\n' "$url") 2>/dev/null) || code=000
  if [ "${code:0:1}" = 2 ]; then echo "$now" >"$STATE/alerts/$slug.last"; vlog "push: sent (HTTP $code)"
  else vlog "push: FAILED (HTTP $code); the alert stays in $STATE/alerts/ALERTS.log"; fi
  return 0
}

# ---- CRE login watch (settle-vps.sh step 5b, isotherm-vps.sh status). Reads evidence records only, never ~/.cre.
# A run MISSED the login when it settled on the harness because the CRE login was missing: settle-job.sh's
# `cre whoami` failed (evidence creLogin=false), or it passed but run-official.sh found no login just before signing
# (exit 3). Not a miss: a harness run after a failed OFFICIAL run (creLogin=true), a dry run, a stand-down.
# A run shows the login is there when it took the official path or its `cre whoami` answered (creLogin=true).
# One miss alone is not reported: `cre whoami` asks the CRE API, which now and then times out. The Mac's own records
# (2026-10-07 to 10-10, 74 runs) hold 3 single misses with an official run an hour before and an hour after.
CRE_LAPSE_JS='const lapsed = (r) => !!r && !r.dryRun && !r.stoodDownForDon && !r.stoodDownForWriter && r.path !== "official" && (r.creLogin === false || /reported no login \(exit 3\)/.test(String(r.pathReason || ""))); const loginOk = (r) => !!r && !r.dryRun && !lapsed(r) && (r.path === "official" || r.creLogin === true);'
RELOGIN_CMD="packages/cre-workflow/vps/relogin.sh isotherm-vps"   # the fix, run on the Mac (the runbook's ssh alias)
CRE_NEEDED_TITLE="ISOTHERM VPS: CRE LOGIN NEEDED"
CRE_RESTORED_TITLE="ISOTHERM VPS: CRE LOGIN RESTORED"
CRE_NEEDED_AFTER=2                          # runs in a row without the login before CRE LOGIN NEEDED
CRE_NEEDED_DEDUPE=10800                     # 3 h
CRE_LAPSED_FILE="$STATE/cre-login-lapsed.json"   # present after a miss, until the login is back: {at, reason, runs}

# cre_login_watch <this run's evidence record>: CRE_NEEDED_AFTER runs in a row without the login -> a high-priority
# push naming the one-line fix (3 h dedupe). The first run that shows the login again clears the state; if the push
# went out, it also sends one "restored" push, and the next lapse pushes at once again. A single miss pushes nothing.
# shellcheck disable=SC2016  # JavaScript template literals, not shell expansions
cre_login_watch() {
  local kind runs since reason now_at mins what
  kind=$(node -e "$CRE_LAPSE_JS"' try { const r = require(process.argv[1]); console.log(lapsed(r) ? "lapsed" : !loginOk(r) ? "other" : r.path === "official" ? "official" : "login-ok") } catch { console.log("other") }' "$1" 2>/dev/null)
  runs=0
  if [ -f "$CRE_LAPSED_FILE" ]; then runs=$(jfield "$CRE_LAPSED_FILE" runs); case "$runs" in ''|*[!0-9]*) runs=1 ;; esac; fi
  case "$kind" in
    lapsed)
      runs=$((runs + 1))
      since=$(jfield "$CRE_LAPSED_FILE" at); [ -n "$since" ] || since=$(jfield "$1" startedAt)
      reason=$(jfield "$1" pathReason | cut -c1-200)
      json_line at "$since" reason "$reason" runs "$runs" >"$CRE_LAPSED_FILE.tmp" && mv -f "$CRE_LAPSED_FILE.tmp" "$CRE_LAPSED_FILE"
      if [ "$runs" -lt "$CRE_NEEDED_AFTER" ]; then
        vlog "CRE login: none in this run ($reason). One miss is often a CRE API timeout; CRE LOGIN NEEDED is pushed if the next run finds none either."
        return 0
      fi
      push_alert "$CRE_NEEDED_TITLE" "The CRE login on the VPS has lapsed: $runs runs in a row without it, since ${since:-?} (this run: $reason). Settlement continues on the labelled harness fallback, not the CRE engine. Fix, one line on the Mac: $RELOGIN_CMD" high "$CRE_NEEDED_DEDUPE"
      ;;
    official|login-ok)
      [ -f "$CRE_LAPSED_FILE" ] || return 0
      since=$(jfield "$CRE_LAPSED_FILE" at); now_at=$(jfield "$1" startedAt)
      # the state goes first, so a failed push can never repeat the "restored" message
      rm -f "$CRE_LAPSED_FILE" "$STATE/alerts/$(alert_slug "$CRE_NEEDED_TITLE").last"
      if [ "$runs" -lt "$CRE_NEEDED_AFTER" ]; then
        vlog "CRE login: there again at ${now_at:-?} after a single miss at ${since:-?}; nothing was pushed"
        return 0
      fi
      mins=$(node -e 'const m = Math.round((Date.parse(process.argv[2]) - Date.parse(process.argv[1])) / 60000); console.log(m >= 0 ? (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`) : "?")' "$since" "$now_at" 2>/dev/null)
      if [ "$kind" = official ]; then what="The official CRE path ran again at ${now_at:-?}"
      else what="cre whoami answered again at ${now_at:-?} (this run still took the harness, after a failed official run; the next run retries the official path)"; fi
      push_alert "$CRE_RESTORED_TITLE" "$what; the login had lapsed from ${since:-?} (${mins:-?} on the harness). No action needed." default 0
      ;;
  esac
  return 0
}
