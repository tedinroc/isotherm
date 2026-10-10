#!/usr/bin/env bash
# TEST ONLY (0 MON, no network, no real key, no CRE session): the one-retry rule of scripts/run-official.sh step 5.
# The REAL run-official.sh and settle-job.sh (symlinked, so they resolve PKG to the scratch package) run from a scratch
# package whose .tools/bin holds shims, ahead of everything else on the scripts' own PATH:
#   cre    `version` v1.37.0, `whoami` OK, `workflow simulate` follows a per-case plan (one step per call) and records
#          its argv and whether the keys arrived through its environment (never their values)
#   cast   the preflight's chain reads and `cast nonce`, answered from files; any other call fails the case (exit 97)
#   sleep  records the seconds asked for, then waits 1 s (so a re-stamped last-run is visibly later)
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
#   J1/J2 the whole settle-job.sh: the evidence record after a retried run and after two credential failures; the
#         tripwire's and settle-job's own log patterns on those logs
#   B  every case without a retry gives a run log identical (timestamps and scratch paths aside) to run-official.sh as
#      it was before the retry existed (the newest committed version without it), with the same exit code
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
mkdir -p "$P/scripts" "$BIN" "$SC/root/deployments" "$SC/home" "$SC/keys" "$SC/cases"
ln -s "$TARGET" "$P/scripts/run-official.sh"          # the code under test
ln -s "$REAL/scripts/settle-job.sh" "$P/scripts/settle-job.sh"
ln -s "$REAL/settle" "$P/settle"                                            # viem (key -> address), evidence-record.ts
ln -s "$REPO/deployments/testnet.json" "$SC/root/deployments/testnet.json"  # read only (addresses)
ln -s "$NODE" "$BIN/node"
# bun: the real one, except `bun test` (only the harness run uses it), which answers like a failed harness run whose
# output names the CRE credential check (R10: harness mode never retries)
cat >"$BIN/bun" <<EOF
#!/bin/bash
if [ "\${1:-}" = test ]; then echo "bun \$*" >>"\${SHIM_DIR:?}/bun-tests"; echo "✗ Credential validation failed (shim harness run)"; exit 1; fi
exec "$BUN" "\$@"
EOF
chmod +x "$BIN/bun"

# ---- baseline: the newest committed run-official.sh that has no retry
BASE_REF=""
for c in $(git -C "$REPO" log --format=%h -- packages/cre-workflow/scripts/run-official.sh 2>/dev/null); do
  case "$(git -C "$REPO" show "$c:packages/cre-workflow/scripts/run-official.sh")" in *credential_check_only*) ;; *) BASE_REF=$c; break ;; esac
done
[ -n "$BASE_REF" ] && git -C "$REPO" show "$BASE_REF:packages/cre-workflow/scripts/run-official.sh" >"$P/scripts/run-official.baseline.sh"

# ---- shims
cat >"$BIN/cre" <<'EOF'
#!/bin/bash
# TEST shim of the CRE CLI v1.37.0: no network, never reads or writes ~/.cre
D=${SHIM_DIR:?}
case "$1 ${2:-}" in
  "version "*) echo "CRE CLI version v1.37.0"; exit 0 ;;
  "whoami "*) exit 0 ;;
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
# TEST shim of sleep: records the seconds asked for, waits 1 s
echo "$*" >>"${SHIM_DIR:?}/sleeps"; /bin/sleep 1
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
# runoff [script] -- <args>: the real run-official.sh (or the baseline) for case $C; exit code in RC, log in RUNLOG
runoff() {
  local s="run-official.sh"; [ "$1" = baseline ] && s="run-official.baseline.sh"; shift
  caseenv "$TBASH" "$P/scripts/$s" "$@" >"$C/stdout" 2>&1; RC=$?
  RUNLOG=$(ls -t "$C/state/logs"/run-*.log 2>/dev/null | head -n1)
}
attempts() { cat "$C/shim/attempts" 2>/dev/null || echo 0; }
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
echo "# scratch package <scratch>/root/packages/cre-workflow (scripts/ symlinked to the code under test); tx sender $ADDR (fresh random key); baseline: run-official.sh at ${BASE_REF:-<none found>}"

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

echo; echo "## J1. settle-job.sh (the hourly entry), credential failure then success"
setup_case j1 cred,ok "7 7"
caseenv "$TBASH" "$P/scripts/settle-job.sh" >"$C/stdout" 2>&1; RC=$?
J="$C/state/evidence/LATEST.json"; JOB=$(ls "$C/state/logs"/job-*.log | head -n1)
jq_() { "$NODE" -e 'const r = require(process.argv[1]); console.log(JSON.stringify(eval(process.argv[2])))' "$J" "$1"; }
ok "$([ "$RC" = 0 ] && [ ! -f "$C/state/official-failed" ] && echo 1 || echo 0)" "job exit $RC; no official-failed marker, so the next run stays official"
ok "$([ "$(jq_ '[r.path, r.exitCode, r.exitMeaning]')" = '["official",0,"ok / nothing to do / skipped"]' ] && echo 1 || echo 0)" "evidence: $(jq_ '[r.path, r.exitCode, r.exitMeaning]')"
ok "$([ "$(jq_ 'r.workflow && r.workflow.ladders')" = '{"count":1,"scanned":[0,1],"due":0}' ] && [ "$(jq_ 'r.reportsSent.length')" = 0 ] && echo 1 || echo 0)" "evidence: workflow summary parsed from the second run (ladders $(jq_ 'r.workflow && r.workflow.ladders')), reportsSent []"
ok "$([ "$(jq_ 'r.runner.filter((l) => l.startsWith("OFFICIAL retry:")).length')" = 1 ] && [ "$(jq_ 'r.stoodDownForDon || r.stoodDownForWriter')" = false ] && echo 1 || echo 0)" "evidence: the retry line is in runner[]; no stand-down flag"
OWN=$(grep -oE 'tx 0x[0-9a-f]{64}( ->| status=)' "$C/stdout" | wc -l | tr -d ' '); UNSURE=$(grep -cE '\[USER LOG\] .*: writeReport |send-report failed' "$C/stdout")
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

echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed"
} 2>&1 | san | tee "$SC/out.txt"
[ -n "${ISOTHERM_RETRY_CHECK_TARGET:-}" ] || cp "$SC/out.txt" "$EVOUT"
grep -q '^# .* done: [0-9]* passed, 0 failed$' "$SC/out.txt"
