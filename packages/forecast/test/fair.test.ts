import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ladderFromGamma } from "../src/polymarket.ts";
import { computeFairs } from "../src/fair.ts";

const OCT8 = JSON.parse(readFileSync(new URL("./fixtures/gamma_taipei_2026-10-08.json", import.meta.url), "utf8"))[0];
const now = Date.parse("2026-10-07T05:00:00Z");
const pm = ladderFromGamma(OCT8, "RCSS", null, new Date(now).toISOString());
const v0 = { ladder: { 27: 0.99, 28: 0.97, 29: 0.88, 30: 0.61, 31: 0.23, 32: 0.05 } as Record<string, number> };
const obs = (m: number | null) => ({ station: "RCSS", date: "2026-10-08", tmaxC: m, nObs: 10, lastObsUtc: 0, lastLocal: "12:00", atLocal: "12:00", dayStarted: true, dayOver: false, fetchedAt: "", sources: [] });
const base = { strikes: [28, 29, 30, 31], nowMs: now, localMinute: null, pm, pmFetchedMs: now, obs: null, v0, intraday: null };

test("fair = Polymarket-implied P(>=k) when fresh and on the grid; v0 is only the guard", () => {
  const f = computeFairs(base);
  assert.deepEqual(f.map((x) => x.source), ["polymarket", "polymarket", "polymarket", "polymarket"]);
  assert.equal(f[2].fair, +pm.ladder[30].toFixed(4));
  assert.equal(f[2].guard, 0.61);
  assert.ok(f[3].flags.length === 0 || f[3].flags.every((x) => x.startsWith("guard")));
});

test("observed max >= k makes the strike certain; strikes above are conditioned on Tmax >= m", () => {
  const f = computeFairs({ ...base, obs: obs(29), localMinute: 9 * 60 });
  assert.equal(f[0].certain, "yes");
  assert.equal(f[1].certain, "yes");
  assert.equal(f[1].fair, 1);
  assert.equal(f[2].fair, +(pm.ladder[30] / pm.ladder[29]).toFixed(4));
  assert.equal(f[2].guardSource, "v0-truncated");
});

test("on day D after 11:00 the guard comes from the intraday increment table", () => {
  const intraday = { incrementTable: [{ mark: "12:00", markMin: 720, pIncGE: [0.4, 0.15, 0.04, 0, 0, 0] }, { mark: "15:00", markMin: 900, pIncGE: [0.05, 0.01, 0, 0, 0, 0] }] };
  const f = computeFairs({ ...base, obs: obs(29), localMinute: 15 * 60 + 5, intraday });
  assert.equal(f[2].guardSource, "intraday");
  assert.equal(f[2].guard, 0.05); // P(rise >= 1 after 15:00)
  assert.equal(f[3].guard, 0.01);
});

test("stale / degraded / missing Polymarket -> v0 fallback (flagged); nothing usable -> none", () => {
  const stale = computeFairs({ ...base, pmFetchedMs: now - 3600_000 });
  assert.equal(stale[0].source, "fallback-v0");
  assert.ok(stale[0].flags.includes("pm-stale-or-degraded"));
  const none = computeFairs({ ...base, pm: null });
  assert.equal(none[1].source, "fallback-v0");
  assert.ok(none[1].flags.includes("no-polymarket-market"));
  const nothing = computeFairs({ ...base, pm: null, v0: null });
  assert.deepEqual(nothing.map((x) => x.fair), [null, null, null, null]);
  assert.ok(nothing.every((x) => x.source === "none"));
  const offGrid = computeFairs({ ...base, strikes: [37] });
  assert.equal(offGrid[0].source, "fallback-v0");
  assert.ok(offGrid[0].flags.includes("pm-extrapolated"));
});

test("guard divergence flags: >0.15 widen, >0.40 pull", () => {
  const far = { ladder: { 28: 0.97, 29: 0.88, 30: 0.95, 31: 0.6 } as Record<string, number> };
  const f = computeFairs({ ...base, v0: far });
  assert.ok(f[2].flags.includes("guard-pull"), JSON.stringify(f[2])); // |0.47-0.95| = 0.48
  assert.ok(f[3].flags.includes("guard-pull") || f[3].flags.includes("guard-wide"));
  const mild = computeFairs({ ...base, v0: { ladder: { ...far.ladder, 30: 0.7 } } });
  assert.ok(mild[2].flags.includes("guard-wide"));
});

test("guard-wide hysteresis: enter above guardWarn, stay wide while >= guardWarnExit when the resting quote is wide, exit below it", () => {
  const f30 = +pm.ladder[30].toFixed(4);
  // |fair - guard| = div on strike 30; restingWide = the maker's lastQuote.wide; cfg.guardWarnExit = the exit threshold
  const at = (div: number, restingWide?: Record<number, boolean> | null, cfg: { guardWarnExit?: number | null } = { guardWarnExit: 0.13 }) =>
    computeFairs({ ...base, strikes: [30], v0: { ladder: { 30: +(f30 + div).toFixed(4) } }, restingWide, cfg })[0];
  assert.equal(at(0.14, { 30: true }).divergence, 0.14);
  // enter: above 0.15, whatever the resting quote
  assert.deepEqual(at(0.16, null).flags, ["guard-wide"]);
  assert.deepEqual(at(0.16, { 30: true }).flags, ["guard-wide"]);
  // stay: the resting quote was placed wide and the divergence is still >= 0.13
  assert.deepEqual(at(0.14, { 30: true }).flags, ["guard-wide", "guard-wide-held"]);
  assert.deepEqual(at(0.13, { 30: true }).flags, ["guard-wide", "guard-wide-held"]);
  // a narrow resting quote is not widened between the thresholds
  assert.deepEqual(at(0.14, { 30: false }).flags, []);
  assert.deepEqual(at(0.14, { 31: true }).flags, []);
  // exit: below 0.13
  assert.deepEqual(at(0.1299, { 30: true }).flags, []);
  assert.deepEqual(at(0.12, { 30: true }).flags, []);
  // absent field (a lastQuote written before `wide` existed): the plain 0.15 threshold, as before
  assert.deepEqual(at(0.14, undefined).flags, []);
  assert.deepEqual(at(0.16, undefined).flags, ["guard-wide"]);
  // absent config value: no hysteresis at all, even with a wide resting quote
  assert.deepEqual(at(0.14, { 30: true }, {}).flags, []);
  assert.deepEqual(at(0.14, { 30: true }, { guardWarnExit: null }).flags, []);
  // guard-pull still wins over a held wide spread
  assert.deepEqual(at(0.45, { 30: true }).flags, ["guard-pull"]);
  // only a Polymarket fair has a divergence: a fallback fair is never held
  const fb = computeFairs({ ...base, strikes: [30], pm: null, v0: { ladder: { 30: 0.5 } }, restingWide: { 30: true }, cfg: { guardWarnExit: 0.13 } })[0];
  assert.equal(fb.source, "fallback-v0");
  assert.ok(!fb.flags.includes("guard-wide"));
});
