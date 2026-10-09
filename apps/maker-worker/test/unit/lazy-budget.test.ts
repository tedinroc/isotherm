// The MON-saving quoting of 2026-10-09 through the engine against the fake chain, LIVE: the lazy re-quote rules
// (packages/maker policy.ts), one-sided refills, the quoting budget tiers (budget.ts quotingTier: soft = x2 spreads and
// urgent re-quotes only, hard = no new quotes and urgent strikes pulled) and the reserve meter that never refuses a pull.
import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { kuruBookAbi } from "../../../../packages/maker/src/abis.ts";
import { budgetDay } from "../../../../packages/maker/src/budget.ts";
import { macSnapshot, MAKER, PM, stubData, world } from "./helpers.ts";

const LEGACY = '{"policy":{"lazy":false}}';
type W = ReturnType<typeof world>;
const live = (w: W) => {
  w.kv.m.set("control", JSON.stringify({ seq: 1, live: true, confirm: MAKER.address }));
  w.api.snapshot = macSnapshot(w, 3600); // the other writer stopped an hour ago
};
const tick = async (w: W, pm: Record<number, number>, over?: string) => {
  w.chain.time += 60;
  return w.engine({ MAKER_MODE: "live", ...(over ? { CONFIG_OVERRIDES: over } : {}) }, stubData({ ...PM, ...pm })).tick();
};
const strike = (r: Awaited<ReturnType<typeof tick>>, k: number) => r.ladders[0].strikes.find((s) => s.k === k)!;
/** set today's live meters (the budget day is the wall clock's Taipei day, as in the shared send()) */
const setMeters = (w: W, spent: Record<string, number>) => {
  const e = w.engine();
  const st = e.loadState("live");
  st.budget = { day: budgetDay(Date.now(), 480), spent, txs: {} };
  e.saveState("live", st);
};
const fill = (w: W, k: number, side: "bid" | "ask") => {
  // a taker lifted our whole order: it is gone from the book (the fake chain models a full fill as a removal)
  const s = w.strikes.find((x) => x.k === k)!;
  const id = w.chain.openOrders(s.market, MAKER.address).find((o) => o.isBuy === (side === "bid"))!.id;
  w.chain.apply(MAKER.address, s.market, encodeFunctionData({ abi: kuruBookAbi, functionName: "batchCancelOrdersNoRevert", args: [[id]] }));
  return id;
};

describe("lazy re-quoting (live)", () => {
  it("a 0.03 fair move inside the resting spread is not re-quoted (the old rules did); a crossing is, at once", async () => {
    const w = world();
    live(w);
    await tick(w, {});
    let r = await tick(w, { 30: 0.505 }); // resting 0.44/0.51, mid 0.475: moved 0.03, nothing crossed
    expect(r.txs).toEqual([]);
    expect(strike(r, 30)).toMatchObject({ action: "none", reasons: ["quote still good"] });
    // the same move under the legacy rules (requoteTicks 3) re-quotes
    const old = world();
    live(old);
    await tick(old, {}, LEGACY);
    expect((await tick(old, { 30: 0.505 }, LEGACY)).txs.map((t) => t.label)).toEqual(["requote >=30 100@0.47 / 100@0.54 cancel 2"]);
    // the fair through the resting ask: urgent, both sides re-centred
    r = await tick(w, { 30: 0.52 });
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 100@0.49 / 100@0.55 cancel 2"]);
    expect(strike(r, 30).reasons[0]).toBe("resting ask 0.51 <= fair 0.52");
    // with the base half-spread (0.03) a move of about 0.03 already crosses: the urgent rule, not the 0.04 rule, fires
    r = await tick(w, { 30: 0.559 });
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 100@0.52 / 100@0.59 cancel 2"]);
    // moves that stay inside the new 0.52/0.59 quote are quiet, both ways (the legacy 3-tick rule re-quoted these)
    for (const f of [0.584, 0.524, 0.57]) expect((await tick(w, { 30: f })).txs).toEqual([]);
  });

  it("a filled side is refilled ALONE (one-sided batchUpdate, no cancel), the other order stays untouched", async () => {
    const w = world();
    live(w);
    await tick(w, { 30: 0.52 }); // urgent re-quote -> lastQuote fair 0.52, 0.49/0.55
    const e = w.engine();
    const before = e.loadState("live").ladders[`RCSS:${w.date}`].series[30];
    expect(before.lastQuote).toMatchObject({ fair: 0.52, bid: 0.49, ask: 0.55 });
    const bidId = before.orders.bid!.id;
    fill(w, 30, "ask");
    const n = w.chain.sent.length;
    const r = await tick(w, { 30: 0.52 });
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 ask 100@0.55 only"]);
    const tx = w.chain.sent[n];
    expect([tx.functionName, tx.args[0], tx.args[2], tx.args[4]]).toEqual(["batchUpdate", [], [5500], []]); // place one ask, cancel nothing
    const after = e.loadState("live").ladders[`RCSS:${w.date}`].series[30];
    expect(after.orders.bid!.id).toBe(bidId);
    expect(after.lastQuote).toMatchObject({ fair: 0.52, at: before.lastQuote!.at, bid: 0.49, ask: 0.55 }); // the centre is unchanged
  });
});

describe("quoting budget tiers and the reserve meter (live)", () => {
  it("soft (>= 60 % of the cap): a refill waits, an urgent strike is re-quoted with x2 spreads", async () => {
    const w = world();
    live(w);
    await tick(w, {});
    setMeters(w, { maker: 0.8 }); // cap 1.2, soft line 0.72
    fill(w, 29, "ask");
    const r = await tick(w, { 30: 0.52 });
    expect(strike(r, 29)).toMatchObject({ action: "none" });
    expect(strike(r, 29).reasons[0]).toMatch(/^quoting budget above the soft threshold: only urgent re-quotes \(ask side empty \(filled\)\)/);
    // >=30 crossed: re-quoted at half-spread 0.06 instead of 0.03
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 100@0.46 / 100@0.58 cancel 2"]);
    expect(w.kv.json("status").budget.tier).toMatchObject({ tier: "soft", cap: 1.2, soft: 0.72 });
  });

  it("hard (at the cap): no new quotes, an urgent strike is PULLED; pulls are never refused, even far past the old cap + reserve", async () => {
    const w = world();
    live(w);
    await tick(w, {});
    setMeters(w, { maker: 5 }); // the old rule refused pulls above cap + reserve (1.2 + 0.5)
    const r = await tick(w, { 31: 0.13 }, '{"budget":{"reserveMon":{"maker":0.001}}}');
    expect(r.errors).toEqual([]);
    expect(r.txs.map((t) => [t.label, t.status])).toEqual([["pull >=31: resting ask 0.12 <= fair 0.13", "success"]]);
    expect(strike(r, 31).reasons.at(-1)).toBe("quoting budget spent for today: pulled instead of re-quoted");
    expect(w.chain.openOrders(w.strikes[2].market, MAKER.address)).toEqual([]);
    const b = w.engine().loadState("live").budget;
    expect(b.spent.maker).toBe(5); // the quoting meter is untouched
    expect(b.spent["maker:reserve"]).toBeGreaterThan(0);
    // the reserve line (0.001 here) was passed: flagged and alerted once a day, never refused
    expect(r.alerts).toContain("RESERVE METER OVER maker");
    expect(w.store.tail<any>("txs:live", 3).at(-1)).toMatchObject({ kind: "pull", overBudget: true });
    // the pulled strike stays empty: no new quotes at the cap
    const r2 = await tick(w, { 31: 0.13 }, '{"budget":{"reserveMon":{"maker":0.001}}}');
    expect(r2.txs).toEqual([]);
    expect(strike(r2, 31)).toMatchObject({ action: "none", reasons: ["quoting budget spent for today: no new quotes"] });
    expect(r2.alerts).not.toContain("RESERVE METER OVER maker"); // once a day
    // the kill switch at stop time is never held back by a tier either
    w.chain.time = w.closeTime - 10 * 60 - 60;
    const k = await w.engine({ MAKER_MODE: "live" }, stubData(PM)).tick();
    expect(k.kill).toEqual([expect.objectContaining({ mode: "live", leftOpen: 0 })]);
    expect(k.txs.filter((t) => /^KILL/.test(t.label)).length).toBeGreaterThan(0);
  });
});
