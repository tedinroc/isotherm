// Anvil-fork integration test: roll (twice: idempotent) + 3 ticks (no change / after a taker fill / after a fair
// move + observed-max certainty) + the close-time kill switch, against the real Kuru v1 Router/MarginAccount, real
// testnet AUSD and the deployed Isotherm contracts (deployments/testnet.json if present, else the feasibility
// deployment). Market data is a deterministic stub built from a captured Polymarket ladder.
//   npm run test:fork        (anvil on port FORK_PORT, default 19150; nothing is sent to the live chain)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, http, maxUint256, parseEther, type Address, type Hex } from "viem";
import { ladderFromGamma, type LiveLadder } from "../../../forecast/src/polymarket.ts";
import type { V0Ladder } from "../../../forecast/src/v0.ts";
import { addDays, localDateOf } from "../../../forecast/src/stations.ts";
import { erc20Abi, kuruBookAbi, resolverCommonAbi } from "../../src/abis.ts";
import { loadKey, LiveRefused, nowSec, read, send, type Ctx } from "../../src/chain.ts";
import { loadConfig, PKG_ROOT } from "../../src/config.ts";
import { buildContext } from "../../src/context.ts";
import type { LadderData, MarketData } from "../../src/data.ts";
import { loadDeployment } from "../../src/deployment.ts";
import { getBook, marginBalance, scanOpenOrders } from "../../src/kuru.ts";
import { roll, station4 } from "../../src/roll.ts";
import { tickAll } from "../../src/runner.ts";
import { writeSnapshot } from "../../src/snapshot.ts";
import { runWatchdog } from "../../src/tick.ts";
import { rpc, startAnvil, type Anvil } from "./anvil.ts";

const PORT = Number(process.env.FORK_PORT ?? 19150);
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = join(PKG_ROOT, "evidence", `fork-${STAMP}`);
const VAR = join(OUT, "var");
mkdirSync(VAR, { recursive: true });
const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  console.log(s);
  writeFileSync(join(OUT, "summary.txt"), lines.join("\n") + "\n");
};

let anvil: Anvil;
let ctx: Ctx;
const KEYS = `${process.env.HOME}/.config/isotherm`;

// ------------------------------------------------------------------ deterministic market data
const FIXTURE = JSON.parse(readFileSync(new URL("../../../forecast/test/fixtures/gamma_taipei_2026-10-08.json", import.meta.url), "utf8"))[0];
const PM0 = ladderFromGamma(FIXTURE, "RCSS", null, new Date().toISOString());
const override: Record<string, number> = {};
let obsMax: number | null = null;
const stub: MarketData = {
  async get(icao, isoDate, nowMs): Promise<LadderData> {
    const ladder = { ...PM0.ladder, ...override };
    const pm: LiveLadder = { ...PM0, date: isoDate, fetchedAt: new Date(nowMs).toISOString(), ladder };
    const v0: V0Ladder = { station: icao, date: isoDate, lead: 1, calibLead: 1, mu: 29.6, modelSpread: 0.5, nModels: 7, residSd: 1.1, nResid: 90, ladder: Object.fromEntries(Object.entries(ladder).map(([k, p]) => [k, Math.min(1, p + 0.04)])), fetchedAt: "", source: "stub" };
    const obs = obsMax === null ? null : { station: icao, date: isoDate, tmaxC: obsMax, nObs: 20, lastObsUtc: nowMs, lastLocal: "10:00", atLocal: "10:00", dayStarted: true, dayOver: false, fetchedAt: new Date(nowMs).toISOString(), sources: [] };
    return { pm, pmFetchedMs: nowMs, obs, v0, intraday: null, localMinute: obsMax === null ? null : 600 };
  },
};

const txCount = () => (existsSync(join(VAR, "txs.jsonl")) ? readFileSync(join(VAR, "txs.jsonl"), "utf8").trim().split("\n").filter(Boolean).length : 0);

before(async () => {
  anvil = await startAnvil(PORT, OUT);
  say(`anvil :${PORT} pid ${anvil.proc.pid} forking https://testnet-rpc.monad.xyz at block ${parseInt(await rpc(anvil.url, "eth_blockNumber"), 16)} (${await rpc(anvil.url, "web3_clientVersion")})`);
  const dep = loadDeployment();
  const overrides: any = { rpc: anvil.url, paths: { state: join(VAR, "state.json"), snapshot: join(VAR, "snapshot.json"), log: join(VAR, "maker.log"), lock: join(VAR, "maker.lock"), heartbeat: join(VAR, "heartbeat.json") } };
  if (dep.variant === "feasibility") overrides.roles = { operator: "deployer" }; // vault owner (the operator key is only authorised on v1)
  const cfg = loadConfig(overrides);
  ctx = await buildContext({ cfg });
  say(`deployment ${dep.variant}: vault ${dep.vault} resolver ${dep.resolver} zap ${dep.zap} (registry ${ctx.dep.zapRegistry}); operator=${ctx.keyNames.operator} ${ctx.addr.operator}; maker ${ctx.addr.maker}`);
  // fork-only setup: gas money, and RCSS on a Resolver that lacks it (feasibility deployment)
  const taker = loadKey(KEYS, "taker1")!;
  for (const a of new Set([ctx.addr.maker, ctx.addr.operator, ctx.addr.marketCreator, taker.address])) await rpc(anvil.url, "anvil_setBalance", [a, "0x" + parseEther("100").toString(16)]);
  try {
    await read(ctx, ctx.dep.resolver, resolverCommonAbi, "dayEnd", [station4("RCSS"), 20261010]);
  } catch {
    const owner = await read<Address>(ctx, ctx.dep.resolver, resolverCommonAbi, "owner");
    const dk = loadKey(KEYS, "deployer")!;
    assert.equal(owner.toLowerCase(), dk.address.toLowerCase(), "fork setup needs the Resolver owner key to register RCSS");
    await rpc(anvil.url, "anvil_setBalance", [dk.address, "0x" + parseEther("100").toString(16)]);
    const w = createWalletClient({ chain: ctx.chain, transport: http(anvil.url), account: dk });
    const h = await w.writeContract({ address: ctx.dep.resolver, abi: resolverCommonAbi, functionName: "registerStation", args: [station4("RCSS"), 8 * 3600], chain: ctx.chain });
    await ctx.pub.waitForTransactionReceipt({ hash: h });
    say("fork-only setup: registered RCSS (UTC+8) on the feasibility Resolver as its owner");
  }
});

after(async () => {
  await anvil?.stop();
  if (existsSync(join(VAR, "snapshot.json"))) copyFileSync(join(VAR, "snapshot.json"), join(OUT, "snapshot.json"));
});

test("roll + idempotent re-roll + 3 ticks + kill switch on an anvil fork", { timeout: 30 * 60_000 }, async () => {
  const now0 = await nowSec(ctx);
  const isoDate = addDays(localDateOf(now0 * 1000, 480), 1); // tomorrow in Taipei
  say(`chain time ${new Date(now0 * 1000).toISOString()}; rolling RCSS ${isoDate}`);

  // the live guard: a non-anvil context must refuse to broadcast
  const fake = { ...ctx, isAnvil: false, cfg: { ...ctx.cfg, allowLive: false, dryRun: false } } as Ctx;
  await assert.rejects(send(fake, "maker", { to: ctx.dep.ausd, abi: erc20Abi, functionName: "approve", args: [ctx.dep.vault, 0n] }, { label: "guard probe", kind: "quote" }), LiveRefused);

  // ---- dry-run roll: plans and estimates, sends nothing
  const dryCtx = { ...ctx, cfg: { ...ctx.cfg, dryRun: true }, state: structuredClone(ctx.state), save: () => {} } as Ctx;
  const dry = await roll(dryCtx, { station: "RCSS", isoDate, data: stub });
  say(`dry-run roll: ok=${dry.ok} strikes [${dry.strikes}] estimated MON ${JSON.stringify(dry.estimatedMonByRole)}`);
  assert.equal(dry.ok, true, JSON.stringify(dry.steps));
  assert.equal(txCount(), 0);

  // ---- roll
  const t0 = txCount();
  const rep = await roll(ctx, { station: "RCSS", isoDate, data: stub });
  for (const s of rep.steps) say(`  roll [${s.step}] ${s.status}: ${s.detail}`);
  assert.equal(rep.ok, true, JSON.stringify(rep.steps.filter((s) => s.status === "blocked")));
  assert.deepEqual(rep.strikes, [28, 29, 30, 31]);
  const lad = ctx.state.ladders[`RCSS:${isoDate.replace(/-/g, "")}`];
  assert.equal(lad.status, "active");
  say(`roll: ${txCount() - t0} txs, MON by role ${JSON.stringify(rep.monByRole)}; close ${rep.closeLocal} local (stop ${rep.stopQuotingLocal})`);
  for (const k of lad.strikes) {
    const s = lad.series[k];
    assert.ok(s.market && s.orders.bid && s.orders.ask, `>=${k} quoted`);
    const book = await getBook(ctx, s.market);
    assert.equal(book.bestBid, s.orders.bid.price);
    assert.equal(book.bestAsk, s.orders.ask.price);
    assert.ok(book.bestBid! < PM0.ladder[k] && book.bestAsk! > PM0.ladder[k]);
    say(`  >=${k} market ${s.market} PM ${PM0.ladder[k].toFixed(3)} -> bid ${s.orders.bid.size}@${s.orders.bid.price} / ask ${s.orders.ask.size}@${s.orders.ask.price}${s.canonical ? " (canonical in Zap)" : ""}`);
  }
  const markets = lad.strikes.map((k) => lad.series[k].market);

  // ---- re-roll: idempotent (no tx, same markets)
  const t1 = txCount();
  const again = await roll(ctx, { station: "RCSS", isoDate, data: stub, skipQuotes: true });
  assert.equal(again.ok, true);
  assert.equal(txCount() - t1, 0, "re-roll must not send anything");
  assert.deepEqual(lad.strikes.map((k) => lad.series[k].market), markets);
  say(`re-roll: 0 txs, same ${markets.length} markets (idempotent)`);

  // ---- tick 1: nothing changed -> no tx
  const t2 = txCount();
  let r = await tickAll(ctx, stub, { post: false });
  const acts1 = [...r.ticks.values()].flatMap((t) => t.actions);
  assert.ok(acts1.every((a) => a.kind === "none"), JSON.stringify(acts1));
  assert.equal(txCount() - t2, 0);
  say(`tick 1: ${acts1.map((a) => `>=${a.strike}:${a.kind}`).join(" ")} (0 txs)`);

  // ---- a taker lifts our ask on >=30, then tick 2 refills it with an inventory skew
  const s30 = lad.series[30];
  const taker = loadKey(KEYS, "taker1")!;
  const tw = createWalletClient({ chain: ctx.chain, transport: http(anvil.url), account: taker });
  const mw = createWalletClient({ chain: ctx.chain, transport: http(anvil.url), account: ctx.accounts.maker });
  await ctx.pub.waitForTransactionReceipt({ hash: await mw.writeContract({ address: ctx.dep.ausd, abi: erc20Abi, functionName: "transfer", args: [taker.address, 200_000_000n], chain: ctx.chain }) });
  await ctx.pub.waitForTransactionReceipt({ hash: await tw.writeContract({ address: ctx.dep.ausd, abi: erc20Abi, functionName: "approve", args: [s30.market!, maxUint256], chain: ctx.chain }) });
  const spend = Math.ceil(s30.orders.ask!.size * s30.orders.ask!.price) + 5; // more than the whole ask
  const buy = await tw.writeContract({ address: s30.market!, abi: kuruBookAbi, functionName: "placeAndExecuteMarketBuy", args: [BigInt(spend * 10_000), 0n, false, false], chain: ctx.chain, gas: 1_500_000n });
  assert.equal((await ctx.pub.waitForTransactionReceipt({ hash: buy })).status, "success");
  const got = await read<bigint>(ctx, s30.yes, erc20Abi, "balanceOf", [taker.address]);
  say(`taker1 market-buys ${spend} AUSD on >=30 -> ${Number(got) / 1e6} YES (our ask was ${s30.orders.ask!.size}@${s30.orders.ask!.price}) tx ${buy}`);
  const askBefore = s30.orders.ask!.price;
  r = await tickAll(ctx, stub, { post: false });
  const t30 = [...r.ticks.values()][0].actions.find((a) => a.strike === 30)!;
  assert.equal(t30.kind, "requote", JSON.stringify(t30));
  assert.ok(s30.orders.ask && s30.orders.bid, "both sides back");
  const inv30 = [...r.ticks.values()][0].strikes.find((x) => x.strike === 30)!.inventory!;
  assert.ok(inv30.netYes < 0, "short YES after the fill");
  assert.ok(s30.orders.ask.price >= askBefore, "skewed up while short YES");
  say(`tick 2: >=30 ${t30.kind} (${t30.reasons.join("; ")}) -> bid ${s30.orders.bid.size}@${s30.orders.bid.price} / ask ${s30.orders.ask.size}@${s30.orders.ask.price}, net YES ${inv30.netYes}`);

  // ---- tick 3: Polymarket moves >=29 from 0.85 to 0.70, and a METAR shows 28 (YES>=28 certain)
  override[29] = 0.7;
  obsMax = 28;
  r = await tickAll(ctx, stub, { post: false });
  const acts3 = [...r.ticks.values()][0].actions;
  const a28 = acts3.find((a) => a.strike === 28)!, a29 = acts3.find((a) => a.strike === 29)!;
  assert.equal(a28.kind, "pull");
  assert.equal(lad.series[28].mode, "certain");
  assert.equal(a29.kind, "requote");
  const s29 = lad.series[29];
  const f29 = [...r.ticks.values()][0].fairs.find((f) => f.k === 29)!;
  assert.ok(Math.abs(f29.fair! - 0.7 / PM0.ladder[28]) < 1e-3, `P(>=29 | Tmax>=28) = ${f29.fair}`);
  assert.ok(s29.orders.bid!.price < f29.fair! && s29.orders.ask!.price > f29.fair!, `>=29 re-centred: ${s29.orders.bid!.price}/${s29.orders.ask!.price} around ${f29.fair}`);
  say(`tick 3: ${acts3.map((a) => `>=${a.strike}:${a.kind}`).join(" ")}; >=29 fair ${f29.fair} (PM 0.70 conditioned on obs max 28) -> ${s29.orders.bid!.price}/${s29.orders.ask!.price}; >=28 pulled (certain)`);
  writeSnapshot(join(OUT, "snapshot.tick3.json"), r.snapshot);
  mkdirSync(join(PKG_ROOT, "examples"), { recursive: true });
  writeSnapshot(join(PKG_ROOT, "examples", "snapshot.example.json"), r.snapshot);
  assert.equal(r.snapshot.schema, "isotherm.snapshot/v1");
  assert.equal(r.snapshot.ladders[0].strikes.length, 4);
  assert.ok(r.snapshot.ladders[0].strikes.every((x) => x.market && x.marketBlock && x.fair !== null));

  // ---- kill switch: jump to the stop-quoting time; the independent watchdog cancels everything
  const tNow = await nowSec(ctx);
  await rpc(anvil.url, "evm_increaseTime", [lad.stopAt - tNow + 5]);
  await rpc(anvil.url, "evm_mine", []);
  const killed = await runWatchdog(ctx);
  say(`kill switch at ${new Date((await nowSec(ctx)) * 1000).toISOString()} (stopAt ${new Date(lad.stopAt * 1000).toISOString()}): ${JSON.stringify(killed)}`);
  assert.equal(lad.status, "closed");
  for (const k of lad.strikes) {
    const s = lad.series[k];
    assert.equal((await scanOpenOrders(ctx, s.market!, ctx.addr.maker)).length, 0, `>=${k} has no open maker orders`);
    assert.equal(await marginBalance(ctx, ctx.addr.maker, s.yes), 0n, `>=${k} YES margin withdrawn`);
    const b = await getBook(ctx, s.market!);
    assert.equal(b.bids.length + b.asks.length, 0, `>=${k} book empty`);
  }
  // a tick after close does nothing
  const t5 = txCount();
  await tickAll(ctx, stub, { post: false });
  assert.equal(txCount() - t5, 0);

  // ---- budget meter == sum of billed tx costs
  const txs = readFileSync(join(VAR, "txs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const byRole: Record<string, number> = {};
  for (const x of txs) byRole[x.role] = (byRole[x.role] ?? 0) + x.mon;
  for (const [role, mon] of Object.entries(byRole)) assert.ok(Math.abs((ctx.state.budget.spent[role] ?? 0) - mon) < 1e-6, `${role} meter`);
  // anvil's fork base fee decays on empty blocks, so its receipts under-bill; live Monad bills gasLimit x ~102 gwei
  const at102: Record<string, number> = {};
  for (const x of txs) at102[x.role] = (at102[x.role] ?? 0) + (Number(x.gasLimit) * 102) / 1e9;
  const rollTx = txs.slice(t0, t0 + (t1 - t0));
  const rollAt102: Record<string, number> = {};
  for (const x of rollTx) rollAt102[x.role] = (rollAt102[x.role] ?? 0) + (Number(x.gasLimit) * 102) / 1e9;
  const r4 = (o: Record<string, number>) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(4)])));
  say(`${txs.length} txs total; meter (anvil-billed) ${r4(byRole)}; at live 102 gwei: roll ${r4(rollAt102)}, whole run ${r4(at102)}; all books empty after the kill switch`);
  writeFileSync(join(OUT, "txs.tsv"), ["#\trole\tlabel\tgasUsed\tgasLimit\tMON@102gwei\tms\thash", ...txs.map((x, i) => [i + 1, x.role, x.label, x.gasUsed, x.gasLimit, ((Number(x.gasLimit) * 102) / 1e9).toFixed(4), x.ms, x.hash].join("\t"))].join("\n") + "\n");
  copyFileSync(join(VAR, "state.json"), join(OUT, "state.json"));
});
