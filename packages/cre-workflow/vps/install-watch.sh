#!/usr/bin/env bash
# Installs, removes or shows the stack watchdog's two systemd USER units on the VPS (vps/stack-watch.sh every 10 min).
# Run ON THE VPS as the job's user, from the copy that vps/push.sh shipped. Idempotent. It touches only
# isotherm-watch.service / isotherm-watch.timer (and, with --purge, var/watch/); never isotherm-settle.*, var/'s other
# files, keys, the CRE login or the alert URL file.
#   bash ~/isotherm/packages/cre-workflow/vps/install-watch.sh               render both units, enable + start the timer
#   bash ~/isotherm/packages/cre-workflow/vps/install-watch.sh --status      timer state, next run, snooze, last run's
#                                                                             journal (-o cat: no hostname in the output)
#   bash ~/isotherm/packages/cre-workflow/vps/install-watch.sh --uninstall [--purge]
#                                                                             stop + disable the timer, remove both
#                                                                             units; --purge also deletes var/watch/
# The first run is the timer's next :x0; it pushes the first daily digest (the "it works" push). To get it at once:
#   systemctl --user start isotherm-watch.service
set -uo pipefail
umask 022   # the unit files must not be group/world-writable (systemd warns, and so would anyone else's write)
PKG="$(cd "$(dirname "$0")/.." && pwd)"
UD=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
U=isotherm-watch
MODE=install; PURGE=0
for a in "$@"; do
  case "$a" in
    --uninstall) MODE=uninstall ;; --status) MODE=status ;; --purge) PURGE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $a (see --help)" >&2; exit 2 ;;
  esac
done
say() { echo "[vps/install-watch] $*"; }
[ "$(id -u)" != 0 ] || { echo "run as the job's non-root user (its systemd user manager runs the timer)" >&2; exit 1; }
systemctl --user show-environment >/dev/null 2>&1 || { echo "no systemd user manager reachable from this shell (log in over SSH again; linger must be on: vps/setup.sh)" >&2; exit 1; }

case "$MODE" in
  install)
    command -v node >/dev/null || { echo "node not found (vps/setup.sh installs it)" >&2; exit 1; }
    [ -x "$PKG/.tools/bin/cast" ] || command -v cast >/dev/null || say "WARNING: no cast found: the balance and Resolver checks will be skipped (vps/setup.sh installs it)"
    for f in vps/stack-watch.sh vps/stack-watch.mjs vps/lib.sh; do [ -f "$PKG/$f" ] || { echo "missing $PKG/$f: push this checkout first (vps/push.sh)" >&2; exit 1; }; done
    mkdir -p "$UD"
    CHANGED=0
    for f in "$U.service" "$U.timer"; do
      sed "s#@PKG@#$PKG#g" "$PKG/vps/systemd/$f.in" >"$UD/$f.new"
      if cmp -s "$UD/$f.new" "$UD/$f"; then rm -f "$UD/$f.new"; else mv -f "$UD/$f.new" "$UD/$f"; CHANGED=1; fi
    done
    if [ "$CHANGED" = 1 ]; then say "units written to $UD"; else say "units unchanged in $UD"; fi
    systemctl --user daemon-reload
    systemd-analyze --user verify "$UD/$U.service" "$UD/$U.timer" 2>&1 | sed 's/^/  verify: /' || true
    systemctl --user enable --now "$U.timer" >/dev/null 2>&1 || { echo "could not enable $U.timer" >&2; exit 1; }
    say "timer $(systemctl --user is-enabled "$U.timer" 2>/dev/null)/$(systemctl --user is-active "$U.timer" 2>/dev/null)"
    systemctl --user list-timers "$U.timer" --no-pager 2>/dev/null | sed -n '1,2p' | sed 's/^/  /'
    [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || say "WARNING: linger is off, so the timer stops when you log out (sudo loginctl enable-linger $(id -un))"
    say "installed. Logs: journalctl --user -u $U -n 30 -o cat; alerts: $PKG/var/watch/alerts/ALERTS.log; remove: $0 --uninstall"
    ;;
  status)
    echo "timer    $(systemctl --user is-enabled "$U.timer" 2>/dev/null || echo not-installed)/$(systemctl --user is-active "$U.timer" 2>/dev/null)"
    systemctl --user list-timers "$U.timer" --no-pager 2>/dev/null | sed -n '2p' | sed 's/^/next     /'
    echo "state    $([ -f "$PKG/var/watch/state.json" ] && echo "$PKG/var/watch/state.json" || echo none)"
    SU=$(cat "$PKG/var/watch/snooze-until" 2>/dev/null)
    case "$SU" in ''|*[!0-9]*) echo "snooze   none" ;;
      *) if [ "$SU" -gt "$(date +%s)" ]; then echo "snooze   maker checks held until $(date -u -d "@$SU" +%FT%TZ) (stack-watch.sh --snooze 0 ends it)"; else echo "snooze   none (the last one ended $(date -u -d "@$SU" +%FT%TZ))"; fi ;;
    esac
    # -o cat: the run's own lines carry their UTC time; journalctl's default format would print the machine's hostname
    journalctl --user -u "$U" -n 12 --no-pager -o cat 2>/dev/null | sed 's/^/  /'
    ;;
  uninstall)
    systemctl --user disable --now "$U.timer" >/dev/null 2>&1 || true
    systemctl --user stop "$U.service" >/dev/null 2>&1 || true
    rm -f "$UD/$U.service" "$UD/$U.timer"
    systemctl --user daemon-reload
    systemctl --user reset-failed "$U.service" "$U.timer" >/dev/null 2>&1 || true
    say "timer stopped and disabled; both units removed from $UD"
    if [ "$PURGE" = 1 ]; then
      case "$PKG/var/watch" in */var/watch) rm -rf "$PKG/var/watch"; say "var/watch/ deleted" ;; esac
    else say "var/watch/ kept (its alerts log and state); --purge deletes it"; fi
    ;;
esac
