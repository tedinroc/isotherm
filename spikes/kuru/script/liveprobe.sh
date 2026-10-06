#!/usr/bin/env bash
# Runs the WHOLE YES/AUSD lifecycle (token, market creation by a non-owner, maker deposit, single + batch quotes,
# taker market buy/sell, cancel, L2 book) inside ONE eth_call against LIVE Monad testnet state.
# No key, no MON, nothing persisted: LiveProbe's runtime code is injected with a state override.
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
cd "$(dirname "$0")/.."
RPC="${RPC_URL:-https://testnet-rpc.monad.xyz}"
forge build -q
RT=$(forge inspect LiveProbe deployedBytecode)
PROBE=0x15000000000000000000000000000000000015BE
BN=$(cast block-number --rpc-url "$RPC")
SIG="run(address,address,address)((address,address,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes,bytes,uint40))"
echo "live block $BN"
cast call "$PROBE" "$SIG" 0x7EFbE105Ca7415dE98F96622173458ac1c054630 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C \
  --override-code "$PROBE:$RT" --from 0xb855f2bCA7C12Db2aA9D70740c6cF40808325c11 --rpc-url "$RPC" --block "$BN" --gas-limit 30000000
# fields: market, yes, maker, taker, gas{create, deposit, bid, ask, batch6, takerBuy, takerSell, cancel6},
#         takerYesFor100AUSD, takerAusdFor20YES, bestBid(1e18), bestAsk(1e18), l2AfterRequote, l2AfterCancel, orderIdCounter
# If it reverts with 0x20e5bc67 (MaxFrequencyExceeded) someone used the AUSD faucet <60 s ago: rerun.
