#!/usr/bin/env bash
# Export contract ABIs from forge `out/` to packages/abi/<Contract>.json (plain ABI arrays, viem-ready), plus
# packages/abi/addresses.json (a flat copy of deployments/testnet.json addresses, if it exists).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$PATH:$HOME/.foundry/bin"
cd "$ROOT"
forge build --skip test --skip script >/dev/null 2>&1
mkdir -p packages/abi
python3 - <<'PY'
import json, os
pairs = [
    ("Resolver.sol", "Resolver"),
    ("CollateralVault.sol", "CollateralVault"),
    ("IsothermZap.sol", "IsothermZap"),
    ("OutcomeToken.sol", "OutcomeToken"),
    ("ForecastCommit.sol", "ForecastCommit"),
    ("IIsothermResolver.sol", "IIsothermResolver"),
    ("IERC3009.sol", "IERC3009"),
    ("IKuru.sol", "IKuruRouterView"),
    ("IKuru.sol", "IKuruOrderBookTaker"),
]
index = {}
for f, c in pairs:
    art = json.load(open(f"out/{f}/{c}.json"))
    json.dump(art["abi"], open(f"packages/abi/{c}.json", "w"), indent=1)
    index[c] = {"file": f"{c}.json", "source": f"src/{f}" if not f.startswith("I") else f"src/interfaces/{f}",
                "entries": len(art["abi"])}
dep = "deployments/testnet.json"
if os.path.exists(dep):
    d = json.load(open(dep))
    addrs = {k: d[k] for k in ("chainId", "deployBlock", "ausd", "ausdFaucet", "kuruRouter", "kuruMarginAccount",
                               "mockForwarder", "keystoneForwarder", "resolver", "vault", "zap", "outcomeTokenImpl")}
    addrs["roles"] = d["roles"]
    json.dump(addrs, open("packages/abi/addresses.json", "w"), indent=1)
    index["addresses"] = {"file": "addresses.json", "source": dep}
json.dump(index, open("packages/abi/index.json", "w"), indent=1)
for k, v in index.items():
    print(f"packages/abi/{v['file']}  ({v.get('entries', '-')} entries)")
PY
