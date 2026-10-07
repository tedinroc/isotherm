#!/bin/sh
# Full evidence run of mm-plugin-isotherm inside the REAL mm 7.0.0 host, against an anvil fork of live Monad testnet.
# TEST HARNESS ONLY: MetaMask's backend is replaced by harness/stub-backend.mjs on 127.0.0.1 (it signs nothing; it
# broadcasts the host's locally signed BYOK tx to anvil). Nothing is sent to the live chain or to MetaMask.
#
#   sh harness/run-all.sh [deployments.json] [run-name]
#     default deployments: the bundled v1 deployment (assets/deployments.testnet.json)
#     e.g.  sh harness/run-all.sh assets/deployments.feasibility.json feasibility
#
# Ports (this agent's range 19250-19299): anvil 19251, stub 19288. Only PIDs started here are ever killed.
set -u
P="$(cd "$(dirname "$0")/.." && pwd)"
H="$P/harness"
DEP_IN="${1:-$P/assets/deployments.testnet.json}"
RUN="${2:-v1}"
OUT="$P/evidence/harness-$RUN"
ANVIL_PORT=19251
STUB_PORT=19288
export ANVIL_RPC="http://127.0.0.1:$ANVIL_PORT"
export PATH="$PATH:$HOME/.foundry/bin"
MMH="$H/bin/mm-harness"
HOME_H="$H/.mmhome-harness"
rm -rf "$OUT" && mkdir -p "$OUT" "$H/logs"
SUM="$OUT/SUMMARY.txt"
: > "$SUM"
n=0

stop_mine() { for f in anvil stub; do if [ -f "$H/logs/$f.pid" ]; then kill "$(cat "$H/logs/$f.pid")" 2>/dev/null; rm -f "$H/logs/$f.pid"; fi; done; sleep 1; }
start_stub() {
  env ANVIL_RPC="$ANVIL_RPC" STUB_PORT=$STUB_PORT STUB_ALLOWLIST="${1:-}" nohup node "$H/stub-backend.mjs" > "$H/logs/stub.out" 2>&1 &
  echo $! > "$H/logs/stub.pid"; sleep 1
}
# run NAME ARGS... : one plugin command in the real host, output saved verbatim
run() {
  name="$1"; shift
  n=$((n + 1)); f="$OUT/$(printf %02d $n)-$name.txt"
  echo "\$ mm $* --json" > "$f"
  t0=$(date +%s)
  "$MMH" "$@" --json >> "$f" 2>&1
  t1=$(date +%s)
  res=$(python3 - "$f" <<'PY'
import json, sys
lines = open(sys.argv[1]).read().split("\n")[1:]
docs, buf = [], None
for line in lines:
    if buf is not None:
        buf.append(line)
        if line == "}":
            try: docs.append(json.loads("\n".join(buf)))
            except Exception: pass
            buf = None
    elif line == "{":
        buf = [line]
    elif line.startswith('{"'):
        try: docs.append(json.loads(line))
        except Exception: pass
ok, code, txs = "?", "", []
for d in docs:
    if "_notice" in d:
        if d["_notice"].get("txHash"): txs.append(d["_notice"]["status"])
        continue
    if "_summary" in d: ok = "ok"; continue
    if d.get("ok") is True: ok = "ok"
    elif d.get("ok") is False: ok, code = "ERR", d["error"]["code"]
print(f"{ok} {code} txs={len(txs)}:{','.join(txs)}")
PY
)
  printf '%02d %-34s %-40s %3ss\n' "$n" "$name" "$res" "$((t1 - t0))" | tee -a "$SUM"
}

echo "== $RUN run $(date -u +%FT%TZ)  deployments: $DEP_IN" | tee -a "$SUM"
stop_mine
BLK=$(cast block-number --rpc-url https://testnet-rpc.monad.xyz)
echo "$BLK" > "$H/logs/fork-block.txt"
nohup anvil --fork-url https://testnet-rpc.monad.xyz --fork-block-number "$BLK" --network monad --port $ANVIL_PORT --chain-id 10143 > "$H/logs/anvil.log" 2>&1 &
echo $! > "$H/logs/anvil.pid"
for i in 1 2 3 4 5 6 7 8 9 10; do cast chain-id --rpc-url "$ANVIL_RPC" >/dev/null 2>&1 && break; sleep 1; done
: > "$H/logs/stub.log"
echo "anvil fork of live Monad testnet at block $BLK (--network monad) on :$ANVIL_PORT; stub on :$STUB_PORT" | tee -a "$SUM"
start_stub

# ---- fresh mm home: fake session for the local stub, setup script BEFORE `mm init`, then BYOK init
(cd "$P" && npm run build --silent >/dev/null 2>&1 && npm pack --silent >/dev/null 2>&1)
TGZ="$P/mm-plugin-isotherm-$(node -p "require('$P/package.json').version").tgz"
rm -rf "$HOME_H" && mkdir -p "$HOME_H"
python3 "$H/seed-session.py" "$HOME_H" isotherm-local > "$OUT/00-setup.txt" 2>&1
( cd "$P" && HOME="$HOME_H" MM_HOME="$HOME_H" MM="$MMH" MONAD_RPC="$ANVIL_RPC" ISOTHERM_TGZ="$TGZ" sh scripts/setup-mm-monad.sh ) >> "$OUT/00-setup.txt" 2>&1
MM_MNEMONIC="$(cat "$H/.secrets/mnemonic.txt")" "$MMH" init --wallet byok --mode guard --json >> "$OUT/00-setup.txt" 2>&1
python3 -c "
import json; d=json.load(open('$HOME_H/.metamask/wallets.json'))['data']
print('after mm init: byok', [w['address'] for w in d['byokWallets']], 'customEvmChains', [(c['chainId'], c['rpcTarget']) for c in d['customEvmChains']])" | tee -a "$OUT/00-setup.txt" "$SUM"

# ---- market scenario on the fork
FORK_BLOCK="$BLK" node "$H/fork-scenario.mjs" "$DEP_IN" "$H/fork-deployments-$RUN.json" > "$OUT/00-fork-scenario.txt" 2>&1 || { echo "scenario FAILED"; tail -20 "$OUT/00-fork-scenario.txt"; exit 1; }
tail -1 "$OUT/00-fork-scenario.txt" | tee -a "$SUM"
export ISOTHERM_DEPLOYMENTS="$H/fork-deployments-$RUN.json"
read TODAY TOMORROW M31 M30 <<EOF2
$(python3 -c "
import json; d=json.load(open('$ISOTHERM_DEPLOYMENTS'))
l=d['ladders']; t=l[0]['date']; m=l[1]
print(t, m['date'], [s for s in m['series'] if s['strikeC']==31][0]['market'], [s for s in m['series'] if s['strikeC']==30][0]['market'])")
EOF2
TOMORROW_ISO=$(python3 -c "d=str($TOMORROW); print(d[:4]+'-'+d[4:6]+'-'+d[6:])")
TODAY_ISO=$(python3 -c "d=str($TODAY); print(d[:4]+'-'+d[4:6]+'-'+d[6:])")
SPIKE_MARKET=0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A   # live Kuru v1 SpikeToken/AUSD book from the Kuru spike (not an Isotherm book)

# ---- read commands (wallet-read)
run doctor                weather doctor
run markets               weather markets
run quote-today           weather quote taipei
run quote-tomorrow        weather quote taipei --date tomorrow
run edge-tomorrow         weather edge taipei --date tomorrow
# ---- trades (wallet-read + wallet-submit, every write through ctx.walletExecutor)
run buy-yes-dryrun        weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.52 --dry-run
run buy-yes               weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.52
run buy-no                weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.2
run buy-no-locked-refused weather buy taipei --strike 28 --side no --amount 10 --max-price 0.2
run buy-yes-today-max     weather buy taipei --strike 29 --side yes --amount 5 --max-price 0.08 --approve max
run buy-no-today          weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9995
run buy-yes-locked-today  weather buy taipei --strike 27 --side yes --amount 5 --max-price 0.999
run sell-yes              weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.43
run sell-no               weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.08
run buy-yes-31            weather buy taipei --date tomorrow --strike 31 --side yes --amount 3 --max-price 0.15
run buy-no-31             weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.95
run positions             weather positions
run redeem-merge          weather redeem taipei --date "$TOMORROW_ISO" --strike 31 --merge
# ---- generic Kuru v1 CLOB
run kuru-book             kuru book "$M31" --depth 3
run kuru-limit-buy        kuru limit "$M31" --side buy --price 0.07 --size 30
run kuru-limit-offtick    kuru limit "$M31" --side sell --price 0.1305 --size 5
run kuru-cancel-notmine   kuru cancel "$M31" --order 1
run kuru-cancel-all       kuru cancel "$M31" --all --withdraw
run kuru-book-spike       kuru book "$SPIKE_MARKET" --depth 3
run kuru-limit-spike      kuru limit "$SPIKE_MARKET" --side buy --price 0.3 --size 10
run kuru-cancel-spike     kuru cancel "$SPIKE_MARKET" --all --withdraw
# ---- guards that must refuse BEFORE signing, and host-side failure mapping
run hostile-market-refused weather buy taipei --date tomorrow --strike 30 --side yes --amount 5 --max-price 0.6 --market "$M31"
stop_stub() { kill "$(cat "$H/logs/stub.pid")" 2>/dev/null; rm -f "$H/logs/stub.pid"; sleep 1; }
stop_stub; start_stub 0x000000000000000000000000000000000000dEaD
run policy-denied         weather buy taipei --date tomorrow --strike 30 --side yes --amount 5 --max-price 0.6 --approve max
stop_stub; start_stub
cp "$HOME_H/.metamask/wallets.json" "$HOME_H/.metamask/wallets.json.bak"
python3 -c "
import json; p='$HOME_H/.metamask/wallets.json'; d=json.load(open(p)); d['data']['customEvmChains']=[]; json.dump(d,open(p,'w'))"
export ISOTHERM_RPC_URL="$ANVIL_RPC"   # reads still work; only the executor loses its 10143 RPC
run gateway-400-mapped    weather buy taipei --date tomorrow --strike 30 --side yes --amount 5 --max-price 0.6
unset ISOTHERM_RPC_URL
mv "$HOME_H/.metamask/wallets.json.bak" "$HOME_H/.metamask/wallets.json"
# ---- settlement (fork-only attestation) and redemption
n=$((n + 1)); node "$H/settle-fork.mjs" "$ISOTHERM_DEPLOYMENTS" RCSS "$TODAY" 28 > "$OUT/$(printf %02d $n)-settle-fork.txt" 2>&1
printf '%02d %-34s %s\n' "$n" "settle-fork (harness, not a plugin cmd)" "$(grep -o 'ReportProcessed.result=[a-z]*' "$OUT/$(printf %02d $n)-settle-fork.txt")" | tee -a "$SUM"
run markets-all-settled   weather markets taipei --date "$TODAY_ISO"
run positions-redeemable  weather positions
run redeem                weather redeem taipei --date "$TODAY_ISO"
run positions-after       weather positions

# ---- tally from the stub (every tx the host submitted for signing/broadcast)
python3 - "$H/logs/stub.log" <<'PY' | tee -a "$SUM"
import json, sys
st = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
req = [x for x in st if x["kind"] == "tx-request"]
conf = {x["requestId"] for x in st if x["kind"] == "tx-status" and x.get("status") == "CONFIRMED"}
den = [x for x in st if x["kind"] == "tx-denied"]
print(f"stub: {len(req)} signed tx requests, {len(conf)} CONFIRMED, {len(den)} denied by the toy Guard allowlist")
PY
cp "$H/logs/stub.log" "$OUT/stub.log"
cp "$ISOTHERM_DEPLOYMENTS" "$OUT/fork-deployments.json"
echo "evidence: $OUT"
stop_mine
