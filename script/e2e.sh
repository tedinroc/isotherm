#!/usr/bin/env bash
# Isotherm v1 critical path as REAL transactions against the DEPLOYED v1 contracts (deployments/testnet.json),
# on an anvil fork of live Monad testnet (anvil_setBalance + time travel; nothing reaches the real chain):
#   operator creates RCSS + RJTT ladders -> faucet AUSD -> maker mints, creates a Kuru YES/AUSD book, posts an ask
#   -> operator registers it as the Zap's canonical market (a hostile registration is refused)
#   -> taker1 signs an EIP-3009 ReceiveWithAuthorization bound to (series, amount, salt); operator relays the mint
#      (re-targeting it to another series is refused) -> taker1 buys YES through the Zap
#   -> day ends -> attester-signed report via the real MockKeystoneForwarder (forged + expired reports rejected)
#   -> redeem refused inside the 15-min challenge window, paid after it
#   -> RJTT: guardian challenges a settled result inside the window -> void pays 0.5/0.5.
# Every signature (EIP-712 Settlement, EIP-3009) is produced by `cast wallet sign --data`, independent of Solidity.
#
#   anvil --fork-url https://testnet-rpc.monad.xyz --port 19101 &
#   RPC=http://127.0.0.1:19101 script/e2e.sh
set -euo pipefail

RPC=${RPC:-http://127.0.0.1:19101}
KEYDIR=${KEYDIR:-$HOME/.config/isotherm}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-$ROOT/script/evidence/e2e-v1}
mkdir -p "$OUT"
export PATH="$PATH:$HOME/.foundry/bin"
DEP="$ROOT/deployments/testnet.json"
j() { python3 -c "import json; print(json.load(open('$DEP'))$1)"; }
AUSD=$(j "['ausd']"); FAUCET=$(j "['ausdFaucet']"); MOCK_FWD=$(j "['mockForwarder']"); ROUTER=$(j "['kuruRouter']")
MARGIN=$(j "['kuruMarginAccount']"); RESOLVER=$(j "['resolver']"); VAULT=$(j "['vault']"); ZAP=$(j "['zap']")
RCSS=0x52435353; RJTT=0x524a5454

key() { tr -d '\n' < "$KEYDIR/$1.key"; }
OPERATOR_KEY=$(key operator); ATTESTER_KEY=$(key attester); GUARDIAN_KEY=$(key guardian)
MAKER_KEY=$(key maker); TAKER1_KEY=$(key taker1); TAKER2_KEY=$(key taker2)
OPERATOR=$(cast wallet address --private-key "$OPERATOR_KEY"); ATTESTER=$(cast wallet address --private-key "$ATTESTER_KEY")
GUARDIAN=$(cast wallet address --private-key "$GUARDIAN_KEY"); MAKER=$(cast wallet address --private-key "$MAKER_KEY")
TAKER1=$(cast wallet address --private-key "$TAKER1_KEY"); TAKER2=$(cast wallet address --private-key "$TAKER2_KEY")
CHAIN=$(cast chain-id --rpc-url "$RPC")
[[ "$CHAIN" == "10143" ]] || { echo "refusing: chain $CHAIN"; exit 1; }
[[ "$(cast rpc anvil_nodeInfo --rpc-url "$RPC" 2>/dev/null | head -c 1)" == "{" ]] || { echo "refusing: $RPC is not anvil (this script time-travels)"; exit 1; }

GAS_TSV="$OUT/gas.tsv"; echo -e "step\tgasUsed\tstatus\ttx" > "$GAS_TSV"
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
unwrap='d=json.load(sys.stdin); d=d["data"] if isinstance(d,dict) and "schema_version" in d else d'
send() { # send <step> <key> <to> <sig> [args...] -> receipt json path
  local step=$1 k=$2; shift 2
  local r; r=$(cast send --rpc-url "$RPC" --private-key "$k" --json "$@")
  local f="$OUT/$step.json"; echo "$r" | python3 -c "import json,sys; $unwrap; json.dump(d,sys.stdout)" > "$f"
  python3 - "$f" "$step" >> "$GAS_TSV" <<'PY'
import json,sys; d=json.load(open(sys.argv[1])); print(f"{sys.argv[2]}\t{int(d['gasUsed'],16)}\t{d['status']}\t{d['transactionHash']}")
PY
  [[ "$(python3 -c "import json; print(json.load(open('$f'))['status'])")" == "0x1" ]] || { echo "tx $step failed"; exit 1; }
  echo "$f"
}
expect_revert() { # expect_revert <label> <from> <to> <sig> [args...]: eth_call must revert
  local label=$1 from=$2; shift 2
  if out=$(cast call --rpc-url "$RPC" --from "$from" "$@" 2>&1); then echo "UNEXPECTED SUCCESS: $label"; exit 1; fi
  log "   refused as expected: $label -> $(echo "$out" | grep -oE '(custom error [^,]*|[A-Z][A-Za-z]+\([^)]*\)|FiatTokenV2: [a-z ]+)' | head -1)"
}
now() { cast block latest --field timestamp --rpc-url "$RPC"; }
warp_to() { cast rpc evm_setNextBlockTimestamp "$1" --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null; }
call1() { cast call --rpc-url "$RPC" "$@" | head -1 | cut -d' ' -f1; }

log "rpc=$RPC resolver=$RESOLVER vault=$VAULT zap=$ZAP"
VAULT_START=$(cast call --rpc-url "$RPC" "$AUSD" 'balanceOf(address)(uint256)' "$VAULT" | cut -d' ' -f1)
for a in $OPERATOR $ATTESTER $GUARDIAN $MAKER $TAKER1 $TAKER2; do cast rpc anvil_setBalance "$a" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null; done

# ---- 1. ladders (operator) ---------------------------------------------------------------------------------
NOW=$(now)
read -r DATE DAYEND JDAYEND <<<"$(python3 - "$NOW" <<'PY'
import sys, datetime as dt
now = int(sys.argv[1])
# a date 3 days out, so this run never collides with ladders the go-live job may have created on the live chain
d = dt.datetime.utcfromtimestamp(now + 8*3600).date() + dt.timedelta(days=3)
end = int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp()) - 8*3600 + 86400
print(d.strftime('%Y%m%d'), end, end - 3600)
PY
)"
[[ "$(call1 "$RESOLVER" 'dayEnd(bytes4,uint32)(uint256)' $RCSS "$DATE")" == "$DAYEND" ]] || { echo "dayEnd mismatch"; exit 1; }
[[ "$(call1 "$RESOLVER" 'dayEnd(bytes4,uint32)(uint256)' $RJTT "$DATE")" == "$JDAYEND" ]] || { echo "RJTT dayEnd mismatch"; exit 1; }
log "1. createLadder RCSS $DATE [28,29,30] + RJTT $DATE [20] (operator), dayEnd RCSS=$DAYEND RJTT=$JDAYEND"
send createLadder3 "$OPERATOR_KEY" "$VAULT" "createLadder(bytes4,uint32,int16[],uint64)" $RCSS "$DATE" "[28,29,30]" $((DAYEND - 600)) >/dev/null
send createLadderRJTT "$OPERATOR_KEY" "$VAULT" "createLadder(bytes4,uint32,int16[],uint64)" $RJTT "$DATE" "[20]" $((JDAYEND - 600)) >/dev/null
ID29=$(call1 "$VAULT" "seriesIdOf(bytes4,uint32,int16)(bytes32)" $RCSS "$DATE" 29)
ID30=$(call1 "$VAULT" "seriesIdOf(bytes4,uint32,int16)(bytes32)" $RCSS "$DATE" 30)
IDJ=$(call1 "$VAULT" "seriesIdOf(bytes4,uint32,int16)(bytes32)" $RJTT "$DATE" 20)
YES29=$(call1 "$VAULT" "predictTokenAddress(bytes4,uint32,int16,bool)(address)" $RCSS "$DATE" 29 true)
YES30=$(call1 "$VAULT" "predictTokenAddress(bytes4,uint32,int16,bool)(address)" $RCSS "$DATE" 30 true)
YESJ=$(call1 "$VAULT" "predictTokenAddress(bytes4,uint32,int16,bool)(address)" $RJTT "$DATE" 20 true)
NOJ=$(call1 "$VAULT" "predictTokenAddress(bytes4,uint32,int16,bool)(address)" $RJTT "$DATE" 20 false)
log "   YES>=29 $YES29 $(cast call --rpc-url "$RPC" "$YES29" 'symbol()(string)')"

# ---- 2. faucet (global 60 s cooldown) ------------------------------------------------------------------------
faucet() { local i; for i in 1 2 3 4; do
  if cast estimate $FAUCET "requestFunds(address)" "$2" --from "$2" --rpc-url "$RPC" >/dev/null 2>&1; then send "faucet_$1" "$3" $FAUCET "requestFunds(address)" "$2" >/dev/null; return; fi
  cast rpc evm_increaseTime 61 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null; done; echo "faucet failed"; exit 1; }
faucet maker "$MAKER" "$MAKER_KEY"; faucet taker1 "$TAKER1" "$TAKER1_KEY"
log "2. faucet: maker $(call1 $AUSD 'balanceOf(address)(uint256)' "$MAKER"), taker1 $(call1 $AUSD 'balanceOf(address)(uint256)' "$TAKER1") AUSD units"

# ---- 3. maker inventory + Kuru book + canonical registration -------------------------------------------------
send approveVault "$MAKER_KEY" $AUSD "approve(address,uint256)" "$VAULT" 1000000000000 >/dev/null
send mintSet29 "$MAKER_KEY" "$VAULT" "mintSet(bytes32,uint256)" "$ID29" 300000000 >/dev/null
send mintSetRJTT "$MAKER_KEY" "$VAULT" "mintSet(bytes32,uint256)" "$IDJ" 10000000 >/dev/null
DP="deployProxy(uint8,address,address,uint96,uint32,uint32,uint96,uint96,uint256,uint256,uint96)"
MKT=$(cast call --rpc-url "$RPC" --from "$MAKER" $ROUTER "$DP(address)" 0 "$YES29" $AUSD 1000000 10000 10 1000000 1000000000000 10 0 100)
send kuruDeployProxy "$MAKER_KEY" $ROUTER "$DP" 0 "$YES29" $AUSD 1000000 10000 10 1000000 1000000000000 10 0 100 >/dev/null
log "3. Kuru YES>=29/AUSD market $MKT (pricePrecision 1e4, sizePrecision 1e6, taker fee 10 bps)"
HOSTILE=$(cast call --rpc-url "$RPC" --from "$TAKER2" $ROUTER "$DP(address)" 0 "$YES29" $AUSD 1000000 10000 10 1000000 1000000000000 9000 0 100)
send kuruHostileBook "$TAKER2_KEY" $ROUTER "$DP" 0 "$YES29" $AUSD 1000000 10000 10 1000000 1000000000000 9000 0 100 >/dev/null
log "   hostile 90%-fee book on the same YES: $HOSTILE (validateMarket=$(call1 "$ZAP" 'validateMarket(bytes32,address)(bool)' "$ID29" "$HOSTILE"))"
expect_revert "taker2 registers a canonical market" "$TAKER2" "$ZAP" "setCanonicalMarket(bytes32,address)" "$ID29" "$MKT"
expect_revert "operator registers the hostile book" "$OPERATOR" "$ZAP" "setCanonicalMarket(bytes32,address)" "$ID29" "$HOSTILE"
send setCanonicalMarket "$OPERATOR_KEY" "$ZAP" "setCanonicalMarket(bytes32,address)" "$ID29" "$MKT" >/dev/null
expect_revert "re-registration (write-once)" "$OPERATOR" "$ZAP" "setCanonicalMarket(bytes32,address)" "$ID29" "$HOSTILE"
log "   canonicalMarket(YES>=29) = $(call1 "$ZAP" 'canonicalMarket(bytes32)(address)' "$ID29")"
send approveMarginYes "$MAKER_KEY" "$YES29" "approve(address,uint256)" $MARGIN 1000000000000 >/dev/null
send marginDepositYes "$MAKER_KEY" $MARGIN "deposit(address,address,uint256)" "$MAKER" "$YES29" 200000000 >/dev/null
send makerAsk "$MAKER_KEY" "$MKT" "batchUpdate(uint32[],uint96[],uint32[],uint96[],uint40[],bool)" "[]" "[]" "[5000]" "[100000000]" "[]" true >/dev/null
log "   maker ask: 100 YES @ 0.50"

# ---- 4. EIP-3009 relayed mint bound to (series, amount, salt) -------------------------------------------------
SALT=$(cast keccak "e2e-salt-$(date +%s)")
NONCE=$(call1 "$VAULT" "mintAuthorizationNonce(bytes32,uint256,bytes32)(bytes32)" "$ID30" 50000000 "$SALT")
[[ "$NONCE" == "$(cast keccak "$(cast abi-encode 'f(bytes32,uint256,bytes32)' "$ID30" 50000000 "$SALT")")" ]] || { echo "nonce formula mismatch"; exit 1; }
VB=$(( $(now) + 3600 ))
cat > "$OUT/auth.json" <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"ReceiveWithAuthorization":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"validAfter","type":"uint256"},{"name":"validBefore","type":"uint256"},{"name":"nonce","type":"bytes32"}]},
"primaryType":"ReceiveWithAuthorization","domain":{"name":"Agora Dollar","version":"1","chainId":10143,"verifyingContract":"$AUSD"},
"message":{"from":"$TAKER1","to":"$VAULT","value":"50000000","validAfter":"0","validBefore":"$VB","nonce":"$NONCE"}}
JSON
ASIG=$(cast wallet sign --data --from-file "$OUT/auth.json" --private-key "$TAKER1_KEY")
AR=0x${ASIG:2:64}; AS=0x${ASIG:66:64}; AV=$((16#${ASIG:130:2}))
M3009="mintSetWithAuthorization(bytes32,uint256,address,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
expect_revert "front-runner re-targets the authorization to YES>=29" "$TAKER2" "$VAULT" "$M3009" "$ID29" 50000000 "$TAKER1" 0 "$VB" "$SALT" $AV "$AR" "$AS"
send mintSetWithAuthorization "$OPERATOR_KEY" "$VAULT" "$M3009" "$ID30" 50000000 "$TAKER1" 0 "$VB" "$SALT" $AV "$AR" "$AS" >/dev/null
log "4. relayed EIP-3009 mint: taker1 YES>=30 = $(call1 "$YES30" 'balanceOf(address)(uint256)' "$TAKER1") (taker1 sent no tx)"

# ---- 5. Zap buyYes on the canonical book --------------------------------------------------------------------
send approveZap "$TAKER1_KEY" $AUSD "approve(address,uint256)" "$ZAP" 1000000000000 >/dev/null
expect_revert "Zap via the hostile book" "$TAKER1" "$ZAP" "buyYes(bytes32,address,uint256,uint256,address)" "$ID29" "$HOSTILE" 10000000 1 "$TAKER1"
expect_revert "Zap with minOut = 0" "$TAKER1" "$ZAP" "buyYes(bytes32,address,uint256,uint256,address)" "$ID29" "$MKT" 10000000 0 "$TAKER1"
send zapBuyYes "$TAKER1_KEY" "$ZAP" "buyYes(bytes32,address,uint256,uint256,address)" "$ID29" "$MKT" 10000000 19000000 "$TAKER1" >/dev/null
Y29=$(call1 "$YES29" 'balanceOf(address)(uint256)' "$TAKER1")
log "5. Zap.buyYes 10 AUSD -> taker1 YES>=29 = $Y29 (20 @ 0.50 minus 0.1% fee = 19980000)"

# ---- 6. settlement through the real MockKeystoneForwarder ---------------------------------------------------
warp_to $((DAYEND + 600))
log "6. clock -> dayEnd+600 ($(now)); due ladders: $(cast call --rpc-url "$RPC" "$VAULT" 'duePendingLadders(uint256,uint256)((bytes4,uint32)[])' 0 50 | tr -d '\n')"
settle_sig() { # settle_sig <station> <tmax> <isVoid> <src> <validUntil> <key>
cat > "$OUT/settle.json" <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"Settlement":[{"name":"station","type":"bytes4"},{"name":"date","type":"uint32"},{"name":"tmaxC","type":"int16"},{"name":"isVoid","type":"bool"},{"name":"sourcesHash","type":"bytes32"},{"name":"validUntil","type":"uint64"}]},
"primaryType":"Settlement","domain":{"name":"Isotherm Resolver","version":"1","chainId":10143,"verifyingContract":"$RESOLVER"},
"message":{"station":"$1","date":$DATE,"tmaxC":$2,"isVoid":$3,"sourcesHash":"$4","validUntil":$5}}
JSON
cast wallet sign --data --from-file "$OUT/settle.json" --private-key "$6"; }
raw_report() { # raw_report <payload> <execId>: simulator header, 109 bytes
  cast concat-hex 0x01 "$2" 0x00000064 0x00000001 0x00000001 \
    0x1111111111111111111111111111111111111111111111111111111111111111 0x37373231353638323933 \
    0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0x0001 "$1"; }
TOPIC_RP=$(cast keccak "ReportProcessed(address,bytes32,bytes2,bool)")
rp() { python3 -c "
import json; r=json.load(open('$1'))
for l in r['logs']:
    if l['address'].lower()=='$MOCK_FWD'.lower() and l['topics'][0]=='$TOPIC_RP': print('accepted' if int(l['data'],16)==1 else 'REJECTED'); break
else: print('no-event')"; }
report() { # report <step> <station> <tmax> <isVoid> <validUntil> <signerKey>
  local src; src=$(cast keccak "iem:$2:$DATE:max=$3|awc:$2:$DATE:max=$3")
  local sig; sig=$(settle_sig "$2" "$3" "$4" "$src" "$5" "$6")
  local digest; digest=$(call1 "$RESOLVER" "settlementDigest(bytes4,uint32,int16,bool,bytes32,uint64)(bytes32)" "$2" "$DATE" "$3" "$4" "$src" "$5")
  [[ "$sig" == "$(cast wallet sign --no-hash "$digest" --private-key "$6")" ]] || { echo "EIP-712 mismatch"; exit 1; }
  local pay; pay=$(cast abi-encode "f(bytes4,uint32,int16,bool,bytes32,uint64,bytes)" "$2" "$DATE" "$3" "$4" "$src" "$5" "$sig")
  local f; f=$(send "$1" "$TAKER2_KEY" $MOCK_FWD "report(address,bytes,bytes,bytes[])" "$RESOLVER" "$(raw_report "$pay" "$(cast keccak "$1")")" 0x "[]")
  echo "$(rp "$f")"
}
T=$(now)
log "   forged (signed by taker2):        ReportProcessed=$(report cre_forged $RCSS 35 false $((T + 1800)) "$TAKER2_KEY")"
log "   expired (attester, validUntil-1): ReportProcessed=$(report cre_expired $RCSS 35 false $((T - 1)) "$ATTESTER_KEY")"
log "   attested Tmax=29:                ReportProcessed=$(report cre_settle $RCSS 29 false $((T + 1800)) "$ATTESTER_KEY")"
log "   replay (attester, Tmax=35):      ReportProcessed=$(report cre_replay $RCSS 35 false $((T + 1800)) "$ATTESTER_KEY")"
RES=$(cast call --rpc-url "$RPC" "$RESOLVER" 'resultOf(bytes4,uint32)((uint8,int16,uint64,uint64,bytes32))' $RCSS "$DATE")
log "   resultOf(RCSS,$DATE) = $RES ; isFinal=$(call1 "$RESOLVER" 'isFinal(bytes4,uint32)(bool)' $RCSS "$DATE")"

# ---- 7. challenge window, then redeem -------------------------------------------------------------------------
expect_revert "redeem inside the challenge window" "$TAKER1" "$VAULT" "redeem(bytes32,uint256,uint256)" "$ID29" "$Y29" 0
FINAL=$(python3 -c "print('$RES'.strip('()').split(', ')[3].split(' ')[0])")
warp_to "$FINAL"
B0=$(call1 $AUSD 'balanceOf(address)(uint256)' "$TAKER1")
send redeemYes29 "$TAKER1_KEY" "$VAULT" "redeem(bytes32,uint256,uint256)" "$ID29" "$Y29" 0 >/dev/null
B1=$(call1 $AUSD 'balanceOf(address)(uint256)' "$TAKER1")
log "7. at finalAt: taker1 redeemed $Y29 YES>=29 (29 >= 29) -> +$((B1 - B0)) AUSD units"
send redeemSet30 "$TAKER1_KEY" "$VAULT" "redeemSet(bytes32,uint256)" "$ID30" 50000000 >/dev/null

# ---- 8. RJTT: guardian veto inside the window -> void --------------------------------------------------------
T=$(now)
log "8. RJTT attested Tmax=25 (YES>=20 would win): ReportProcessed=$(report cre_rjtt $RJTT 25 false $((T + 1800)) "$ATTESTER_KEY")"
expect_revert "challenge by a non-guardian" "$TAKER2" "$RESOLVER" "challenge(bytes4,uint32,bytes32)" $RJTT "$DATE" 0x0000000000000000000000000000000000000000000000000000000000000000
send guardianChallenge "$GUARDIAN_KEY" "$RESOLVER" "challenge(bytes4,uint32,bytes32)" $RJTT "$DATE" "$(cast keccak 'e2e: guardian veto drill')" >/dev/null
log "   after challenge: resultOf(RJTT) = $(cast call --rpc-url "$RPC" "$RESOLVER" 'resultOf(bytes4,uint32)((uint8,int16,uint64,uint64,bytes32))' $RJTT "$DATE")"
B0=$(call1 $AUSD 'balanceOf(address)(uint256)' "$MAKER")
send redeemVoidYes "$MAKER_KEY" "$VAULT" "redeem(bytes32,uint256,uint256)" "$IDJ" 10000000 0 >/dev/null
send redeemVoidNo "$MAKER_KEY" "$VAULT" "redeem(bytes32,uint256,uint256)" "$IDJ" 0 10000000 >/dev/null
B1=$(call1 $AUSD 'balanceOf(address)(uint256)' "$MAKER")
log "   void: maker 10 YES + 10 NO -> +$((B1 - B0)) AUSD units (0.5 each)"

# ---- 9. books ---------------------------------------------------------------------------------------------------
SUM=0; for id in "$ID29" "$ID30" "$IDJ" "$(call1 "$VAULT" "seriesIdOf(bytes4,uint32,int16)(bytes32)" $RCSS "$DATE" 28)"; do
  C=$(cast call --rpc-url "$RPC" "$VAULT" 'getSeries(bytes32)((bytes4,uint32,int16,uint64,bool,address,address,uint256))' "$id" | tr -d '()' | awk -F', ' '{print $8}' | cut -d' ' -f1); SUM=$((SUM + C)); done
VB=$(call1 $AUSD 'balanceOf(address)(uint256)' "$VAULT")
log "9. vault AUSD $VB == pre-run $VAULT_START + sum(this run's series collateral) $SUM : $([[ "$VB" == "$((VAULT_START + SUM))" ]] && echo OK || echo MISMATCH)"
[[ "$VB" == "$((VAULT_START + SUM))" ]] || exit 1
echo; column -t -s $'\t' "$GAS_TSV"
log "E2E v1 OK (anvil fork of live testnet, deployed v1 bytecode). Artifacts in $OUT"
