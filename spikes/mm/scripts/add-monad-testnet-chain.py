#!/usr/bin/env python3
"""Add Monad testnet (10143) to mm's wallet state as a customEvmChains entry.

mm 7.0.0 has no CLI command for this; getEvmRpcConfig() checks
wallets.json#data.customEvmChains first, and an entry with `rpcTarget` is used
verbatim (so the executor's nonce/gas/fee reads go to that RPC instead of the
hosted gateway, which answers HTTP 400 "Invalid chainId" for 10143).
Usage: add-monad-testnet-chain.py <HOME-of-mm> [rpcUrl]
"""
import json, os, sys
home = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~")
rpc = sys.argv[2] if len(sys.argv) > 2 else "https://testnet-rpc.monad.xyz"
p = os.path.join(home, ".metamask", "wallets.json")
d = json.load(open(p))
chains = [c for c in d["data"].get("customEvmChains", []) if c.get("chainId") != 10143]
chains.append({
    "key": "monad-testnet",
    "chainId": 10143,
    "caip2": "eip155:10143",
    "name": "Monad Testnet",
    "nativeCurrency": {"name": "Monad", "symbol": "MON", "decimals": 18},
    "blockExplorer": "https://testnet.monadexplorer.com",
    "rpcTarget": rpc,
})
d["data"]["customEvmChains"] = chains
tmp = p + ".tmp"
json.dump(d, open(tmp, "w"), indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, p)
print(f"customEvmChains[10143].rpcTarget = {rpc}  ({p})")
