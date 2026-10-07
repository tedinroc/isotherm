#!/usr/bin/env node
// Isotherm maker CLI (Monad testnet 10143 only; refuses to broadcast to a non-anvil RPC unless ISOTHERM_ALLOW_LIVE=1).
//
//   node src/cli.ts preflight [--station RCSS] [--date tomorrow]   read-only: keys, MON/AUSD, roles, station, plan, costs
//   node src/cli.ts roll --station RCSS --date 2026-10-08 [--strikes 28,29,30,31] [--dry-run] [--no-faucet] [--force]
//                        [--not-before 12:00]   (station-local; the hourly launchd job uses this)
//   node src/cli.ts tick [--dry-run] [--no-post]     one pass: kill switch, quotes, snapshot
//   node src/cli.ts loop                             long-running maker (tick every loop.tickSec, watchdog every 15 s)
//   node src/cli.ts watchdog [--verify]              kill switch only (independent launchd job)
//   node src/cli.ts pull --station RCSS --date 2026-10-08 | --all     cancel quotes now and pause re-quoting
//   node src/cli.ts resume --station RCSS --date 2026-10-08           undo "pull"
//   node src/cli.ts snapshot [--post]                read-only snapshot (no trading)
//   node src/cli.ts status                           state + budget summary
import { isoToYmd, localDateOf, addDays, station as stationOf } from "../../forecast/src/stations.ts";
import { loadConfig } from "./config.ts";
import { buildContext } from "./context.ts";
import { liveMarketData } from "./data.ts";
import { acquireLock, enqueueRoll, heartbeatAge, readLock } from "./lock.ts";
import { roll } from "./roll.ts";
import { processRollRequests, runLoop, tickAll } from "./runner.ts";
import { buildSnapshot, postSnapshot, writeSnapshot } from "./snapshot.ts";
import { killLadder, runWatchdog } from "./tick.ts";
import { ladderKey } from "./state.ts";
import { preflight } from "./preflight.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function resolveDate(stationIcao: string, d: string | undefined): string {
  const st = stationOf(stationIcao);
  const today = localDateOf(Date.now(), st.utcOffsetMin);
  if (!d || d === "tomorrow") return addDays(today, 1);
  if (d === "today") return today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`--date must be YYYY-MM-DD, today or tomorrow (got ${d})`);
  return d;
}

async function main() {
  if (!cmd || cmd === "help" || flag("help")) {
    console.log((await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 15).join("\n"));
    return;
  }
  const dryRun = flag("dry-run") || cmd === "preflight" || cmd === "snapshot" || cmd === "status";
  const cfg = loadConfig({ dryRun });
  const data = liveMarketData({ pmTtlSec: cfg.loop.pmTtlSec, obsTtlSec: cfg.loop.obsTtlSec, v0RefreshSec: cfg.loop.v0RefreshSec });
  const stationIcao = (opt("station") ?? cfg.stations[0]).toUpperCase();

  if (cmd === "preflight") {
    const ctx = await buildContext({ cfg });
    const r = await preflight(ctx, stationIcao, resolveDate(stationIcao, opt("date")), data);
    console.log(JSON.stringify(r, null, 1));
    return;
  }

  // writers take the lock; read-only commands do not
  const writer = !["snapshot", "status"].includes(cmd) && !dryRun;
  if (writer) {
    const l = acquireLock(cfg.paths.lock, cmd);
    if ("heldBy" in l) {
      const age = heartbeatAge(cfg.paths.heartbeat);
      if (cmd === "roll") {
        const isoDate = resolveDate(stationIcao, opt("date"));
        if (!notBeforeOk(stationIcao, opt("not-before"))) return;
        const f = enqueueRoll(cfg.paths.state, { station: stationIcao, isoDate, strikes: opt("strikes")?.split(",").map(Number), noFaucet: flag("no-faucet"), at: Math.floor(Date.now() / 1000) });
        console.log(`maker ${l.heldBy.cmd} (pid ${l.heldBy.pid}) holds the lock; queued the roll for it: ${f}`);
        return;
      }
      if (cmd === "watchdog") {
        if (age !== null && age < cfg.loop.heartbeatStaleSec) {
          console.log(`loop pid ${l.heldBy.pid} is alive (heartbeat ${age}s ago): it runs the kill switch itself`);
          return;
        }
        console.log(`WARNING: lock held by pid ${l.heldBy.pid} but heartbeat is ${age ?? "missing"}s old: running the kill switch anyway`);
      } else {
        console.error(`another maker process holds ${cfg.paths.lock}: ${JSON.stringify(readLock(cfg.paths.lock))}`);
        process.exitCode = 2;
        return;
      }
    }
  }
  const ctx = await buildContext({ cfg });
  ctx.log.info(`isotherm-maker ${cmd} rpc=${cfg.rpc} (${ctx.clientVersion}${ctx.isAnvil ? ", anvil" : ""}) deployment=${ctx.dep.variant} vault=${ctx.dep.vault} maker=${ctx.addr.maker}${cfg.dryRun ? " DRY-RUN" : ""}`);

  switch (cmd) {
    case "roll": {
      if (!notBeforeOk(stationIcao, opt("not-before"))) return;
      await processRollRequests(ctx, data);
      const rep = await roll(ctx, { station: stationIcao, isoDate: resolveDate(stationIcao, opt("date")), strikes: opt("strikes")?.split(",").map(Number), data, noFaucet: flag("no-faucet"), force: flag("force"), skipQuotes: flag("skip-quotes") });
      console.log(JSON.stringify(rep, null, 1));
      if (!rep.ok) process.exitCode = 1;
      if (!cfg.dryRun) {
        const snap = await buildSnapshot(ctx, new Map());
        writeSnapshot(cfg.paths.snapshot, snap);
      }
      break;
    }
    case "tick": {
      const r = await tickAll(ctx, data, { post: !flag("no-post") });
      for (const [k, t] of r.ticks) for (const a of t.actions) console.log(`${k} >=${a.strike} ${a.kind} ${a.reasons.join("; ")}${a.tx ? " " + a.tx : ""}${a.error ? " ERROR " + a.error : ""}`);
      if (r.killed.length) console.log("kill switch:", JSON.stringify(r.killed));
      break;
    }
    case "loop":
      await runLoop(ctx, data, { maxTicks: opt("max-ticks") ? Number(opt("max-ticks")) : undefined });
      break;
    case "watchdog": {
      const r = await runWatchdog(ctx, { verifyClosed: flag("verify") });
      console.log(r.length ? JSON.stringify(r) : "watchdog: nothing due");
      if (r.some((x) => x.leftOpen)) process.exitCode = 3;
      break;
    }
    case "pull":
    case "resume": {
      const targets = flag("all") ? Object.values(ctx.state.ladders).filter((l) => l.status !== "closed") : [ctx.state.ladders[ladderKey(stationIcao, isoToYmd(resolveDate(stationIcao, opt("date"))))]].filter(Boolean);
      if (!targets.length) throw new Error("no matching ladder in state");
      for (const lad of targets) {
        if (cmd === "resume") {
          lad.paused = false;
          ctx.log.info(`${lad.key} resumed`);
          continue;
        }
        lad.paused = true;
        ctx.save();
        const r = await killLadder(ctx, lad, "manual pull", { close: false, withdraw: false });
        ctx.log.warn(`${lad.key} pulled: cancelled ${r.cancelled}, left open ${r.leftOpen}; paused until "resume"`);
      }
      ctx.save();
      break;
    }
    case "snapshot": {
      const ticks = new Map();
      const { tickLadder } = await import("./tick.ts");
      for (const lad of Object.values(ctx.state.ladders)) if (lad.status !== "closed") ticks.set(lad.key, await tickLadder(ctx, lad, data)); // dry-run: no sends
      const snap = await buildSnapshot(ctx, ticks);
      writeSnapshot(cfg.paths.snapshot.replace(/\.json$/, ".readonly.json"), snap);
      if (flag("post")) console.log(JSON.stringify(await postSnapshot(ctx, snap)));
      console.log(JSON.stringify(snap, null, 1));
      break;
    }
    case "status": {
      const now = Math.floor(Date.now() / 1000);
      console.log(`budget day ${ctx.state.budget.day}: ${JSON.stringify(ctx.state.budget.spent)} caps ${JSON.stringify(cfg.budget.dailyCapMon)}`);
      for (const l of Object.values(ctx.state.ladders))
        console.log(`${l.key} ${l.status}${l.paused ? " PAUSED" : ""} strikes [${l.strikes}] stop ${new Date(l.stopAt * 1000).toISOString()} (${Math.round((l.stopAt - now) / 60)} min) ${l.strikes.map((k) => `>=${k}:${l.series[k]?.mode ?? "-"}${l.series[k]?.orders.bid ? ` b${l.series[k].orders.bid!.price}` : ""}${l.series[k]?.orders.ask ? ` a${l.series[k].orders.ask!.price}` : ""}`).join(" ")}`);
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

function notBeforeOk(stationIcao: string, hhmm: string | undefined): boolean {
  if (!hhmm) return true;
  const st = stationOf(stationIcao);
  const local = new Date(Date.now() + st.utcOffsetMin * 60_000).toISOString().slice(11, 16);
  if (local < hhmm) {
    console.log(`${stationIcao} local time ${local} < --not-before ${hhmm}: nothing to do`);
    return false;
  }
  return true;
}

main().catch((e) => {
  console.error(String((e as Error)?.stack ?? e));
  process.exitCode = 1;
});
