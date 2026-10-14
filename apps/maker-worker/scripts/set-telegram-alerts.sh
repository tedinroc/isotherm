#!/usr/bin/env bash
# Switch the maker Worker's alert push (ALERT_WEBHOOK_URL) to a Telegram bot. The Worker's ntfy push cannot work from
# Cloudflare: ntfy answers 429 to its shared egress IPs, and the URL's ntfy credential was rejected (401) once revoked.
#   1. In Telegram, talk to @BotFather: /newbot, pick a name; it replies with a bot token (digits:letters).
#   2. Open your new bot and send it any message (e.g. "hi"), so the chat id below can be found.
#   3. From apps/maker-worker, with XDG_CONFIG_HOME set as in OPERATIONS 8.2: bash scripts/set-telegram-alerts.sh
#      (asks for the token; input hidden)
# The token is read from the keyboard only: never printed, never a command-line argument, written only into
# ~/.config/isotherm/alert-webhook.url (mode 600; the previous ntfy URL is kept as alert-webhook.ntfy.url). Then the URL
# is uploaded as the Worker secret (a new Worker version with the same code and vars) and a TEST ALERT is raised.
# The settlement VPS keeps its own ntfy URL file and is not touched.
set -euo pipefail
umask 077
CFG="$HOME/.config/isotherm"
cd "$(dirname "$0")/.."
: "${XDG_CONFIG_HOME:?set XDG_CONFIG_HOME to the wrangler config of the account that owns the Worker, as in OPERATIONS 8.2}"
export XDG_CONFIG_HOME
if [ -f "$CFG/alert-webhook.url" ] && grep -q 'ntfy\.sh' "$CFG/alert-webhook.url" && [ ! -f "$CFG/alert-webhook.ntfy.url" ]; then
  cp "$CFG/alert-webhook.url" "$CFG/alert-webhook.ntfy.url"
  echo "kept the previous ntfy URL as alert-webhook.ntfy.url"
fi
printf 'Telegram bot token from @BotFather (input hidden): '
IFS= read -rs TK
echo
[ -n "$TK" ] || { echo "no token entered; nothing changed"; exit 1; }
printf '%s' "$TK" | python3 -c '
import json, os, sys, urllib.request
t = sys.stdin.read().strip()
if ":" not in t:
    sys.exit("that does not look like a Telegram bot token (digits:letters); nothing changed")
api = "https://api.telegram.org/bot" + t
try:
    with urllib.request.urlopen(api + "/getUpdates", timeout=20) as r:
        upd = json.load(r)
except Exception as e:
    sys.exit("Telegram refused the token or could not be reached (" + type(e).__name__ + "); nothing changed")
chats = [u["message"]["chat"]["id"] for u in upd.get("result", []) if u.get("message", {}).get("chat", {}).get("id") is not None]
if not chats:
    sys.exit("no message found: open your bot in Telegram, send it any message, then run this again; nothing changed")
p = os.path.expanduser("~/.config/isotherm/alert-webhook.url")
with open(p, "w") as f:
    f.write(api + "/sendMessage?chat_id=" + str(chats[-1]) + "\n")
os.chmod(p, 0o600)
print("alert-webhook.url now points to your bot (chat found)")
'
unset TK
node scripts/put-secrets.mjs --only ALERT_WEBHOOK_URL --live
node scripts/control.mjs test-alert --force
echo "done: a TEST ALERT should reach Telegram within about a minute (node scripts/control.mjs result shows the push outcome)"
