#!/usr/bin/env bash
# On the MAC, after a "CRE LOGIN NEEDED" push: sign the settlement VPS back in to CRE with one command.
#   packages/cre-workflow/vps/relogin.sh <ssh-alias> [--dry-run] [--timeout SEC] [--print-url]
#
#   1. Refuses if anything on this machine listens on port 53682 (the CLI's browser callback port).
#   2. Starts, in the background, with its output in a private temp file:
#        ssh -tt -L 53682:127.0.0.1:53682 <alias> bash isotherm/packages/cre-workflow/vps/isotherm-vps.sh login
#   3. Waits for the CLI's sign-in URL (https://login.chain.link/authorize?...) and opens it in the default browser
#      (`open`, macOS; printed instead elsewhere, or with --print-url). You sign in there (password + authenticator
#      code); the browser's redirect to localhost:53682 reaches the CLI on the VPS through the tunnel.
#   4. Waits for the VPS helper's answer: `cre whoami: yes` -> exit 0.
# The VPS's next :05 run then takes the official path and pushes "CRE LOGIN RESTORED" (vps/README.md section 4).
# One CRE session per account: this sign-in ends any other session of the same account (the Mac's, for example).
#
#   --dry-run       check the prerequisites only (tools, the alias in the ssh config, port 53682); no connection
#   --timeout SEC   give up after SEC seconds in all (default 600; the sign-in URL itself must come within 180 s)
#   --print-url     print the sign-in URL instead of opening it
# Exit: 0 signed in; 1 the sign-in did not complete (the VPS answered otherwise, or ssh ended); 2 refused (usage, port
#   in use, a missing prerequisite); 124 timed out; 130 interrupted. Every exit stops the ssh process (the `cre login`
#   waiting on the VPS ends with it) and deletes the temp file. Never prints a token: the VPS's output is shown with
#   terminal codes stripped and the sign-in URL, e-mail addresses, IPv4 addresses and long opaque strings masked.
# Env: ISOTHERM_VPS_SSH_OPTS (extra ssh options, as for push.sh), ISOTHERM_VPS_DIR (default isotherm).
#   Tests only: ISOTHERM_RELOGIN_PORT (the local port checked and forwarded; the CLI's callback is always 53682).
# bash 3.2 compatible (macOS /bin/bash).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
usage() { sed -n '2,24p' "$0"; }
DEST=""; DRY=0; TIMEOUT=600; PRINT_URL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --timeout) TIMEOUT=${2:-}; shift ;;
    --print-url) PRINT_URL=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
    *) [ -z "$DEST" ] || { echo "one ssh alias only (see --help)" >&2; exit 2; }; DEST=$1 ;;
  esac
  shift
done
[ -n "$DEST" ] || { usage >&2; exit 2; }
case "$DEST" in *[!A-Za-z0-9._@-]*) echo "refusing the ssh destination '$DEST': use the alias from ~/.ssh/config" >&2; exit 2 ;; esac
case "$TIMEOUT" in ''|0|*[!0-9]*) echo "--timeout needs a whole number of seconds (> 0)" >&2; exit 2 ;; esac
PORT=${ISOTHERM_RELOGIN_PORT:-53682}
case "$PORT" in ''|*[!0-9]*) echo "bad ISOTHERM_RELOGIN_PORT" >&2; exit 2 ;; esac
# shellcheck source=lib-mac.sh
. "$PKG/vps/lib-mac.sh"   # VPS_PKG, SSH_OPTS, say
URL_WAIT=180; [ "$TIMEOUT" -lt "$URL_WAIT" ] && URL_WAIT=$TIMEOUT
# `stty cols` first: a wide pseudo-terminal, so the CLI never wraps the long sign-in URL
REMOTE="stty cols 1000 2>/dev/null; bash $VPS_PKG/vps/isotherm-vps.sh login"

# terminal codes out (OSC, CSI, charset selection, carriage returns); line count unchanged
strip() { perl -pe 's/\e\][^\a\e]*(?:\a|\e\\)//g; s/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e[()][0-9A-Za-z]//g; s/\e[=>]//g; s/\r//g'; }
# what may be shown of the VPS's output: no sign-in URL, e-mail address, IPv4 address, token or long opaque string
mask() {
  perl -pe 's{https://login\.chain\.link/authorize\?\S*}{<sign-in URL>}g;
    s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<e-mail>/g;
    s/\b(?:\d{1,3}\.){3}\d{1,3}\b/<address>/g;
    s/\b((?:access|refresh|id)[_ -]?token|bearer|authorization|api[_ -]?key)(\W+)\S+/$1$2<masked>/gi;
    s/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}/<masked>/g;
    s/[A-Za-z0-9_+=-]{32,}/<masked>/g'
}
port_in_use() { # anything listening on this machine's port $1 (IPv4 or IPv6 loopback)
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# ---- prerequisites (all of them also run for --dry-run; none connects anywhere)
BAD=0
pre() { if [ "$1" = 1 ]; then say "OK       $2"; else say "FAIL     $2"; BAD=$((BAD + 1)); fi; }
for t in ssh perl mktemp; do pre "$(command -v "$t" >/dev/null 2>&1 && echo 1 || echo 0)" "$t"; done
if [ "$PRINT_URL" = 0 ] && [ "$(uname -s)" = Darwin ] && command -v open >/dev/null 2>&1; then OPENER=open
  say "OK       browser: the sign-in URL opens with \`open\` (default browser)"
else OPENER=print; say "OK       browser: the sign-in URL will be printed here; open it on THIS machine (the tunnel listens here)"; fi
if port_in_use "$PORT"; then pre 0 "port $PORT: something on this machine already listens on it (a \`cre login\` running here?); stop it, then run this again"
else pre 1 "port $PORT free on this machine"; fi
if command -v ssh >/dev/null 2>&1; then
  if HN=$(ssh -G ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$DEST" 2>/dev/null | awk '$1 == "hostname" { print $2 }') && [ -n "$HN" ]; then
    if [ "$HN" = "$DEST" ]; then say "NOTE     '$DEST' is not a Host alias in the ssh config; ssh treats it as a host name"
    else pre 1 "ssh config: '$DEST' is an alias"; fi
  else pre 0 "ssh config: 'ssh -G $DEST' failed"; fi
fi
[ "$BAD" = 0 ] || { say "REFUSED: $BAD prerequisite(s) failed; nothing started"; exit 2; }
if [ "$DRY" = 1 ]; then
  say "DRY RUN: nothing started. Without --dry-run this runs, with its output in a private temp file:"
  say "  ssh -tt -o BatchMode=yes -o ExitOnForwardFailure=yes -L $PORT:127.0.0.1:53682 $DEST '$REMOTE'"
  say "then opens the sign-in URL and waits up to $TIMEOUT s for 'cre whoami: yes'"
  exit 0
fi

# ---- the tunnel and the VPS's login helper
umask 077
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/isotherm-relogin.XXXXXX") || { say "REFUSED: no private temp directory"; exit 2; }
OUT="$TMPD/vps-login.out"; : >"$OUT"
SSH_PID=""
cleanup() {
  trap '' INT TERM HUP   # a second Ctrl-C must not cut the cleanup short (at most 3 s, then kill -9)
  if [ -n "$SSH_PID" ]; then
    kill "$SSH_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$SSH_PID" 2>/dev/null || break; sleep 0.3; done
    kill -9 "$SSH_PID" 2>/dev/null
    wait "$SSH_PID" 2>/dev/null
  fi
  rm -rf "$TMPD"
}
trap cleanup EXIT
trap 'echo; say "interrupted: stopping ssh (the cre login waiting on the VPS ends with it)"; exit 130' INT TERM HUP
say "connecting to $DEST: tunnel localhost:$PORT -> the VPS's 127.0.0.1:53682, then isotherm-vps.sh login there"
# -tt: `cre login` refuses to run without a terminal; stdin stays empty (nothing has to be typed on the VPS)
ssh -tt -o BatchMode=yes -o ConnectTimeout=15 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=4 -o LogLevel=ERROR ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} -L "$PORT:127.0.0.1:53682" "$DEST" "$REMOTE" \
  </dev/null >"$OUT" 2>&1 &
SSH_PID=$!

tail_out() { strip <"$OUT" | mask | grep -v '^[[:space:]]*$' | tail -n 12 | sed 's/^/  vps | /'; }
T0=$(date +%s); SHOWN=0; HDR=0; URL=""; STAGE="the sign-in URL"; NEXT_BEAT=$((T0 + 60))
while :; do
  ALIVE=1; kill -0 "$SSH_PID" 2>/dev/null || ALIVE=0
  N=$(wc -l <"$OUT" | tr -d ' '); [ "$ALIVE" = 0 ] && N=$((N + 1))   # complete lines only, unless ssh has ended
  CLEAN=""; [ "$N" -gt 0 ] && CLEAN=$(head -n "$N" "$OUT" | strip)   # (BSD head refuses -n 0)
  # the CLI's own output starts at its header (or at the URL line); the helper's instructions before it are not shown
  if [ "$HDR" = 0 ]; then
    HDR=$(printf '%s\n' "$CLEAN" | grep -nE '^ *(CRE Login *$|Opening browser to)' | head -n1 | cut -d: -f1)
    [ -n "$HDR" ] || HDR=$(printf '%s\n' "$CLEAN" | grep -nE 'https://login\.chain\.link/authorize\?[A-Za-z0-9_%-]+=' | head -n1 | cut -d: -f1)
    [ -n "$HDR" ] || HDR=0
  fi
  if [ "$HDR" -gt 0 ] && [ "$N" -gt "$SHOWN" ]; then
    [ "$SHOWN" -lt $((HDR - 1)) ] && SHOWN=$((HDR - 1))
    printf '%s\n' "$CLEAN" | sed -n "$((SHOWN + 1)),${N}p" | mask | grep -v '^[[:space:]]*$' | sed 's/^/  vps | /'
    SHOWN=$N
  fi
  if [ -z "$URL" ]; then
    URL=$(printf '%s\n' "$CLEAN" | grep -oE 'https://login\.chain\.link/authorize\?[^[:space:]"<>]+' | grep -E '[?&]client_id=' | grep -E '[?&]state=' | tail -n1)
    if [ -n "$URL" ]; then
      if [ "$OPENER" = open ] && open "$URL" >/dev/null 2>&1; then say "sign-in page opened in your default browser"
      else say "open this sign-in URL in a browser on THIS machine (the tunnel listens here, not on the VPS):"; printf '\n  %s\n\n' "$URL"; fi
      say "sign in there (password + authenticator code); waiting for the browser's callback through the tunnel (up to $(((TIMEOUT - ($(date +%s) - T0) + 59) / 60)) min)"
      STAGE="the browser sign-in"
    fi
  fi
  RES=$(printf '%s\n' "$CLEAN" | sed -n 's/.*cre whoami: \([a-z]*\).*/\1/p' | tail -n1)
  if [ "$RES" = yes ]; then
    say "SIGNED IN: the VPS answered 'cre whoami: yes'. Its next :05 run takes the official path and pushes CRE LOGIN RESTORED."
    exit 0
  elif [ -n "$RES" ]; then
    say "FAILED: after cre login the VPS answered 'cre whoami: $RES', not 'yes'; the sign-in did not complete. Last output:"
    tail_out
    say "If the browser said the login succeeded, the CRE API may have timed out: check in a minute with ssh $DEST bash $VPS_PKG/vps/isotherm-vps.sh status"
    exit 1
  fi
  if [ "$ALIVE" = 0 ]; then
    wait "$SSH_PID"; RC=$?; SSH_PID=""
    WHY="ssh ended (exit $RC) before the VPS answered 'cre whoami: yes'"
    if grep -qiE 'address already in use|forwarding failed|cannot listen' "$OUT"; then WHY="$WHY: the tunnel could not listen on port $PORT"
    elif [ "$RC" = 255 ]; then WHY="$WHY: ssh could not connect or log in to '$DEST' (it runs with BatchMode=yes: key login only)"; fi
    say "FAILED: $WHY. Last output:"; tail_out; exit 1
  fi
  NOW=$(date +%s)
  if [ -z "$URL" ] && [ $((NOW - T0)) -ge "$URL_WAIT" ]; then
    say "TIMED OUT after $URL_WAIT s waiting for the sign-in URL; stopping ssh. Last output:"; tail_out
    say "Try again: packages/cre-workflow/vps/relogin.sh $DEST"; exit 124
  fi
  if [ $((NOW - T0)) -ge "$TIMEOUT" ]; then
    say "TIMED OUT after $TIMEOUT s waiting for $STAGE; stopping ssh (the cre login waiting on the VPS ends with it)."
    say "If you did finish signing in, check: ssh $DEST bash $VPS_PKG/vps/isotherm-vps.sh status   (cre login: yes)"
    say "Try again: packages/cre-workflow/vps/relogin.sh $DEST [--timeout SEC]"; exit 124
  fi
  if [ -n "$URL" ] && [ "$NOW" -ge "$NEXT_BEAT" ]; then
    say "still waiting for $STAGE ($(((TIMEOUT - (NOW - T0) + 59) / 60)) min left)"; NEXT_BEAT=$((NOW + 60))
  fi
  sleep 1
done
