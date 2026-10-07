#!/usr/bin/env node
// Add Monad testnet (10143) to MetaMask Agent Wallet (mm 7.x) state as a customEvmChains entry.
//
// Why: mm's hosted RPC gateway answers HTTP 400 {"error":"Invalid chainId"} for 10143, which breaks the executor's
// nonce/gas/fee reads. mm 7.0.0 has no CLI command for custom chains, but getEvmRpcConfig() checks
// wallets.json#data.customEvmChains first and uses an entry's `rpcTarget` verbatim.
//
// Usage: node add-monad-testnet-chain.mjs [mmHome=$HOME] [rpcUrl=https://testnet-rpc.monad.xyz]
// Safe on a fresh home (before `mm init`): it creates ~/.metamask/wallets.json with only this entry; mm merges
// its own wallet state into the file later (checked in the plugin harness: the entry survives `mm init`).
// Idempotent: replaces any previous 10143 entry. Writes atomically with mode 0600.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.argv[2] || homedir();
const rpc = process.argv[3] || process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz";
if (!/^https?:\/\//.test(rpc)) {
  console.error(`rpcUrl must be http(s): ${rpc}`);
  process.exit(2);
}
const dir = join(home, ".metamask");
const file = join(dir, "wallets.json");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
let doc = { schemaVersion: "0.0.1", data: {} };
let created = true;
if (existsSync(file)) {
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
    created = false;
  } catch (e) {
    console.error(`refusing to touch ${file}: not valid JSON (${e.message})`);
    process.exit(3);
  }
}
doc.data = doc.data && typeof doc.data === "object" ? doc.data : {};
const chains = Array.isArray(doc.data.customEvmChains) ? doc.data.customEvmChains.filter((c) => Number(c?.chainId) !== 10143) : [];
chains.push({
  key: "monad-testnet",
  chainId: 10143,
  caip2: "eip155:10143",
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  blockExplorer: "https://testnet.monadexplorer.com",
  rpcTarget: rpc,
});
doc.data.customEvmChains = chains;
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
chmodSync(tmp, 0o600);
renameSync(tmp, file);
console.log(`customEvmChains[10143].rpcTarget = ${rpc}  (${file}${created ? ", created" : ""})`);
