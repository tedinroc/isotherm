import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildPaths, closeTimeStats, dayPath, pIncrementAtLeast, recommendClose } from "../src/closetime.ts";
import { runningMax } from "../src/obs.ts";
import { closeFor } from "../src/close-config.ts";
import { station } from "../src/stations.ts";

const RCSS = station("RCSS");
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) - 8 * 3600_000; // local Taipei -> UTC
/** A synthetic complete day: half-hourly reports, temps from `f(minute)`. */
function day(date: string, f: (min: number) => number) {
  return Array.from({ length: 48 }, (_, i) => {
    const min = i * 30;
    const hh = `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    return { tUtc: at(date, hh), tempC: f(min), kind: "METAR" as const, raw: "", src: "iem" as const };
  });
}

test("dayPath: first time the max is reached, running max before each half-hour mark", () => {
  const os = day("2026-07-01", (m) => (m < 13 * 60 ? 28 : m < 15 * 60 ? 33 : 31));
  const p = dayPath(RCSS, "2026-07-01", os, "iem");
  assert.equal(p.M, 33);
  assert.equal(p.tFirstMin, 13 * 60);
  assert.equal(p.runBefore[25], 28); // before 13:00
  assert.equal(p.runBefore[26], 33); // before 13:30 (the 13:00 report counts)
});

test("closeTimeStats: quantiles and mass left; a late-max day moves t99 only", () => {
  const paths = [];
  for (let i = 0; i < 99; i++) paths.push(dayPath(RCSS, "2026-07-01", day("2026-07-01", (m) => (m === 14 * 60 ? 32 : 30)), "iem"));
  paths.push(dayPath(RCSS, "2026-07-02", day("2026-07-02", (m) => (m === 21 * 60 ? 33 : 30)), "iem"));
  const s = closeTimeStats("RCSS", "a", "b", paths);
  assert.equal(s.t95, "14:30"); // first max at 14:00 -> reached "before 14:30"
  assert.equal(s.t99, "14:30");
  assert.equal(s.t995, "21:30");
  const h = s.hourly.find((x) => x.until === "15:00")!;
  assert.equal(h.massLeft, 0.01);
  assert.equal(h.inc3, 0.01); // 33 - 30
  assert.equal(pIncrementAtLeast(s, 15 * 60 + 10, 30, 31), 0.01);
  assert.equal(pIncrementAtLeast(s, 15 * 60 + 10, 30, 30), 1);
});

test("buildPaths uses the fallback source only when the primary day is incomplete", () => {
  const good = day("2026-07-01", () => 30);
  const partial = day("2026-07-02", () => 25).slice(0, 10);
  const og = day("2026-07-02", () => 31).map((o) => ({ ...o, src: "ogimet" as const }));
  const p = buildPaths(RCSS, "2026-07-01", "2026-07-02", [{ name: "iem", obs: [...good, ...partial] }, { name: "ogimet", obs: og }]);
  assert.deepEqual(p.map((x) => [x.date, x.source, x.M]), [["2026-07-01", "iem", 30], ["2026-07-02", "ogimet", 31]]);
});

test("runningMax: union of sources, window [local midnight, now), day flags", () => {
  const now = at("2026-10-07", "12:40");
  const awc = [{ tUtcMs: at("2026-10-07", "12:30"), tempC: 28 }, { tUtcMs: at("2026-10-06", "23:30"), tempC: 35 }];
  const iem = [{ tUtcMs: at("2026-10-07", "11:00"), tempC: 27 }, { tUtcMs: at("2026-10-07", "13:00"), tempC: 40 }];
  const r = runningMax(RCSS, "2026-10-07", now, [{ src: "awc", url: "a", obs: awc }, { src: "iem", url: "i", obs: iem }]);
  assert.equal(r.tmaxC, 28);
  assert.equal(r.nObs, 2);
  assert.equal(r.atLocal, "12:30");
  assert.equal(r.dayStarted, true);
  assert.equal(r.dayOver, false);
  const before = runningMax(RCSS, "2026-10-08", now, []);
  assert.equal(before.dayStarted, false);
  assert.equal(before.tmaxC, null);
});

test("2-year analysis result (results/close_time.json): Taipei warm-season t99 17:30, close/stop times", (t) => {
  const f = new URL("../results/close_time.json", import.meta.url);
  if (!existsSync(f)) return t.skip("run npm run close-time first");
  const j = JSON.parse(readFileSync(f, "utf8"));
  const s = j.stations.RCSS;
  assert.ok(s.days >= 700);
  assert.equal(recommendClose(s, 10).closeLocal, s.bySeason["warm (May-Oct)"].t99);
  const c = closeFor("RCSS", "2026-10-08");
  assert.equal(c.closeLocal, s.bySeason["warm (May-Oct)"].t99);
  assert.equal(new Date(c.closeUtcMs).toISOString().slice(11, 16), `${String(Number(c.closeLocal.slice(0, 2)) - 8).padStart(2, "0")}:${c.closeLocal.slice(3)}`);
  assert.equal(c.closeUtcMs - c.stopUtcMs, 10 * 60_000);
  assert.ok(c.closeUtcMs < c.dayEndUtcMs);
});
