#!/usr/bin/env bash
# Regenerate script/attestation-vector.json: an EIP-712 Settlement test vector for the CRE workflow, signed by the
# PUBLIC test key 0xa11ce with `cast wallet sign --data` (independent of Solidity) and cross-checked against
# Resolver.settlementDigest() of the deployed v1 Resolver (read-only eth_call). The signature is NOT accepted by the
# live Resolver (its attester is a different key); it exists so the workflow's encoder can be byte-compared.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$PATH:$HOME/.foundry/bin"
RPC=${RPC:-https://testnet-rpc.monad.xyz}
RESOLVER=${RESOLVER:-$(python3 -c "import json; print(json.load(open('$ROOT/deployments/testnet.json'))['resolver'])")}
PK=0x00000000000000000000000000000000000000000000000000000000000a11ce
STATION=0x52435353 DATE=20261007 TMAX=31 ISVOID=false VU=1791392400 # validUntil = 2026-10-07T17:00:00Z
SRC=$(cast keccak "iem:RCSS:20261007:max=31|awc:RCSS:20261007:max=31")
TMP=$(mktemp -d)
cat > "$TMP/td.json" <<JSON
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],
"Settlement":[{"name":"station","type":"bytes4"},{"name":"date","type":"uint32"},{"name":"tmaxC","type":"int16"},{"name":"isVoid","type":"bool"},{"name":"sourcesHash","type":"bytes32"},{"name":"validUntil","type":"uint64"}]},
"primaryType":"Settlement","domain":{"name":"Isotherm Resolver","version":"1","chainId":10143,"verifyingContract":"$RESOLVER"},
"message":{"station":"$STATION","date":$DATE,"tmaxC":$TMAX,"isVoid":$ISVOID,"sourcesHash":"$SRC","validUntil":$VU}}
JSON
SIG=$(cast wallet sign --data --from-file "$TMP/td.json" --private-key $PK)
DIGEST=$(cast call --rpc-url "$RPC" "$RESOLVER" "settlementDigest(bytes4,uint32,int16,bool,bytes32,uint64)(bytes32)" $STATION $DATE $TMAX $ISVOID "$SRC" $VU)
RAWSIG=$(cast wallet sign --no-hash "$DIGEST" --private-key $PK)
[[ "$SIG" == "$RAWSIG" ]] || { echo "MISMATCH: typed-data signature != signature over on-chain settlementDigest"; exit 1; }
SIGNER=$(cast wallet address --private-key $PK)
REPORT=$(cast abi-encode "f(bytes4,uint32,int16,bool,bytes32,uint64,bytes)" $STATION $DATE $TMAX $ISVOID "$SRC" $VU "$SIG")
TYPEHASH=$(cast call --rpc-url "$RPC" "$RESOLVER" "SETTLEMENT_TYPEHASH()(bytes32)")
DOMAINSEP=$(cast call --rpc-url "$RPC" "$RESOLVER" "domainSeparator()(bytes32)")
python3 - "$TMP/td.json" <<PY
import json, sys
td = json.load(open(sys.argv[1]))
out = {
  "_comment": "Isotherm v1 Resolver attestation test vector. Signed by the PUBLIC test-only key 0xa11ce with cast wallet sign --data (Foundry 1.8.5); digest cross-checked against settlementDigest() of the live v1 Resolver via eth_call. The live Resolver will REJECT this signature (its attester is a different key) - use it only to byte-compare your encoder.",
  "typedData": td,
  "typehash": "$TYPEHASH",
  "domainSeparator": "$DOMAINSEP",
  "digest": "$DIGEST",
  "signer": "$SIGNER",
  "signature": "$SIG",
  "report": "$REPORT",
  "reportEncoding": "abi.encode(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash,uint64 validUntil,bytes signature)",
  "onReportMetadata": "ignored unless Resolver.expectedWorkflowId/Owner are pinned (64 bytes: workflowId|name(10)|owner(20)|reportId(2))"
}
json.dump(out, open("$ROOT/script/attestation-vector.json", "w"), indent=2)
print("digest", out["digest"]); print("signature", out["signature"][:20] + "..."); print("OK: cast typed-data signature == signature over live settlementDigest")
PY
