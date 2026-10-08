// Anvil-fork test of the failure paths: a crash between broadcasting Router.deployProxy and its receipt must not
// create a duplicate Kuru market on resume; the MON budget refuses a non-urgent re-quote and turns an urgent one
// into a pull paid from the reserve; the manual "pull" cancels and pauses.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEther } from "viem";
import { ladderFromGamma, type LiveLadder } from "../../../forecast/src/polymarket.ts";
import { addDays, localDateOf } from "../../../forecast/src/stations.ts";
import { nowSec, type Ctx } from "../../src/chain.ts";
import { loadConfig, PKG_ROOT } from "../../src/config.ts";
import { buildContext } from "../../src/context.ts";
import type { MarketData } from "../../src/data.ts";
import { loadDeployment } from "../../src/deployment.ts";
import { scanOpenOrders } from "../../src/kuru.ts";
import { marketFromReceipt, roll } from "../../src/roll.ts";
import { tickAll } from "../../src/runner.ts";
import { killLadder } from "../../src/tick.ts";
import { rpc, startAnvil, type Anvil } from "./anvil.ts";

const PORT = Number(process.env.FORK_PORT_2 ?? 19153);
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = join(PKG_ROOT, "evidence", `fork-resume-${STAMP}`);
const VAR = join(OUT, "var");
mkdirSync(VAR, { recursive: true });
const lines: string[] = [];
const say = (s: string) => (lines.push(s), console.log(s), writeFileSync(join(OUT, "summary.txt"), lines.join("\n") + "\n"));
let anvil: Anvil;
let ctx: Ctx;

const FIXTURE = JSON.parse(readFileSync(new URL("../../../forecast/test/fixtures/gamma_taipei_2026-10-08.json", import.meta.url), "utf8"))[0];
const PM0 = ladderFromGamma(FIXTURE, "RCSS", null, new Date().toISOString());
const override: Record<string, number> = {};
const stub: MarketData = {
  async get(icao, isoDate, nowMs) {
    const pm: LiveLadder = { ...PM0, date: isoDate, fetchedAt: new Date(nowMs).toISOString(), ladder: { ...PM0.ladder, ...override } };
    return { pm, pmFetchedMs: nowMs, obs: null, v0: null, intraday: null, localMinute: null };
  },
};
const txs = () => (existsSync(join(VAR, "txs.jsonl")) ? readFileSync(join(VAR, "txs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

before(async () => {
  anvil = await startAnvil(PORT, OUT);
  const dep = loadDeployment();
  const overrides: any = { rpc: anvil.url, paths: { state: join(VAR, "state.json"), snapshot: join(VAR, "snapshot.json"), log: join(VAR, "maker.log"), lock: join(VAR, "maker.lock"), heartbeat: join(VAR, "heartbeat.json") } };
  if (dep.variant === "feasibility") throw new Error("this test targets the v1 deployment (canonical-market registry)");
  ctx = await buildContext({ cfg: loadConfig(overrides) });
  for (const a of new Set([ctx.addr.maker, ctx.addr.operator])) await rpc(anvil.url, "anvil_setBalance", [a, "0x" + parseEther("100").toString(16)]);
  say(`anvil :${PORT} pid ${anvil.proc.pid}; v1 vault ${ctx.dep.vault}`);
});
after(async () => anvil?.stop());

test("crash after broadcasting deployProxy -> resume recovers the market, no duplicate; budget refusal; manual pull", { timeout: 20 * 60_000 }, async () => {
  const isoDate = addDays(localDateOf((await nowSec(ctx)) * 1000, 480), Number(process.env.FORK_DAYS_AHEAD ?? 1));
  process.env.MAKER_TEST_CRASH_AFTER = "deployProxy:30";
  const first = await roll(ctx, { station: "RCSS", isoDate, data: stub });
  delete process.env.MAKER_TEST_CRASH_AFTER;
  assert.equal(first.ok, false);
  const lad = Object.values(ctx.state.ladders)[0];
  const pend = lad.pending["market:30"];
  assert.ok(pend?.hash, "the in-flight tx hash was persisted before the crash");
  assert.equal(lad.series[30].market, null);
  assert.ok(lad.series[28].market && lad.series[29].market && !lad.series[31].market);
  say(`crash: roll stopped with ${first.steps.at(-1)!.detail}; pending ${pend.hash}`);
  const deploysBefore = txs().filter((x) => /deployProxy/.test(x.label)).length;

  const second = await roll(ctx, { station: "RCSS", isoDate, data: stub });
  assert.equal(second.ok, true, JSON.stringify(second.steps));
  const deploys = txs().filter((x) => /deployProxy/.test(x.label));
  assert.equal(deploys.length - deploysBefore, 1, "only >=31 is created on resume");
  const rcpt = await ctx.pub.getTransactionReceipt({ hash: pend.hash });
  assert.equal(marketFromReceipt(rcpt).toLowerCase(), lad.series[30].market!.toLowerCase(), "the >=30 market is the one the crashed tx created");
  assert.deepEqual(Object.keys(lad.pending), []);
  const markets = new Set(lad.strikes.map((k) => lad.series[k].market!.toLowerCase()));
  assert.equal(markets.size, 4);
  assert.ok(lad.strikes.every((k) => lad.series[k].canonical === true));
  say(`resume: >=30 market ${lad.series[30].market} recovered from the pending tx; ${deploys.length} deployProxy txs in total for 4 strikes; all canonical`);

  // ---- budget: cap the maker at what it spent -> a 2-tick move is refused (not urgent)
  const spent = ctx.state.budget.spent.maker ?? 0;
  ctx.cfg.budget.dailyCapMon.maker = spent + 1e-9;
  ctx.cfg.budget.reserveMon.maker = 10;
  override[30] = PM0.ladder[30] + 0.025;
  let r = await tickAll(ctx, stub, { post: false });
  let a30 = [...r.ticks.values()][0].actions.find((a) => a.strike === 30)!;
  assert.equal(a30.kind, "requote");
  assert.match(a30.error ?? "", /cap/);
  assert.ok(lad.series[30].orders.ask, "quotes left in place when a non-urgent re-quote is refused");
  say(`budget: non-urgent re-quote of >=30 refused (${a30.error}); quotes stay`);
  // fair jumps above our resting ask: urgent -> pull paid from the reserve
  override[30] = (lad.series[30].orders.ask?.price ?? 0.5) + 0.05;
  r = await tickAll(ctx, stub, { post: false });
  a30 = [...r.ticks.values()][0].actions.find((a) => a.strike === 30)!;
  assert.equal(a30.kind, "requote");
  assert.equal((await scanOpenOrders(ctx, lad.series[30].market!, ctx.addr.maker)).length, 0, "urgent + no budget -> pulled");
  say(`budget: fair crossed the resting ask -> urgent; re-quote refused, quotes pulled from the reserve (tx ${a30.tx})`);
  ctx.cfg.budget.dailyCapMon.maker = 100;

  // ---- manual pull: cancels everything, pauses re-quoting, ladder stays open
  const k = await killLadder(ctx, lad, "manual pull", { close: false, withdraw: false });
  lad.paused = true;
  assert.equal(lad.status, "active");
  for (const s of lad.strikes) assert.equal((await scanOpenOrders(ctx, lad.series[s].market!, ctx.addr.maker)).length, 0);
  const n = txs().length;
  r = await tickAll(ctx, stub, { post: false });
  assert.equal(txs().length, n, "paused ladder: no re-quote");
  say(`manual pull: cancelled ${k.cancelled}, ladder paused (0 txs on the next tick)`);
});
