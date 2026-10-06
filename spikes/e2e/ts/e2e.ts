// Isotherm full product loop as REAL transactions, with a per-tx gas table.
//
//   MODE=fork RPC=http://127.0.0.1:18991 npx tsx ts/e2e.ts    (anvil --fork-url <monad testnet> --network monad)
//   MODE=live npx tsx ts/e2e.ts                               (live Monad testnet 10143; see Makefile: testnet-e2e)
//
// Loop: deploy core (+Zap) -> Taipei ladder 28/29/30 (+ a void ladder, + a stale ladder on the fork)
//   -> maker: faucet AUSD, mint complete sets -> one Kuru v1 YES/AUSD book per strike, two-sided maker quotes around a
//   forecast fair value -> taker1 buys YES>=29 on the book; taker2 uses the Zap (buy NO>=30 = mint + sell YES; buy
//   YES>=28) -> maker re-quotes every strike (the "hourly" re-quote), pulls all quotes at close -> the day ends
//   -> CRE report (tmax 29, EIP-712 attested) through the real MockKeystoneForwarder, exactly as
//   `cre workflow simulate --broadcast` sends it; a replay is rejected; the void ladder gets a void report
//   -> redeem: winners 1, losers 0, void 0.5/0.5 -> (fork) stale ladder voided by anyone after 24h -> solvency checks
//   -> budget for a 1-city 6-strike ladder with hourly re-quotes.
// Live mode uses no cheats. By default it registers a throwaway test station ("ZZZZ" = ICAO "no code") whose local
// day ends ~LIVE_DAY_MIN minutes after launch, so settlement + redeem happen in the same sitting. LIVE_STATION=RCSS
// uses the real Taipei day instead (the script waits for 00:00 Taipei; resumable with RESUME=<state.json>).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  decodeEventLog,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  hashTypedData,
  keccak256,
  maxUint256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  A,
  ART,
  BILL_GWEI,
  CHAIN_ID,
  CRE_CONTEXT,
  CRE_SIGS,
  HERE,
  KURU,
  ROLES,
  Recorder,
  SETTLEMENT_TYPES,
  bookAbi,
  creRawReport,
  dayEndOf,
  erc20Abi,
  explainRevert,
  fairValue,
  faucetAbi,
  fmt6,
  forecastTaipei,
  forwarderAbi,
  jsonSafe,
  kuruRouterAbi,
  loadAccount,
  localDate,
  makeClients,
  marginAbi,
  quoteAround,
  readJsonIf,
  settlementPayload,
  short,
  sleep,
  station4,
  writeJson,
  type Rec,
  type Role,
} from "./lib.ts";

// ------------------------------------------------------------------ config
const MODE = (process.env.MODE ?? "fork") as "fork" | "live";
const RPC = process.env.RPC ?? (MODE === "fork" ? "http://127.0.0.1:18991" : "https://testnet-rpc.monad.xyz");
const GAS_MULT = Number(process.env.GAS_MULT ?? 1.1);
const TAKER_GAS_MULT = Number(process.env.TAKER_GAS_MULT ?? 1.25);
const CRE_GAS_LIMIT = BigInt(process.env.CRE_GAS_LIMIT ?? 220_000);
const LIVE_STATION = process.env.LIVE_STATION ?? "fast";
const LIVE_DAY_MIN = Number(process.env.LIVE_DAY_MIN ?? 12);
const TMAX = Number(process.env.TMAX ?? 29);
const STRIKES = [28, 29, 30];
const RESUME = process.env.RESUME;
// REHEARSAL=1: run the MODE=live code path (no cheats, real balances, real waiting) against an anvil fork that mines a
// block every second. Proves the one-command live script end to end without spending real testnet MON.
const REHEARSAL = process.env.REHEARSAL === "1";
const OUT = RESUME ? dirname(RESUME) : join(HERE, "../logs", `${MODE}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(OUT, { recursive: true });
const REQ_FILE = join(HERE, "../logs/live-requirements.json");
if (MODE === "live" && !process.env.RPC && process.env.REHEARSAL === "1") throw new Error("REHEARSAL needs RPC=<anvil url>");

const log = (...a: unknown[]) => {
  const line = a.map(String).join(" ");
  console.log(line);
  appendFileSync(join(OUT, "console.txt"), line + "\n");
};

// ------------------------------------------------------------------ clients, wallets
const { pub, test, wallet, chain } = makeClients(RPC);
const acct = Object.fromEntries(ROLES.map((r) => [r, loadAccount(r)])) as Record<Role, ReturnType<typeof loadAccount>>;
const addr = Object.fromEntries(ROLES.map((r) => [r, acct[r].address])) as Record<Role, Address>;
const rec = new Recorder(OUT);

type SeriesRef = { strike: number; id: Hex; yes: Address; no: Address; market?: Address; symbol?: string };
type Station = { code: string; hex: Hex; offset: number };
type Ctx = {
  mode: string;
  rpc: string;
  done: string[];
  forkBlock?: string;
  stations: { settle: Station; void: Station; stale?: Station };
  date: number;
  dayEnd: number;
  close: number;
  resolver: Address;
  vault: Address;
  zap: Address;
  series: Record<string, SeriesRef>;
  voidSeries: SeriesRef;
  staleSeries?: SeriesRef;
  forecast: { mu: number; sigma: number; source: string; fv: Record<string, number> };
  orders: Record<string, number[]>;
  quotes: Record<string, { bid: number; ask: number }[]>;
  start: Record<string, { mon: string; ausd: string }>;
  r: Record<string, any>;
};
let ctx: Ctx = (RESUME ? JSON.parse(readFileSync(RESUME, "utf8")) : { mode: MODE, rpc: RPC, done: [], series: {}, orders: {}, quotes: {}, start: {}, r: {} }) as Ctx;
if (RESUME) {
  for (const line of readFileSync(join(OUT, "steps.jsonl"), "utf8").split("\n").filter(Boolean)) rec.recs.push(JSON.parse(line));
  log(`resuming ${RESUME}: done = ${ctx.done.join(", ")}`);
}
const save = () => writeJson(join(OUT, "state.json"), ctx);

// ------------------------------------------------------------------ tx sender (estimate -> tight limit -> send -> receipt)
type Req = {
  to?: Address;
  abi?: Abi | readonly unknown[];
  functionName?: string;
  args?: readonly unknown[];
  deploy?: { abi: Abi; bytecode: Hex; args: readonly unknown[] };
  value?: bigint;
  gas?: bigint; // fixed limit (skips the multiplier)
  mult?: number;
  forkOnly?: boolean;
  note?: string;
};
async function send(phase: string, step: string, op: string, who: Role, q: Req): Promise<TransactionReceipt> {
  const data = q.deploy ? encodeDeployData(q.deploy as any) : q.abi ? encodeFunctionData({ abi: q.abi as Abi, functionName: q.functionName!, args: q.args ?? [] } as any) : ("0x" as Hex);
  let est: bigint;
  try {
    est = await pub.estimateGas({ account: acct[who], to: q.to, data, value: q.value });
  } catch (e) {
    throw new Error(`${step}: would revert -> ${explainRevert(e)}`);
  }
  const gas = q.gas ?? BigInt(Math.ceil(Number(est) * (q.mult ?? GAS_MULT)));
  const t0 = Date.now();
  const hash = await wallet(acct[who]).sendTransaction({ account: acct[who], chain, to: q.to ?? null, data, value: q.value, gas } as any);
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 180_000 });
  const latencyMs = Date.now() - t0;
  const x = rec.add({
    phase,
    step,
    op,
    who,
    gasUsed: r.gasUsed.toString(),
    gasEstimate: est.toString(),
    gasLimit: gas.toString(),
    monBilled: Number(gas * BILL_GWEI) / 1e9,
    latencyMs,
    block: r.blockNumber.toString(),
    hash,
    status: r.status,
    forkOnly: q.forkOnly,
    note: q.note,
  });
  log(`  #${String(x.n).padStart(2)} ${step.padEnd(52)} ${who.padEnd(8)} used ${String(r.gasUsed).padStart(9)} limit ${String(gas).padStart(9)}  ${x.monBilled.toFixed(4)} MON  ${latencyMs} ms  ${short(hash)}`);
  if (r.status !== "success") throw new Error(`${step} reverted on-chain: ${hash}`);
  return r;
}

const read = <T = any>(address: Address, abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi: abi as Abi, functionName, args } as any) as Promise<T>;
const bal = (token: Address, who: Address) => read<bigint>(token, erc20Abi, "balanceOf", [who]);
const ausdOf = (who: Address) => bal(A.ausd, who);
const now = async () => Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
const V = () => ({ address: ctx.vault, abi: ART.CollateralVault.abi });
const Rz = () => ({ address: ctx.resolver, abi: ART.Resolver.abi });

function eventsOf(r: TransactionReceipt, abi: Abi | readonly unknown[], address?: Address) {
  const out: any[] = [];
  for (const l of r.logs) {
    if (address && l.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      out.push(decodeEventLog({ abi: abi as Abi, data: l.data, topics: l.topics }));
    } catch {}
  }
  return out;
}

async function faucet(phase: string, to: Role) {
  for (let i = 0; i < 30; i++) { // live: other users share the global cooldown; up to ~7.5 min
    try {
      await pub.estimateGas({ account: acct[to], to: A.faucet, data: encodeFunctionData({ abi: faucetAbi, functionName: "requestFunds", args: [addr[to]] }) });
    } catch (e) {
      const why = explainRevert(e);
      if (!why.includes("MaxFrequencyExceeded")) throw new Error(`faucet: ${why}`);
      log(`  faucet: global 60 s cooldown (MaxFrequencyExceeded), ${MODE === "fork" ? "advancing anvil clock 61 s" : "waiting 15 s"}`);
      if (MODE === "fork") {
        await test.increaseTime({ seconds: 61 });
        await test.mine({ blocks: 1 });
      } else await sleep(15_000);
      continue;
    }
    return send(phase, `AUSD faucet.requestFunds -> ${to}`, "faucet", to, { to: A.faucet, abi: faucetAbi, functionName: "requestFunds", args: [addr[to]] });
  }
  throw new Error("faucet kept failing");
}

/** Remaining size of one of our Kuru orders, 0 if filled/cancelled. Open iff owner matches, price != 0 and the
 *  price point's head is non-zero and <= id (a fully filled order keeps its struct; rule from the Kuru spike). */
async function openRemaining(market: Address, id: number): Promise<{ size: bigint; price: number; isBuy: boolean }> {
  const o = await read<any[]>(market, bookAbi, "s_orders", [id]);
  const [owner, size, , , , price, , isBuy] = o as [Address, bigint, number, number, number, number, number, boolean];
  if (owner.toLowerCase() !== addr.maker.toLowerCase() || Number(price) === 0) return { size: 0n, price: 0, isBuy };
  const [head] = await read<[number, number]>(market, bookAbi, isBuy ? "s_buyPricePoints" : "s_sellPricePoints", [BigInt(price)]);
  return { size: Number(head) !== 0 && Number(head) <= id ? size : 0n, price: Number(price), isBuy };
}

/** Inventory-aware sizes: what the maker can lock after the cancels = free margin + what the cancelled orders free.
 *  (A naive fixed-size re-quote after a fill reverts with Kuru InsufficientBalance() 0xf4d678b8, seen in this run.) */
async function sizesFor(k: number, bid: number, cancel: number[], target: bigint) {
  const s = ctx.series[k];
  let freeYes = await read<bigint>(A.marginAccount, marginAbi, "getBalance", [addr.maker, s.yes]);
  let freeAusd = await read<bigint>(A.marginAccount, marginAbi, "getBalance", [addr.maker, A.ausd]);
  for (const id of cancel) {
    const o = await openRemaining(s.market!, id);
    if (o.isBuy) freeAusd += (o.size * BigInt(o.price)) / 10_000n;
    else freeYes += o.size;
  }
  const askSize = freeYes < target ? (freeYes / 1_000_000n) * 1_000_000n : target;
  const bidCap = ((freeAusd * 10_000n) / BigInt(bid) / 1_000_000n) * 1_000_000n; // whole YES
  const bidSize = bidCap < target ? bidCap : target;
  return { bidSize, askSize, freeYes, freeAusd };
}

/** Kuru: one batchUpdate = cancel `cancel` ids, then place 1 bid + 1 ask (post-only). Returns the new order ids. */
async function quote(phase: string, k: number, bid: number, ask: number, target: bigint, cancel: number[], op: string) {
  const s = ctx.series[k];
  const { bidSize, askSize } = await sizesFor(k, bid, cancel, target);
  const r = await send(phase, `maker ${op === "quoteInit" ? "quote" : "re-quote"} >=${k}: ${Number(bidSize) / 1e6}@${(bid / 1e4).toFixed(3)} / ${Number(askSize) / 1e6}@${(ask / 1e4).toFixed(3)}${cancel.length ? ` cancel ${cancel.length}` : ""}`, op, "maker", {
    to: s.market!,
    abi: bookAbi,
    functionName: "batchUpdate",
    args: [bidSize ? [bid] : [], bidSize ? [bidSize] : [], askSize ? [ask] : [], askSize ? [askSize] : [], cancel, true],
  });
  const ids = eventsOf(r, bookAbi, s.market).filter((e) => e.eventName === "OrderCreated").map((e) => Number(e.args.orderId));
  ctx.orders[k] = ids;
  (ctx.quotes[k] ??= []).push({ bid, ask });
  return ids;
}

async function bookLine(k: number) {
  const [b, a] = await read<[bigint, bigint]>(ctx.series[k].market!, bookAbi, "bestBidAsk");
  const bid = b === maxUint256 ? "none" : (Number(b) / 1e18).toFixed(3);
  const ask = a === 0n ? "none" : (Number(a) / 1e18).toFixed(3);
  return `>=${k}C  bestBid ${bid}  bestAsk ${ask}`;
}

async function creReport(phase: string, step: string, op: string, st: Station, tmax: number, isVoid: boolean, tag: string) {
  const sourcesHash = keccak256(stringToHex(`iem+awc:${st.code}:${ctx.date}:${isVoid ? "void" : tmax}`));
  const domain = { name: "Isotherm Resolver", version: "1", chainId: CHAIN_ID, verifyingContract: ctx.resolver } as const;
  const message = { station: st.hex, date: ctx.date, tmaxC: tmax, isVoid, sourcesHash } as const;
  // attester = deployer (this e2e); signature made by viem, independent of the Solidity digest code
  const sig = await acct.deployer.signTypedData({ domain, types: SETTLEMENT_TYPES, primaryType: "Settlement", message });
  const onchainDigest = await read<Hex>(ctx.resolver, ART.Resolver.abi, "settlementDigest", [st.hex, ctx.date, tmax, isVoid, sourcesHash]);
  const localDigest = hashTypedData({ domain, types: SETTLEMENT_TYPES, primaryType: "Settlement", message });
  if (onchainDigest !== localDigest) throw new Error(`EIP-712 digest mismatch ${onchainDigest} vs ${localDigest}`);
  const raw = creRawReport(keccak256(stringToHex(`${tag}:${OUT}`)), settlementPayload(st.hex, ctx.date, tmax, isVoid, sourcesHash, sig));
  const args = [ctx.resolver, raw, CRE_CONTEXT, CRE_SIGS] as const;
  // The mock forwards all gas and swallows a failing onReport, so eth_estimateGas can return a limit at which
  // onReport silently runs out of gas. Use a fixed limit and record what the node estimated.
  const est = await pub.estimateGas({ account: acct.deployer, to: A.mockForwarder, data: encodeFunctionData({ abi: forwarderAbi, functionName: "report", args }) });
  const r = await send(phase, step, op, "deployer", { to: A.mockForwarder, abi: forwarderAbi, functionName: "report", args, gas: CRE_GAS_LIMIT, note: `eth_estimateGas said ${est}` });
  const rp = eventsOf(r, forwarderAbi, A.mockForwarder).find((e) => e.eventName === "ReportProcessed");
  const lr = eventsOf(r, ART.Resolver.abi, ctx.resolver).find((e) => e.eventName === "LadderResolved");
  return { result: rp?.args.result as boolean, ladderResolved: lr?.args, estimate: est, gasUsed: r.gasUsed, hash: r.transactionHash, digest: onchainDigest };
}

// ------------------------------------------------------------------ phases
const phases: [string, () => Promise<void>][] = [];
const phase = (name: string, fn: () => Promise<void>) => phases.push([name, fn]);

phase("preflight", async () => {
  const cid = await pub.getChainId();
  if (cid !== CHAIN_ID) throw new Error(`refusing: chain ${cid} is not Monad testnet ${CHAIN_ID}`);
  const client = (await pub.request({ method: "web3_clientVersion" as any })) as string;
  if (MODE === "fork" && !/anvil/i.test(client)) throw new Error(`MODE=fork but ${RPC} is ${client}, not anvil`);
  if (MODE === "live" && /anvil/i.test(client) && !REHEARSAL) throw new Error("MODE=live but RPC is anvil (set REHEARSAL=1 for a no-cheat rehearsal)");
  if (MODE === "live" && REHEARSAL) log("REHEARSAL: live code path (no cheats) against an anvil fork; nothing reaches the real chain");
  ctx.forkBlock = (await pub.getBlockNumber()).toString();
  log(`chain ${cid} via ${client} at block ${ctx.forkBlock}, ts ${await now()} (${new Date((await now()) * 1000).toISOString()})`);
  log(`MockKeystoneForwarder ${A.mockForwarder}: ${await read(A.mockForwarder, forwarderAbi, "typeAndVersion")}`);
  if (MODE === "fork") for (const r of ROLES) await test.setBalance({ address: addr[r], value: 100n * 10n ** 18n });
  for (const r of ROLES) {
    ctx.start[r] = { mon: formatEther(await pub.getBalance({ address: addr[r] })), ausd: fmt6(await ausdOf(addr[r])) };
    log(`  ${r.padEnd(8)} ${addr[r]}  ${ctx.start[r].mon} MON  ${ctx.start[r].ausd} AUSD`);
  }
});

phase("fund", async () => {
  if (MODE !== "live") return;
  const req = readJsonIf<{ perRole: Record<Role, number> }>(REQ_FILE);
  if (!req) throw new Error(`${REQ_FILE} missing: run 'make fork-e2e' first (it measures what each wallet needs)`);
  for (const r of ["maker", "taker1", "taker2"] as Role[]) {
    const have = Number(formatEther(await pub.getBalance({ address: addr[r] })));
    const need = req.perRole[r];
    if (have >= need) continue;
    const amt = BigInt(Math.ceil((need - have) * 1e4)) * 10n ** 14n;
    // Monad reserve balance: an account under 10 MON may only send value in an "emptying" tx, i.e. with no other tx
    // from it in the previous 3 blocks. Wait 4 blocks before every transfer.
    const b0 = await pub.getBlockNumber();
    while ((await pub.getBlockNumber()) < b0 + 4n) await sleep(300);
    await send("fund", `MON ${formatEther(amt)} deployer -> ${r}`, "fund", "deployer", { to: addr[r], value: amt });
  }
  for (const r of ROLES) {
    const have = Number(formatEther(await pub.getBalance({ address: addr[r] })));
    if (have < req.perRole[r]) throw new Error(`${r} has ${have} MON, needs ${req.perRole[r]} (run 'make testnet-preflight')`);
  }
});

phase("deploy", async () => {
  const t = await now();
  if (MODE === "fork" || LIVE_STATION === "RCSS") {
    ctx.stations = { settle: { code: "RCSS", hex: station4("RCSS"), offset: 8 * 3600 }, void: { code: "RJTT", hex: station4("RJTT"), offset: 9 * 3600 } };
    if (MODE === "fork") ctx.stations.stale = { code: "ZGSZ", hex: station4("ZGSZ"), offset: 8 * 3600 };
  } else {
    // throwaway test station whose local day ends LIVE_DAY_MIN..+15 min from now (offset is a multiple of 15 min)
    let best: { off: number; end: number } | undefined;
    for (let off = -12 * 3600; off <= 14 * 3600; off += 900) {
      const end = dayEndOf(localDate(t, off), off);
      if (end - t >= LIVE_DAY_MIN * 60 && (!best || end < best.end)) best = { off, end };
    }
    ctx.stations = { settle: { code: "ZZZZ", hex: station4("ZZZZ"), offset: best!.off }, void: { code: "ZZZY", hex: station4("ZZZY"), offset: best!.off } };
    log(`  live fast mode: test stations ZZZZ/ZZZY at UTC${best!.off >= 0 ? "+" : ""}${best!.off / 3600}h, local day ends in ${((best!.end - t) / 60).toFixed(1)} min`);
  }
  let r = await send("deploy", "deploy Resolver (forwarder=MockKeystoneForwarder, attester=deployer)", "deployResolver", "deployer", {
    deploy: { abi: ART.Resolver.abi, bytecode: ART.Resolver.bytecode, args: [addr.deployer, A.mockForwarder, addr.deployer, addr.deployer] },
  });
  ctx.resolver = r.contractAddress!;
  r = await send("deploy", "deploy CollateralVault (+OutcomeToken impl)", "deployVault", "deployer", {
    deploy: { abi: ART.CollateralVault.abi, bytecode: ART.CollateralVault.bytecode, args: [addr.deployer, ctx.resolver, A.ausd, addr.deployer] },
  });
  ctx.vault = r.contractAddress!;
  for (const st of [ctx.stations.settle, ctx.stations.void, ctx.stations.stale].filter(Boolean) as Station[]) {
    await send("deploy", `registerStation ${st.code} UTC${st.offset >= 0 ? "+" : ""}${st.offset / 3600}h`, "registerStation", "deployer", {
      ...Rz(),
      to: ctx.resolver,
      functionName: "registerStation",
      args: [st.hex, st.offset],
      forkOnly: st === ctx.stations.stale,
    });
  }
  r = await send("deploy", "deploy IsothermZap (Kuru router, vault)", "deployZap", "deployer", {
    deploy: { abi: ART.IsothermZap.abi, bytecode: ART.IsothermZap.bytecode, args: [A.kuruRouter, ctx.vault] },
  });
  ctx.zap = r.contractAddress!;
  log(`  Resolver ${ctx.resolver}  Vault ${ctx.vault}  Zap ${ctx.zap}`);
});

phase("ladder", async () => {
  const t = await now();
  const st = ctx.stations.settle;
  if (st.code === "RCSS") {
    const minLead = MODE === "fork" ? 3 * 3600 : 30 * 60;
    let d = localDate(t, st.offset);
    if (dayEndOf(d, st.offset) - t < minLead) d = localDate(t + 86_400, st.offset);
    ctx.date = d;
  } else ctx.date = localDate(t, st.offset);
  ctx.dayEnd = Number(await read<bigint>(ctx.resolver, ART.Resolver.abi, "dayEnd", [st.hex, ctx.date]));
  if (ctx.dayEnd !== dayEndOf(ctx.date, st.offset)) throw new Error("dayEnd mismatch between TS and Resolver");
  ctx.close = ctx.dayEnd - (MODE === "fork" ? 3600 : st.code === "RCSS" ? 600 : 60);
  log(`  ${st.code} local date ${ctx.date}, dayEnd ${new Date(ctx.dayEnd * 1000).toISOString()}, close ${new Date(ctx.close * 1000).toISOString()}`);
  await send("ladder", `createLadder ${st.code} ${ctx.date} strikes [${STRIKES}]`, "createLadder3", "deployer", {
    ...V(),
    to: ctx.vault,
    functionName: "createLadder",
    args: [st.hex, ctx.date, STRIKES, BigInt(ctx.close)],
  });
  const ids = await read<Hex[]>(ctx.vault, ART.CollateralVault.abi, "ladderSeries", [st.hex, ctx.date]);
  for (const id of ids) {
    const s = await read<any>(ctx.vault, ART.CollateralVault.abi, "getSeries", [id]);
    ctx.series[s.strikeC] = { strike: Number(s.strikeC), id, yes: s.yes, no: s.no, symbol: await read<string>(s.yes, erc20Abi, "symbol") };
  }
  const mk = async (st2: Station, strike: number, forkOnly = false, op = "createSeries") => {
    const end = Number(await read<bigint>(ctx.resolver, ART.Resolver.abi, "dayEnd", [st2.hex, ctx.date]));
    const close = Math.min(ctx.close, end - (MODE === "fork" ? 3600 : 60));
    await send("ladder", `createSeries ${st2.code} ${ctx.date} >=${strike}`, op, "deployer", { ...V(), to: ctx.vault, functionName: "createSeries", args: [st2.hex, ctx.date, strike, BigInt(close)], forkOnly });
    const id = await read<Hex>(ctx.vault, ART.CollateralVault.abi, "seriesIdOf", [st2.hex, ctx.date, strike]);
    const s = await read<any>(ctx.vault, ART.CollateralVault.abi, "getSeries", [id]);
    return { strike, id, yes: s.yes, no: s.no, symbol: await read<string>(s.yes, erc20Abi, "symbol") } as SeriesRef;
  };
  ctx.voidSeries = await mk(ctx.stations.void, 25);
  if (ctx.stations.stale) ctx.staleSeries = await mk(ctx.stations.stale, 30, true, "createSeriesStale");
  for (const k of STRIKES) log(`  ${ctx.series[k].symbol}  YES ${ctx.series[k].yes}  NO ${ctx.series[k].no}`);
  log(`  void ladder ${ctx.voidSeries.symbol}${ctx.staleSeries ? `, stale ladder ${ctx.staleSeries.symbol}` : ""}`);
});

phase("makerInventory", async () => {
  await faucet("maker", "maker");
  await send("maker", "maker approve AUSD -> vault", "approveAusdVault", "maker", { to: A.ausd, abi: erc20Abi, functionName: "approve", args: [ctx.vault, maxUint256] });
  for (const k of STRIKES) await send("maker", `maker mintSet >=${k} x500`, "mintSet", "maker", { ...V(), to: ctx.vault, functionName: "mintSet", args: [ctx.series[k].id, 500_000_000n] });
  await send("maker", `maker mintSet void-ladder ${ctx.voidSeries.symbol.slice(0, 4)} x100`, "mintSetVoid", "maker", { ...V(), to: ctx.vault, functionName: "mintSet", args: [ctx.voidSeries.id, 100_000_000n] });
  if (ctx.staleSeries)
    await send("maker", "maker mintSet stale-ladder ZGSZ x10", "mintSetStale", "maker", { ...V(), to: ctx.vault, functionName: "mintSet", args: [ctx.staleSeries.id, 10_000_000n], forkOnly: true });
});

phase("markets", async () => {
  const fc = await forecastTaipei(ctx.date);
  const sigma = 1.5;
  ctx.forecast = { mu: fc.mu, sigma, source: fc.source, fv: Object.fromEntries(STRIKES.map((k) => [k, fairValue(fc.mu, sigma, k)])) };
  log(`  forecast: Taipei ${ctx.date} Tmax mu=${fc.mu} sigma=${sigma} (${fc.source.startsWith("http") ? "Open-Meteo" : fc.source}) -> P(>=k): ${STRIKES.map((k) => `${k}:${ctx.forecast.fv[k].toFixed(3)}`).join(" ")}`);
  for (const k of STRIKES) {
    const r = await send("markets", `Kuru Router.deployProxy YES>=${k}/AUSD`, "deployProxy", "deployer", {
      to: A.kuruRouter,
      abi: kuruRouterAbi,
      functionName: "deployProxy",
      args: [KURU.type, ctx.series[k].yes, A.ausd, KURU.sizePrecision, KURU.pricePrecision, KURU.tick, KURU.minSize, KURU.maxSize, KURU.takerFeeBps, KURU.makerFeeBps, KURU.ammSpread],
    });
    ctx.series[k].market = eventsOf(r, kuruRouterAbi).find((e) => e.eventName === "MarketRegistered")!.args.market;
  }
  await send("markets", "maker approve AUSD -> Kuru MarginAccount", "approveAusdMargin", "maker", { to: A.ausd, abi: erc20Abi, functionName: "approve", args: [A.marginAccount, maxUint256] });
  await send("markets", "maker MarginAccount.deposit AUSD 800", "depositAusd", "maker", { to: A.marginAccount, abi: marginAbi, functionName: "deposit", args: [addr.maker, A.ausd, 800_000_000n] });
  for (const k of STRIKES) {
    const yes = ctx.series[k].yes;
    await send("markets", `maker approve YES>=${k} -> MarginAccount`, "approveYesMargin", "maker", { to: yes, abi: erc20Abi, functionName: "approve", args: [A.marginAccount, maxUint256] });
    await send("markets", `maker MarginAccount.deposit YES>=${k} 300`, "depositYes", "maker", { to: A.marginAccount, abi: marginAbi, functionName: "deposit", args: [addr.maker, yes, 300_000_000n] });
  }
  for (const k of STRIKES) {
    const { bid, ask } = quoteAround(ctx.forecast.fv[k]);
    await quote("markets", k, bid, ask, 200_000_000n, [], "quoteInit");
  }
  for (const k of STRIKES) log(`  book ${await bookLine(k)}  market ${ctx.series[k].market}`);
});

phase("takers", async () => {
  // taker1: buy YES>=29 straight from the Kuru book (approve the market, market-buy, YES lands in the wallet)
  await faucet("takers", "taker1");
  const s29 = ctx.series[29];
  const ask29 = ctx.quotes[29][0].ask / 1e4;
  const spend = Math.min(50, Math.floor(0.9 * 200 * ask29)); // stay inside the first level
  const spend6 = BigInt(spend) * 1_000_000n;
  const expYes = (spend / ask29) * 0.999;
  await send("takers", `taker1 approve AUSD -> market >=29`, "approveMarket", "taker1", { to: A.ausd, abi: erc20Abi, functionName: "approve", args: [s29.market!, spend6] });
  const y0 = await bal(s29.yes, addr.taker1);
  const r = await send("takers", `taker1 Kuru market-buy YES>=29 for ${spend} AUSD`, "takerBuy", "taker1", {
    to: s29.market!,
    abi: bookAbi,
    functionName: "placeAndExecuteMarketBuy",
    args: [spend6 / 100n, BigInt(Math.floor(expYes * 0.98 * 1e6)), false, false],
    mult: TAKER_GAS_MULT,
  });
  const yes29 = (await bal(s29.yes, addr.taker1)) - y0;
  const trades = eventsOf(r, bookAbi, s29.market).filter((e) => e.eventName === "Trade");
  ctx.r.taker1 = { spentAusd: spend, yes29: yes29.toString(), fills: trades.length, ask: ask29 };
  log(`  taker1 got ${fmt6(yes29)} YES>=29 in wallet (${trades.length} Trade event(s) at ${ask29}; expected ${expYes.toFixed(6)})`);

  // taker2: Zap flows (approve the Zap once; works for every strike, every day)
  await send("takers", "taker1 transfer 200 AUSD -> taker2", "transfer", "taker1", { to: A.ausd, abi: erc20Abi, functionName: "transfer", args: [addr.taker2, 200_000_000n] });
  await send("takers", "taker2 approve AUSD -> Zap (once)", "approveZap", "taker2", { to: A.ausd, abi: erc20Abi, functionName: "approve", args: [ctx.zap, maxUint256] });
  const s30 = ctx.series[30];
  const bid30 = ctx.quotes[30][0].bid / 1e4;
  const expBack = 40 * bid30 * 0.999;
  const a0 = await ausdOf(addr.taker2);
  const rz = await send("takers", `taker2 Zap.buyNo >=30 with 40 AUSD (mint set, sell YES)`, "zapBuyNo", "taker2", {
    to: ctx.zap,
    abi: ART.IsothermZap.abi,
    functionName: "buyNo",
    args: [s30.id, s30.market!, 40_000_000n, BigInt(Math.floor(expBack * 0.98 * 1e6)), addr.taker2],
    mult: TAKER_GAS_MULT,
  });
  const ev = eventsOf(rz, ART.IsothermZap.abi, ctx.zap).find((e) => e.eventName === "ZapBuyNo")!.args;
  const net = a0 - (await ausdOf(addr.taker2));
  ctx.r.taker2 = { no30: ev.noOut.toString(), back30: ev.ausdBack.toString(), netCost30: net.toString(), bid30 };
  log(`  taker2 got ${fmt6(ev.noOut)} NO>=30 + ${fmt6(ev.ausdBack)} AUSD back; net NO price ${(Number(net) / Number(ev.noOut)).toFixed(4)} (1 - bid ${bid30} - fee)`);

  const s28 = ctx.series[28];
  const ask28 = ctx.quotes[28][0].ask / 1e4;
  const spend28 = Math.min(30, Math.floor(0.9 * 200 * ask28));
  const exp28 = (spend28 / ask28) * 0.999;
  const rb = await send("takers", `taker2 Zap.buyYes >=28 with ${spend28} AUSD`, "zapBuyYes", "taker2", {
    to: ctx.zap,
    abi: ART.IsothermZap.abi,
    functionName: "buyYes",
    args: [s28.id, s28.market!, BigInt(spend28) * 1_000_000n, BigInt(Math.floor(exp28 * 0.98 * 1e6)), addr.taker2],
    mult: TAKER_GAS_MULT,
  });
  const eb = eventsOf(rb, ART.IsothermZap.abi, ctx.zap).find((e) => e.eventName === "ZapBuyYes")!.args;
  ctx.r.taker2.yes28 = eb.yesOut.toString();
  ctx.r.taker2.spend28 = spend28;
  log(`  taker2 got ${fmt6(eb.yesOut)} YES>=28 (refund ${fmt6(eb.ausdRefund)})`);
  // the Zap keeps nothing
  const left = [await ausdOf(ctx.zap), ...(await Promise.all(STRIKES.flatMap((k) => [bal(ctx.series[k].yes, ctx.zap), bal(ctx.series[k].no, ctx.zap)])))];
  if (left.some((x) => x !== 0n)) throw new Error(`Zap holds tokens: ${left}`);
  log("  Zap balance after both flows: 0 AUSD, 0 YES, 0 NO");
  for (const k of STRIKES) log(`  book ${await bookLine(k)}`);
});

phase("requote", async () => {
  // one "hourly" re-quote round: forecast moved by +/-0.01 -> cancel both orders and post a new 1 bid / 1 ask per strike
  for (const [i, k] of STRIKES.entries()) {
    const fv2 = ctx.forecast.fv[k] + (i % 2 === 0 ? 0.01 : -0.01);
    const { bid, ask } = quoteAround(Math.min(Math.max(fv2, 0), 1));
    await quote("requote", k, bid, ask, 200_000_000n, ctx.orders[k], "requote");
  }
});

phase("close", async () => {
  // Isotherm cannot pause a Kuru book, so the maker pulls every quote at close (before the result is knowable).
  for (const k of STRIKES)
    await send("close", `maker pull quotes >=${k} (batchCancelOrdersNoRevert x${ctx.orders[k].length})`, "cancelClose", "maker", {
      to: ctx.series[k].market!,
      abi: bookAbi,
      functionName: "batchCancelOrdersNoRevert",
      args: [ctx.orders[k]],
    });
  for (const k of STRIKES) log(`  book ${await bookLine(k)}`);
});

phase("dayEnd", async () => {
  const target = ctx.dayEnd + (MODE === "fork" ? 600 : 5);
  if (MODE === "fork") {
    await test.setNextBlockTimestamp({ timestamp: BigInt(target) });
    await test.mine({ blocks: 1 });
    log(`  anvil clock -> ${new Date((await now()) * 1000).toISOString()} (dayEnd + 10 min)`);
  } else {
    let t = await now();
    while (t < target) {
      log(`  waiting for the ${ctx.stations.settle.code} local day to end: ${Math.ceil((target - t) / 60)} min left (Ctrl-C is safe; resume with RESUME=${join(OUT, "state.json")})`);
      await sleep(Math.min(60_000, (target - t) * 1000 + 1000));
      t = await now();
    }
  }
  const due = await read<any[]>(ctx.vault, ART.CollateralVault.abi, "duePendingLadders", [0n, 50n]);
  log(`  vault.duePendingLadders -> ${due.map((d: any) => `${Buffer.from(d.station.slice(2), "hex").toString()}/${d.date}`).join(", ")}`);
});

phase("settle", async () => {
  const st = ctx.stations.settle;
  const a = await creReport("settle", `CRE report ${st.code} tmax=${TMAX} via MockKeystoneForwarder`, "creSettle", st, TMAX, false, "settle");
  if (!a.result) throw new Error("settlement report was not accepted");
  const res = await read<any>(ctx.resolver, ART.Resolver.abi, "resultOf", [st.hex, ctx.date]);
  log(`  ReportProcessed.result=${a.result}  LadderResolved status=${a.ladderResolved?.status} tmax=${a.ladderResolved?.tmaxC}  resultOf=(${res.status}, ${res.tmaxC})  eth_estimateGas=${a.estimate} vs used ${a.gasUsed}`);
  const b = await creReport("settle", `CRE replay ${st.code} tmax=35 (must be rejected)`, "creReplay", st, 35, false, "replay");
  log(`  replay ReportProcessed.result=${b.result} (tx succeeds, Resolver rejected it: write-once)`);
  if (b.result) throw new Error("replay accepted!");
  const v = await creReport("settle", `CRE void report ${ctx.stations.void.code}`, "creVoid", ctx.stations.void, 0, true, "void");
  if (!v.result) throw new Error("void report was not accepted");
  ctx.r.cre = { settle: { hash: a.hash, estimate: a.estimate.toString(), gasUsed: a.gasUsed.toString() }, replay: b.hash, void: v.hash };
});

phase("redeem", async () => {
  const payout = (r: TransactionReceipt) => eventsOf(r, ART.CollateralVault.abi, ctx.vault).find((e) => e.eventName === "Redeemed")!.args.payout as bigint;
  const y29 = BigInt(ctx.r.taker1.yes29);
  let r = await send("redeem", `taker1 redeem YES>=29 x${fmt6(y29)} (29>=29 wins)`, "redeem", "taker1", { ...V(), to: ctx.vault, functionName: "redeem", args: [ctx.series[29].id, y29, 0n] });
  if (payout(r) !== y29) throw new Error("taker1 payout != YES amount");
  const no30 = BigInt(ctx.r.taker2.no30), y28 = BigInt(ctx.r.taker2.yes28);
  r = await send("redeem", `taker2 redeem NO>=30 x${fmt6(no30)} (29<30: NO wins)`, "redeem", "taker2", { ...V(), to: ctx.vault, functionName: "redeem", args: [ctx.series[30].id, 0n, no30] });
  if (payout(r) !== no30) throw new Error("taker2 NO payout wrong");
  r = await send("redeem", `taker2 redeem YES>=28 x${fmt6(y28)}`, "redeem", "taker2", { ...V(), to: ctx.vault, functionName: "redeem", args: [ctx.series[28].id, y28, 0n] });
  if (payout(r) !== y28) throw new Error("taker2 YES28 payout wrong");
  await send("redeem", "maker MarginAccount.batchWithdrawMaxTokens [AUSD, YES x3]", "withdraw", "maker", {
    to: A.marginAccount,
    abi: marginAbi,
    functionName: "batchWithdrawMaxTokens",
    args: [[A.ausd, ...STRIKES.map((k) => ctx.series[k].yes)]],
  });
  const no29 = await bal(ctx.series[29].no, addr.maker);
  r = await send("redeem", `maker redeem losing NO>=29 x${fmt6(no29)} -> pays 0`, "redeemLoser", "maker", { ...V(), to: ctx.vault, functionName: "redeem", args: [ctx.series[29].id, 0n, no29] });
  ctx.r.loserPayout = payout(r).toString();
  if (payout(r) !== 0n) throw new Error("loser paid!");
  log(`  losing side: maker burned ${fmt6(no29)} NO>=29, payout ${fmt6(payout(r))} AUSD`);
  ctx.r.makerRedeem = {};
  for (const k of STRIKES) {
    const y = await bal(ctx.series[k].yes, addr.maker), n = await bal(ctx.series[k].no, addr.maker);
    if (y + n === 0n) continue;
    r = await send("redeem", `maker redeem >=${k} YES x${fmt6(y)} NO x${fmt6(n)}`, "redeemMaker", "maker", { ...V(), to: ctx.vault, functionName: "redeem", args: [ctx.series[k].id, y, n] });
    ctx.r.makerRedeem[k] = { yes: y.toString(), no: n.toString(), payout: payout(r).toString() };
  }
  // void ladder: YES and NO each pay 0.5
  r = await send("redeem", `maker redeem void ${ctx.stations.void.code} YES x100 -> 0.5 each`, "redeemVoid", "maker", { ...V(), to: ctx.vault, functionName: "redeem", args: [ctx.voidSeries.id, 100_000_000n, 0n] });
  const vy = payout(r);
  r = await send("redeem", `maker redeem void ${ctx.stations.void.code} NO x100 -> 0.5 each`, "redeemVoid", "maker", { ...V(), to: ctx.vault, functionName: "redeem", args: [ctx.voidSeries.id, 0n, 100_000_000n] });
  const vn = payout(r);
  if (vy !== 50_000_000n || vn !== 50_000_000n) throw new Error(`void payouts ${vy}/${vn}`);
  ctx.r.void = { yesPayout: vy.toString(), noPayout: vn.toString() };
  log(`  void: 100 YES -> ${fmt6(vy)} AUSD, 100 NO -> ${fmt6(vn)} AUSD`);
});

phase("stale", async () => {
  if (!ctx.staleSeries || MODE !== "fork") return;
  const st = ctx.stations.stale!;
  const end = Number(await read<bigint>(ctx.resolver, ART.Resolver.abi, "dayEnd", [st.hex, ctx.date]));
  await test.setNextBlockTimestamp({ timestamp: BigInt(end + 86_400 + 60) });
  await test.mine({ blocks: 1 });
  await send("stale", `anyone (taker1) voidIfStale ${st.code} after 24h without a report`, "voidIfStale", "taker1", { ...Rz(), to: ctx.resolver, functionName: "voidIfStale", args: [st.hex, ctx.date], forkOnly: true });
  const r = await send("stale", `maker redeem stale ${st.code} set x10 -> 10 AUSD`, "redeemStale", "maker", { ...V(), to: ctx.vault, functionName: "redeem", args: [ctx.staleSeries.id, 10_000_000n, 10_000_000n], forkOnly: true });
  const p = eventsOf(r, ART.CollateralVault.abi, ctx.vault).find((e) => e.eventName === "Redeemed")!.args.payout as bigint;
  if (p !== 10_000_000n) throw new Error("stale payout");
});

phase("checks", async () => {
  const all = [...STRIKES.map((k) => ctx.series[k]), ctx.voidSeries, ...(ctx.staleSeries ? [ctx.staleSeries] : [])];
  let sum = 0n;
  const rows: string[] = [];
  for (const s of all) {
    const g = await read<any>(ctx.vault, ART.CollateralVault.abi, "getSeries", [s.id]);
    const [yh, nh] = await read<[bigint, bigint]>(ctx.vault, ART.CollateralVault.abi, "payoutHalves", [s.id]);
    const ys = await read<bigint>(s.yes, erc20Abi, "totalSupply"), ns = await read<bigint>(s.no, erc20Abi, "totalSupply");
    const claims = (ys * yh + ns * nh) / 2n;
    if (g.collateral < claims) throw new Error(`series ${s.symbol} insolvent`);
    sum += g.collateral;
    rows.push(`${s.symbol!.padEnd(22)} payout YES/NO ${Number(yh) / 2}/${Number(nh) / 2}  collateral ${fmt6(g.collateral)}  outstanding claims ${fmt6(claims)}`);
  }
  const vaultAusd = await ausdOf(ctx.vault);
  if (vaultAusd !== sum) throw new Error(`vault AUSD ${vaultAusd} != sum(collateral) ${sum}`);
  rows.forEach((x) => log("  " + x));
  log(`  vault AUSD ${fmt6(vaultAusd)} == sum(series collateral) ${fmt6(sum)}  (the remaining claims are Kuru's taker-fee YES)`);
  ctx.r.end = {};
  for (const r of ROLES) {
    const a = await ausdOf(addr[r]);
    ctx.r.end[r] = { ausd: fmt6(a), mon: formatEther(await pub.getBalance({ address: addr[r] })) };
  }
  const t1 = ctx.r.taker1;
  log(`  taker1: paid ${t1.spentAusd} AUSD for ${fmt6(BigInt(t1.yes29))} YES>=29, redeemed ${fmt6(BigInt(t1.yes29))} -> P&L ${(Number(t1.yes29) / 1e6 - t1.spentAusd).toFixed(6)} AUSD`);
  const t2 = ctx.r.taker2;
  log(`  taker2: NO>=30 cost ${fmt6(BigInt(t2.netCost30))} for ${fmt6(BigInt(t2.no30))} (paid ${fmt6(BigInt(t2.no30))}); YES>=28 cost ${t2.spend28} for ${fmt6(BigInt(t2.yes28))} (paid ${fmt6(BigInt(t2.yes28))})`);
});

phase("budgetProbe", async () => {
  if (MODE !== "fork") return;
  // measure a 6-strike createLadder exactly (fork only; a fresh future date)
  const st = ctx.stations.settle;
  const d = localDate((await now()) + 3 * 86_400, st.offset);
  const end = dayEndOf(d, st.offset);
  await send("probe", `createLadder ${st.code} ${d} 6 strikes (budget probe)`, "createLadder6", "deployer", {
    ...V(),
    to: ctx.vault,
    functionName: "createLadder",
    args: [st.hex, d, [27, 28, 29, 30, 31, 32], BigInt(end - 3600)],
    forkOnly: true,
  });
});

// ------------------------------------------------------------------ report
function report(recs: Rec[]) {
  const W = [3, 9, 58, 8, 10, 10, 9, 7];
  const head = ["#", "phase", "step", "from", "gas used", "gas limit", "MON@102", "ms"];
  const line = (c: string[]) => c.map((x, i) => (i >= 4 ? x.padStart(W[i]) : x.padEnd(W[i]))).join(" ") ;
  log("\n" + line(head) + "  tx");
  for (const r of recs)
    log(line([String(r.n), r.phase, r.step.slice(0, 58), r.who, r.gasUsed, r.gasLimit, r.monBilled.toFixed(4), String(r.latencyMs)]) + "  " + r.hash + (r.forkOnly ? "  (fork-only)" : ""));
  const tot = (xs: Rec[]) => ({ gasUsed: xs.reduce((a, r) => a + BigInt(r.gasUsed), 0n), gasLimit: xs.reduce((a, r) => a + BigInt(r.gasLimit), 0n), mon: xs.reduce((a, r) => a + r.monBilled, 0) });
  const T = tot(recs);
  log(`\nTOTAL ${recs.length} txs: gas used ${T.gasUsed}, gas limit (billed) ${T.gasLimit}, ${T.mon.toFixed(4)} MON at 102 gwei`);
  const live = recs.filter((r) => !r.forkOnly);
  const perRole: Record<string, number> = {};
  for (const r of ROLES) perRole[r] = tot(live.filter((x) => x.who === r)).mon;
  log(`per wallet (live-relevant steps only): ${ROLES.map((r) => `${r} ${perRole[r].toFixed(4)}`).join(", ")}`);
  const lat = live.map((r) => r.latencyMs).sort((a, b) => a - b);
  log(`latency send->receipt: median ${lat[Math.floor(lat.length / 2)]} ms, min ${lat[0]}, max ${lat[lat.length - 1]} (${MODE})`);

  // ---- daily budget, 1 city x 6 strikes, hourly re-quotes, from the measured billed limits
  const avg = (op: string) => {
    const xs = recs.filter((r) => r.op === op);
    return xs.length ? xs.reduce((a, r) => a + BigInt(r.gasLimit), 0n) / BigInt(xs.length) : undefined;
  };
  const ladder6 = avg("createLadder6") ?? (avg("createLadder3")! * 2n * 9n) / 10n;
  const items: [string, number, bigint][] = [
    ["createLadder, 6 strikes (12 token clones)", 1, ladder6],
    ["Kuru Router.deployProxy, one book per strike", 6, avg("deployProxy")!],
    ["maker mintSet (inventory per strike)", 6, avg("mintSet")!],
    ["maker approve new YES -> MarginAccount", 6, avg("approveYesMargin")!],
    ["maker MarginAccount.deposit YES", 6, avg("depositYes")!],
    ["maker MarginAccount.deposit AUSD (daily top-up)", 1, avg("depositAusd")!],
    ["maker initial quote (1 bid + 1 ask)", 6, avg("quoteInit")!],
    ["maker HOURLY re-quote (cancel 2 + place 2), 24 x 6", 144, avg("requote")!],
    ["maker pulls quotes at close", 6, avg("cancelClose")!],
    ["CRE settlement report (sim forwarder: we pay)", 1, avg("creSettle")!],
    ["maker MarginAccount withdraw", 1, avg("withdraw")!],
    ["maker redeem", 6, avg("redeemMaker")!],
  ];
  const mon = (g: bigint) => Number(g * BILL_GWEI) / 1e9;
  log(`\nDAILY TESTNET-MON BUDGET, 1 city x 6 strikes, hourly re-quotes (billed gas limit x 102 gwei; measured per op on ${MODE})`);
  let day = 0;
  for (const [what, n, g] of items) {
    const m = n * mon(g);
    day += m;
    log(`  ${what.padEnd(52)} ${String(n).padStart(4)} x ${String(g).padStart(9)} gas = ${m.toFixed(4)} MON`);
  }
  const requoteMon = 144 * mon(avg("requote")!);
  const fixed = day - requoteMon;
  log(`  ${"TOTAL per city-day".padEnd(52)} ${day.toFixed(3)} MON  (fixed ${fixed.toFixed(3)} + re-quotes ${requoteMon.toFixed(3)})`);
  log(`  variants: re-quote only strikes that moved >=1 tick (~half): ${(fixed + requoteMon / 2).toFixed(3)} MON/day; every 30 min (METAR cadence): ${(fixed + 2 * requoteMon).toFixed(3)} MON/day`);
  log(`  per user trade (paid by the user or a relayer): taker buy ${mon(avg("takerBuy")!).toFixed(4)}, Zap.buyNo ${mon(avg("zapBuyNo")!).toFixed(4)}, Zap.buyYes ${mon(avg("zapBuyYes")!).toFixed(4)}, redeem ${mon(avg("redeem")!).toFixed(4)} MON`);

  const summary = {
    mode: MODE,
    rpc: RPC,
    out: OUT,
    forkBlock: ctx.forkBlock,
    addresses: { resolver: ctx.resolver, vault: ctx.vault, zap: ctx.zap, series: ctx.series, voidSeries: ctx.voidSeries, staleSeries: ctx.staleSeries },
    stations: ctx.stations,
    date: ctx.date,
    forecast: ctx.forecast,
    results: ctx.r,
    totals: { txs: recs.length, gasUsed: T.gasUsed.toString(), gasLimit: T.gasLimit.toString(), mon: T.mon },
    perRoleMonLiveSteps: perRole,
    budget: { items: items.map(([what, n, g]) => ({ what, n, gasLimit: g.toString(), mon: n * mon(g) })), perCityDay: day, fixed, requote: requoteMon },
    latency: { medianMs: lat[Math.floor(lat.length / 2)], minMs: lat[0], maxMs: lat[lat.length - 1] },
  };
  writeFileSync(join(OUT, "summary.json"), jsonSafe(summary));
  writeFileSync(join(OUT, "steps.tsv"), ["n\tphase\tstep\twho\tgasUsed\tgasEstimate\tgasLimit\tmonBilled\tlatencyMs\tblock\thash\tforkOnly", ...recs.map((r) => [r.n, r.phase, r.step, r.who, r.gasUsed, r.gasEstimate, r.gasLimit, r.monBilled.toFixed(6), r.latencyMs, r.block, r.hash, r.forkOnly ? 1 : 0].join("\t"))].join("\n") + "\n");
  if (MODE === "fork") {
    // what one live run needs per wallet: measured billed MON x 1.3 + 0.05 headroom (+ funding transfers)
    const need = Object.fromEntries(ROLES.map((r) => [r, Math.ceil((perRole[r] * 1.3 + 0.05) * 100) / 100])) as Record<Role, number>;
    need.deployer = Math.ceil((need.deployer + 3 * 0.0025) * 100) / 100; // + up to 3 funding transfers
    const total = ROLES.reduce((a, r) => a + need[r], 0);
    writeJson(REQ_FILE, { generatedFrom: OUT, generatedAt: new Date().toISOString(), note: "MON per wallet for one MODE=live run (fork-measured billed gas x1.3 + 0.05)", perRole: need, total: Math.round(total * 100) / 100 });
    log(`\nlive run requirement written to ${REQ_FILE}: ${ROLES.map((r) => `${r} ${need[r]}`).join(", ")} = ${total.toFixed(2)} MON total`);
  }
}

// ------------------------------------------------------------------ main
(async () => {
  log(`Isotherm e2e MODE=${MODE} RPC=${RPC} out=${OUT}`);
  for (const [name, fn] of phases) {
    if (ctx.done.includes(name)) continue;
    log(`\n== ${name}`);
    await fn();
    ctx.done.push(name);
    save();
  }
  report(rec.recs);
  log(`\nE2E OK (${MODE}). Evidence: ${OUT}/{console.txt,steps.tsv,steps.jsonl,summary.json,state.json}`);
})().catch((e) => {
  save();
  log(`\nE2E FAILED: ${e?.message ?? e}`);
  if (MODE === "live") log(`resume with: RESUME=${join(OUT, "state.json")} MODE=live npx tsx ts/e2e.ts`);
  process.exit(1);
});
