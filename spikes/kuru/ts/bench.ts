// Gas benchmark for the maker bot budget (anvil fork only):
//   RPC_URL=http://127.0.0.1:8546 npx tsx bench.ts
// Measures per-strike re-quote patterns and taker cost vs levels crossed. Gas = Monad schedule (anvil
// --network monad / chain 10143 applies Monad cold-access pricing; verified against live eth_call).
import { encodeDeployData, type Address, type Hex } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TESTNET, clients, loadKey, send, txLog, createMarket, depositMargin, placeQuotes, marketBuy, cancelAll, faucetAbi } from "./kuru.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { pub, wallet } = clients(process.env.RPC_URL ?? "http://127.0.0.1:8546");
const D = wallet(loadKey("deployer"));
const M = wallet(loadKey("maker"));
const T = wallet(loadKey("taker1"));

async function main() {
  if ((await pub.getChainId()) !== 10143) throw new Error("not a Monad testnet fork");
  for (const w of [D, M, T]) await pub.request({ method: "anvil_setBalance" as any, params: [w.account!.address, "0x56BC75E2D63100000"] as any });
  for (const w of [M, T]) {
    await pub.request({ method: "evm_increaseTime" as any, params: [61] as any });
    await pub.request({ method: "evm_mine" as any, params: [] as any });
    await send(pub, D, { to: TESTNET.ausdFaucet, abi: faucetAbi, functionName: "requestFunds", args: [w.account!.address] }, "faucet");
  }
  const art = JSON.parse(readFileSync(join(here, "../out/SpikeToken.sol/SpikeToken.json"), "utf8"));
  const d = { abi: art.abi, bytecode: art.bytecode.object as Hex, args: [`YES bench ${Date.now()}`, "YES", D.account!.address] } as const;
  const hash = await D.deployContract({ ...(d as any), gas: 800_000n });
  const yes = (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;
  void encodeDeployData;
  await send(pub, D, { to: yes, abi: art.abi, functionName: "mint", args: [M.account!.address, 5_000_000_000n] }, "mint");
  const { market } = await createMarket(pub, D, yes);
  await depositMargin(pub, M, TESTNET.ausd, 2_000_000_000n);
  await depositMargin(pub, M, yes, 4_000_000_000n);
  txLog.splice(0);

  const rows: { pattern: string; gasUsed: string; gasLimit: string; mon: number }[] = [];
  const rec = (pattern: string) => {
    const r = txLog[txLog.length - 1];
    rows.push({ pattern, gasUsed: r.gasUsed.toString(), gasLimit: r.gasLimit.toString(), mon: r.costMonAt102Gwei });
  };

  // 1 bid + 1 ask per strike (the ladder bot's default shape)
  let q = await placeQuotes(pub, M, market, [{ price: 0.4, size: 100 }], [{ price: 0.44, size: 100 }]);
  rec("first quote 1b/1a on empty book (fresh price levels)");
  let ids = q.created.map((c) => c.id);
  for (let i = 1; i <= 3; i++) {
    q = await placeQuotes(pub, M, market, [{ price: 0.4, size: 100 + i }], [{ price: 0.44, size: 100 + i }], ids);
    rec(`re-quote 1b/1a SAME prices (cancel 2 + place 2) #${i}`);
    ids = q.created.map((c) => c.id);
  }
  for (let i = 1; i <= 3; i++) {
    const p = 0.4 + i * 0.005;
    q = await placeQuotes(pub, M, market, [{ price: +p.toFixed(3), size: 100 }], [{ price: +(p + 0.04).toFixed(3), size: 100 }], ids);
    rec(`re-quote 1b/1a SHIFTED +0.005 (cancel 2 + place 2) #${i}`);
    ids = q.created.map((c) => c.id);
  }
  // 3x3 ladder per strike
  q = await placeQuotes(pub, M, market, [0.41, 0.4, 0.39].map((price) => ({ price, size: 100 })), [0.45, 0.46, 0.47].map((price) => ({ price, size: 100 })), ids);
  rec("re-quote to 3b/3a (cancel 2 + place 6)");
  ids = q.created.map((c) => c.id);
  q = await placeQuotes(pub, M, market, [0.41, 0.4, 0.39].map((price) => ({ price, size: 90 })), [0.45, 0.46, 0.47].map((price) => ({ price, size: 90 })), ids);
  rec("re-quote 3b/3a SAME prices (cancel 6 + place 6)");
  ids = q.created.map((c) => c.id);
  q = await placeQuotes(pub, M, market, [0.42, 0.41, 0.4].map((price) => ({ price, size: 90 })), [0.46, 0.47, 0.48].map((price) => ({ price, size: 90 })), ids);
  rec("re-quote 3b/3a SHIFTED one tick-row (cancel 6 + place 6)");
  ids = q.created.map((c) => c.id);

  // taker cost vs levels crossed (asks 0.46/0.47/0.48 x 90)
  await marketBuy(pub, T, market, 10);
  rows.push({ pattern: "(approve market AUSD, one-off)", gasUsed: txLog[txLog.length - 2].gasUsed.toString(), gasLimit: txLog[txLog.length - 2].gasLimit.toString(), mon: txLog[txLog.length - 2].costMonAt102Gwei });
  rec("taker market buy 10 AUSD (1 level, partial)");
  await marketBuy(pub, T, market, 30);
  rec("taker market buy 30 AUSD (finishes level 1, into level 2)");
  await marketBuy(pub, T, market, 90);
  rec("taker market buy 90 AUSD (crosses 2 levels)");
  await cancelAll(pub, M, market);
  rec("cancelAll remaining (scan + batchCancelOrdersNoRevert)");

  console.log("\n  gasUsed  gasLimit(billed)  MON@102gwei  pattern");
  for (const r of rows) console.log(`  ${r.gasUsed.padStart(7)}  ${r.gasLimit.padStart(9)}  ${r.mon.toFixed(5)}  ${r.pattern}`);
  writeFileSync(join(here, `../logs/bench-${Date.now()}.json`), JSON.stringify({ market, rows }, null, 2));
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
