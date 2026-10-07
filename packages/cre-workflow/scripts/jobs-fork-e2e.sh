#!/bin/bash
# End-to-end test of the two settlement LaunchAgents, STARTED BY LAUNCHD FROM THE RUNTIME COPY (~/isotherm-live), against
# a fresh anvil fork of LIVE Monad testnet warped past the end of the live RCSS 2026-10-08 ladder's day. 0 MON spent.
#
#   F  launchd runs `cre workflow build` from the runtime copy: the official toolchain compiles there (TCC check).
#   A  launchd runs the settle job: no CRE login -> HARNESS FALLBACK path; the live maker ladder RCSS 2026-10-08 is
#      settled through the MockKeystoneForwarder; the evidence record names the path. A second kickstart is
#      stopped by the 30-min spacing guard. Then the watcher job verifies the result: MATCH, no challenge.
#   B  (fork reverted) a FORGED report settles 31 C; the watcher job finds the mismatch, re-fetches, and challenge()s
#      from the guardian key -> Void.
#   C  (fork reverted) same forged report, guardian has 0 MON: the watcher prints the exact manual command and sends
#      nothing; the test then funds the guardian and runs that printed command verbatim -> Void.
#   D  the LIVE guardian key and the LIVE attester key are refused on the fork (run directly, nothing signed).
#
# Test-only inputs: the day's METARs do not exist yet, so ISOTHERM_TEST_RELABEL serves LIVE archive data of
# 2026-10-06 relabelled to 2026-10-08 (both jobs refuse it on a non-loopback RPC). Keys: public anvil dev keys
# (#9 attester, #1 tx sender, #2 guardian), installed on the fork by impersonating the owner.
# Port: ISOTHERM_ANVIL_PORT (default 19330). Output: evidence/jobs-fork-e2e.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$HOME/.foundry/bin:$HOME/.local/bin:$PATH"
RT=${ISOTHERM_RUNTIME:-$HOME/isotherm-live}
RTP=$RT/packages/cre-workflow
PORT=${ISOTHERM_ANVIL_PORT:-19330}
RPC="http://127.0.0.1:$PORT"
OUT="$PKG/evidence/jobs-fork-e2e.txt"
T="$RTP/var/test-fork"
UID_=$(id -u)
TP=xyz.isotherm.test
DEP="$PKG/../../deployments/testnet.json"
jget() { node -e 'const d=require(process.argv[1]); console.log(process.argv[2].split(".").reduce((o,k)=>o[k],d))' "$DEP" "$1"; }
RESOLVER=$(jget resolver); OWNER=$(jget roles.owner)
ATT9=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
GUARD2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT busy" >&2; exit 1; fi

bash "$PKG/scripts/deploy-runtime.sh" >/dev/null           # sync only; the real jobs are not touched
rm -rf "$T"; mkdir -p "$T/keys"
anvil --fork-url "${ISOTHERM_FORK_URL:-https://testnet-rpc.monad.xyz}" --port "$PORT" --silent >"$T/anvil.log" 2>&1 &
ANVIL_PID=$!
cleanup() {
  for j in cre-settle challenge-watch build; do launchctl bootout "gui/$UID_/$TP.$j" 2>/dev/null || true; done
  kill "$ANVIL_PID" 2>/dev/null || true
  rm -rf "$T/keys"   # public anvil keys, but keep key files out of the runtime tree
}
trap cleanup EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
# public anvil dev keys: worthless, published in every Foundry install
printf '%s' 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 > "$T/keys/attester.key"
printf '%s' 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d > "$T/keys/tx.key"
printf '%s' 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a > "$T/keys/guardian.key"
chmod 600 "$T/keys/"*.key

COMMON="ISOTHERM_RPC=$RPC;ISOTHERM_ATTESTER_KEY_FILE=$T/keys/attester.key;ISOTHERM_TX_KEY_FILE=$T/keys/tx.key;ISOTHERM_GUARDIAN_KEY_FILE=$T/keys/guardian.key;ISOTHERM_TEST_RELABEL=RCSS:2026-10-08=2026-10-06;WATCH_LOOKBACK_BLOCKS=600;WATCH_RECHECK_SEC=5"
res() { cast call "$RESOLVER" 'resultOf(bytes4,uint32)((uint8,int16,uint64,uint64,bytes32))' 0x52435353 20261008 --rpc-url "$RPC"; }
# launchd: render the RUNTIME copy's template with test env, bootstrap, kickstart, wait for exit, print exit code
via_launchd() { # job scenario
  local job=$1 sc=$2 label="$TP.$1"
  mkdir -p "$T/$sc/logs"
  ISOTHERM_LAUNCHD_PREFIX=$TP ISOTHERM_LAUNCHD_ONDEMAND=1 ISOTHERM_LAUNCHD_OUT="$T/plists-$sc" ISOTHERM_LAUNCHD_LOGDIR="$T/$sc/logs" \
    ISOTHERM_LAUNCHD_ENV="$COMMON;ISOTHERM_STATE_DIR=$T/$sc" bash "$RTP/scripts/install-launchd.sh" >/dev/null
  launchctl bootout "gui/$UID_/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_" "$T/plists-$sc/$label.plist"
  local before; before=$(launchctl print "gui/$UID_/$label" | awk -F' = ' '/^\truns =/{print $2}')
  launchctl kickstart "gui/$UID_/$label"
  for _ in $(seq 1 300); do
    sleep 1
    local p; p=$(launchctl print "gui/$UID_/$label")
    if echo "$p" | grep -q $'^\tstate = not running' && [ "$(echo "$p" | awk -F' = ' '/^\truns =/{print $2}')" != "$before" ]; then break; fi
  done
  echo "launchd $label: $(launchctl print "gui/$UID_/$label" | grep -E $'^\t(runs|last exit code|program|working directory) =' | sed 's/^\t//' | tr '\n' ';')"
}

{
set +e
echo "# $(date -u +%FT%TZ) jobs-fork-e2e: launchd jobs from $RTP on an anvil fork of live testnet (pid $ANVIL_PID, :$PORT, block $(cast block-number --rpc-url "$RPC"))"
echo "# live: Resolver.attester $(cast call "$RESOLVER" 'attester()(address)' --rpc-url "$RPC"), guardian $(cast call "$RESOLVER" 'guardian()(address)' --rpc-url "$RPC"); resultOf(RCSS,20261008) = $(res)"
cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$OWNER" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
cast send --unlocked --from "$OWNER" "$RESOLVER" "setAttester(address)" $ATT9 --rpc-url "$RPC" >/dev/null
cast send --unlocked --from "$OWNER" "$RESOLVER" "setGuardian(address)" $GUARD2 --rpc-url "$RPC" >/dev/null
echo "# fork only: attester -> $(cast call "$RESOLVER" 'attester()(address)' --rpc-url "$RPC") (anvil #9), guardian -> $(cast call "$RESOLVER" 'guardian()(address)' --rpc-url "$RPC") (anvil #2) via owner impersonation"
W=$(node -e 'console.log(Date.parse("2026-10-08T18:05:00Z")/1000)')
cast rpc evm_setNextBlockTimestamp "$W" --rpc-url "$RPC" >/dev/null
cast rpc anvil_mine 0x50 0x1 --rpc-url "$RPC" >/dev/null
echo "# warped: chain time $(node -e 'console.log(new Date(Number(process.argv[1])*1000).toISOString())' "$(cast block latest --field timestamp --rpc-url "$RPC")") = 02:06 Taipei on Oct 9 (dayEnd 2026-10-08T16:00Z + 2 h gate passed)"
SNAP=$(cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"')

echo; echo "## F. launchd runs the OFFICIAL toolchain's compile step (cre workflow build, no login needed) from the runtime copy"
mkdir -p "$T/F"
cat > "$T/F/build.sh" <<EOS
#!/bin/bash
cd "$RTP/settle" && export PATH="$RTP/.tools/bin:$RTP/.tools/node_modules/.bin:/usr/bin:/bin" && cre workflow build . -T testnet -R .. 2>&1 | grep -v "Update available\|cre update\|upgrade\.\$"; shasum -a 256 binary.wasm
EOS
chmod +x "$T/F/build.sh"
cat > "$T/F/$TP.build.plist" <<EOS
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$TP.build</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>$T/F/build.sh</string></array>
<key>StandardOutPath</key><string>$T/F/build.log</string><key>StandardErrorPath</key><string>$T/F/build.log</string><key>RunAtLoad</key><false/></dict></plist>
EOS
launchctl bootout "gui/$UID_/$TP.build" 2>/dev/null || true
launchctl bootstrap "gui/$UID_" "$T/F/$TP.build.plist"; launchctl kickstart "gui/$UID_/$TP.build"
for _ in $(seq 1 180); do sleep 1; launchctl print "gui/$UID_/$TP.build" | grep -q $'^\tlast exit code = [0-9]' && break; done
echo "launchd $TP.build: $(launchctl print "gui/$UID_/$TP.build" | grep -E $'^\t(runs|last exit code) =' | sed 's/^\t//' | tr '\n' ';')"
cat "$T/F/build.log"
launchctl bootout "gui/$UID_/$TP.build" 2>/dev/null || true

echo; echo "## A1. launchd runs the settle job (xyz.isotherm.cre-settle template, on demand) from the runtime copy"
via_launchd cre-settle A
grep -E "settle-job|\[path\]|\[time\]|\[TEST\]|USER LOG|\[sent\]|block .* status=|evidence" "$T/A/logs/settle.out.log" || true
echo "resultOf(RCSS,20261008) = $(res)"
echo "### evidence record (var/evidence/LATEST.json, abridged)"
node -e 'const r=require(process.argv[1]); console.log(JSON.stringify({path:r.path,pathLabel:r.pathLabel,pathReason:r.pathReason,creLogin:r.creLogin,network:r.network,testDataRelabel:r.testDataRelabel,exitCode:r.exitCode,reportsSent:r.reportsSent,receiptChecks:r.receiptChecks},null,1))' "$T/A/evidence/LATEST.json"
ls "$T/A/evidence/"
echo; echo "## A2. a second kickstart right away: the 30-min spacing guard stops it (no second signature)"
via_launchd cre-settle A
tail -n 4 "$T/A/logs/settle.out.log"
echo; echo "## A3. launchd runs the challenge watcher: honest result -> MATCH, nothing sent"
via_launchd challenge-watch A
grep -vE "^\s*$" "$T/A/logs/watch.out.log" | tail -n 6
echo "resultOf(RCSS,20261008) = $(res)"

echo; echo "## B. fork reverted; a FORGED report (31 C, signed by the fork's test attester) settles; the watcher challenges"
cast rpc evm_revert "$SNAP" --rpc-url "$RPC" >/dev/null; SNAP=$(cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"')
(cd settle && ISOTHERM_RPC=$RPC ISOTHERM_ATTESTER_KEY_FILE="$T/keys/attester.key" bun e2e/forge-report.ts RCSS 20261008 31)
echo "resultOf(RCSS,20261008) = $(res)"
echo "guardian balance $(cast balance $GUARD2 --ether --rpc-url "$RPC") MON"
via_launchd challenge-watch B
grep -E "MISMATCH|CHALLENGE|challenge tx|reasonHash|pass done|event " "$T/B/logs/watch.out.log"
echo "resultOf(RCSS,20261008) = $(res)"
cast logs --from-block "$(($(cast block-number --rpc-url "$RPC") - 20))" --address "$RESOLVER" 'LadderChallenged(bytes4 indexed,uint32 indexed,int16,bytes32,address)' --rpc-url "$RPC" | grep -E "transactionHash|data" | head -2

echo; echo "## C. fork reverted; forged report again, guardian holds 0 MON: the watcher prints the exact manual command"
cast rpc evm_revert "$SNAP" --rpc-url "$RPC" >/dev/null
(cd settle && ISOTHERM_RPC=$RPC ISOTHERM_ATTESTER_KEY_FILE="$T/keys/attester.key" bun e2e/forge-report.ts RCSS 20261008 31)
cast rpc anvil_setBalance $GUARD2 0x0 --rpc-url "$RPC" >/dev/null
via_launchd challenge-watch C
grep -E "NOT CHALLENGED|Why:|cast send|fund the guardian|RUN THIS" "$T/C/logs/watch.out.log"
CMD=$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).filter(r=>r.manualCommand).pop(); console.log(l.manualCommand)' "$T/C/watch/watch.jsonl")
echo "resultOf before the manual command = $(res)"
cast rpc anvil_setBalance $GUARD2 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null
echo "funded the fork guardian with 1 MON; running the printed command verbatim:"
bash -c "$CMD" | grep -E "^(status|gasUsed|transactionHash)" || true
echo "resultOf after the manual command = $(res)"

echo; echo "## D. live keys on the fork are refused (nothing is signed)"
(cd "$RTP/settle" && ISOTHERM_RPC=$RPC ISOTHERM_STATE_DIR="$T/D" ISOTHERM_GUARDIAN_KEY_FILE="$HOME/.config/isotherm/guardian.key" WATCH_LOOKBACK_BLOCKS=50 bun ops/challenge-watch.ts | grep "pass done")
(cd "$RTP" && ISOTHERM_RPC=$RPC ISOTHERM_STATE_DIR="$T/D" ISOTHERM_SETTLE_MODE=harness bash scripts/settle-job.sh 2>&1 | grep -E "REFUSED|exit|evidence\]") || true
echo; echo "# done $(date -u +%FT%TZ); anvil pid $ANVIL_PID stopped on exit; test labels booted out"
} 2>&1 | tee "$OUT"
