// The pull hysteresis (packages/maker policy.ts, policy.pullReentry) through the engine against the fake chain, LIVE:
// on 2026-10-14 a fair hovering at quote.pullBelow (0.03) and a Polymarket/guard divergence hovering at fair.guardPull
// (0.4) flapped pull -> quote -> pull, ~0.0875 MON a cycle (0.059 quoting + 0.028 reserve). With pullReentry a strike
// pulled for the band or the guard is quoted again only once it is clear of both thresholds by that margin; other pulls
// (a manual pull then resume, ...) are quoted again as before. Off (null, the default) = as before.
import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { kuruBookAbi } from "../../../../packages/maker/src/abis.ts";
import { macSnapshot, MAKER, PM, stubData, world } from "./helpers.ts";

const ON = '{"policy":{"pullReentry":0.02}}';
type W = ReturnType<typeof world>;
const live = (w: W) => {
  w.kv.m.set("control", JSON.stringify({ seq: 1, live: true, confirm: MAKER.address }));
  w.api.snapshot = macSnapshot(w, 3600); // the other writer stopped an hour ago
};
/** one tick; `guard` overrides the guard model's P(>=k) (default: equal to Polymarket, so no guard flags) */
const tick = async (w: W, pm: Record<number, number>, over?: string, guard: Record<number, number> = {}) => {
  w.chain.time += 60;
  const p = { ...PM, ...pm };
  return w.engine({ MAKER_MODE: "live", ...(over ? { CONFIG_OVERRIDES: over } : {}) }, stubData(p, { max: null }, { ...p, ...guard })).tick();
};
const strike = (r: Awaited<ReturnType<typeof tick>>, k: number) => r.ladders[0].strikes.find((s) => s.k === k)!;
const labels = (r: Awaited<ReturnType<typeof tick>>) => r.txs.map((t) => t.label);
const seriesOf = (w: W, k: number) => w.engine().loadState("live").ladders[`RCSS:${w.date}`].series[k];
const modeOf = (w: W, k: number) => seriesOf(w, k).mode;
const fill = (w: W, k: number, side: "bid" | "ask") => {
  // a taker lifted our whole order: it is gone from the book (the fake chain models a full fill as a removal)
  const s = w.strikes.find((x) => x.k === k)!;
  const id = w.chain.openOrders(s.market, MAKER.address).find((o) => o.isBuy === (side === "bid"))!.id;
  w.chain.apply(MAKER.address, s.market, encodeFunctionData({ abi: kuruBookAbi, functionName: "batchCancelOrdersNoRevert", args: [[id]] }));
};

describe("pull hysteresis (policy.pullReentry, live)", () => {
  it("a fair flapping at pullBelow: one pull, then nothing until the fair is back to 0.05; without it, a quote + pull per bounce", async () => {
    const w = world();
    live(w);
    expect((await tick(w, {}, ON)).errors).toEqual([]);
    expect(labels(await tick(w, { 31: 0.0297 }, ON))).toEqual(["pull >=31: fair 0.0297 outside (0.03, 0.97): outcome ~known"]);
    for (const f of [0.031, 0.029, 0.031, 0.0299, 0.04, 0.0499]) {
      const r = await tick(w, { 31: f }, ON);
      expect(labels(r)).toEqual([]);
      expect(strike(r, 31).action).toBe("none");
      expect(modeOf(w, 31)).toBe("pulled");
    }
    expect(strike(await tick(w, { 31: 0.031 }, ON), 31).reasons).toEqual(["pulled: fair 0.031 not back inside [0.05, 0.95] (pullReentry 0.02)"]);
    expect(w.chain.openOrders(w.strikes[2].market, MAKER.address)).toEqual([]);
    const r = await tick(w, { 31: 0.05 }, ON);
    expect(labels(r)).toEqual([expect.stringMatching(/^quote >=31 /)]);
    expect(strike(r, 31).action).toBe("quote");
    expect(modeOf(w, 31)).toBe("quoting");

    // control: the same fairs today (pullReentry off)
    const off = world();
    live(off);
    await tick(off, {});
    const sent: string[] = [];
    for (const f of [0.0297, 0.031, 0.029, 0.031]) sent.push(...labels(await tick(off, { 31: f })));
    expect(sent.map((l) => l.split(":")[0].split(" 100@")[0])).toEqual(["pull >=31", "quote >=31", "pull >=31", "quote >=31"]);
  });

  it("a guard pull: no re-quote until |Polymarket - guard| <= guardPull - pullReentry (0.38)", async () => {
    const w = world();
    live(w);
    await tick(w, {}, ON);
    expect(labels(await tick(w, {}, ON, { 30: 0.88 }))).toEqual(["pull >=30: Polymarket and the guard model disagree by > guardPull"]); // 0.41
    for (const g of [0.86, 0.865, 0.88, 0.8601]) expect(labels(await tick(w, {}, ON, { 30: g }))).toEqual([]); // 0.39, 0.395, 0.41, 0.3901
    expect(strike(await tick(w, {}, ON, { 30: 0.86 }), 30).reasons).toEqual(["pulled: Polymarket and the guard model still disagree by 0.39 (> guardPull 0.4 - pullReentry 0.02)"]);
    expect(labels(await tick(w, {}, ON, { 30: 0.85 }))).toEqual([expect.stringMatching(/^quote >=30 /)]); // 0.38

    const off = world();
    live(off);
    await tick(off, {});
    expect(labels(await tick(off, {}, undefined, { 30: 0.88 }))).toEqual(["pull >=30: Polymarket and the guard model disagree by > guardPull"]);
    expect(labels(await tick(off, {}, undefined, { 30: 0.86 }))).toEqual([expect.stringMatching(/^quote >=30 /)]);
  });

  it("a strike that genuinely recovers is quoted at once; pullReentry null is the same as absent", async () => {
    const w = world();
    live(w);
    await tick(w, {}, ON);
    expect(labels(await tick(w, { 31: 0.0297 }, ON))).toHaveLength(1);
    expect(labels(await tick(w, { 31: 0.09 }, ON))).toEqual([expect.stringMatching(/^quote >=31 /)]);
    const n = world();
    live(n);
    const NULL = '{"policy":{"pullReentry":null}}';
    await tick(n, {}, NULL);
    expect(labels(await tick(n, { 31: 0.0297 }, NULL))).toHaveLength(1);
    expect(labels(await tick(n, { 31: 0.031 }, NULL))).toEqual([expect.stringMatching(/^quote >=31 /)]);
  });

  it("an empty strike pulled without a tx (both sides filled, then the fair left the band) records why, and waits too", async () => {
    const w = world();
    live(w);
    await tick(w, {}, ON);
    fill(w, 31, "bid");
    fill(w, 31, "ask");
    const p = await tick(w, { 31: 0.029 }, ON);
    expect([labels(p), strike(p, 31).action, modeOf(w, 31)]).toEqual([[], "none", "pulled"]);
    expect(seriesOf(w, 31)).toMatchObject({ reason: "fair 0.029 outside (0.03, 0.97): outcome ~known", lastPullAt: w.chain.time });
    expect(strike(await tick(w, { 31: 0.04 }, ON), 31).reasons).toEqual(["pulled: fair 0.04 not back inside [0.05, 0.95] (pullReentry 0.02)"]);
    expect(labels(await tick(w, { 31: 0.05 }, ON))).toEqual([expect.stringMatching(/^quote >=31 /)]);

    // off: quoted again at 0.04, and the stored state is left as before (no pull reason recorded on the empty path)
    const off = world();
    live(off);
    await tick(off, {});
    fill(off, 31, "bid");
    fill(off, 31, "ask");
    const before = seriesOf(off, 31);
    await tick(off, { 31: 0.029 });
    expect(seriesOf(off, 31)).toEqual({ ...before, mode: "pulled" });
    expect(labels(await tick(off, { 31: 0.04 }))).toEqual([expect.stringMatching(/^quote >=31 /)]);
  });

  it("a manual pull then resume is not held: quoted at once inside both hold zones (fair 0.04, divergence 0.39)", async () => {
    const w = world();
    live(w);
    const at = async () => tick(w, { 31: 0.04 }, ON, { 30: 0.86 });
    await at();
    w.kv.m.set("control", JSON.stringify({ seq: 2, pull: "all" }));
    await at();
    expect([modeOf(w, 30), modeOf(w, 31)]).toEqual(["pulled", "pulled"]);
    for (const k of [29, 30, 31]) expect(w.chain.openOrders(w.strikes.find((x) => x.k === k)!.market, MAKER.address)).toEqual([]);
    w.kv.m.set("control", JSON.stringify({ seq: 3, resume: `RCSS:${w.date}` }));
    const back = await at();
    expect(labels(back)).toEqual([expect.stringMatching(/^quote >=29 /), expect.stringMatching(/^quote >=30 /), expect.stringMatching(/^quote >=31 /)]);
    expect(strike(back, 30).flags).toContain("guard-wide");
  });

  it("a bad value is refused by the shared validation when the engine starts", () => {
    const w = world();
    expect(() => w.engine({ MAKER_MODE: "live", CONFIG_OVERRIDES: '{"policy":{"pullReentry":0.2}}' })).toThrow(/policy.pullReentry 0.2 must be a number in \[0, 0.2\)/);
    expect(() => w.engine({ MAKER_MODE: "live", CONFIG_OVERRIDES: '{"policy":{"pullReentry":-0.01}}' })).toThrow(/policy.pullReentry/);
    expect(w.engine({ MAKER_MODE: "live", CONFIG_OVERRIDES: ON })).toBeTruthy();
  });
});
