#!/usr/bin/env bash
# Fund one Dynamic embedded wallet on Monad TESTNET (chain 10143) for the localhost proof in
# evidence/dynamic/RESULT.md: 0.25 testnet MON (plain transfer, gas limit 21000) and 10,000 faucet AUSD
# (AUSD faucet requestFunds(address); one global 60 s cooldown for everyone, retried once after 65 s).
# Both are sent from the deployer key in ~/.config/isotherm/deployer.key, which is read here and never printed.
#
#   scripts/fund-embedded.sh 0xEMBEDDED_WALLET_ADDRESS --yes
#
# Testnet only: MON and AUSD on 10143 are free test tokens. Prints the two tx hashes and the balances after.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC_URL:-https://testnet-rpc.monad.xyz}"
MON_AMOUNT="${MON_AMOUNT:-0.25ether}"
TO="${1:-}"
[[ "$TO" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "usage: $0 0xADDRESS --yes" >&2; exit 2; }
[[ "${2:-}" == "--yes" ]] || { echo "refusing without --yes (this spends testnet MON from the deployer)" >&2; exit 2; }
[[ "$(cast chain-id --rpc-url "$RPC")" == "10143" ]] || { echo "RPC is not Monad testnet (10143)" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
AUSD=$(python3 -c "import json;print(json.load(open('$HERE/deployments/testnet.json'))['ausd'])")
FAUCET=$(python3 -c "import json;print(json.load(open('$HERE/deployments/testnet.json'))['ausdFaucet'])")
KEYFILE="$HOME/.config/isotherm/deployer.key"
[[ -r "$KEYFILE" ]] || { echo "missing $KEYFILE" >&2; exit 2; }
PK="$(tr -d '[:space:]' < "$KEYFILE")"
FROM=$(cast wallet address --private-key "$PK")
echo "deployer $FROM  MON before: $(cast balance --ether --rpc-url "$RPC" "$FROM")"

echo "-> $MON_AMOUNT MON to $TO (gas limit 21000)"
H1=$(cast send --rpc-url "$RPC" --private-key "$PK" --gas-limit 21000 --value "$MON_AMOUNT" "$TO" --json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["transactionHash"], d["status"])')
echo "   MON tx: $H1"

faucet() {
  local est
  est=$(cast estimate --rpc-url "$RPC" --from "$FROM" "$FAUCET" 'requestFunds(address)' "$TO")
  cast send --rpc-url "$RPC" --private-key "$PK" --gas-limit $((est * 110 / 100)) "$FAUCET" 'requestFunds(address)' "$TO" --json |
    python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["transactionHash"], d["status"])'
}
echo "-> faucet requestFunds($TO)"
if ! H2=$(faucet 2>/dev/null); then
  echo "   faucet cooling down (global 60 s); retrying in 65 s"
  sleep 65
  H2=$(faucet)
fi
echo "   AUSD tx: $H2"
unset PK

echo "after: $TO MON $(cast balance --ether --rpc-url "$RPC" "$TO"), AUSD (6 dp units) $(cast call --rpc-url "$RPC" "$AUSD" 'balanceOf(address)(uint256)' "$TO")"
