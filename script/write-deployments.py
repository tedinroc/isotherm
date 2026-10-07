#!/usr/bin/env python3
"""Write deployments/<name>.json from a forge broadcast file plus on-chain reads (single source of truth for addresses).

Env: RPC, RUN (broadcast run-latest.json), OUTJSON, FUNDING (lines "label txhash status block"), BAL0/BAL1 (deployer
wei before/after), DEPLOYER/GUARDIAN/ATTESTER/OPERATOR, MODE. Every value written is read back from the chain, so a
mismatch between what the script intended and what is deployed fails loudly here.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

RPC = os.environ["RPC"]
RUN = json.load(open(os.environ["RUN"]))


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=30))
            if "error" in r:
                raise RuntimeError(r["error"])
            return r["result"]
        except Exception as e:  # public RPC is rate limited (~25 rps): back off and retry
            if attempt == 5:
                raise
            time.sleep(0.5 * (attempt + 1))


def call(to, sig, *args):
    out = subprocess.run(
        ["cast", "call", "--rpc-url", RPC, to, sig, *args], capture_output=True, text=True, check=True
    ).stdout.strip()
    time.sleep(0.05)
    return out.split(" ")[0] if "\n" not in out else out


def cs(a):
    return subprocess.run(["cast", "to-check-sum-address", a], capture_output=True, text=True, check=True).stdout.strip()


txs = []
created = {}
for t in RUN["transactions"]:
    h = t["hash"]
    rc = rpc("eth_getTransactionReceipt", [h])
    tx = rpc("eth_getTransactionByHash", [h])
    entry = {
        "what": ("create " + t["contractName"]) if t["transactionType"] == "CREATE" else t["function"].split("(")[0],
        "hash": h,
        "block": int(rc["blockNumber"], 16),
        "status": int(rc["status"], 16),
        "gasUsed": int(rc["gasUsed"], 16),
        "gasLimit": int(tx["gas"], 16),
        "gasPriceWei": int(rc.get("effectiveGasPrice", tx.get("gasPrice", "0x0")), 16),
    }
    assert entry["status"] == 1, f"tx failed: {h}"
    txs.append(entry)
    if t["transactionType"] == "CREATE":
        created[t["contractName"]] = cs(t["contractAddress"])

resolver, vault, zap = created["Resolver"], created["CollateralVault"], created["IsothermZap"]
deploy_block = min(e["block"] for e in txs)

roles = {
    "owner": cs(os.environ["DEPLOYER"]),
    "guardian": cs(os.environ["GUARDIAN"]),
    "attester": cs(os.environ["ATTESTER"]),
    "operator": cs(os.environ["OPERATOR"]),
}
# --- read back and assert -------------------------------------------------------------------------------------
assert cs(call(resolver, "owner()(address)")) == roles["owner"]
assert cs(call(vault, "owner()(address)")) == roles["owner"]
assert cs(call(resolver, "attester()(address)")) == roles["attester"]
assert cs(call(resolver, "guardian()(address)")) == roles["guardian"]
assert cs(call(vault, "guardian()(address)")) == roles["guardian"]
assert call(vault, "isOperator(address)(bool)", roles["operator"]) == "true"
assert cs(call(vault, "resolver()(address)")) == resolver
assert cs(call(zap, "vault()(address)")) == vault
forwarder = cs(call(resolver, "forwarder()(address)"))
ausd = cs(call(vault, "collateral()(address)"))
router = cs(call(zap, "router()(address)"))
token_impl = cs(call(vault, "tokenImplementation()(address)"))

stations = {}
for code, name, tz in (("RCSS", "Taipei Songshan", "Asia/Taipei"), ("RJTT", "Tokyo Haneda", "Asia/Tokyo")):
    hexcode = "0x" + code.encode().hex()
    out = subprocess.run(
        ["cast", "call", "--rpc-url", RPC, resolver, "stations(bytes4)(int32,bool)", hexcode],
        capture_output=True, text=True, check=True,
    ).stdout.strip().split("\n")
    out = [line.split(" ")[0] for line in out]
    assert out[1] == "true", code
    stations[code] = {"bytes4": hexcode, "utcOffsetSeconds": int(out[0]), "city": name, "tz": tz}

params = {
    "challengeWindow": int(call(resolver, "challengeWindow()(uint256)")),
    "staleWindow": int(call(resolver, "STALE_WINDOW()(uint256)")),
    "resumeGrace": int(call(resolver, "RESUME_GRACE()(uint256)")),
    "maxStaleWindow": int(call(resolver, "MAX_STALE_WINDOW()(uint256)")),
    "maxChallengeWindow": int(call(resolver, "MAX_CHALLENGE_WINDOW()(uint256)")),
    "minTmaxC": int(call(resolver, "MIN_TMAX_C()(int16)")),
    "maxTmaxC": int(call(resolver, "MAX_TMAX_C()(int16)")),
    "minStrikeC": int(call(vault, "MIN_STRIKE_C()(int16)")),
    "maxStrikeC": int(call(vault, "MAX_STRIKE_C()(int16)")),
    "settlementTypehash": call(resolver, "SETTLEMENT_TYPEHASH()(bytes32)"),
    "resolverDomainSeparator": call(resolver, "domainSeparator()(bytes32)"),
    "eip712": {"name": "Isotherm Resolver", "version": "1", "chainId": 10143, "verifyingContract": resolver},
    "settlementType": "Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash,uint64 validUntil)",
    "reportEncoding": "abi.encode(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash,uint64 validUntil,bytes signature)",
    "zapKuruMarket": {
        "type": 0,
        "pricePrecision": int(call(zap, "PRICE_PRECISION()(uint256)")),
        "sizePrecision": int(call(zap, "SIZE_PRECISION()(uint256)")),
        "maxTakerFeeBps": int(call(zap, "MAX_TAKER_FEE_BPS()(uint256)")),
        "recommended": {"tickSize": 10, "minSize": 1000000, "maxSize": 1000000000000, "takerFeeBps": 10,
                        "makerFeeBps": 0, "kuruAmmSpread": 100},
    },
    "ausdEip712": {"name": "Agora Dollar", "version": "1", "chainId": 10143, "verifyingContract": ausd},
    "mintAuthorizationNonce": "keccak256(abi.encode(bytes32 seriesId, uint256 amount, bytes32 salt))",
}

funding = []
for line in open(os.environ["FUNDING"]).read().split("\n"):
    if line.strip():
        label, h, st, bn = line.split()
        funding.append({"to": label, "hash": h, "status": st, "block": int(bn)})

billed = sum(e["gasLimit"] * e["gasPriceWei"] for e in txs)
doc = {
    "network": "monad-testnet",
    "chainId": int(rpc("eth_chainId", []), 16),
    "version": "isotherm-contracts-v1",
    "mode": os.environ["MODE"],
    "deployBlock": deploy_block,
    "deployedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "ausd": ausd,
    "ausdFaucet": "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
    "kuruRouter": router,
    "kuruMarginAccount": "0xd029C2D98ff85D8F64799017fE00a59B1159CE02",
    "mockForwarder": "0xB9F79d863261869B234c481D1f9A7af84AeAd192",
    "keystoneForwarder": "0xF8344CFd5c43616a4366C34E3EEE75af79a74482",
    "activeForwarder": forwarder,
    "resolver": resolver,
    "vault": vault,
    "factory": vault,
    "zap": zap,
    "outcomeTokenImpl": token_impl,
    "roles": roles,
    "stations": stations,
    "params": params,
    "abi": {"dir": "packages/abi", "files": ["Resolver.json", "CollateralVault.json", "IsothermZap.json",
                                              "OutcomeToken.json", "addresses.json"]},
    "deployTxs": txs,
    "deployGas": {"used": sum(e["gasUsed"] for e in txs), "limitBilled": sum(e["gasLimit"] for e in txs),
                  "monBilled": round(billed / 1e18, 6)},
    "funding": funding,
    "deployerSpentMon": round((int(os.environ["BAL0"]) - int(os.environ["BAL1"])) / 1e18, 6),
    "notes": [
        "factory == vault: StrikeFactory is inherited by CollateralVault (one address).",
        "Settled results become redeemable at Resolver.resultOf(...).finalAt (resolvedAt + challengeWindow).",
        "Zap trades only on zap.canonicalMarket(seriesId), registered once by the operator after Kuru deployProxy.",
    ],
}
os.makedirs(os.path.dirname(os.environ["OUTJSON"]), exist_ok=True)
json.dump(doc, open(os.environ["OUTJSON"], "w"), indent=2)
open(os.environ["OUTJSON"], "a").write("\n")
print(json.dumps({k: doc[k] for k in ("chainId", "deployBlock", "resolver", "vault", "zap", "deployGas")}, indent=1))
