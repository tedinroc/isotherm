#!/bin/bash
# Renders and (un)loads the two settlement LaunchAgents for THIS copy of the package:
#   xyz.isotherm.cre-settle       hourly at minute 05 -> scripts/settle-job.sh (official CRE path, else harness fallback)
#   xyz.isotherm.challenge-watch  every 120 s         -> scripts/challenge-watch.sh
# launchd-started bash/bun cannot read ~/Documents (macOS TCC, exit 126), so --load refuses a copy under ~/Documents,
# ~/Desktop or ~/Downloads. Use scripts/deploy-runtime.sh (copy to ~/isotherm-live, then --load from there).
#   scripts/install-launchd.sh            render to var/launchd/ + plutil -lint (no change to the Mac)
#   scripts/install-launchd.sh --load     render, copy to ~/Library/LaunchAgents, bootstrap both jobs, show status
#   scripts/install-launchd.sh --unload   bootout both jobs and remove their plists
#   scripts/install-launchd.sh --status   launchctl state, last exit, next run, latest evidence
# Test rendering (used by scripts/jobs-fork-e2e.sh): ISOTHERM_LAUNCHD_PREFIX (label prefix, default xyz.isotherm),
#   ISOTHERM_LAUNCHD_ENV ("K=V;K=V" extra environment), ISOTHERM_LAUNCHD_ONDEMAND=1 (no schedule; kickstart only),
#   ISOTHERM_LAUNCHD_OUT (render dir), ISOTHERM_LAUNCHD_LOGDIR.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
PREFIX=${ISOTHERM_LAUNCHD_PREFIX:-xyz.isotherm}
OUTDIR=${ISOTHERM_LAUNCHD_OUT:-$PKG/var/launchd}
LOGDIR=${ISOTHERM_LAUNCHD_LOGDIR:-$PKG/var/logs}
mkdir -p "$OUTDIR" "$LOGDIR"
UID_=$(id -u)
JOBS="cre-settle challenge-watch"

ENVXML=""
IFS=';' read -r -a KVS <<<"${ISOTHERM_LAUNCHD_ENV:-}"
for kv in ${KVS[@]+"${KVS[@]}"}; do
  [ -n "$kv" ] || continue
  ENVXML+="    <key>${kv%%=*}</key>"$'\n'"    <string>${kv#*=}</string>"$'\n'
done
export ENVXML
schedule() {
  if [ "${ISOTHERM_LAUNCHD_ONDEMAND:-0}" = 1 ]; then printf '  <key>RunAtLoad</key>\n  <false/>'; return; fi
  case "$1" in
    cre-settle) printf '  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Minute</key>\n    <integer>5</integer>\n  </dict>\n  <key>RunAtLoad</key>\n  <false/>' ;;
    challenge-watch) printf '  <key>StartInterval</key>\n  <integer>120</integer>\n  <key>RunAtLoad</key>\n  <true/>' ;;
  esac
}
render() {
  local job=$1 label="$PREFIX.$1" out="$OUTDIR/$PREFIX.$1.plist"
  SCHED=$(schedule "$job") LABEL=$label PKGP=$PKG HOMEP=$HOME LOGD=$LOGDIR \
    perl -0pe 's/__EXTRA_ENV__/$ENV{ENVXML}/g; s/__SCHEDULE__/$ENV{SCHED}/g; s/__LABEL__/$ENV{LABEL}/g; s/__PKG__/$ENV{PKGP}/g; s/__HOME__/$ENV{HOMEP}/g; s/__LOGDIR__/$ENV{LOGD}/g' \
    "launchd/xyz.isotherm.$job.plist.template" > "$out"
  plutil -lint "$out" >/dev/null
  echo "$out"
}
status() {
  for j in $JOBS; do
    local l="$PREFIX.$j"
    if ! launchctl print "gui/$UID_/$l" >/tmp/.isotherm-lc.$$ 2>&1; then echo "$l: NOT LOADED"; continue; fi
    echo "$l: $(grep -E $'^\t(state|runs|last exit code|run interval|program) =' /tmp/.isotherm-lc.$$ | sed 's/^[[:space:]]*//' | tr '\n' ';')$(grep -A0 '"Minute" =>' /tmp/.isotherm-lc.$$ | sed 's/^[[:space:]]*/ calendar: /')"
    rm -f /tmp/.isotherm-lc.$$
  done
  launchctl list | grep -E "$PREFIX\.(cre-settle|challenge-watch)" || true
  node -e '
    const n=new Date(); const s=new Date(n); s.setUTCSeconds(0,0); s.setUTCMinutes(5); if (s<=n) s.setUTCHours(s.getUTCHours()+1);
    console.log("next cre-settle run: "+s.toISOString()+" (every hour at :05; first settlement attempt for RCSS 2026-10-08 = 2026-10-08T18:05:00Z)");'
  local hb="$PKG/var/watch/heartbeat.json"
  [ -f "$hb" ] && node -e 'const h=require(process.argv[1]); const nx=new Date(Date.parse(h.at)+120e3); console.log("challenge-watch last pass "+h.at+" (head "+h.head+", "+h.guardian+"); next due ~"+nx.toISOString())' "$hb" || true
  [ -f "$PKG/var/evidence/LATEST.json" ] && node -e 'const r=require(process.argv[1]); console.log("latest settle run "+r.finishedAt+": path="+r.path+" exit="+r.exitCode+" ("+r.pathReason+")")' "$PKG/var/evidence/LATEST.json" || true
}

case "${1:-}" in
  --load)
    case "$PKG" in "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
      echo "refusing: launchd cannot read $PKG (macOS TCC, exit 126). Run scripts/deploy-runtime.sh --load from the repo." >&2; exit 1 ;; esac
    for j in $JOBS; do
      p=$(render "$j"); l="$PREFIX.$j"; dest="$HOME/Library/LaunchAgents/$l.plist"
      cp "$p" "$dest"
      launchctl bootout "gui/$UID_/$l" 2>/dev/null || true
      launchctl bootstrap "gui/$UID_" "$dest"
      echo "loaded $l from $dest"
    done
    status ;;
  --unload)
    for j in $JOBS; do l="$PREFIX.$j"; launchctl bootout "gui/$UID_/$l" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$l.plist"; echo "unloaded $l"; done ;;
  --status) status ;;
  "") for j in $JOBS; do render "$j"; done; echo "rendered (not installed). Install from the runtime copy: scripts/deploy-runtime.sh --load" ;;
  *) echo "usage: $0 [--load|--unload|--status]" >&2; exit 2 ;;
esac
