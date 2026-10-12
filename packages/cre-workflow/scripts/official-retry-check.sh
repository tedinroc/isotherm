#!/usr/bin/env bash
# TEST ONLY (0 MON, no network, no real key, no CRE session): the one-retry rules of scripts/run-official.sh, step 5
# (simulate stopped at the CLI's credential check) and step 1 (`cre whoami` failed once).
# The REAL run-official.sh and settle-job.sh (symlinked, so they resolve PKG to the scratch package) run from a scratch
# package whose .tools/bin holds shims, ahead of everything else on the scripts' own PATH:
#   cre    `version` v1.37.0; `whoami` OK, or per a case's whoami plan (one step per call, the last step repeats; a
#          failing call prints text that must stay out of every log); `workflow simulate` follows a per-case plan (one
#          step per call) and records its argv and whether the keys arrived through its environment (never their values)
#   cast   the preflight's chain reads and `cast nonce`, answered from files; any other call fails the case (exit 97)
#   sleep  records the seconds asked for (and whether run.lock was held and last-run stamped at that moment), then
#          waits 1 s (so a re-stamped last-run is visibly later)
# Scratch HOME, scratch state, a fresh random key (never printed; deleted at the end). Nothing reaches the network:
# no real CLI or cast runs, and HTTP(S)_PROXY points at a closed local port, so even a broken script under test that
# reached the receipt check (bun e2e/confirm.ts) would fail to connect instead of querying the live RPC.
#   R1 credential failure, then success           -> one retry after 45 s; identical argv; keys in env only; exit 0
#   R2 another failure (RPC check timed out)      -> no retry, exit 1
#   R3 credential failure twice                   -> exactly one retry, then exit 1
#   R4 credential failure after "Workflow compiled"          -> no retry
#   R5 credential failure and a "tx 0x<64 hex>" line         -> no retry
#   R6 credential failure and "Workflow Simulation Result"   -> no retry
#   R7 the tx sender's nonce moved during the wait, or could not be read -> no retry
#   R8 --no-broadcast: the retry repeats the dry command (no --broadcast either time)
#   R9 30-min spacing guard and lock: right after a retried run, and while run.lock is held, simulate is not called
#   R10 harness mode never retries; R11 the credential message with exit 0 -> no retry; R12 the message on stderr in
#      ANSI colour -> retried; R13 the second run's exit code is the script's; R14 a "[USER LOG]" line or an upper-case
#      tx hash -> no retry; R15 last-run cannot be re-stamped -> no retry; R16 a hung (20 s alarm) or non-decimal nonce
#      read before the run -> no retry
#   W1 cre whoami fails, then answers             -> one wait of 30 s (before the lock and the last-run stamp), the
#      identical check once more (after the wait, not before it), then the official path as usual; exit 0
#   W2 cre whoami fails twice                     -> exit 3 as before, after that one wait; nothing read on chain
#   W3 cre whoami answers at once                 -> no wait, no new line
#   W4 CRE_API_KEY set                            -> cre whoami never asked, no wait
#   W5 --preflight-only / --harness / --harness-if-no-login / a non-live RPC with --official, cre whoami failing ->
#      no wait (only a run that would exit 3 checks again)
#   W6 both retries in one run (whoami fails once, then simulate stops at the credential check once) -> 30 s, then 45 s
#   W7 cre whoami fails, then the 2nd check hangs -> bounded by the same 45 s alarm, exit 3
#   W8 the most one run waits: the 1st check hangs (45 s alarm: a CRE API timeout), the 2nd answers, then simulate
#      stops at the credential check twice -> waits exactly [30 45], two simulate calls, exit 1. On the server that is
#      at most 45 + 30 + 45 s for the login check (nothing held), then the 45 s retry wait under the lock, as before
#   J1/J2 the whole settle-job.sh: the evidence record after a retried run and after two credential failures; the
#         tripwire's and settle-job's own log patterns on those logs
#   J3/J4 settle-job.sh, then vps/lib.sh cre_login_watch (settle-vps.sh step 5b) on its evidence record: the job's
#         whoami answers but run-official.sh's first check fails, then answers -> official, NOT a miss (it clears a
#         previous single miss); both checks fail (twice in a row) -> exit 3, harness fallback, a miss each time, and
#         CRE LOGIN NEEDED on the second
#   D1 a report sent, its "tx 0x… ->" line dropped (the simulator stopped first; live 2026-10-11 18:05 UTC), its hash
#      only in the result JSON -> step 6 still checks its receipt (bun e2e/confirm.ts, a shim here) with that hash;
#      run-official.sh before scripts/sent-hashes.mjs (the newest committed one without it) checked nothing
#   D2 the same report with its "tx 0x… ->" line -> one receipt check, for that hash once
#   D3 a failed writeReport whose hash is in the result JSON -> no receipt check, as before
#   B  every case without a retry gives a run log identical (timestamps and scratch paths aside) to run-official.sh as
#      it was before the retry existed (the newest committed version without it), with the same exit code
#   B2 the same against the newest committed run-official.sh without the login-check retry: identical logs (and stdout)
#      for the W3-W5 cases; for W2 identical apart from the one new line, same exit 3
# Usage: scripts/official-retry-check.sh        Env: ISOTHERM_TEST_BASH (default /bin/bash), KEEP=1 keeps the scratch,
#   ISOTHERM_RETRY_CHECK_TARGET=<a copy of run-official.sh> tests that copy instead (to check that this test catches a
#   broken retry rule); its output goes to stdout only.
# Output: stdout and evidence/official-retry-check.txt (local paths replaced by <repo>, <scratch>, ~). Exit 0 = all pass.
set -uo pipefail
REAL="$(cd "$(dirname "$0")/.." && pwd)"; REPO=$(cd "$REAL/../.." && pwd)
TBASH=${ISOTHERM_TEST_BASH:-/bin/bash}
TARGET=${ISOTHERM_RETRY_CHECK_TARGET:-$REAL/scripts/run-official.sh}
EVOUT="$REAL/evidence/official-retry-check.txt"
SEARCH="$REAL/.tools/bin:$REAL/.tools/node_modules/.bin:$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.local/bin"
BUN=$(PATH=$SEARCH; command -v bun) || { echo "bun not found" >&2; exit 2; }
NODE=$(PATH=$SEARCH; command -v node) || { echo "node not found" >&2; exit 2; }
TMPBASE=${TMPDIR:-/tmp}; SC=$(mktemp -d "${TMPBASE%/}/isotherm-retry-check.XXXXXX"); SCP=$(cd "$SC" && pwd -P)
cleanup() { rm -rf "$SC/keys"; [ "${KEEP:-0}" = 1 ] || rm -rf "$SC"; }
trap cleanup EXIT
P="$SC/root/packages/cre-workflow"; BIN="$P/.tools/bin"
mkdir -p "$P/scripts" "$P/vps" "$BIN" "$SC/root/deployments" "$SC/home" "$SC/keys" "$SC/cases"
ln -s "$TARGET" "$P/scripts/run-official.sh"          # the code under test
ln -s "$REAL/scripts/settle-job.sh" "$P/scripts/settle-job.sh"
ln -s "$REAL/vps/lib.sh" "$P/vps/lib.sh"                                    # cre_login_watch (J3/J4)
ln -s "$REAL/scripts/sent-hashes.mjs" "$P/scripts/sent-hashes.mjs"          # step 6's hashes (D1-D3)
ln -s "$REAL/settle" "$P/settle"                                            # viem (key -> address), evidence-record.ts
ln -s "$REPO/deployments/testnet.json" "$SC/root/deployments/testnet.json"  # read only (addresses)
ln -s "$NODE" "$BIN/node"
# bun: the real one, except `bun test` (only the harness run uses it), which answers like a failed harness run whose
# output names the CRE credential check (R10: harness mode never retries), or, when the case has a file harness-ok,
# like a harness run that had nothing to settle (J4); and `bun e2e/confirm.ts` (step 6, the receipt check: D1-D3),
# which records its argv and answers OK without any network
cat >"$BIN/bun" <<EOF
#!/bin/bash
if [ "\${1:-}" = e2e/confirm.ts ]; then
  echo "bun \$*" >>"\${SHIM_DIR:?}/confirms"; shift 3
  for h in "\$@"; do echo "\$h block 1 status=success (shim receipt check)"; done; exit 0
fi
if [ "\${1:-}" = test ]; then
  echo "bun \$*" >>"\${SHIM_DIR:?}/bun-tests"
  if [ -f "\$SHIM_DIR/harness-ok" ]; then echo '[result] {"triggerTime":"2026-10-11T01:05:40.000Z","outcomes":[],"skipped":[],"ladders":{"count":1,"due":0}}'; exit 0; fi
  echo "✗ Credential validation failed (shim harness run)"; exit 1
fi
exec "$BUN" "\$@"
EOF
chmod +x "$BIN/bun"

# ---- baseline: the newest committed run-official.sh that has no retry
BASE_REF=""
for c in $(git -C "$REPO" log --format=%h -- packages/cre-workflow/scripts/run-official.sh 2>/dev/null); do
  case "$(git -C "$REPO" show "$c:packages/cre-workflow/scripts/run-official.sh")" in *credential_check_only*) ;; *) BASE_REF=$c; break ;; esac
done
[ -n "$BASE_REF" ] && git -C "$REPO" show "$BASE_REF:packages/cre-workflow/scripts/run-official.sh" >"$P/scripts/run-official.baseline.sh"
# ---- baseline 2: the newest committed run-official.sh without the login-check retry (B2)
BASE2_REF=""
for c in $(git -C "$REPO" log --format=%h -- packages/cre-workflow/scripts/run-official.sh 2>/dev/null); do
  case "$(git -C "$REPO" show "$c:packages/cre-workflow/scripts/run-official.sh")" in *'CRE login check:'*) ;; *) BASE2_REF=$c; break ;; esac
done
[ -n "$BASE2_REF" ] && git -C "$REPO" show "$BASE2_REF:packages/cre-workflow/scripts/run-official.sh" >"$P/scripts/run-official.baseline2.sh"

# ---- baseline 3: the newest committed run-official.sh without scripts/sent-hashes.mjs (D1)
BASE3_REF=""
for c in $(git -C "$REPO" log --format=%h -- packages/cre-workflow/scripts/run-official.sh 2>/dev/null); do
  case "$(git -C "$REPO" show "$c:packages/cre-workflow/scripts/run-official.sh")" in *sent-hashes.mjs*) ;; *) BASE3_REF=$c; break ;; esac
done
[ -n "$BASE3_REF" ] && git -C "$REPO" show "$BASE3_REF:packages/cre-workflow/scripts/run-official.sh" >"$P/scripts/run-official.baseline3.sh"

# ---- shims
cat >"$BIN/cre" <<'EOF'
#!/bin/bash
# TEST shim of the CRE CLI v1.37.0: no network, never reads or writes ~/.cre
D=${SHIM_DIR:?}
case "$1 ${2:-}" in
  "version "*) echo "CRE CLI version v1.37.0"; exit 0 ;;
  "whoami "*)
    n=$(( $(cat "$D/whoami-n" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$D/whoami-n"
    s=ok; if [ -f "$D/whoami-plan" ]; then s=$(awk -F, -v n="$n" '{ i = (n <= NF) ? n : NF; print $i }' "$D/whoami-plan"); fi
    echo "whoami#$n argv=[$*] -> $s" >>"$D/whoami-calls"
    w=0; [ -f "$D/sleeps" ] && w=$(wc -l <"$D/sleeps" | tr -d ' ')
    echo "whoami#$n after $w wait(s)" >>"$D/whoami-waits"   # the waits (sleep shim calls) before this check
    [ "$s" = ok ] && exit 0
    [ "$s" = hang ] && exec /bin/sleep 90   # a CRE API that never answers: only the caller's perl alarm ends it
    echo "shim-whoami-output: not logged in"; echo "shim-whoami-output: stderr" >&2; exit 1 ;;
  "workflow simulate") ;;
  *) echo "shim cre: unexpected: $*" >&2; exit 97 ;;
esac
n=$(( $(cat "$D/attempts" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$D/attempts"
k=$(tr -d '[:space:]' <"$SHIM_KEYFILE")
tx=missing; [ -n "${CRE_ETH_PRIVATE_KEY:-}" ] && { tx=other; [ "$CRE_ETH_PRIVATE_KEY" = "$k" ] && tx=the-key-file; }
at=missing; [ -n "${ISOTHERM_ATTESTER_KEY_ALL:-}" ] && { at=other; [ "$ISOTHERM_ATTESTER_KEY_ALL" = "$k" ] && at=the-key-file; }
inargv=no; case " $* " in *"$k"*) inargv=YES ;; esac
unset k
echo "simulate#$n argv=[$*] env:CRE_ETH_PRIVATE_KEY=$tx env:ISOTHERM_ATTESTER_KEY_ALL=$at key-in-argv=$inargv last-run=$(cat "$ISOTHERM_STATE_DIR/last-run" 2>/dev/null)" >>"$D/calls"
cred() {
  echo "✗ Credential validation failed"
  echo "✗ authentication required: credential validation failed: authentication failed: unable to retrieve organization info. Your account may not be fully set up yet — please try again in a few minutes: Post \"https://api.cre.chain.link/graphql\": context deadline exceeded"
}
compiled() { echo "Checking RPC connectivity..."; echo "Compiling workflow..."; echo "✓ Workflow compiled"; }
echo "Initializing..."; echo "Loading settings..."
case "$(awk -F, -v n="$n" '{print $n}' "$D/plan")" in
  cred) cred; exit 1 ;;
  other) echo "Checking RPC connectivity..."; echo "✗ RPC connectivity check failed: Post \"https://testnet-rpc.monad.xyz\": context deadline exceeded"; exit 1 ;;
  cred-after-compile) compiled; cred; exit 1 ;;
  cred-tx) cred; echo "RCSS 2026-10-09: tx 0x$(printf 'ab%.0s' $(seq 1 32)) -> resolved"; exit 1 ;;
  cred-result) cred; echo "✓ Workflow Simulation Result:"; echo '"{}"'; exit 1 ;;
  cred-rc0) cred; exit 0 ;;
  cred-stderr) { printf '\033[31m✗ Credential validation failed\033[0m\n'; printf '\033[31m✗ authentication required: credential validation failed: context deadline exceeded\033[0m\n'; } >&2; exit 1 ;;
  fail5) echo "✗ some other failure"; exit 5 ;;
  cred-userlog) cred; echo "2026-10-10T09:06:02Z [USER LOG] nothing to settle (ladders=1, due=0, skipped=0)"; exit 1 ;;
  cred-txupper) cred; echo "tx 0x$(printf 'AB%.0s' $(seq 1 32))"; exit 1 ;;
  cred-breakstamp) cred; rm -f "$ISOTHERM_STATE_DIR/last-run"; mkdir "$ISOTHERM_STATE_DIR/last-run"; exit 1 ;;
  sent-noline|sent-line|wr-failed) compiled   # D1-D3: one report; the hash 0xcdcd…, or 0xefef… for the failed one
      H=0x$(printf 'cd%.0s' $(seq 1 32)); R="primary sources agree"; C=resolved
      echo "2026-10-11T18:05:23Z [SIMULATION] Simulator Initialized"
      echo "2026-10-11T18:05:26Z [USER LOG] RCSS 2026-10-11: SETTLED (primary sources agree) | IEM 30C n=42 h=24 last=23:30 complete"
      case "$(awk -F, -v n="$n" '{print $n}' "$D/plan")" in
        sent-line) echo "2026-10-11T18:05:27Z [USER LOG] RCSS 2026-10-11: tx $H -> resolved" ;;
        wr-failed) H=0x$(printf 'ef%.0s' $(seq 1 32)); R="writeReport status 2: execution reverted"; C=not-accepted
                   echo "2026-10-11T18:05:27Z [USER LOG] RCSS 2026-10-11: writeReport 2 execution reverted" ;;
      esac
      echo; echo "✓ Workflow Simulation Result:"
      echo "\"{\\\"triggerTime\\\":\\\"2026-10-11T18:05:23.000Z\\\",\\\"outcomes\\\":[{\\\"station\\\":\\\"RCSS\\\",\\\"date\\\":20261011,\\\"action\\\":\\\"settled\\\",\\\"reason\\\":\\\"$R\\\",\\\"tmaxC\\\":30,\\\"txHash\\\":\\\"$H\\\",\\\"confirmed\\\":\\\"$C\\\"}],\\\"skipped\\\":[]}\""
      echo "time=2026-10-11T18:05:27.652Z level=INFO msg=\"context canceled\""
      echo; exit 0 ;;
  ok) compiled
      echo "2026-10-10T09:06:01Z [SIMULATION] Simulator Initialized"
      echo "2026-10-10T09:06:02Z [USER LOG] nothing to settle (ladders=1, due=0, skipped=0)"
      echo; echo "✓ Workflow Simulation Result:"
      echo '"{\"triggerTime\":\"2026-10-10T09:06:01.000Z\",\"outcomes\":[],\"skipped\":[],\"budget\":{\"http\":\"0/15\",\"evmReads\":\"2/15\",\"reports\":\"0/5\"},\"ladders\":{\"count\":1,\"scanned\":[0,1],\"due\":0}}"'
      echo; exit 0 ;;
  *) echo "shim cre: no plan step $n" >&2; exit 98 ;;
esac
EOF
cat >"$BIN/cast" <<'EOF'
#!/bin/bash
# TEST shim of Foundry's cast: the preflight's reads and the nonce, from files; anything else fails the case
D=${SHIM_DIR:?}; echo "cast $1 ${3:-}" >>"$D/cast-calls"
case "$1" in
  chain-id) echo 10143 ;;
  call) case "$3" in
          'attester()(address)') echo "$SHIM_ATTESTER" ;;
          'forwarder()(address)') echo "$SHIM_FORWARDER" ;;
          'paused()(bool)') echo false ;;
          'ladderCount()(uint256)') echo 1 ;;
          *) echo "shim cast: unexpected: $*" >&2; exit 97 ;;
        esac ;;
  balance) echo 400000000000000000 ;;
  from-wei) echo 0.400000000000000000 ;;
  nonce) n=$(( $(cat "$D/nonce-reads" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$D/nonce-reads"
         v=$(sed -n "${n}p" "$D/nonce-plan"); [ -n "$v" ] || v=$(tail -n1 "$D/nonce-plan")
         [ "$v" = fail ] && { echo "shim cast: RPC error" >&2; exit 1; }
         [ "$v" = hang ] && exec /bin/sleep 30   # an RPC that never answers: only the caller's perl alarm ends it
         echo "$v" ;;
  *) echo "shim cast: unexpected: $*" >&2; exit 97 ;;
esac
EOF
cat >"$BIN/sleep" <<'EOF'
#!/bin/bash
# TEST shim of sleep: records the seconds asked for (and the lock and last-run at that moment), waits 1 s
echo "$*" >>"${SHIM_DIR:?}/sleeps"
S=${ISOTHERM_STATE_DIR:-/nonexistent}
echo "$* run.lock=$([ -d "$S/run.lock" ] && echo held || echo free) last-run=$([ -f "$S/last-run" ] && echo stamped || echo none)" >>"$SHIM_DIR/sleep-state"
/bin/sleep 1
EOF
chmod +x "$BIN/cre" "$BIN/cast" "$BIN/sleep"

# ---- a fresh random key (never printed) and the addresses the shims answer with
"$NODE" -e 'process.stdout.write("0x" + require("crypto").randomBytes(32).toString("hex"))' >"$SC/keys/attester.key"; chmod 600 "$SC/keys/attester.key"
ADDR=$(cd "$REAL/settle" && KEYFILE="$SC/keys/attester.key" "$BUN" -e 'import {privateKeyToAccount} from "viem/accounts"; console.log(privateKeyToAccount(require("fs").readFileSync(process.env.KEYFILE, "utf8").trim()).address)')
FWD=$("$NODE" -e 'console.log(require(process.argv[1]).mockForwarder)' "$REPO/deployments/testnet.json")

PASS=0; FAIL=0
ok() { if [ "$1" = 1 ]; then PASS=$((PASS + 1)); echo "  PASS  $2"; else FAIL=$((FAIL + 1)); echo "  FAIL  $2"; fi; }
# setup_case <name> <plan> <nonce plan, e.g. "7 7">: fresh state and shim records
setup_case() { C="$SC/cases/$1"; rm -rf "$C"; mkdir -p "$C/state" "$C/shim"; echo "$2" >"$C/shim/plan"; printf '%s\n' $3 >"$C/shim/nonce-plan"; }
caseenv() { env -i HOME="$SC/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="${TMPDIR:-/tmp}" \
  HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 \
  SHIM_DIR="$C/shim" SHIM_KEYFILE="$SC/keys/attester.key" SHIM_ATTESTER="$ADDR" SHIM_FORWARDER="$FWD" \
  ISOTHERM_RUNTIME="$SC/no-runtime" ISOTHERM_STATE_DIR="$C/state" ISOTHERM_ATTESTER_KEY_FILE="$SC/keys/attester.key" "$@"; }
# runoff current|baseline|baseline2 <args>: the real run-official.sh (or a baseline) for case $C, with RUNENV (one
# NAME=VALUE, or empty) added to its environment; exit code in RC, log in RUNLOG
RUNENV=""
runoff() {
  local s="run-official.sh"; case "$1" in baseline) s="run-official.baseline.sh" ;; baseline2) s="run-official.baseline2.sh" ;; baseline3) s="run-official.baseline3.sh" ;; esac; shift
  caseenv ${RUNENV:+"$RUNENV"} "$TBASH" "$P/scripts/$s" "$@" >"$C/stdout" 2>&1; RC=$?
  RUNLOG=$(ls -t "$C/state/logs"/run-*.log 2>/dev/null | head -n1)
}
attempts() { cat "$C/shim/attempts" 2>/dev/null || echo 0; }
whoamis() { cat "$C/shim/whoami-n" 2>/dev/null || echo 0; }
whoami_waits() { [ -f "$C/shim/whoami-waits" ] && tr '\n' ';' <"$C/shim/whoami-waits" | sed 's/;$//'; }
sleeps() { [ -f "$C/shim/sleeps" ] && tr '\n' ' ' <"$C/shim/sleeps" | sed 's/ $//'; }
count() { grep -c -- "$1" "$RUNLOG" 2>/dev/null || true; }
san() { sed -e "s#$SCP#<scratch>#g" -e "s#$SC#<scratch>#g" -e "s#$REPO#<repo>#g" -e "s#$HOME#~#g"; }
norm() { sed -E -e 's/^\[[0-9T:-]+Z\] /[T] /' -e 's#run-[0-9]{8}T[0-9]{6}Z\.log#run-<ts>.log#' -e "s#$SCP#<scratch>#g" -e "s#$SC#<scratch>#g" -e 's#<scratch>/cases/[^/]+/#<case>/#g' "$1"; }
show_calls() { sed 's/^/    | /' "$C/shim/calls" 2>/dev/null; }
no_retry_checks() { # <label>: one simulate call, no wait, no retry line, "run exited 1", lock released
  ok "$([ "$RC" = 1 ] && [ "$(attempts)" = 1 ] && [ -z "$(sleeps)" ] && [ "$(count 'OFFICIAL retry:')" = 0 ] && [ "$(count 'run exited 1')" = 1 ] && [ ! -d "$C/state/run.lock" ] && echo 1 || echo 0)" \
    "$1: exit $RC, simulate calls $(attempts), waits [$(sleeps)], retry lines $(count 'OFFICIAL retry:'), lock released"
}
BASELINE_CASES=""

{
echo "# $(date -u +%FT%TZ) run-official.sh one-retry check: $("$TBASH" -c 'echo bash $BASH_VERSION') on $(uname -s) $(uname -m); shims for cre, cast, sleep; no network, no real key, 0 MON"
echo "# scratch package <scratch>/root/packages/cre-workflow (scripts/ symlinked to the code under test); tx sender $ADDR (fresh random key); baseline: run-official.sh at ${BASE_REF:-<none found>}; baseline 2 (no login-check retry): ${BASE2_REF:-<none found>}; baseline 3 (no sent-hashes.mjs): ${BASE3_REF:-<none found>}"

echo; echo "## R1. credential failure, then success: one retry after 45 s"
setup_case r1 cred,ok "7 7"; runoff current --official
ok "$([ "$RC" = 0 ] && echo 1 || echo 0)" "exit $RC"
ok "$([ "$(attempts)" = 2 ] && echo 1 || echo 0)" "simulate called $(attempts) times"
ok "$([ "$(sleeps)" = 45 ] && echo 1 || echo 0)" "one wait of [$(sleeps)] s"
ok "$([ "$(cat "$C/shim/nonce-reads")" = 2 ] && echo 1 || echo 0)" "tx sender nonce read $(cat "$C/shim/nonce-reads") times (before the first run, after the wait)"
A1=$(sed -n 1p "$C/shim/calls" | sed -E 's/^simulate#1 (argv=\[[^]]*\]).*/\1/'); A2=$(sed -n 2p "$C/shim/calls" | sed -E 's/^simulate#2 (argv=\[[^]]*\]).*/\1/')
ok "$([ "$A1" = "$A2" ] && [ "$A1" = "argv=[workflow simulate ./settle -T testnet --non-interactive --trigger-index 2 --broadcast]" ] && echo 1 || echo 0)" "identical command both times: $A2"
ok "$([ "$(grep -c 'env:CRE_ETH_PRIVATE_KEY=the-key-file env:ISOTHERM_ATTESTER_KEY_ALL=the-key-file key-in-argv=no' "$C/shim/calls")" = 2 ] && echo 1 || echo 0)" "both runs got both keys through the environment, neither in argv"
L1=$(sed -n 1p "$C/shim/calls" | grep -oE 'last-run=[0-9]+$' | cut -d= -f2); L2=$(sed -n 2p "$C/shim/calls" | grep -oE 'last-run=[0-9]+$' | cut -d= -f2)
ok "$([ -n "$L1" ] && [ "${L2:-0}" -gt "$L1" ] && [ "$(cat "$C/state/last-run")" = "$L2" ] && echo 1 || echo 0)" "last-run stamped again before the retry ($L1 -> $L2; the spacing guard counts from the run that can sign)"
ok "$([ "$(count 'OFFICIAL: cre workflow simulate')" = 1 ] && [ "$(count 'OFFICIAL retry:')" = 1 ] && [ "$(count 'run exited')" = 0 ] && [ "$(count 'done; log:')" = 1 ] && echo 1 || echo 0)" "log: one OFFICIAL line, one retry line, no 'run exited', 'done'"
ok "$([ "$(grep -n 'Credential validation failed' "$RUNLOG" | head -n1 | cut -d: -f1)" -lt "$(grep -n 'OFFICIAL retry:' "$RUNLOG" | cut -d: -f1)" ] && [ "$(grep -n 'OFFICIAL retry:' "$RUNLOG" | cut -d: -f1)" -lt "$(grep -n 'Workflow compiled' "$RUNLOG" | cut -d: -f1)" ] && echo 1 || echo 0)" "order: failure, retry line, second run"
ok "$([ ! -d "$C/state/run.lock" ] && echo 1 || echo 0)" "lock released"
RL=$(grep 'OFFICIAL retry:' "$RUNLOG" | sed 's/^\[[^]]*\] //')
ok "$(! grep -qE '^SKIPPED:|run exited|tx 0x[0-9a-fA-F]{64}|\[USER LOG\]|send-report failed|: writeReport |-> not-accepted|tx sender 0x[0-9a-fA-F]{40} has|Simulation Result|^\[result\] |^\[TEST\] |Credential validation failed' <<<"$RL" && echo 1 || echo 0)" \
  "the new line matches none of the patterns that run-official, settle-job, settle-vps and evidence-record parse"
echo "  the run log:"; san <"$RUNLOG" | sed 's/^/    | /'
echo "  what the shim CLI received (key values never recorded):"; show_calls | san

echo; echo "## R2. another failure (the RPC connectivity check timed out): no retry"
setup_case r2 other "7 7"; runoff current --official
no_retry_checks "no retry"; BASELINE_CASES="$BASELINE_CASES r2:other"

echo; echo "## R3. credential failure twice: exactly one retry, then the exit code of the second run"
setup_case r3 cred,cred,ok "7 7"; runoff current --official
ok "$([ "$RC" = 1 ] && [ "$(attempts)" = 2 ] && [ "$(sleeps)" = 45 ] && [ "$(count 'OFFICIAL retry:')" = 1 ] && [ "$(count 'run exited 1')" = 1 ] && [ "$(count 'Credential validation failed')" = 2 ] && [ ! -d "$C/state/run.lock" ] && echo 1 || echo 0)" \
  "exit $RC after $(attempts) simulate calls (the plan had a third, successful step), waits [$(sleeps)], retry lines $(count 'OFFICIAL retry:'), lock released"
echo "  the run log from the retry line on:"; sed -n '/OFFICIAL retry:/,$p' "$RUNLOG" | san | sed 's/^/    | /'

echo; echo "## R4. credential failure after \"Workflow compiled\": no retry"
setup_case r4 cred-after-compile,ok "7 7"; runoff current --official
no_retry_checks "no retry"; BASELINE_CASES="$BASELINE_CASES r4:cred-after-compile,ok"

echo; echo "## R5. credential failure and a \"tx 0x<64 hex>\" line (no compile line): no retry"
setup_case r5 cred-tx,ok "7 7"; runoff current --official
no_retry_checks "no retry"; BASELINE_CASES="$BASELINE_CASES r5:cred-tx,ok"

echo; echo "## R6. credential failure and \"Workflow Simulation Result\": no retry"
setup_case r6 cred-result,ok "7 7"; runoff current --official
no_retry_checks "no retry"; BASELINE_CASES="$BASELINE_CASES r6:cred-result,ok"

echo; echo "## R7. the tx sender's nonce: moved during the wait / unreadable after the wait / unreadable before the run"
setup_case r7a cred,ok "7 8"; runoff current --official
ok "$([ "$RC" = 1 ] && [ "$(attempts)" = 1 ] && [ "$(sleeps)" = 45 ] && [ "$(count 'OFFICIAL retry:')" = 0 ] && [ "$(count 'run exited 1')" = 1 ] && echo 1 || echo 0)" "7 -> 8: waited [$(sleeps)], no retry (simulate calls $(attempts)), exit $RC"
setup_case r7b cred,ok "7 fail"; runoff current --official
ok "$([ "$RC" = 1 ] && [ "$(attempts)" = 1 ] && [ "$(count 'OFFICIAL retry:')" = 0 ] && echo 1 || echo 0)" "7 -> RPC error: no retry (simulate calls $(attempts)), exit $RC"
setup_case r7c cred,ok "fail 7"; runoff current --official
no_retry_checks "RPC error before the run"
BASELINE_CASES="$BASELINE_CASES r7a:cred,ok:7_8 r7c:cred,ok:fail_7"

echo; echo "## R8. --no-broadcast: the retry repeats the dry command"
setup_case r8 cred,ok "7 7"; runoff current --official --no-broadcast
ok "$([ "$RC" = 0 ] && [ "$(attempts)" = 2 ] && [ "$(grep -c 'argv=\[workflow simulate ./settle -T testnet --non-interactive --trigger-index 2\] ' "$C/shim/calls")" = 2 ] && echo 1 || echo 0)" "exit $RC, $(attempts) calls, neither with --broadcast"

echo; echo "## R9. the 30-min spacing guard and the lock"
C="$SC/cases/r1"; echo 7 >"$C/shim/nonce-plan"; rm -f "$C/shim/nonce-reads"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(attempts)" = 2 ] && grep -q '(< 1800 s spacing); skipping' "$RUNLOG" && echo 1 || echo 0)" "right after R1's retried run, same state: '$(grep 'spacing); skipping' "$RUNLOG" | sed 's/^\[[^]]*\] //')', simulate not called"
setup_case r9 cred,ok "7 7"; mkdir "$C/state/run.lock"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(attempts)" = 0 ] && grep -q 'another run holds' "$RUNLOG" && [ -d "$C/state/run.lock" ] && echo 1 || echo 0)" "while another run holds run.lock: skipped, simulate not called, the other run's lock left alone"
BASELINE_CASES="$BASELINE_CASES r0:ok"

echo; echo "## R10. harness mode: a failed harness run whose output names the credential check is never retried"
setup_case r10 ok "7 7"; runoff current --harness
bun_runs() { if [ -f "$C/shim/bun-tests" ]; then wc -l <"$C/shim/bun-tests" | tr -d ' '; else echo 0; fi; }
ok "$([ "$RC" = 1 ] && [ "$(bun_runs)" = 1 ] && [ "$(attempts)" = 0 ] && [ -z "$(sleeps)" ] && ! grep -q '^cast nonce' "$C/shim/cast-calls" && [ "$(count 'OFFICIAL retry:')" = 0 ] && [ "$(count 'run exited 1')" = 1 ] && echo 1 || echo 0)" \
  "exit $RC, harness runs $(bun_runs), simulate calls $(attempts), waits [$(sleeps)], nonce reads $(grep -c '^cast nonce' "$C/shim/cast-calls")"

echo; echo "## R11. the credential message but exit 0: no retry, the run completes as before"
setup_case r11 cred-rc0 "7 7"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(attempts)" = 1 ] && [ -z "$(sleeps)" ] && [ "$(count 'OFFICIAL retry:')" = 0 ] && [ "$(count 'done; log:')" = 1 ] && echo 1 || echo 0)" "exit $RC, simulate calls $(attempts), waits [$(sleeps)], 'done'"
BASELINE_CASES="$BASELINE_CASES r11:cred-rc0"

echo; echo "## R12. the credential failure on stderr, in ANSI colour: still recognised (2>&1 into the log), one retry"
setup_case r12 cred-stderr,ok "7 7"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(attempts)" = 2 ] && [ "$(sleeps)" = 45 ] && [ "$(count 'OFFICIAL retry:')" = 1 ] && grep -q $'\033\\[31m✗ Credential validation failed' "$RUNLOG" && echo 1 || echo 0)" "exit $RC, simulate calls $(attempts), waits [$(sleeps)], the coloured line is in the run log"

echo; echo "## R13. credential failure, then a different failure (exit 5): the script exits with the SECOND run's code"
setup_case r13 cred,fail5 "7 7"; runoff current --official
ok "$([ "$RC" = 5 ] && [ "$(attempts)" = 2 ] && [ "$(count 'run exited 5')" = 1 ] && [ "$(count 'run exited 1')" = 0 ] && echo 1 || echo 0)" "exit $RC, simulate calls $(attempts), '$(grep 'run exited' "$RUNLOG" | sed 's/^\[[^]]*\] //')'"

echo; echo "## R14. credential failure plus a \"[USER LOG]\" line / plus an upper-case \"tx 0x<64 HEX>\" (no compile line): no retry"
setup_case r14a cred-userlog,ok "7 7"; runoff current --official
no_retry_checks "[USER LOG]"
setup_case r14b cred-txupper,ok "7 7"; runoff current --official
no_retry_checks "tx 0x<64 HEX>"
BASELINE_CASES="$BASELINE_CASES r14a:cred-userlog,ok r14b:cred-txupper,ok"

echo; echo "## R15. last-run cannot be stamped again before the retry: no retry"
setup_case r15 cred-breakstamp,ok "7 7"; runoff current --official
ok "$([ "$RC" = 1 ] && [ "$(attempts)" = 1 ] && [ "$(sleeps)" = 45 ] && [ "$(count 'OFFICIAL retry:')" = 0 ] && [ "$(count 'run exited 1')" = 1 ] && [ ! -d "$C/state/run.lock" ] && echo 1 || echo 0)" "exit $RC, simulate calls $(attempts), waits [$(sleeps)], lock released"

echo; echo "## R16. the nonce read before the run hangs (bounded at 20 s) / answers something that is not a decimal: no retry"
setup_case r16a cred,ok "hang 7"; T0=$(date +%s); runoff current --official; EL=$(( $(date +%s) - T0 ))
ok "$([ "$RC" = 1 ] && [ "$(attempts)" = 1 ] && [ -z "$(sleeps)" ] && [ "$EL" -ge 19 ] && [ "$EL" -lt 29 ] && [ "$(count 'OFFICIAL retry:')" = 0 ] && echo 1 || echo 0)" "exit $RC after $EL s (the 20 s alarm, not the 30 s hang), simulate calls $(attempts), waits [$(sleeps)]"
setup_case r16b cred,ok "0x7 7"; runoff current --official
no_retry_checks "nonce answer 0x7"
BASELINE_CASES="$BASELINE_CASES r16b:cred,ok:0x7_7"

echo; echo "## W1. cre whoami fails, then answers: one wait of 30 s, the identical check once more, then the official path"
setup_case w1 ok "7 7"; echo fail,ok >"$C/shim/whoami-plan"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(whoamis)" = 2 ] && [ "$(sleeps)" = 30 ] && [ "$(attempts)" = 1 ] && echo 1 || echo 0)" "exit $RC, cre whoami asked $(whoamis) times, waits [$(sleeps)], simulate calls $(attempts)"
ok "$([ "$(grep -c '^whoami#[12] argv=\[whoami\] -> ' "$C/shim/whoami-calls")" = 2 ] && echo 1 || echo 0)" "the identical check both times: $(sed 's/^whoami#[0-9]* //' "$C/shim/whoami-calls" | tr '\n' ';' | sed 's/;$//')"
ok "$([ "$(cat "$C/shim/sleep-state")" = "30 run.lock=free last-run=none" ] && echo 1 || echo 0)" "during the wait: $(cat "$C/shim/sleep-state") (before the lock and the last-run stamp)"
ok "$([ "$(whoami_waits)" = "whoami#1 after 0 wait(s);whoami#2 after 1 wait(s)" ] && echo 1 || echo 0)" "the wait comes between the two checks: $(whoami_waits)"
ok "$([ "$(count 'CRE login check:')" = 1 ] && [ "$(count 'NOT LOGGED IN')" = 0 ] && [ "$(count 'mode=official rpc=https://testnet-rpc.monad.xyz cre-login=yes broadcast=1')" = 1 ] && [ "$(count 'OFFICIAL: cre workflow simulate')" = 1 ] && [ "$(count 'done; log:')" = 1 ] && echo 1 || echo 0)" "log: one new line, then 'mode=official ... cre-login=yes', one OFFICIAL line, 'done'"
ok "$([ "$(grep -n 'CRE login check:' "$RUNLOG" | cut -d: -f1)" -lt "$(grep -n 'mode=official' "$RUNLOG" | cut -d: -f1)" ] && [ -f "$C/state/last-run" ] && [ ! -d "$C/state/run.lock" ] && echo 1 || echo 0)" "order: the new line before the mode line; last-run stamped by the run, lock released"
ok "$(! grep -q 'shim-whoami-output' "$RUNLOG" "$C/stdout" && echo 1 || echo 0)" "cre whoami's own output stays out of the run log and stdout, both checks"
WL=$(grep 'CRE login check:' "$RUNLOG" | sed 's/^\[[^]]*\] //')
ok "$(! grep -qE '^SKIPPED:|run exited|tx 0x[0-9a-fA-F]{64}|\[USER LOG\]|send-report failed|: writeReport |-> not-accepted|tx sender 0x[0-9a-fA-F]{40} has|Simulation Result|^\[result\] |^\[TEST\] |Credential validation failed|OFFICIAL retry:|NOT LOGGED IN|reported no login|\[settle-job\]|\[vps\]' <<<"$WL" && echo 1 || echo 0)" \
  "the new line matches none of the patterns that run-official, settle-job, settle-vps, lib.sh and evidence-record parse"
echo "  the run log:"; san <"$RUNLOG" | sed 's/^/    | /'

echo; echo "## W2. cre whoami fails twice: exit 3 exactly as before, after that one wait"
setup_case w2 ok "7 7"; echo fail >"$C/shim/whoami-plan"; runoff current --official
ok "$([ "$RC" = 3 ] && [ "$(whoamis)" = 2 ] && [ "$(sleeps)" = 30 ] && [ "$(attempts)" = 0 ] && echo 1 || echo 0)" "exit $RC, cre whoami asked $(whoamis) times, waits [$(sleeps)], simulate calls $(attempts)"
ok "$([ "$(count 'CRE login check:')" = 1 ] && [ "$(count '^NOT LOGGED IN TO CRE.')" = 1 ] && [ "$(count 'mode=')" = 0 ] && [ ! -e "$C/state/last-run" ] && [ ! -d "$C/state/run.lock" ] && [ ! -f "$C/shim/cast-calls" ] && echo 1 || echo 0)" "one new line, then the NOT LOGGED IN steps; no last-run stamp, no lock, nothing read on chain"
ok "$(! grep -q 'shim-whoami-output' "$RUNLOG" "$C/stdout" && echo 1 || echo 0)" "cre whoami's own output stays out of the run log and stdout"
echo "  the run log:"; san <"$RUNLOG" | sed 's/^/    | /'

echo; echo "## W3. cre whoami answers at once: no wait, no new line"
setup_case w3 ok "7 7"; echo ok >"$C/shim/whoami-plan"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(whoamis)" = 1 ] && [ -z "$(sleeps)" ] && [ "$(count 'CRE login check:')" = 0 ] && [ "$(attempts)" = 1 ] && echo 1 || echo 0)" "exit $RC, cre whoami asked $(whoamis) time, waits [$(sleeps)], new lines $(count 'CRE login check:')"

echo; echo "## W4. CRE_API_KEY set: cre whoami is never asked, no wait (as before)"
setup_case w4 ok "7 7"; echo fail >"$C/shim/whoami-plan"; RUNENV="CRE_API_KEY=test-only-not-a-key"; runoff current --official; RUNENV=""
ok "$([ "$RC" = 0 ] && [ "$(whoamis)" = 0 ] && [ -z "$(sleeps)" ] && [ "$(count 'CRE login check:')" = 0 ] && [ "$(count 'cre-login=yes')" = 1 ] && echo 1 || echo 0)" "exit $RC, cre whoami asked $(whoamis) times, waits [$(sleeps)], 'cre-login=yes'"

echo; echo "## W5. cre whoami failing, in runs that never exit 3: no wait, no new line"
setup_case w5a ok "7 7"; echo fail >"$C/shim/whoami-plan"; runoff current --official --preflight-only
ok "$([ "$RC" = 0 ] && [ "$(whoamis)" = 1 ] && [ -z "$(sleeps)" ] && [ "$(count 'CRE login check:')" = 0 ] && [ "$(count 'preflight OK')" = 1 ] && [ "$(count 'cre-login=no')" = 1 ] && echo 1 || echo 0)" "--official --preflight-only: exit $RC, whoami $(whoamis), waits [$(sleeps)], 'preflight OK' with cre-login=no"
setup_case w5b ok "7 7"; echo fail >"$C/shim/whoami-plan"; runoff current --harness
ok "$([ "$RC" = 1 ] && [ "$(whoamis)" = 1 ] && [ -z "$(sleeps)" ] && [ "$(count 'CRE login check:')" = 0 ] && [ "$(count 'mode=harness')" = 1 ] && echo 1 || echo 0)" "--harness: exit $RC (the shim harness run fails), whoami $(whoamis), waits [$(sleeps)]"
setup_case w5c ok "7 7"; echo fail >"$C/shim/whoami-plan"; runoff current --harness-if-no-login
ok "$([ "$RC" = 1 ] && [ "$(whoamis)" = 1 ] && [ -z "$(sleeps)" ] && [ "$(count 'CRE login check:')" = 0 ] && [ "$(count 'mode=harness')" = 1 ] && [ "$(attempts)" = 0 ] && echo 1 || echo 0)" "--harness-if-no-login: harness at once as before, exit $RC, whoami $(whoamis), waits [$(sleeps)]"
setup_case w5d ok "7 7"; echo fail >"$C/shim/whoami-plan"; RUNENV="ISOTHERM_RPC=http://127.0.0.1:9"; runoff current --official; RUNENV=""
ok "$([ "$RC" = 2 ] && [ "$(whoamis)" = 1 ] && [ -z "$(sleeps)" ] && [ "$(count 'CRE login check:')" = 0 ] && [ "$(count 'official mode always uses the -T testnet target')" = 1 ] && echo 1 || echo 0)" "--official with a non-live RPC: refused (exit $RC) before any wait, whoami $(whoamis)"

echo; echo "## W6. both retries in one run: cre whoami fails once, then simulate stops at the credential check once"
setup_case w6 cred,ok "7 7"; echo fail,ok >"$C/shim/whoami-plan"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(whoamis)" = 2 ] && [ "$(sleeps)" = "30 45" ] && [ "$(attempts)" = 2 ] && [ "$(count 'CRE login check:')" = 1 ] && [ "$(count 'OFFICIAL retry:')" = 1 ] && echo 1 || echo 0)" "exit $RC, whoami $(whoamis), waits [$(sleeps)], simulate calls $(attempts), one line for each retry"
ok "$([ "$(sed -n 1p "$C/shim/sleep-state")" = "30 run.lock=free last-run=none" ] && [ "$(sed -n 2p "$C/shim/sleep-state")" = "45 run.lock=held last-run=stamped" ] && echo 1 || echo 0)" "the 30 s wait before the lock and the stamp, the 45 s wait under them: $(tr '\n' ';' <"$C/shim/sleep-state" | sed 's/;$//')"

echo; echo "## W7. cre whoami fails, then the second check hangs: the same 45 s alarm ends it, exit 3"
setup_case w7 ok "7 7"; echo fail,hang >"$C/shim/whoami-plan"; T0=$(date +%s); runoff current --official; EL=$(( $(date +%s) - T0 ))
ok "$([ "$RC" = 3 ] && [ "$(whoamis)" = 2 ] && [ "$(sleeps)" = 30 ] && [ "$EL" -ge 45 ] && [ "$EL" -lt 58 ] && [ "$(count '^NOT LOGGED IN TO CRE.')" = 1 ] && echo 1 || echo 0)" "exit $RC after $EL s (the shim's 1 s wait plus the 45 s alarm, not the 90 s hang), whoami $(whoamis), waits [$(sleeps)]"

echo; echo "## W8. the most one run waits: the first check hangs (a CRE API timeout), the second answers, then simulate stops at"
echo "   the credential check twice"
setup_case w8 cred,cred "7 7"; echo hang,ok >"$C/shim/whoami-plan"; T0=$(date +%s); runoff current --official; EL=$(( $(date +%s) - T0 ))
ok "$([ "$RC" = 1 ] && [ "$(whoamis)" = 2 ] && [ "$(sleeps)" = "30 45" ] && [ "$(attempts)" = 2 ] && [ "$EL" -ge 45 ] && [ "$EL" -lt 60 ] && echo 1 || echo 0)" "exit $RC after $EL s (the 45 s alarm on the first check plus the shim's two 1 s waits), whoami $(whoamis), waits [$(sleeps)] and no more, simulate calls $(attempts)"
ok "$([ "$(whoami_waits)" = "whoami#1 after 0 wait(s);whoami#2 after 1 wait(s)" ] && [ "$(count 'CRE login check:')" = 1 ] && [ "$(count 'cre-login=yes')" = 1 ] && [ "$(count 'OFFICIAL retry:')" = 1 ] && [ "$(count 'run exited 1')" = 1 ] && [ "$(count 'NOT LOGGED IN')" = 0 ] && [ ! -d "$C/state/run.lock" ] && echo 1 || echo 0)" "the timed-out check counts as a failure and is checked once more after the wait ($(whoami_waits)); one line per retry, 'run exited 1', lock released"

HD=0x$(printf 'cd%.0s' $(seq 1 32)); HF=0x$(printf 'ef%.0s' $(seq 1 32))
confirms() { cat "$C/shim/confirms" 2>/dev/null; }
echo; echo "## D1. a report sent, its 'tx 0x… ->' line dropped: the receipt check still runs, with the hash from the result JSON"
setup_case d1 sent-noline "7 7"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(confirms | wc -l | tr -d ' ')" = 1 ] && [ "$(confirms | grep -oE '0x[0-9a-f]{64}' | tr '\n' ' ')" = "$HD " ] && echo 1 || echo 0)" "exit $RC; receipt checks: $(confirms | wc -l | tr -d ' '), hashes [$(confirms | grep -oE '0x[0-9a-f]{64}' | cut -c1-10 | tr '\n' ' ')]"
ok "$([ "$(count 'status=success (shim receipt check)')" = 1 ] && [ "$(count 'tx 0x')" = 0 ] && echo 1 || echo 0)" "the run log has the receipt line and no 'tx 0x… ->' line"
OWN=$("$NODE" "$REAL/scripts/sent-hashes.mjs" "$C/stdout" | sort -u | wc -l | tr -d ' '); OLD=$(grep -oE 'tx 0x[0-9a-f]{64}( ->| status=)' "$C/stdout" | wc -l | tr -d ' ')
ok "$([ "$OWN" = 1 ] && [ "$OLD" = 0 ] && echo 1 || echo 0)" "vps tripwire on this output: own txs $OWN (the grep alone: $OLD)"
if [ -n "$BASE3_REF" ]; then
  setup_case d1-base sent-noline "7 7"; runoff baseline3 --official
  ok "$([ "$RC" = 0 ] && [ -z "$(confirms)" ] && echo 1 || echo 0)" "run-official.sh at $BASE3_REF on the same output: exit $RC, receipt checks $(confirms | wc -l | tr -d ' ') (the gap this closes)"
else echo "  SKIP  no committed run-official.sh without sent-hashes.mjs to compare with"; fi

echo; echo "## D2. the same report with its 'tx 0x… ->' line: one receipt check, for that hash once"
setup_case d2 sent-line "7 7"; runoff current --official
ok "$([ "$RC" = 0 ] && [ "$(confirms | wc -l | tr -d ' ')" = 1 ] && [ "$(confirms | grep -oE '0x[0-9a-f]{64}' | tr '\n' ' ')" = "$HD " ] && echo 1 || echo 0)" "exit $RC; receipt checks: $(confirms | wc -l | tr -d ' '), hashes [$(confirms | grep -oE '0x[0-9a-f]{64}' | cut -c1-10 | tr '\n' ' ')]"

echo; echo "## D3. a failed writeReport whose hash is in the result JSON: no receipt check, as before"
setup_case d3 wr-failed "7 7"; runoff current --official
ok "$([ "$RC" = 0 ] && [ -z "$(confirms)" ] && [ "$(count 'writeReport 2 execution reverted')" = 1 ] && echo 1 || echo 0)" "exit $RC; receipt checks: $(confirms | wc -l | tr -d ' ')"
ok "$([ "$("$NODE" "$REAL/scripts/sent-hashes.mjs" "$C/stdout" | wc -l | tr -d ' ')" = 0 ] && [ "$(grep -cE '\[USER LOG\] .*: writeReport |send-report failed' "$C/stdout")" = 1 ] && echo 1 || echo 0)" "vps tripwire on this output: own txs 0, failed reports 1 (counted once)"

echo; echo "## J1. settle-job.sh (the hourly entry), credential failure then success"
setup_case j1 cred,ok "7 7"
caseenv "$TBASH" "$P/scripts/settle-job.sh" >"$C/stdout" 2>&1; RC=$?
J="$C/state/evidence/LATEST.json"; JOB=$(ls "$C/state/logs"/job-*.log | head -n1)
jq_() { "$NODE" -e 'const r = require(process.argv[1]); console.log(JSON.stringify(eval(process.argv[2])))' "$J" "$1"; }
ok "$([ "$RC" = 0 ] && [ ! -f "$C/state/official-failed" ] && echo 1 || echo 0)" "job exit $RC; no official-failed marker, so the next run stays official"
ok "$([ "$(jq_ '[r.path, r.exitCode, r.exitMeaning]')" = '["official",0,"ok / nothing to do / skipped"]' ] && echo 1 || echo 0)" "evidence: $(jq_ '[r.path, r.exitCode, r.exitMeaning]')"
ok "$([ "$(jq_ 'r.workflow && r.workflow.ladders')" = '{"count":1,"scanned":[0,1],"due":0}' ] && [ "$(jq_ 'r.reportsSent.length')" = 0 ] && echo 1 || echo 0)" "evidence: workflow summary parsed from the second run (ladders $(jq_ 'r.workflow && r.workflow.ladders')), reportsSent []"
ok "$([ "$(jq_ 'r.runner.filter((l) => l.startsWith("OFFICIAL retry:")).length')" = 1 ] && [ "$(jq_ 'r.stoodDownForDon || r.stoodDownForWriter')" = false ] && echo 1 || echo 0)" "evidence: the retry line is in runner[]; no stand-down flag"
OWN=$("$NODE" "$REAL/scripts/sent-hashes.mjs" "$C/stdout" | sort -u | wc -l | tr -d ' '); UNSURE=$(grep -cE '\[USER LOG\] .*: writeReport |send-report failed' "$C/stdout")
WR=$(grep -cE '\[USER LOG\] .*(: writeReport |-> not-accepted)' "$JOB")
ok "$([ "$OWN" = 0 ] && [ "$UNSURE" = 0 ] && [ "$WR" = 0 ] && echo 1 || echo 0)" "vps tripwire patterns on the job output: own txs $OWN, failed reports $UNSURE; settle-job's writeReport pattern: $WR"
echo "  evidence runner[]:"; jq_ 'r.runner' | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>JSON.parse(s).forEach(l=>console.log("    | "+l)))' | san

echo; echo "## J2. settle-job.sh, credential failure twice"
setup_case j2 cred,cred "7 7"
caseenv "$TBASH" "$P/scripts/settle-job.sh" >"$C/stdout" 2>&1; RC=$?
J="$C/state/evidence/LATEST.json"
ok "$([ "$RC" = 1 ] && grep -q '^rc=1 at ' "$C/state/official-failed" && echo 1 || echo 0)" "job exit $RC; official-failed '$(cat "$C/state/official-failed" 2>/dev/null)' (the next hourly run uses the harness, as before)"
ok "$([ "$(jq_ '[r.path, r.exitCode, r.exitMeaning, r.workflow]')" = '["official",1,"run failed",null]' ] && [ "$(attempts)" = 2 ] && echo 1 || echo 0)" "evidence: $(jq_ '[r.path, r.exitCode, r.exitMeaning, r.workflow]'); simulate calls $(attempts)"
ok "$([ "$(jq_ 'r.runner.slice(-2)')" = "$(jq_ 'r.runner.filter((l) => /^(OFFICIAL retry:|run exited 1)/.test(l))')" ] && echo 1 || echo 0)" "the push's last two runner lines: $(jq_ 'r.runner.slice(-2).map((l) => l.slice(0, 60) + "...")')"

# jobrun <case>: the real settle-job.sh for case $C; then vps/lib.sh cre_login_watch on its LATEST.json, as
# settle-vps.sh step 5b runs it (no alert URL in the scratch HOME: an alert is logged to ALERTS.log and the output, never
# sent)
jobrun() {
  caseenv "$TBASH" "$P/scripts/settle-job.sh" >"$C/stdout-$1" 2>&1; RC=$?
  caseenv PKG="$P" "$TBASH" -c '. "$PKG/vps/lib.sh"; cre_login_watch "$STATE/evidence/LATEST.json"' >"$C/watch-$1" 2>&1
  J="$C/state/evidence/LATEST.json"
}
lapse() { "$NODE" -e 'try { console.log(require(process.argv[1]).runs) } catch { console.log("absent") }' "$C/state/cre-login-lapsed.json"; }
needed() { grep -c 'ALERT: ISOTHERM VPS: CRE LOGIN NEEDED' "$1" 2>/dev/null || true; }

echo; echo "## J3. settle-job.sh: the job's cre whoami answers, run-official.sh's first check fails and its second answers"
echo "   (the 2026-10-11 01:05 UTC case); the previous hour was a single miss"
setup_case j3 ok "7 7"; echo ok,fail,ok >"$C/shim/whoami-plan"
printf '%s\n' '{"at":"2026-10-11T00:05:02Z","reason":"cre whoami failed (not logged in to CRE)","runs":"1"}' >"$C/state/cre-login-lapsed.json"
jobrun 1
ok "$([ "$RC" = 0 ] && [ "$(whoamis)" = 3 ] && [ "$(sleeps)" = 30 ] && [ "$(attempts)" = 1 ] && [ ! -f "$C/state/official-failed" ] && echo 1 || echo 0)" "job exit $RC, cre whoami asked $(whoamis) times (job, check, check again), waits [$(sleeps)], simulate calls $(attempts), no official-failed marker"
ok "$([ "$(jq_ '[r.path, r.creLogin, r.exitCode, r.pathReason]')" = '["official",true,0,"cre whoami succeeded"]' ] && [ "$(jq_ 'r.runner.filter((l) => l.startsWith("CRE login check:")).length')" = 1 ] && echo 1 || echo 0)" "evidence: $(jq_ '[r.path, r.creLogin, r.exitCode, r.pathReason]'); the new line in runner[]"
ok "$([ "$(needed "$C/watch-1")" = 0 ] && grep -q 'CRE login: there again at .* after a single miss at 2026-10-11T00:05:02Z; nothing was pushed' "$C/watch-1" && [ "$(lapse)" = absent ] && echo 1 || echo 0)" "cre_login_watch: not a miss; it clears the previous single miss, no push (lapse state $(lapse))"
echo "  cre_login_watch:"; sed -E 's/^\[[^]]+\] //; s/^/    | /' "$C/watch-1" | san

echo; echo "## J4. settle-job.sh: the job's cre whoami answers, both of run-official.sh's checks fail; two hours in a row"
setup_case j4 ok "7 7"; echo ok,fail,fail,fail >"$C/shim/whoami-plan"; touch "$C/shim/harness-ok"
jobrun 1
ok "$([ "$RC" = 0 ] && [ "$(whoamis)" = 4 ] && [ "$(sleeps)" = 30 ] && [ "$(attempts)" = 0 ] && [ "$(wc -l <"$C/shim/bun-tests" | tr -d ' ')" = 1 ] && [ ! -f "$C/state/official-failed" ] && echo 1 || echo 0)" "job exit $RC: whoami $(whoamis) (job, check, check again, the harness run's own), waits [$(sleeps)] (the harness run does not wait), simulate calls $(attempts), harness runs 1"
ok "$(grep -q '\[settle-job\] official path exited 3 (login vanished between checks): running the harness fallback now' "$C/stdout-1" && echo 1 || echo 0)" "settle-job: 'official path exited 3 (login vanished between checks): running the harness fallback now'"
ok "$([ "$(jq_ '[r.path, r.creLogin, r.exitCode, r.pathReason]')" = '["harness-fallback",true,0,"cre whoami succeeded; then run-official.sh reported no login (exit 3) before signing"]' ] && [ "$(jq_ 'r.runner.filter((l) => l.startsWith("CRE login check:")).length')" = 1 ] && echo 1 || echo 0)" "evidence: $(jq_ '[r.path, r.creLogin, r.exitCode, r.pathReason]')"
ok "$([ "$(needed "$C/watch-1")" = 0 ] && grep -q 'CRE login: none in this run (cre whoami succeeded; then run-official.sh reported no login (exit 3) before signing)' "$C/watch-1" && [ "$(lapse)" = 1 ] && echo 1 || echo 0)" "cre_login_watch, hour 1: a miss (lapse state runs=$(lapse)), no push yet"
rm -f "$C/shim/whoami-n" "$C/state/last-run"   # an hour later: the spacing guard is past
jobrun 2
ok "$([ "$RC" = 0 ] && [ "$(whoamis)" = 4 ] && [ "$(needed "$C/watch-2")" = 1 ] && [ "$(lapse)" = 2 ] && grep -q 'CRE LOGIN NEEDED' "$C/state/alerts/ALERTS.log" && echo 1 || echo 0)" "cre_login_watch, hour 2: CRE LOGIN NEEDED (lapse state runs=$(lapse)), job exit $RC"
OWN=$(for i in 1 2; do "$NODE" "$REAL/scripts/sent-hashes.mjs" "$C/stdout-$i"; done | sort -u | wc -l | tr -d ' '); UNSURE=$(cat "$C/stdout-1" "$C/stdout-2" | grep -cE '\[USER LOG\] .*: writeReport |send-report failed')
ok "$([ "$OWN" = 0 ] && [ "$UNSURE" = 0 ] && echo 1 || echo 0)" "vps tripwire patterns on both jobs' output: own txs $OWN, failed reports $UNSURE"
echo "  cre_login_watch, hours 1 and 2:"; cat "$C/watch-1" "$C/watch-2" | sed -E 's/^\[[^]]+\] //; s/^/    | /' | cut -c1-240 | san

echo; echo "## B. without a retry the run log is as before: run-official.sh at ${BASE_REF:-<none>} vs now, same case, same shims"
if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then echo "  SKIP  no git history here (a pushed copy): nothing to compare with"
elif [ -z "$BASE_REF" ]; then ok 0 "no committed run-official.sh without the retry found"
else
  for spec in $BASELINE_CASES; do
    name=${spec%%:*}; rest=${spec#*:}; plan=${rest%%:*}; np=7; [ "$rest" != "$plan" ] && np=$(echo "${rest#*:}" | tr _ ' ')
    setup_case "b-$name-old" "$plan" "$np"; runoff baseline --official; RO=$RC; LO=$RUNLOG; NO=$(attempts)
    setup_case "b-$name-new" "$plan" "$np"; runoff current --official; RN=$RC; LN=$RUNLOG; NN=$(attempts)
    if diff <(norm "$LO") <(norm "$LN") >"$C/diff"; then same=1; else same=0; fi
    ok "$([ "$same" = 1 ] && [ "$RO" = "$RN" ] && [ "$NO" = "$NN" ] && echo 1 || echo 0)" "plan $plan, nonce reads [$np]: log identical ($(wc -l <"$LN" | tr -d ' ') lines), exit $RO / $RN, simulate calls $NO / $NN"
    [ "$same" = 1 ] || sed 's/^/    | /' "$C/diff" | san
  done
fi

echo; echo "## B2. the login-check retry changes nothing else: run-official.sh at ${BASE2_REF:-<none>} vs now, same case, same shims"
# b2 <name> <whoami plan> <new lines expected: 0|1> <one NAME=VALUE or -> <args...>: run log and stdout identical, apart
# from exactly <new lines> "CRE login check:" line(s); same exit code, same simulate calls
b2() {
  local name=$1 wp=$2 nl=$3 e=$4 ro lo so wo co rn ln sn wn same; shift 4; [ "$e" = - ] && e=""
  setup_case "b2-$name-old" ok "7 7"; echo "$wp" >"$C/shim/whoami-plan"; RUNENV=$e; runoff baseline2 "$@"; ro=$RC; lo=$RUNLOG; so=$(sleeps); wo=$(whoamis); co=$C
  setup_case "b2-$name-new" ok "7 7"; echo "$wp" >"$C/shim/whoami-plan"; RUNENV=$e; runoff current "$@"; rn=$RC; ln=$RUNLOG; sn=$(sleeps); wn=$(whoamis); RUNENV=""
  if diff <(norm "$lo") <(norm "$ln" | grep -v '^\[T\] CRE login check: ') >"$C/diff" && diff <(norm "$co/stdout") <(norm "$C/stdout" | grep -v '^\[T\] CRE login check: ') >>"$C/diff"; then same=1; else same=0; fi
  ok "$([ "$same" = 1 ] && [ "$(count 'CRE login check:')" = "$nl" ] && [ "$ro" = "$rn" ] && [ "$(cat "$co/shim/attempts" 2>/dev/null || echo 0)" = "$(attempts)" ] && { [ "$nl" = 1 ] || { [ "$wo" = "$wn" ] && [ "$so" = "$sn" ]; }; } && echo 1 || echo 0)" \
    "$name ($*${e:+, ${e%%=*} set}; whoami $wp): log and stdout identical apart from $(count 'CRE login check:') new line(s); exit $ro / $rn; whoami $wo / $wn; waits [$so] / [$sn]"
  [ "$same" = 1 ] || sed 's/^/    | /' "$C/diff" | san
}
if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then echo "  SKIP  no git history here (a pushed copy): nothing to compare with"
elif [ -z "$BASE2_REF" ]; then ok 0 "no committed run-official.sh without the login-check retry found"
else
  b2 fails-twice fail 1 - --official
  b2 answers ok 0 - --official
  b2 api-key fail 0 CRE_API_KEY=test-only-not-a-key --official
  b2 preflight-only fail 0 - --official --preflight-only
  b2 harness fail 0 - --harness
  b2 harness-if-no-login fail 0 - --harness-if-no-login
  b2 non-live-rpc fail 0 ISOTHERM_RPC=http://127.0.0.1:9 --official
fi

echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed"
} 2>&1 | san | tee "$SC/out.txt"
[ -n "${ISOTHERM_RETRY_CHECK_TARGET:-}" ] || cp "$SC/out.txt" "$EVOUT"
grep -q '^# .* done: [0-9]* passed, 0 failed$' "$SC/out.txt"
