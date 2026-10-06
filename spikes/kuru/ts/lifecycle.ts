// Full YES/AUSD lifecycle on Kuru v1 with the four Isotherm testnet wallets.
//   anvil fork : RPC_URL=http://127.0.0.1:8546 npx tsx lifecycle.ts      (funds wallets with anvil_setBalance)
//   live       : RPC_URL=https://testnet-rpc.monad.xyz LIVE=1 npx tsx lifecycle.ts   (needs MON in all 4 wallets)
import { encodeDeployData, formatUnits, parseEther, type Address, type Hex } from "viem";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TESTNET, PARAMS, clients, loadKey, send, txLog, erc20Abi, faucetAbi, marginAccountAbi,
  createMarket, depositMargin, placeLimit, placeQuotes, cancelAll, getOpenOrders, marketBuy, marketSell,
  routerBuy, getBook, fmtBook, withdrawAllMargin, ausd, orderBookAbi,
} from "./kuru.ts";

const here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.LIVE === "1";
const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8546";
const { pub, wallet } = clients(rpc);

const W = {
  deployer: wallet(loadKey("deployer")),
  maker: wallet(loadKey("maker")),
  taker1: wallet(loadKey("taker1")),
  taker2: wallet(loadKey("taker2")),
};
const addr = (k: keyof typeof W) => W[k].account!.address as Address;
const out: any = { rpc: LIVE ? rpc : `anvil fork of ${TESTNET.rpc}`, live: LIVE, startedAt: new Date().toISOString(), steps: [] as any[] };
const note = (s: string, extra: any = {}) => {
  console.log(s);
  out.steps.push({ t: new Date().toISOString(), s, ...extra });
};
const bal = async (token: Address, who: Address) => (await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] })) as bigint;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function faucet(to: Address) {
  // global 60 s cooldown: on anvil we fast-forward time, live we wait
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await send(pub, W.deployer, { to: TESTNET.ausdFaucet, abi: faucetAbi, functionName: "requestFunds", args: [to] }, `faucet.requestFunds -> ${to.slice(0, 8)}`);
      return;
    } catch (e: any) {
      if (!String(e?.message ?? e).includes("MaxFrequencyExceeded") && !String(e).includes("0x20e5bc67")) throw e;
      if (LIVE && !process.env.REHEARSAL) await sleep(61_000);
      else {
        await pub.request({ method: "evm_increaseTime" as any, params: [61] as any });
        await pub.request({ method: "evm_mine" as any, params: [] as any });
      }
    }
  }
  throw new Error("faucet kept rate-limiting");
}

async function main() {
  const chainId = await pub.getChainId();
  const startBlock = await pub.getBlockNumber();
  note(`chain ${chainId} @ block ${startBlock} via ${LIVE ? rpc : "anvil fork"}`);

  if (!LIVE) {
    for (const k of Object.keys(W) as (keyof typeof W)[])
      await pub.request({ method: "anvil_setBalance" as any, params: [addr(k), "0x56BC75E2D63100000"] as any }); // 100 MON
    note("anvil: set 100 MON on deployer/maker/taker1/taker2 (anvil_setBalance)");
  } else {
    for (const k of Object.keys(W) as (keyof typeof W)[]) note(`${k} ${addr(k)} MON=${formatUnits(await pub.getBalance({ address: addr(k) }), 18)}`);
    // Monad reserve-balance rule: an account under 10 MON may only send VALUE in an "emptying" tx, i.e. with no
    // other tx from it in the previous k=3 blocks. So: transfers first, spaced > 3 blocks apart, nothing in between.
    const fund: [keyof typeof W, bigint][] = [["maker", parseEther(process.env.MAKER_MON ?? "1.0")], ["taker1", parseEther(process.env.TAKER_MON ?? "0.35")]];
    for (const [k, v] of fund) {
      if ((await pub.getBalance({ address: addr(k) })) >= v / 2n) continue;
      await sleep(2500);
      const t0 = Date.now();
      const hash = await W.deployer.sendTransaction({ to: addr(k), value: v, gas: 21000n });
      const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
      txLog.push({ label: `MON transfer ${formatUnits(v, 18)} -> ${k}`, hash, gasUsed: rc.gasUsed, gasLimit: 21000n, effectiveGasPrice: rc.effectiveGasPrice, costMonAt102Gwei: Number(21000n * 102n) / 1e9, latencyMs: Date.now() - t0, status: rc.status });
      if (rc.status !== "success") throw new Error(`MON transfer to ${k} reverted ${hash}`);
      note(`    sent ${formatUnits(v, 18)} MON -> ${k} (${hash}); ${k} MON=${formatUnits(await pub.getBalance({ address: addr(k) }), 18)}`);
    }
    await sleep(2500);
  }
  // live: taker2's role is played by taker1 to save testnet MON (both paths were proven on the fork)
  const T2: keyof typeof W = LIVE ? "taker1" : "taker2";

  // (0) AUSD from the public testnet faucet
  for (const k of (LIVE ? ["maker", "taker1"] : ["maker", "taker1", "taker2"]) as (keyof typeof W)[]) {
    if ((await bal(TESTNET.ausd, addr(k))) < ausd(1000)) await faucet(addr(k));
    note(`${k} AUSD = ${formatUnits(await bal(TESTNET.ausd, addr(k)), 6)}`);
  }

  // (a) plain 6-dp YES token, minted to maker (deployer is minter)
  const art = JSON.parse(readFileSync(join(here, "../out/SpikeToken.sol/SpikeToken.json"), "utf8"));
  const label = `YES RCSS Tmax>=30C ${new Date().toISOString().slice(0, 10)} spike ${Date.now()}`;
  const deployData = { abi: art.abi, bytecode: art.bytecode.object as Hex, args: [label, "YES", addr("deployer")] } as const;
  const est = await pub.estimateGas({ account: W.deployer.account!, data: encodeDeployData(deployData as any) });
  const gas = BigInt(Math.ceil(Number(est) * 1.15));
  const t0 = Date.now();
  const hash = await W.deployer.deployContract({ ...(deployData as any), gas });
  const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  txLog.push({ label: "deploy SpikeToken (YES, 6dp)", hash, gasUsed: rc.gasUsed, gasLimit: gas, effectiveGasPrice: rc.effectiveGasPrice, costMonAt102Gwei: Number(gas * 102n) / 1e9, latencyMs: Date.now() - t0, status: rc.status });
  const yes = rc.contractAddress as Address;
  await send(pub, W.deployer, { to: yes, abi: art.abi, functionName: "mint", args: [addr("maker"), 2_000_000_000n] }, "YES.mint 2,000 -> maker");
  if (!LIVE) await send(pub, W.deployer, { to: yes, abi: art.abi, functionName: "mint", args: [addr("taker2"), 50_000_000n] }, "YES.mint 50 -> taker2");
  note(`(a) YES token ${yes}; maker YES=${formatUnits(await bal(yes, addr("maker")), 6)}`);

  // (b) create the YES/AUSD market from a NON-owner (deployer)
  const routerOwner = await pub.readContract({ address: TESTNET.router, abi: [{ type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }], functionName: "owner" });
  const { market, vault } = await createMarket(pub, W.deployer, yes);
  note(`(b) market ${market} (vault ${vault}) created by ${addr("deployer")}; router owner is ${routerOwner}`, { market, vault, yes });
  const mp = await pub.readContract({ address: market, abi: orderBookAbi, functionName: "getMarketParams" });
  note(`    getMarketParams = ${JSON.stringify(mp, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  // (c) maker: deposit both legs, single bid + ask, then batch ladder
  await depositMargin(pub, W.maker, TESTNET.ausd, ausd(500));
  await depositMargin(pub, W.maker, yes, 1_000_000_000n);
  const mBal = async (t: Address) => formatUnits((await pub.readContract({ address: TESTNET.marginAccount, abi: marginAccountAbi, functionName: "getBalance", args: [addr("maker"), t] })) as bigint, 6);
  note(`(c) maker margin: AUSD=${await mBal(TESTNET.ausd)} YES=${await mBal(yes)}`);
  const b1 = await placeLimit(pub, W.maker, market, "bid", { price: 0.41, size: 100 });
  const a1 = await placeLimit(pub, W.maker, market, "ask", { price: 0.45, size: 100 });
  note(`    single quotes: bid id ${b1.created[0].id} @0.41, ask id ${a1.created[0].id} @0.45`);
  console.log(fmtBook(await getBook(pub, market)));

  const ladder1 = await placeQuotes(
    pub, W.maker, market,
    [{ price: 0.42, size: 100 }, { price: 0.41, size: 150 }, { price: 0.4, size: 200 }],
    [{ price: 0.44, size: 100 }, { price: 0.45, size: 150 }, { price: 0.46, size: 200 }],
    [b1.created[0].id, a1.created[0].id],
    true,
    "batchUpdate re-quote: cancel 2 + place 3 bids/3 asks",
  );
  let ids = ladder1.created.map((c) => c.id);
  note(`    batch ladder placed ids ${ids.join(",")}`);
  const ladder2 = await placeQuotes(
    pub, W.maker, market,
    [{ price: 0.43, size: 100 }, { price: 0.42, size: 150 }, { price: 0.41, size: 200 }],
    [{ price: 0.45, size: 100 }, { price: 0.46, size: 150 }, { price: 0.47, size: 200 }],
    ids,
    true,
    "batchUpdate steady-state re-quote: cancel 6 + place 6",
  );
  ids = ladder2.created.map((c) => c.id);
  const book1 = await getBook(pub, market);
  note(`    re-quoted ladder ids ${ids.join(",")}`, { book: book1 });
  console.log(fmtBook(book1));

  // (d) takers take liquidity
  const y0 = await bal(yes, addr("taker1"));
  const buy = await marketBuy(pub, W.taker1, market, 50);
  const y1 = await bal(yes, addr("taker1"));
  note(`(d) taker1 market-bought with 50 AUSD -> +${formatUnits(y1 - y0, 6)} YES in wallet (${buy.trades.length} fills)`, { fills: buy.trades.map((t) => ({ ...t, orderId: t.orderId.toString(), price: t.price.toString(), filled: t.filled.toString() })) });
  const a0 = await bal(TESTNET.ausd, addr(T2));
  await marketSell(pub, W[T2], market, yes, 30);
  note(`    ${T2} market-sold 30 YES -> +${formatUnits((await bal(TESTNET.ausd, addr(T2))) - a0, 6)} AUSD in wallet`);
  const y2 = await bal(yes, addr(T2));
  await routerBuy(pub, W[T2], market, yes, 20);
  note(`    ${T2} bought via Router.anyToAnySwap (20 AUSD, FOK) -> +${formatUnits((await bal(yes, addr(T2))) - y2, 6)} YES`);
  const book2 = await getBook(pub, market);
  note("    book after takes", { book: book2 });
  console.log(fmtBook(book2));

  // (e) maker cancels / replaces: scan open orders, replace, then cancel all
  const open = await getOpenOrders(pub, market, addr("maker"));
  note(`(e) maker open orders (scan): ${open.map((o) => `${o.id}:${o.isBuy ? "bid" : "ask"}@${o.price}x${o.size}`).join(" ")}`);
  const rep = await placeQuotes(pub, W.maker, market, [{ price: 0.425, size: 120 }], [{ price: 0.455, size: 120 }], open.map((o) => o.id), true, `batchUpdate replace: cancel ${open.length} + place 1b/1a`);
  note(`    replaced with ids ${rep.created.map((c) => c.id).join(",")}`);
  console.log(fmtBook(await getBook(pub, market)));
  await cancelAll(pub, W.maker, market);
  const book3 = await getBook(pub, market);
  note(`    after cancelAll: bids=${book3.bids.length} asks=${book3.asks.length}`, { book: book3 });
  await withdrawAllMargin(pub, W.maker, [TESTNET.ausd, yes]);
  note(`    maker withdrew margin; wallet AUSD=${formatUnits(await bal(TESTNET.ausd, addr("maker")), 6)} YES=${formatUnits(await bal(yes, addr("maker")), 6)}`);

  // gas table
  console.log("\n  gasUsed   gasLimit  MON@102gwei(limit)  latency  label");
  for (const r of txLog) console.log(`  ${String(r.gasUsed).padStart(8)} ${String(r.gasLimit).padStart(9)}  ${r.costMonAt102Gwei.toFixed(5).padStart(10)}        ${String(r.latencyMs).padStart(5)}ms  ${r.label}`);
  const total = txLog.reduce((s, r) => s + r.costMonAt102Gwei, 0);
  console.log(`  total ${txLog.length} txs = ${total.toFixed(4)} MON (billed on gas limit)`);
  out.txs = txLog.map((r) => ({ ...r, gasUsed: r.gasUsed.toString(), gasLimit: r.gasLimit.toString(), effectiveGasPrice: r.effectiveGasPrice.toString() }));
  out.totalMon = total;
  out.market = market;
  out.yes = yes;
  out.endBlock = (await pub.getBlockNumber()).toString();
  const f = join(here, `../logs/lifecycle-${process.env.REHEARSAL ? "rehearsal-anvil" : LIVE ? "live" : "anvil"}-${Date.now()}.json`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nwrote ${f}`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
