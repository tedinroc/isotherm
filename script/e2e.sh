#!/usr/bin/env bash
# Isotherm core critical path as REAL transactions:
#   deploy -> create Taipei ladder -> faucet AUSD -> mintSet -> gasless permit mint (relayed) -> trade (transfer)
#   -> forged CRE report rejected -> attested CRE report via the real MockKeystoneForwarder -> replay rejected
#   -> redeem.
# Signatures (EIP-2612 permit on AUSD, EIP-712 settlement attestation) are produced by `cast wallet sign --data`,
# i.e. independently of the Solidity code, so a digest mismatch would fail here.
#
# MODE=anvil (default): against an anvil fork of Monad testnet. Uses anvil_setBalance + time travel.
#   anvil --fork-url https://testnet-rpc.monad.xyz --port 18947 &   (anvil auto-detects network=monad, MonadTen)
#   RPC=http://127.0.0.1:18947 script/e2e.sh
# MODE=live: against the real testnet (needs MON on deployer/maker/taker1/taker2). No cheats, so it stops after
#   minting and prints the settle command to run once the Taipei day has ended.
#
# Keys are read from $KEYDIR/{deployer,maker,taker1,taker2}.key and never printed. The attester key is a fresh
# throwaway generated per run (override with ATTESTER_KEY_FILE).
set -euo pipefail

MODE=${MODE:-anvil}
RPC=${RPC:-http://127.0.0.1:18947}
KEYDIR=${KEYDIR:-$HOME/.config/isotherm}
OUT=${OUT:-$(mktemp -d)}
TMAX=${TMAX:-31}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$PATH:$HOME/.foundry/bin"

AUSD=0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC
FAUCET=0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C
MOCK_FWD=0xB9F79d863261869B234c481D1f9A7af84AeAd192
STATION=0x52435353 # "RCSS"
TPE_OFFSET=28800

key() { tr -d '\n' < "$KEYDIR/$1.key"; }
DEPLOYER_KEY=$(key deployer); MAKER_KEY=$(key maker); TAKER1_KEY=$(key taker1); TAKER2_KEY=$(key taker2)
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
MAKER=$(cast wallet address --private-key "$MAKER_KEY")
TAKER1=$(cast wallet address --private-key "$TAKER1_KEY")
TAKER2=$(cast wallet address --private-key "$TAKER2_KEY")
if [[ -n "${ATTESTER_KEY_FILE:-}" ]]; then ATTESTER_KEY=$(tr -d '\n' < "$ATTESTER_KEY_FILE"); else
  ATTESTER_KEY=$(cast wallet new --json | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d.get("data",d) if isinstance(d,dict) else d; print(d[0]["private_key"])'); fi
ATTESTER=$(cast wallet address --private-key "$ATTESTER_KEY")
CHAIN=$(cast chain-id --rpc-url "$RPC")
[[ "$CHAIN" == "10143" ]] || { echo "refusing: chain $CHAIN is not Monad testnet 10143"; exit 1; }

GAS_TSV="$OUT/gas.tsv"; echo -e "step\tgasUsed\tgasLimit\tstatus\ttx" > "$GAS_TSV"
log() { echo "[$(date +%H:%M:%S)] $*"; }
# Foundry >=1.8 wraps --json output in {"schema_version","success","data",...}; unwrap it.
unwrap='d=json.load(sys.stdin); d=d["data"] if isinstance(d,dict) and "schema_version" in d else d'
jget() { python3 -c "import json,sys; $unwrap; print(d$1)"; }

# send <step> <key> <to> <sig> [args...]  -> records gas, echoes receipt json path
send() {
  local step=$1 k=$2; shift 2
  local r; r=$(cast send --rpc-url "$RPC" --private-key "$k" --json "$@")
  local f="$OUT/$step.json"; echo "$r" | python3 -c "import json,sys; $unwrap; json.dump(d,sys.stdout)" > "$f"
  local h gu st gl
  h=$(echo "$r" | jget "['transactionHash']"); gu=$(echo "$r" | jget "['gasUsed']"); st=$(echo "$r" | jget "['status']")
  gl=$(cast tx "$h" gas --rpc-url "$RPC")
  echo -e "$step\t$((gu))\t$gl\t$st\t$h" >> "$GAS_TSV"
  [[ "$st" == "0x1" ]] || { echo "tx $step failed: $h"; exit 1; }
  echo "$f"
}

log "mode=$MODE rpc=$RPC chain=$CHAIN out=$OUT"
log "deployer=$DEPLOYER maker(operator,relayer)=$MAKER taker1=$TAKER1 taker2=$TAKER2 attester=$ATTESTER"

if [[ "$MODE" == "anvil" ]]; then
  for a in $DEPLOYER $MAKER $TAKER1 $TAKER2; do cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null; done
  log "anvil: funded 100 MON each"
fi
for a in $DEPLOYER $MAKER $TAKER1 $TAKER2; do log "MON $a = $(cast balance "$a" --ether --rpc-url "$RPC")"; done

# ---- 1. deploy --------------------------------------------------------------------------------
log "1. deploy (forge script)"
(cd "$ROOT" && ATTESTER=$ATTESTER OPERATOR=$MAKER FOUNDRY_BROADCAST="$OUT/broadcast" \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER_KEY" --slow \
  > "$OUT/deploy.log" 2>&1) || { tail -30 "$OUT/deploy.log"; exit 1; }
RUN=$(ls "$OUT"/broadcast/Deploy.s.sol/"$CHAIN"/run-latest.json)
RESOLVER=$(python3 -c "import json; t=json.load(open('$RUN'))['transactions']; print([x['contractAddress'] for x in t if x['contractName']=='Resolver'][0])")
VAULT=$(python3 -c "import json; t=json.load(open('$RUN'))['transactions']; print([x['contractAddress'] for x in t if x['contractName']=='CollateralVault'][0])")
python3 -c "
import json; t=json.load(open('$RUN'))['transactions']
for x in t: print(x['hash'], 'deploy:'+(('new '+x['contractName']) if x['transactionType']=='CREATE' else x['function'].split('(')[0]))
" | while read -r H NAME; do
  echo -e "$NAME\t$(cast receipt "$H" gasUsed --rpc-url "$RPC")\t$(cast tx "$H" gas --rpc-url "$RPC")\t$(cast receipt "$H" status --rpc-url "$RPC")\t$H" >> "$GAS_TSV"
done
log "Resolver=$RESOLVER Vault=$VAULT"

# ---- 2. ladder for the current Taipei day (or tomorrow if <45 min to close) ----------------------
NOW=$(cast block latest --field timestamp --rpc-url "$RPC")
read DATE DAYEND <<<"$(python3 - "$NOW" "$TPE_OFFSET" <<'PY'
import sys,datetime as dt
now,off=int(sys.argv[1]),int(sys.argv[2])
d=dt.datetime.utcfromtimestamp(now+off).date()
end=int(dt.datetime(d.year,d.month,d.day,tzinfo=dt.timezone.utc).timestamp())-off+86400
if end-3600-now<2700: d=d+dt.timedelta(days=1); end+=86400
print(d.strftime('%Y%m%d'), end)
PY
)"
[[ "$(cast call "$RESOLVER" 'dayEnd(bytes4,uint32)(uint256)' $STATION "$DATE" --rpc-url "$RPC" | cut -d' ' -f1)" == "$DAYEND" ]] \
  || { echo "dayEnd mismatch between python and contract"; exit 1; }
CLOSE=$((DAYEND - 600))
log "2. createLadder RCSS date=$DATE dayEnd=$DAYEND close=$CLOSE (now=$NOW)"
send createLadder6 "$MAKER_KEY" "$VAULT" "createLadder(bytes4,uint32,int16[],uint64)" $STATION "$DATE" "[27,28,29,30,31,32]" "$CLOSE" >/dev/null
ID30=$(cast call "$VAULT" "seriesIdOf(bytes4,uint32,int16)(bytes32)" $STATION "$DATE" 30 --rpc-url "$RPC")
ID32=$(cast call "$VAULT" "seriesIdOf(bytes4,uint32,int16)(bytes32)" $STATION "$DATE" 32 --rpc-url "$RPC")
YES30=$(cast call "$VAULT" "predictTokenAddress(bytes4,uint32,int16,bool)(address)" $STATION "$DATE" 30 true --rpc-url "$RPC")
NO30=$(cast call "$VAULT" "predictTokenAddress(bytes4,uint32,int16,bool)(address)" $STATION "$DATE" 30 false --rpc-url "$RPC")
log "YES>=30 $YES30 $(cast call "$YES30" 'symbol()(string)' --rpc-url "$RPC") | NO $NO30"
send createSeries1 "$MAKER_KEY" "$VAULT" "createSeries(bytes4,uint32,int16,uint64)" $STATION "$DATE" 33 "$CLOSE" >/dev/null

# ---- 3. faucet + mintSet (taker1) ---------------------------------------------------------------
log "3. faucet requestFunds + approve + mintSet 100 AUSD (taker1)"
# The AUSD faucet has a GLOBAL 60 s cooldown: requestFunds reverts with MaxFrequencyExceeded() (0x20e5bc67) until
# 60 s after the previous request by anyone (measured on the fork). Wait it out and retry.
faucet() { # $1=step $2=key $3=addr
  local i
  for i in 1 2 3 4 5 6; do
    if cast estimate $FAUCET "requestFunds(address)" "$3" --from "$3" --rpc-url "$RPC" >/dev/null 2>&1; then
      send "$1" "$2" $FAUCET "requestFunds(address)" "$3" >/dev/null; return 0; fi
    log "faucet busy (MaxFrequencyExceeded), retry $i"
    if [[ "$MODE" == "anvil" ]]; then cast rpc evm_increaseTime 61 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null; else sleep 61; fi
  done
  echo "faucet kept failing"; exit 1
}
faucet faucet "$TAKER1_KEY" "$TAKER1"
faucet faucet2 "$TAKER2_KEY" "$TAKER2"
log "taker1 AUSD=$(cast call $AUSD 'balanceOf(address)(uint256)' "$TAKER1" --rpc-url "$RPC")"
send approve "$TAKER1_KEY" $AUSD "approve(address,uint256)" "$VAULT" 1000000000 >/dev/null
send mintSet "$TAKER1_KEY" "$VAULT" "mintSet(bytes32,uint256)" "$ID30" 100000000 >/dev/null
send mintSet_2nd "$TAKER1_KEY" "$VAULT" "mintSet(bytes32,uint256)" "$ID30" 100000000 >/dev/null

# ---- 4. gasless mint: taker2 signs an AUSD EIP-2612 permit with cast, maker relays ---------------
log "4. permit-relayed mint (taker2 signs with cast, maker submits)"
NONCE=$(cast call $AUSD 'nonces(address)(uint256)' "$TAKER2" --rpc-url "$RPC" | cut -d' ' -f1)
DEADLINE=$((NOW + 7200))
cat > "$OUT/permit.json" <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]},
"primaryType":"Permit","domain":{"name":"Agora Dollar","version":"1","chainId":$CHAIN,"verifyingContract":"$AUSD"},
"message":{"owner":"$TAKER2","spender":"$VAULT","value":"50000000","nonce":"$NONCE","deadline":"$DEADLINE"}}
JSON
SIG=$(cast wallet sign --data --from-file "$OUT/permit.json" --private-key "$TAKER2_KEY")
R=0x${SIG:2:64}; S=0x${SIG:66:64}; V=$((16#${SIG:130:2}))
send mintSetWithPermit "$MAKER_KEY" "$VAULT" "mintSetWithPermit(bytes32,uint256,address,uint256,uint8,bytes32,bytes32)" \
  "$ID30" 50000000 "$TAKER2" "$DEADLINE" "$V" "$R" "$S" >/dev/null
log "taker2 YES30=$(cast call "$YES30" 'balanceOf(address)(uint256)' "$TAKER2" --rpc-url "$RPC") (minted by relayer, paid by taker2)"

# ---- 5. a 'trade': taker1 sells 60 NO to taker2 (stand-in for a Kuru fill) -------------------------
send transferNO "$TAKER1_KEY" "$NO30" "transfer(address,uint256)" "$TAKER2" 60000000 >/dev/null
send redeemSet "$TAKER1_KEY" "$VAULT" "redeemSet(bytes32,uint256)" "$ID30" 10000000 >/dev/null

if [[ "$MODE" != "anvil" ]]; then
  log "LIVE mode: settlement must wait until dayEnd=$DAYEND ($(date -r "$DAYEND" -u)). Re-run the settle steps then."
  cat "$GAS_TSV"; exit 0
fi

# ---- 6. time travel past the Taipei day end ------------------------------------------------------
cast rpc evm_setNextBlockTimestamp $((DAYEND + 600)) --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
log "6. clock -> $(cast block latest --field timestamp --rpc-url "$RPC") (dayEnd+600)"

# ---- 7. CRE settlement through the real MockKeystoneForwarder ------------------------------------
SRC=$(cast keccak "iem:RCSS:$DATE:max=$TMAX|awc:RCSS:$DATE:max=$TMAX")
settle_json() { # $1=tmax
cat <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"Settlement":[{"name":"station","type":"bytes4"},{"name":"date","type":"uint32"},{"name":"tmaxC","type":"int16"},{"name":"isVoid","type":"bool"},{"name":"sourcesHash","type":"bytes32"}]},
"primaryType":"Settlement","domain":{"name":"Isotherm Resolver","version":"1","chainId":$CHAIN,"verifyingContract":"$RESOLVER"},
"message":{"station":"$STATION","date":$DATE,"tmaxC":$1,"isVoid":false,"sourcesHash":"$SRC"}}
JSON
}
settle_json "$TMAX" > "$OUT/settlement.json"
ATT=$(cast wallet sign --data --from-file "$OUT/settlement.json" --private-key "$ATTESTER_KEY")
# cross-check: contract digest signed raw must give the identical (RFC 6979) signature
DIGEST=$(cast call "$RESOLVER" "settlementDigest(bytes4,uint32,int16,bool,bytes32)(bytes32)" $STATION "$DATE" "$TMAX" false "$SRC" --rpc-url "$RPC")
ATT_RAW=$(cast wallet sign --no-hash "$DIGEST" --private-key "$ATTESTER_KEY")
[[ "$ATT" == "$ATT_RAW" ]] && log "7. EIP-712: cast typed-data signature == signature over contract settlementDigest ($DIGEST)" \
  || { echo "EIP-712 digest mismatch"; exit 1; }

raw_report() { # $1=payload hex, $2=executionId. Keystone layout: version(1)|execId(32)|ts(4)|donId(4)|donCfg(4)|
  # workflowCid(32)|workflowName(10)|workflowOwner(20)|reportId(2)|report
  local ts; ts=$(cast block latest --field timestamp --rpc-url "$RPC")
  cast concat-hex 0x01 "$2" "$(printf '0x%08x' "$ts")" 0x00000001 0x00000001 \
    "0x$(printf '0%.0s' {1..64})" "0x$(printf '0%.0s' {1..20})" "0x$(printf '0%.0s' {1..40})" 0x0000 "$1"
}
TOPIC_RP=$(cast keccak "ReportProcessed(address,bytes32,bytes2,bool)")
rp_result() { python3 -c "
import json,sys; r=json.load(open('$1'))
for l in r['logs']:
    if l['address'].lower()=='$MOCK_FWD'.lower() and l['topics'][0]=='$TOPIC_RP': print('success' if int(l['data'],16)==1 else 'REJECTED'); break
else: print('no-event')"; }

# 7a forged (wrong signer)
EVIL=$(cast wallet new --json | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d.get("data",d) if isinstance(d,dict) else d; print(d[0]["private_key"])')
settle_json 35 > "$OUT/forged.json"
FSIG=$(cast wallet sign --data --from-file "$OUT/forged.json" --private-key "$EVIL")
FPAY=$(cast abi-encode "f(bytes4,uint32,int16,bool,bytes32,bytes)" $STATION "$DATE" 35 false "$SRC" "$FSIG")
F=$(send cre_forged "$TAKER2_KEY" $MOCK_FWD "report(address,bytes,bytes,bytes[])" "$RESOLVER" "$(raw_report "$FPAY" "$(cast keccak forged)")" 0x "[]")
log "7a. forged report via MockKeystoneForwarder (sent by an arbitrary EOA): ReportProcessed=$(rp_result "$F")"

# 7b attested
PAY=$(cast abi-encode "f(bytes4,uint32,int16,bool,bytes32,bytes)" $STATION "$DATE" "$TMAX" false "$SRC" "$ATT")
G=$(send cre_settle "$TAKER2_KEY" $MOCK_FWD "report(address,bytes,bytes,bytes[])" "$RESOLVER" "$(raw_report "$PAY" "$(cast keccak good)")" 0x "[]")
log "7b. attested report: ReportProcessed=$(rp_result "$G") result=$(cast call "$RESOLVER" 'resultOf(bytes4,uint32)((uint8,int16,uint64,bytes32))' $STATION "$DATE" --rpc-url "$RPC")"

# 7c replay
P=$(send cre_replay "$TAKER2_KEY" $MOCK_FWD "report(address,bytes,bytes,bytes[])" "$RESOLVER" "$(raw_report "$PAY" "$(cast keccak replay)")" 0x "[]")
log "7c. replayed report: ReportProcessed=$(rp_result "$P")"

# ---- 8. redeem -----------------------------------------------------------------------------------
log "8. redeem (Tmax=$TMAX vs strike 30)"
B1=$(cast call $AUSD 'balanceOf(address)(uint256)' "$TAKER1" --rpc-url "$RPC" | cut -d' ' -f1)
Y1=$(cast call "$YES30" 'balanceOf(address)(uint256)' "$TAKER1" --rpc-url "$RPC" | cut -d' ' -f1)
N1=$(cast call "$NO30" 'balanceOf(address)(uint256)' "$TAKER1" --rpc-url "$RPC" | cut -d' ' -f1)
send redeem_taker1 "$TAKER1_KEY" "$VAULT" "redeem(bytes32,uint256,uint256)" "$ID30" "$Y1" "$N1" >/dev/null
A1=$(cast call $AUSD 'balanceOf(address)(uint256)' "$TAKER1" --rpc-url "$RPC" | cut -d' ' -f1)
Y2=$(cast call "$YES30" 'balanceOf(address)(uint256)' "$TAKER2" --rpc-url "$RPC" | cut -d' ' -f1)
N2=$(cast call "$NO30" 'balanceOf(address)(uint256)' "$TAKER2" --rpc-url "$RPC" | cut -d' ' -f1)
B2=$(cast call $AUSD 'balanceOf(address)(uint256)' "$TAKER2" --rpc-url "$RPC" | cut -d' ' -f1)
send redeem_taker2 "$TAKER2_KEY" "$VAULT" "redeem(bytes32,uint256,uint256)" "$ID30" "$Y2" "$N2" >/dev/null
A2=$(cast call $AUSD 'balanceOf(address)(uint256)' "$TAKER2" --rpc-url "$RPC" | cut -d' ' -f1)
log "taker1 burned YES=$Y1 NO=$N1 -> +$((A1 - B1)) AUSD units; taker2 burned YES=$Y2 NO=$N2 -> +$((A2 - B2))"
log "vault AUSD left=$(cast call $AUSD 'balanceOf(address)(uint256)' "$VAULT" --rpc-url "$RPC") series30 collateral=$(cast call "$VAULT" 'getSeries(bytes32)((bytes4,uint32,int16,uint64,address,address,uint256))' "$ID30" --rpc-url "$RPC" | tr -d '()' | awk -F', ' '{print $7}')"
log "strike 32 payoutHalves=$(cast call "$VAULT" 'payoutHalves(bytes32)(uint256,uint256)' "$ID32" --rpc-url "$RPC" | tr '\n' ' ')"

echo; column -t -s $'\t' "$GAS_TSV"
log "artifacts in $OUT"
