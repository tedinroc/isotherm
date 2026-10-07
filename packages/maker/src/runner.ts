// tickAll = watchdog + every active ladder + snapshot; runLoop = the long-running maker (with an independent
// watchdog timer, roll requests from the daily job, heartbeat, graceful SIGTERM).
import { unlinkSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import type { Ctx } from "./chain.ts";
import { explainRevert } from "./chain.ts";
import type { MarketData } from "./data.ts";
import { requestDir, takeRollRequests, writeHeartbeat } from "./lock.ts";
import { roll, type RollReport } from "./roll.ts";
import { buildSnapshot, postSnapshot, writeSnapshot, type Snapshot } from "./snapshot.ts";
import { runWatchdog, tickLadder, type LadderTick } from "./tick.ts";

export async function tickAll(ctx: Ctx, data: MarketData, opts: { post?: boolean } = {}): Promise<{ ticks: Map<string, LadderTick>; snapshot: Snapshot; killed: { key: string; cancelled: number; leftOpen: number }[] }> {
  const killed = await runWatchdog(ctx);
  const ticks = new Map<string, LadderTick>();
  for (const lad of Object.values(ctx.state.ladders).sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (lad.status === "closed" || lad.status === "planned") continue;
    try {
      ticks.set(lad.key, await tickLadder(ctx, lad, data));
    } catch (e) {
      ctx.log.error(`tick ${lad.key}: ${explainRevert(e)}`);
    }
  }
  const snapshot = await buildSnapshot(ctx, ticks);
  if (!ctx.cfg.dryRun) {
    writeSnapshot(ctx.cfg.paths.snapshot, snapshot);
    if (opts.post !== false) await postSnapshot(ctx, snapshot);
  }
  return { ticks, snapshot, killed };
}

export async function processRollRequests(ctx: Ctx, data: MarketData): Promise<RollReport[]> {
  const out: RollReport[] = [];
  for (const { file, req } of takeRollRequests(ctx.cfg.paths.state)) {
    ctx.log.info(`roll request ${basename(file)}`);
    const rep = await roll(ctx, { station: req.station, isoDate: req.isoDate, strikes: req.strikes, noFaucet: req.noFaucet, data });
    const done = join(requestDir(ctx.cfg.paths.state), "done");
    mkdirSync(done, { recursive: true });
    try {
      renameSync(file, join(done, basename(file).replace(/\.json$/, `-${Date.now()}.json`)));
    } catch {
      try { unlinkSync(file); } catch {}
    }
    out.push(rep);
  }
  return out;
}

export async function runLoop(ctx: Ctx, data: MarketData, opts: { maxTicks?: number } = {}) {
  let stopping = false;
  let busy = false;
  const stop = () => {
    stopping = true;
    ctx.log.warn("stop requested: finishing the current step (resting quotes stay up; the watchdog job still runs the kill switch)");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const wd = setInterval(async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      await runWatchdog(ctx);
      writeHeartbeat(ctx.cfg.paths.heartbeat, { phase: "watchdog" });
    } catch (e) {
      ctx.log.error(`watchdog: ${explainRevert(e)}`);
    } finally {
      busy = false;
    }
  }, ctx.cfg.loop.watchdogSec * 1000);
  let n = 0;
  try {
    while (!stopping && (opts.maxTicks === undefined || n < opts.maxTicks)) {
      while (busy) await new Promise((r) => setTimeout(r, 200));
      busy = true;
      const t0 = Date.now();
      try {
        writeHeartbeat(ctx.cfg.paths.heartbeat, { phase: "tick", n });
        await processRollRequests(ctx, data);
        const r = await tickAll(ctx, data);
        const acted = [...r.ticks.values()].flatMap((t) => t.actions.filter((a) => a.kind !== "none").map((a) => `${t.key}>=${a.strike}:${a.kind}`));
        ctx.log.info(`tick ${n} done in ${Date.now() - t0} ms; ${acted.length ? acted.join(" ") : "no changes"}; budget ${JSON.stringify(ctx.state.budget.spent)}`);
        writeHeartbeat(ctx.cfg.paths.heartbeat, { phase: "idle", n, lastTickMs: Date.now() - t0 });
      } catch (e) {
        ctx.log.error(`tick ${n}: ${explainRevert(e)}`);
      } finally {
        busy = false;
      }
      n++;
      const wait = Math.max(1000, ctx.cfg.loop.tickSec * 1000 - (Date.now() - t0));
      for (let waited = 0; waited < wait && !stopping; waited += 500) await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    clearInterval(wd);
  }
}
