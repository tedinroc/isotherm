# shellcheck shell=bash
# shellcheck disable=SC2034  # variables used by the scripts that source this file
# Shared by vps/push.sh, vps/cutover.sh and vps/rollback.sh, which run on the MAC (sourced, never run).
# Expects PKG (this checkout's packages/cre-workflow) and DEST (the VPS as an ssh destination or ~/.ssh/config alias).
# bash 3.2 compatible (macOS /bin/bash).
REPO=$(cd "$PKG/../.." && pwd)
VPS_DIR=${ISOTHERM_VPS_DIR:-isotherm}                 # on the VPS, relative to the user's home
VPS_PKG="$VPS_DIR/packages/cre-workflow"
SSH_OPTS=()
# shellcheck disable=SC2206
[ -n "${ISOTHERM_VPS_SSH_OPTS:-}" ] && SSH_OPTS=(${ISOTHERM_VPS_SSH_OPTS})   # e.g. "-F file" or "-p 2222"; split on spaces
vssh() { ssh -o ConnectTimeout=15 -o BatchMode=yes ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$DEST" "$@"; }
vps() { vssh "bash $VPS_PKG/vps/isotherm-vps.sh $*"; }   # the VPS helper; arguments are plain words
RT=${ISOTHERM_RUNTIME:-$HOME/isotherm-live}            # the Mac's runtime copy (launchd cannot read ~/Documents)
RTV="$RT/packages/cre-workflow/var"
LABEL=xyz.isotherm.cre-settle
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UIDN=$(id -u)
mac_job_loaded() { launchctl print "gui/$UIDN/$LABEL" >/dev/null 2>&1; }
# `launchctl disable` survives logins and reboots (unlike bootout); print-disabled shows "label" => disabled (or true)
mac_job_disabled() { launchctl print-disabled "gui/$UIDN" 2>/dev/null | grep -Eq "\"$LABEL\" => (disabled|true)"; }
mac_job_running() { pgrep -f 'cre-workflow/scripts/(settle-job|run-official)\.sh' >/dev/null 2>&1; }
LOGF=""
say() { echo "[$(date -u +%FT%TZ)] $*" | if [ -n "$LOGF" ]; then tee -a "$LOGF"; else cat; fi; }
GATES_FAILED=0
gate() { if [ "$1" = 1 ]; then say "GATE OK    $2: $3"; else say "GATE FAIL  $2: $3"; GATES_FAILED=$((GATES_FAILED + 1)); fi; }
jq_() { node -e 'try { const v = process.argv[2].split(".").reduce((o, k) => o?.[k], JSON.parse(process.argv[1])); if (v != null) console.log(typeof v === "object" ? JSON.stringify(v) : v) } catch {}' "$1" "$2"; }
sha_local() { (cd "$PKG" && shasum -a 256 "$@" | awk '{print $2 "=" $1}'); }
# files whose bytes must be equal on the Mac checkout and on the VPS before a cutover
CODE_FILES="scripts/run-official.sh scripts/settle-job.sh scripts/lib-don.sh settle/e2e/evidence-record.ts vps/settle-vps.sh vps/lib.sh vps/isotherm-vps.sh"
