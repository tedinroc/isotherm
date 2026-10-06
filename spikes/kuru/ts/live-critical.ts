// Trigger-T1 critical path on LIVE Monad testnet (chain 10143), resumable.
//   RPC_URL=https://testnet-rpc.monad.xyz npx tsx live-critical.ts
// The deployer key is shared with other spikes, so every step is idempotent: progress is stored in
// ../logs/live-state.json and a re-run continues where it stopped. Budget ≈ 0.55 MON total.
import { encodeDeployData, formatUnits, parseEther, type Address, type Hex } from "viem";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TESTNET, clients, loadKey, send, txLog, erc20Abi, faucetAbi, marginAccountAbi, orderBookAbi,
  createMarket, depositMargin, placeLimit, placeQuotes, cancelAll, marketBuy, getBook, fmtBook, ausd, type TxRecord,
} from "./kuru.ts";

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = process.env.STATE_FILE ?? join(here, "../logs/live-state.json");
const rpc = process.env.RPC_URL ?? TESTNET.rpc;
const { pub, wallet } = clients(rpc);
const D = wallet(loadKey("deployer"));
const M = wallet(loadKey("maker"));
const T = wallet(loadKey("taker1"));
const A = { deployer: D.account!.address, maker: M.account!.address, taker1: T.account!.address };

type State = { [k: string]: any; txs: any[] };
const st: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { txs: [] };
const save = () => {
  const fresh = txLog.splice(0).map((r: TxRecord) => ({ ...r, gasUsed: r.gasUsed.toString(), gasLimit: r.gasLimit.toString(), effectiveGasPrice: r.effectiveGasPrice.toString() }));
  st.txs.push(...fresh);
  writeFileSync(stateFile, JSON.stringify(st, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mon = async (a: Address) => formatUnits(await pub.getBalance({ address: a }), 18);
const bal = async (t: Address, a: Address) => (await pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint;
const step = async (name: string, fn: () => Promise<any>) => {
  if (st[name]) return console.log(`= ${name} (done earlier)`, typeof st[name] === "object" ? "" : st[name]);
  const r = await fn();
  st[name] = r ?? true;
  save();
  console.log(`+ ${name}`, typeof r === "string" ? r : "");
};

async function fundMon(to: Address, label: string, v: bigint) {
  if ((await pub.getBalance({ address: to })) >= v / 2n) return "already funded";
  // Monad reserve balance: deployer (<10 MON) may send VALUE only in an "emptying" tx (no other tx from it in
  // the last k=3 blocks). Other agents share this key, so retry if the transfer reverts.
  for (let i = 0; i < 4; i++) {
    await sleep(3000);
    const t0 = Date.now();
    const hash = await D.sendTransaction({ to, value: v, gas: 21000n });
    const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    txLog.push({ label, hash, gasUsed: rc.gasUsed, gasLimit: 21000n, effectiveGasPrice: rc.effectiveGasPrice, costMonAt102Gwei: 0.002142, latencyMs: Date.now() - t0, status: rc.status });
    save();
    if (rc.status === "success") return hash;
    console.log(`  transfer reverted (reserve-balance rule?) ${hash}; retrying`);
  }
  throw new Error("MON transfer kept reverting");
}

async function faucetSelf(w: typeof M, who: string) {
  for (let i = 0; i < 8; i++) {
    try {
      await send(pub, w, { to: TESTNET.ausdFaucet, abi: faucetAbi, functionName: "requestFunds", args: [w.account!.address] }, `faucet.requestFunds (${who})`);
      return formatUnits(await bal(TESTNET.ausd, w.account!.address), 6);
    } catch (e: any) {
      const m = String(e?.shortMessage ?? e?.message ?? e);
      if (!m.includes("MaxFrequencyExceeded") && !m.includes("0x20e5bc67")) throw e;
      console.log("  faucet global cooldown (60 s) — waiting");
      if (process.env.REHEARSAL) {
        await pub.request({ method: "evm_increaseTime" as any, params: [61] as any });
        await pub.request({ method: "evm_mine" as any, params: [] as any });
      } else await sleep(62_000);
    }
  }
  throw new Error("faucet busy");
}

async function main() {
  console.log(`chain ${await pub.getChainId()} block ${await pub.getBlockNumber()}`);
  console.log(`MON deployer=${await mon(A.deployer)} maker=${await mon(A.maker)} taker1=${await mon(A.taker1)}`);

  await step("fund_maker", () => fundMon(A.maker, "MON 0.6 deployer->maker", parseEther("0.6")));
  await step("fund_taker1", () => fundMon(A.taker1, "MON 0.2 deployer->taker1", parseEther("0.2")));
  await sleep(1500);
  await step("ausd_maker", () => faucetSelf(M, "maker"));
  await step("ausd_taker1", () => faucetSelf(T, "taker1"));

  // (a) YES token (deployer = minter) and mint to maker
  await step("yes", async () => {
    const art = JSON.parse(readFileSync(join(here, "../out/SpikeToken.sol/SpikeToken.json"), "utf8"));
    const d = { abi: art.abi, bytecode: art.bytecode.object as Hex, args: ["YES RCSS Tmax>=30C 2026-10-08 (Isotherm spike)", "YES", A.deployer] } as const;
    const est = await pub.estimateGas({ account: D.account!, data: encodeDeployData(d as any) });
    const gas = BigInt(Math.ceil(Number(est) * 1.1));
    const t0 = Date.now();
    const hash = await D.deployContract({ ...(d as any), gas });
    const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250 });
    txLog.push({ label: "deploy SpikeToken (YES 6dp)", hash, gasUsed: rc.gasUsed, gasLimit: gas, effectiveGasPrice: rc.effectiveGasPrice, costMonAt102Gwei: Number(gas * 102n) / 1e9, latencyMs: Date.now() - t0, status: rc.status });
    if (rc.status !== "success") throw new Error("deploy failed");
    return rc.contractAddress;
  });
  const yes = st.yes as Address;
  await step("mint_maker", async () => {
    const art = JSON.parse(readFileSync(join(here, "../out/SpikeToken.sol/SpikeToken.json"), "utf8"));
    await send(pub, D, { to: yes, abi: art.abi, functionName: "mint", args: [A.maker, 500_000_000n] }, "YES.mint 500 -> maker");
    return formatUnits(await bal(yes, A.maker), 6);
  });

  // (b) market creation from the non-owner deployer
  await step("market", async () => (await createMarket(pub, D, yes)).market);
  const market = st.market as Address;
  console.log(`  market ${market}`);

  // (c) maker margin deposits, a single resting order, then a batch ladder that also cancels it
  await step("deposit_ausd", async () => (await depositMargin(pub, M, TESTNET.ausd, ausd(200))).transactionHash);
  await step("deposit_yes", async () => (await depositMargin(pub, M, yes, 400_000_000n)).transactionHash);
  await step("single_ask", async () => {
    const r = await placeLimit(pub, M, market, "ask", { price: 0.45, size: 50 });
    return r.created.map((c) => c.id.toString());
  });
  await step("ladder", async () => {
    const r = await placeQuotes(
      pub, M, market,
      [{ price: 0.42, size: 50 }, { price: 0.41, size: 75 }, { price: 0.4, size: 100 }],
      [{ price: 0.44, size: 50 }, { price: 0.45, size: 75 }, { price: 0.46, size: 100 }],
      (st.single_ask as string[]).map(BigInt),
      true,
      "batchUpdate: cancel 1 + place 3 bids/3 asks",
    );
    return r.created.map((c) => c.id.toString());
  });
  await step("book_quoted", async () => {
    const b = await getBook(pub, market);
    console.log(fmtBook(b));
    return b;
  });

  // (d) second wallet takes liquidity: market buy, YES lands in taker1's wallet
  await step("take", async () => {
    const y0 = await bal(yes, A.taker1);
    const r = await marketBuy(pub, T, market, 20);
    const y1 = await bal(yes, A.taker1);
    return { yesReceived: formatUnits(y1 - y0, 6), fills: r.trades.length, tx: r.receipt.transactionHash };
  });
  await step("book_after_take", async () => {
    const b = await getBook(pub, market);
    console.log(fmtBook(b));
    return b;
  });

  // (e) maker cancels everything it still has resting
  await step("cancel_all", async () => (await cancelAll(pub, M, market, (st.ladder as string[]).map(BigInt)))?.transactionHash ?? "nothing to cancel");
  await step("book_after_cancel", async () => {
    const b = await getBook(pub, market);
    console.log(fmtBook(b));
    return b;
  });
  await step("maker_margin_after", async () => ({
    ausd: formatUnits((await pub.readContract({ address: TESTNET.marginAccount, abi: marginAccountAbi, functionName: "getBalance", args: [A.maker, TESTNET.ausd] })) as bigint, 6),
    yes: formatUnits((await pub.readContract({ address: TESTNET.marginAccount, abi: marginAccountAbi, functionName: "getBalance", args: [A.maker, yes] })) as bigint, 6),
  }));

  console.log("\n  gasLimit(billed)  MON@102gwei  latency  status  label / tx");
  let tot = 0;
  for (const r of st.txs) {
    tot += r.costMonAt102Gwei;
    console.log(`  ${String(r.gasLimit).padStart(9)}  ${r.costMonAt102Gwei.toFixed(5)}  ${String(r.latencyMs).padStart(6)}ms  ${r.status}  ${r.label}  ${r.hash}`);
  }
  console.log(`  total ${st.txs.length} txs ≈ ${tot.toFixed(4)} MON`);
  console.log(`MON deployer=${await mon(A.deployer)} maker=${await mon(A.maker)} taker1=${await mon(A.taker1)}`);
  void orderBookAbi;
}

main().catch((e) => {
  save();
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
