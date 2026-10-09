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

# Phone push through ntfy (optional): the URL comes from ALERT_URL_FILE (chmod 600) and never reaches argv or a log.
# push_alert <title> <body> [priority low|default|high] [dedupe seconds per title, 0 = always]
push_alert() {
  local title=$1 body=$2 prio=${3:-default} dedupe=${4:-0} slug now last url code
  vlog "ALERT: $title | $body"
  printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$title" "$body" >>"$STATE/alerts/ALERTS.log"
  [ -r "$ALERT_URL_FILE" ] || return 0
  slug=$(printf '%s' "$title" | tr -c 'A-Za-z0-9' '_' | cut -c1-80)
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
