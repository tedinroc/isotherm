// The Durable Object's maker logic (engine.ts) against a fake Monad chain: shadow sends nothing, both live switches,
// the other-writer interlock, the kill switch in both modes, control documents, state import, snapshot publishing,
// nonce handling and the alarm schedule. The real tick/roll/kill code from packages/maker runs unmodified.
import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { kuruBookAbi } from "../../../../packages/maker/src/abis.ts";
import { stringify } from "../../src/store.ts";
import { addDays, macSnapshot, MAKER, OPERATOR, PM, stubData, world } from "./helpers.ts";

const armed = async (w: ReturnType<typeof world>, seq = 1) => {
  w.kv.m.set("control", JSON.stringify({ seq, live: true, confirm: MAKER.address }));
};

describe("shadow mode (the default)", () => {
  it("adopts today's on-chain ladder, mirrors the live maker's orders, decides, and sends NOTHING", async () => {
    const w = world();
    const e = w.engine();
    const r1 = await e.tick();
    expect(r1.mode).toBe("shadow");
    expect(r1.reasons).toEqual(expect.arrayContaining(["env MAKER_MODE is shadow", "Durable Object live flag is off"]));
    expect(r1.errors).toEqual([]);
    expect(r1.rolls.map((r) => [r.key, r.ok])).toEqual([[`RCSS:${w.date}`, true]]);
    // the shadow tracks the Mac's resting orders (same maker key) as found on the books
    const st = e.loadState("shadow");
    const lad = st.ladders[`RCSS:${w.date}`];
    expect(lad.status).toBe("active");
    for (const s of w.strikes) expect([lad.series[s.k].orders.bid?.id, lad.series[s.k].orders.ask?.id]).toEqual([w.macOrders[s.k].bid, w.macOrders[s.k].ask]);
    // the Mac's quotes are where the shared policy wants them -> nothing to do
    expect(r1.ladders[0].strikes.map((k) => k.action)).toEqual(["none", "none", "none"]);
    expect(r1.intents).toEqual([]);
    // Polymarket moves >=30 from 0.47 to 0.55: the shadow WOULD re-quote, and records it, but sends nothing
    const r2 = await w.engine({}, stubData({ ...PM, 30: 0.55 })).tick();
    const a30 = r2.ladders[0].strikes.find((k) => k.k === 30)!;
    expect(a30.action).toBe("requote");
    expect(a30.reasons.join(" ")).toMatch(/resting ask 0.51 <= fair 0.55/);
    expect(r2.intents.map((i) => i.label)).toEqual([expect.stringMatching(/^requote >=30 100@0.52 \/ 100@0.58 cancel 2$/)]);
    expect(r2.intents[0]).toMatchObject({ role: "maker", functionName: "batchUpdate", kind: "quote", gasLimit: String(Math.ceil(450_000 * 1.08)) });
    expect(w.chain.sent).toEqual([]);
    expect(w.chain.openOrders(w.strikes[1].market).map((o) => o.id)).toEqual([w.macOrders[30].bid, w.macOrders[30].ask]);
    // no snapshot is published in shadow (it would replace the live maker's); the binding is read for the comparison
    expect(w.api.posted).toEqual([]);
    expect(w.api.gets).toBeGreaterThanOrEqual(2);
    expect(r2.snapshot).toMatchObject({ posted: false });
    // the shadow meters what it would have spent
    expect(e.loadState("shadow").budget.spent.maker).toBeCloseTo(Math.ceil(450_000 * 1.08) * 102e-9, 9);
    // the live maker does not re-quote, so the shadow wants the identical tx again: reported, but metered only once
    const again = await w.engine({}, stubData({ ...PM, 30: 0.55 })).tick();
    expect(again.intents).toEqual([expect.objectContaining({ label: r2.intents[0].label, repeat: true })]);
    expect(w.engine().loadState("shadow").budget.spent.maker).toBeCloseTo(Math.ceil(450_000 * 1.08) * 102e-9, 9);
    // the outbox the operator reads with scripts/control.mjs
    expect(w.kv.json("status")).toMatchObject({ mode: "shadow", liveFlag: false, keys: { maker: MAKER.address } });
    expect(w.kv.json("tick:last").intents).toHaveLength(1);
    expect(w.kv.json("shadow:summary")).toMatchObject({ ticks: 3, liveTicks: 0, intents: { requote: 1 }, intentRepeats: 1 });
  });

  it("compares its decisions with the live maker's published snapshot", async () => {
    const w = world();
    w.api.snapshot = macSnapshot(w, 30);
    const r = await w.engine().tick();
    expect(r.ladders[0].strikes.find((k) => k.k === 30)!.mac).toMatchObject({ fair: 0.47, bid: 0.44, ask: 0.51 });
    const s = w.store.get<any>("shadow:summary");
    expect(s.compare).toMatchObject({ n: 3, restingMatchesDesired: 3, wouldChange: 0, macMissing: 0 });
    expect(s.compare.fairAbsDiffMax).toBe(0);
  });

  it("runs the kill switch as a dry run at stop time, then closes the shadow ladder (no repeats)", async () => {
    const w = world();
    const e = w.engine();
    await e.tick();
    w.chain.time = w.closeTime - 10 * 60 - 60; // inside preStopSec (90 s) of stopAt (close - 10 min)
    const r = await e.tick();
    expect(r.kill).toEqual([{ key: `RCSS:${w.date}`, cancelled: 6, leftOpen: 0, mode: "shadow" }]);
    expect(r.intents.filter((i) => /^KILL/.test(i.label))).toHaveLength(3);
    // the would-be kill is complete: the YES margin withdraw is simulated and recorded too
    expect(r.intents.filter((i) => /^withdraw YES margin x3 after close$/.test(i.label))).toHaveLength(1);
    expect(w.chain.sent).toEqual([]);
    expect(e.loadState("shadow").ladders[`RCSS:${w.date}`].status).toBe("closed");
    const again = await e.tick();
    expect(again.kill).toEqual([]);
    expect(again.intents).toEqual([]);
  });
});

describe("watch-only shadow (public addresses, no key secrets)", () => {
  it("mirrors the live maker from its address alone and can never be armed", async () => {
    const w = world();
    w.kv.m.set("control", JSON.stringify({ seq: 1, live: true, confirm: MAKER.address }));
    const e = w.engine({ MAKER_MODE: "live" }, stubData({ ...PM, 30: 0.55 }), { makerAddress: MAKER.address, operatorAddress: OPERATOR.address });
    const r = await e.tick();
    expect(r.control).toMatch(/arm REFUSED: no MAKER_KEY secret/);
    expect(r.mode).toBe("shadow");
    expect(r.reasons).toContain("watch-only addresses (no key secrets): shadow only");
    expect(r.errors).toEqual([]);
    expect(r.intents.map((i) => i.label)).toEqual([expect.stringMatching(/^requote >=30 /)]);
    expect(r.intents[0].from).toBe(MAKER.address);
    expect(w.chain.sent).toEqual([]);
    expect(w.kv.json("status").keys).toMatchObject({ maker: MAKER.address, watchOnly: true });
  });
});

describe("the two live switches", () => {
  it("needs MAKER_MODE=live AND an armed Durable Object flag (confirmed with the maker address)", async () => {
    const w = world();
    w.kv.m.set("control", JSON.stringify({ seq: 1, live: true, confirm: "0x000000000000000000000000000000000000dEaD" }));
    let r = await w.engine({ MAKER_MODE: "live" }).tick();
    expect(r.control).toMatch(/arm REFUSED: confirm must be the maker address/);
    expect(r.mode).toBe("shadow");
    await armed(w, 2);
    r = await w.engine().tick(); // env still shadow
    expect(r.control).toMatch(/ARMED/);
    expect(r.liveFlag).toBe(true);
    expect(r.mode).toBe("shadow");
    expect(r.reasons).toEqual(["env MAKER_MODE is shadow"]);
    r = await w.engine({ MAKER_MODE: "live" }).tick(); // both on (same seq: not re-applied)
    expect(r.control).toBeNull();
    expect(r.mode).toBe("live");
    w.kv.m.set("control", JSON.stringify({ seq: 3, live: false }));
    r = await w.engine({ MAKER_MODE: "live" }).tick();
    expect(r.control).toMatch(/disarmed/);
    expect(r.mode).toBe("shadow");
    expect(w.kv.json("control:result")).toMatchObject({ seq: 3 });
  });

  it("live: adopts the books, re-quotes for real through the nonce tracker, and publishes the snapshot via the binding", async () => {
    const w = world();
    await armed(w);
    w.api.snapshot = macSnapshot(w, 3600); // the Mac stopped an hour ago
    const e = w.engine({ MAKER_MODE: "live" }, stubData({ ...PM, 30: 0.55 }));
    const r = await e.tick();
    expect(r.mode).toBe("live");
    expect(r.interlock).toMatchObject({ checked: true, blocked: false });
    expect(r.errors).toEqual([]);
    expect(w.chain.sent.map((t) => [t.functionName, t.from, t.nonce])).toEqual([["batchUpdate", MAKER.address, 0]]);
    const tx = w.chain.sent[0];
    expect(tx.gas).toBe(BigInt(Math.ceil(450_000 * 1.08))); // Monad bills the limit: estimate x 1.08
    expect(tx.args[4]).toEqual([w.macOrders[30].bid, w.macOrders[30].ask]); // cancels the old quote in the same tx
    const open = w.chain.openOrders(w.strikes[1].market, MAKER.address);
    expect(open.map((o) => [o.isBuy, o.price / 1e4])).toEqual([[true, 0.52], [false, 0.58]]);
    const lad = e.loadState("live").ladders[`RCSS:${w.date}`];
    expect([lad.series[30].orders.bid?.id, lad.series[30].orders.ask?.id]).toEqual(open.map((o) => o.id));
    expect(w.store.get<any>(`nonce:${MAKER.address.toLowerCase()}`)).toMatchObject({ next: 1, inflight: {}, lastMined: { nonce: 0 } });
    expect(r.txs).toEqual([expect.objectContaining({ role: "maker", status: "success" })]);
    // the snapshot goes to the API Worker through the service binding with the bearer token, labelled as ours
    expect(w.api.posted).toHaveLength(1);
    expect(w.api.posted[0].token).toBe("test-snapshot-token");
    expect(w.api.posted[0].body).toMatchObject({ schema: "isotherm.snapshot/v1", source: "isotherm-maker-worker", chainId: 10143 });
    expect(w.api.posted[0].body.budget.byRole.maker.roll).toMatchObject({ capMon: 0.8 });
    // a second tick has nothing to do
    const r2 = await e.tick();
    expect(r2.txs).toEqual([]);
    expect(w.chain.sent).toHaveLength(1);
  });

  it("interlock: a fresh snapshot from another writer (the Mac) keeps a live tick in shadow", async () => {
    const w = world();
    await armed(w);
    w.api.snapshot = macSnapshot(w, 30);
    const r = await w.engine({ MAKER_MODE: "live" }, stubData({ ...PM, 30: 0.55 })).tick();
    expect(r.interlock).toMatchObject({ blocked: true });
    expect(r.mode).toBe("shadow");
    expect(r.alerts).toEqual(["live mode blocked: another writer is active"]);
    expect(r.intents.length).toBe(1); // the decision is still computed and recorded
    expect(w.chain.sent).toEqual([]);
    expect(w.api.posted).toEqual([]);
  });

  it("live kill switch at stop time cancels every maker order and withdraws the YES margin; it also runs while the interlock holds", async () => {
    const w = world();
    // live state imported from the Mac (its state.json carries the order ids)
    const mac = {
      version: 1,
      deployment: { vault: "0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39", resolver: "0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B", zap: null, source: "mac", variant: "v1" },
      budget: { day: "", spent: {}, txs: {} },
      events: [],
      ladders: {
        [`RCSS:${w.date}`]: {
          key: `RCSS:${w.date}`, station: "RCSS", date: w.date, isoDate: w.isoToday, strikes: [29, 30, 31], strikeSource: "mac", closeTime: w.closeTime, stopAt: w.closeTime - 600, dayEnd: w.closeTime + 6.5 * 3600, status: "active", steps: {}, pending: {}, createdAt: 0,
          series: Object.fromEntries(w.strikes.map((s) => [s.k, { strike: s.k, seriesId: s.seriesId, yes: s.yes, no: s.no, market: s.market, canonical: true, mode: "quoting", orders: { bid: { id: w.macOrders[s.k].bid, price: 0, size: 100, placedAt: 0 }, ask: { id: w.macOrders[s.k].ask, price: 0, size: 100, placedAt: 0 } }, marginDone: true }])),
        },
      },
    };
    w.kv.m.set("import:state", stringify(mac));
    w.kv.m.set("control", JSON.stringify({ seq: 1, importState: "import:state" }));
    let r = await w.engine().tick();
    expect(r.control).toMatch(/imported live state from import:state: 1 ladder/);
    // arming refuses a later import
    w.kv.m.set("control", JSON.stringify({ seq: 2, live: true, confirm: MAKER.address, importState: "import:state" }));
    r = await w.engine().tick();
    expect(r.control).toMatch(/ARMED.*importState REFUSED: disarm first/);
    // the Mac is still publishing -> interlocked, yet the stop-time kill switch runs live
    w.chain.time = w.closeTime - 600 - 30;
    w.api.snapshot = macSnapshot(w, 20);
    r = await w.engine({ MAKER_MODE: "live" }).tick();
    expect(r.interlock?.blocked).toBe(true);
    expect(r.kill).toEqual(expect.arrayContaining([{ key: `RCSS:${w.date}`, cancelled: 6, leftOpen: 0, mode: "live" }]));
    expect(w.chain.sent.map((t) => t.functionName)).toEqual(["batchCancelOrdersNoRevert", "batchCancelOrdersNoRevert", "batchCancelOrdersNoRevert", "batchWithdrawMaxTokens"]);
    for (const s of w.strikes) expect(w.chain.openOrders(s.market, MAKER.address)).toEqual([]);
    expect(w.engine().loadState("live").ladders[`RCSS:${w.date}`].status).toBe("closed");
  });
});

describe("control and schedule", () => {
  it("pull cancels and pauses (in the current mode), resume undoes it; resetShadow clears the shadow", async () => {
    const w = world();
    await armed(w);
    w.api.snapshot = macSnapshot(w, 3600);
    const e = w.engine({ MAKER_MODE: "live" });
    await e.tick();
    w.kv.m.set("control", JSON.stringify({ seq: 2, pull: "all" }));
    const r = await e.tick();
    expect(r.control).toMatch(/pull all queued/);
    expect(w.chain.sent.filter((t) => t.functionName === "batchCancelOrdersNoRevert")).toHaveLength(3);
    expect(e.loadState("live").ladders[`RCSS:${w.date}`].paused).toBe(true);
    const quiet = await e.tick();
    expect(quiet.txs).toEqual([]);
    w.kv.m.set("control", JSON.stringify({ seq: 3, resume: `RCSS:${w.date}` }));
    const back = await e.tick();
    expect(e.loadState("live").ladders[`RCSS:${w.date}`].paused).toBe(false);
    expect(back.txs.map((t) => t.label)).toEqual([expect.stringMatching(/^quote >=29/), expect.stringMatching(/^quote >=30/), expect.stringMatching(/^quote >=31/)]);
    w.kv.m.set("control", JSON.stringify({ seq: 4, live: false, resetShadow: true }));
    await e.tick();
    expect(w.store.list("state:shadow:").length).toBeGreaterThan(0); // the tick after the reset rebuilt it
  });

  it("schedules the next alarm at the kill-switch time when it comes before the next tick", async () => {
    const w = world();
    const e = w.engine();
    await e.tick();
    expect(e.nextDelayMs()).toBe(60_000);
    expect(e.nextDelayMs(7_000)).toBe(53_000); // the period runs from tick start to tick start (no drift)
    expect(e.nextDelayMs(75_000)).toBe(2_000);
    w.chain.time = w.closeTime - 600 - 90 - 20; // 20 s before the kill window opens
    expect(e.nextDelayMs()).toBe(20_500);
    expect(e.nextDelayMs(7_000)).toBe(20_500);
  });
});

describe("shadow fidelity (fixes from the 2026-10-08 shadow-vs-Mac comparison)", () => {
  it("does not keep a dry-run roll plan; adopts the live maker's real ladder (with ITS strikes) once it is on chain", async () => {
    const w = world();
    const e = w.engine();
    await e.tick();
    const tIso = addDays(w.isoToday, 1);
    const tKey = `RCSS:${tIso.replace(/-/g, "")}`;
    w.chain.time += 3600 + 30; // 12:00:30 Taipei: tomorrow's roll is due
    const r1 = await e.tick();
    expect(r1.rolls.find((x) => x.key === tKey)?.ok).toBe(true);
    expect(r1.intents.map((i) => i.label)).toEqual(expect.arrayContaining([expect.stringMatching(/^createLadder RCSS \d{8} \[28,29,30,31\]$/)]));
    expect(w.chain.sent).toEqual([]);
    // the plan is reported and kept for comparison, but NOT in the shadow state (it would freeze these strikes)
    expect(e.loadState("shadow").ladders[tKey]).toBeUndefined();
    expect(w.store.list(`state:shadow:ladder:${tKey}`)).toEqual([]);
    expect(w.store.get<any>(`shadow:plan:${tKey}`)).toMatchObject({ strikes: [28, 29, 30, 31] });
    w.chain.time += 60;
    expect((await e.tick()).rolls).toEqual([]); // nothing on chain yet, re-plan throttled
    // the live maker rolls tomorrow with OTHER strikes and quotes them
    const tm = w.chain.addLadder("RCSS", Number(tIso.replace(/-/g, "")), [30, 31, 32], w.closeTime + 86_400, MAKER.address);
    const ids = tm.map((s) => ({ bid: w.chain.place(s.market, MAKER.address, 0.4, 100, true), ask: w.chain.place(s.market, MAKER.address, 0.5, 100, false) }));
    w.chain.time += 70; // > 120 s after the dry run: the shadow looks again and finds the real ladder
    const r3 = await e.tick();
    expect(r3.rolls.find((x) => x.key === tKey)?.ok).toBe(true);
    const lad = e.loadState("shadow").ladders[tKey];
    expect(lad.status).toBe("active");
    expect(lad.strikes).toEqual([30, 31, 32]);
    expect(lad.strikeSource).toMatch(/adopted from the existing on-chain ladder/);
    expect(tm.map((s) => [lad.series[s.k].orders.bid?.id, lad.series[s.k].orders.ask?.id])).toEqual(ids.map((x) => [x.bid, x.ask]));
    expect(r3.intents.filter((i) => /createLadder|createSeries/.test(i.label))).toEqual([]);
    expect(w.chain.sent).toEqual([]);
  });

  it("mirrors the live maker's lastQuote, so it predicts the 'quote older than 6 h' re-quote", async () => {
    const w = world();
    const quotedAt = w.chain.time - 6 * 3600 + 120; // the live maker quoted 5 h 58 min ago
    const snap = () => {
      const s = macSnapshot(w, 30) as any;
      for (const k of s.ladders[0].strikes) k.lastQuoteAt = quotedAt;
      return s;
    };
    w.api.snapshot = snap();
    const e = w.engine();
    const r1 = await e.tick();
    expect(r1.ladders[0].strikes.map((k) => k.action)).toEqual(["none", "none", "none"]);
    expect(r1.ladders[0].strikes[0].mac).toMatchObject({ lastQuoteAt: quotedAt });
    const s29 = e.loadState("shadow").ladders[`RCSS:${w.date}`].series[29];
    expect(s29.lastQuote).toMatchObject({ at: quotedAt, bid: 0.82, ask: 0.88, fair: 0.85 });
    w.chain.time += 180;
    w.api.snapshot = snap();
    const r2 = await e.tick();
    expect(r2.ladders[0].strikes.map((k) => [k.action, k.reasons.join("; ")])).toEqual([
      ["requote", "quote older than 6 h"],
      ["requote", "quote older than 6 h"],
      ["requote", "quote older than 6 h"],
    ]);
    expect(r2.intents.map((i) => i.label)).toEqual([expect.stringMatching(/^requote >=29 /), expect.stringMatching(/^requote >=30 /), expect.stringMatching(/^requote >=31 /)]);
    expect(w.chain.sent).toEqual([]);
    // the live maker re-quotes (new ids at the same prices): the shadow re-mirrors and is quiet again
    for (const s of w.strikes) {
      w.chain.apply(MAKER.address, s.market, encodeFunctionData({ abi: kuruBookAbi, functionName: "batchCancelOrdersNoRevert", args: [[w.macOrders[s.k].bid, w.macOrders[s.k].ask]] }));
      const q = { 29: [0.82, 0.88], 30: [0.44, 0.51], 31: [0.06, 0.12] }[s.k as 29 | 30 | 31]!;
      w.chain.place(s.market, MAKER.address, q[0], 100, true);
      w.chain.place(s.market, MAKER.address, q[1], 100, false);
    }
    w.chain.time += 60;
    const fresh = snap();
    for (const k of fresh.ladders[0].strikes) k.lastQuoteAt = w.chain.time - 20;
    w.api.snapshot = fresh;
    const r3 = await e.tick();
    expect(r3.ladders[0].strikes.map((k) => k.action)).toEqual(["none", "none", "none"]);
    expect(e.loadState("shadow").ladders[`RCSS:${w.date}`].series[29].lastQuote?.at).toBe(w.chain.time - 20);
  });

  it("re-scans recently closed ladders every WATCHDOG_VERIFY_SEC and cancels a maker order left on a book (Mac: watchdog --verify)", async () => {
    const w = world();
    await armed(w);
    w.api.snapshot = macSnapshot(w, 3600);
    const e = w.engine({ MAKER_MODE: "live" });
    await e.tick();
    w.chain.time = w.closeTime - 600 - 30;
    const k = await e.tick();
    expect(k.kill).toEqual([expect.objectContaining({ key: `RCSS:${w.date}`, leftOpen: 0, mode: "live" })]);
    // an order shows up on a closed book (e.g. from a tx that landed late)
    const stray = w.chain.place(w.strikes[0].market, MAKER.address, 0.5, 10, true);
    w.chain.time += 60;
    expect((await e.tick()).kill).toEqual([]); // not yet: the verify pass runs every 300 s
    expect(w.chain.openOrders(w.strikes[0].market, MAKER.address).map((o) => o.id)).toEqual([stray]);
    w.chain.time += 300;
    const v = await e.tick();
    expect(v.kill).toEqual([{ key: `RCSS:${w.date}`, cancelled: 1, leftOpen: 0, mode: "live" }]);
    expect(w.chain.openOrders(w.strikes[0].market, MAKER.address)).toEqual([]);
  });
});

describe("re-quote spend: guard-wide hysteresis (fair.guardWarnExit 0.13) and requoteTicks 3 (config/worker.json)", () => {
  // Polymarket fair and v0 guard: equal on every strike except >=30, so only >=30 can get a guard flag
  const data = (f30: number, g30: number) => stubData({ ...PM, 30: f30 }, { max: null }, { ...PM, 30: g30 });
  const live = async (w: ReturnType<typeof world>) => {
    await armed(w);
    w.api.snapshot = macSnapshot(w, 3600); // the Mac stopped an hour ago
  };

  it("live: enters the wide spread above 0.15, keeps it while |fair - guard| >= 0.13, leaves it below; a 2-tick move is not re-quoted", async () => {
    const w = world();
    await live(w);
    const tick = async (f30: number, g30: number) => {
      w.chain.time += 60;
      return w.engine({ MAKER_MODE: "live" }, data(f30, g30)).tick();
    };
    const s30 = () => w.engine().loadState("live").ladders[`RCSS:${w.date}`].series[30];
    const v30 = (r: Awaited<ReturnType<typeof tick>>) => r.ladders[0].strikes.find((k) => k.k === 30)!;
    // |0.47 - 0.63| = 0.16 > 0.15: the adopted 0.44/0.51 quote is re-placed wide, and the flag is stored with it
    let r = await tick(0.47, 0.63);
    expect(r.mode).toBe("live");
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 100@0.41 / 100@0.53 cancel 2"]);
    expect(s30().lastQuote).toMatchObject({ bid: 0.41, ask: 0.53, fair: 0.47, wide: true });
    // 0.14, between the thresholds: held (without the hysteresis this re-quotes back to 0.44/0.50: the Oct 9 flip-flop)
    r = await tick(0.47, 0.61);
    expect(r.txs).toEqual([]);
    expect(v30(r)).toMatchObject({ action: "none", flags: ["guard-wide", "guard-wide-held"], desired: { bid: 0.41, ask: 0.53 } });
    r = await tick(0.47, 0.6);
    expect(r.txs).toEqual([]);
    // 0.12 < 0.13: narrow again
    r = await tick(0.47, 0.59);
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 100@0.44 / 100@0.5 cancel 2"]);
    expect(s30().lastQuote).toMatchObject({ bid: 0.44, ask: 0.5, wide: false });
    // 0.14 again, but the resting quote is narrow now: the 0.15 entry threshold applies
    r = await tick(0.47, 0.61);
    expect(r.txs).toEqual([]);
    expect(v30(r).flags).toEqual([]);
    // requoteTicks 3: fair +0.02 (desired 0.46/0.52) is not worth a re-quote ...
    r = await tick(0.49, 0.49);
    expect(r.txs).toEqual([]);
    expect(v30(r)).toMatchObject({ action: "none", desired: { bid: 0.46, ask: 0.52 } });
    // ... a 3-tick move of the desired ask is
    r = await tick(0.497, 0.497);
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 100@0.46 / 100@0.53 cancel 2"]);
    expect(v30(r).reasons).toEqual(["ask 0.5 -> 0.53"]);
    // the urgent rule is unaffected: the fair through the resting ask re-quotes at once (0.53 <= 0.535, a 0.008 move)
    r = await tick(0.535, 0.535);
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 100@0.5 / 100@0.57 cancel 2"]);
    expect(v30(r).reasons[0]).toBe("resting ask 0.53 <= fair 0.535");
    expect(w.chain.sent.filter((t) => t.functionName === "batchUpdate")).toHaveLength(4);
  });

  it("control: without the exit threshold (fair.guardWarnExit null) the same path flip-flops, one re-quote per flip", async () => {
    const w = world();
    await live(w);
    const tick = async (g30: number) => {
      w.chain.time += 60;
      return w.engine({ MAKER_MODE: "live", CONFIG_OVERRIDES: '{"fair":{"guardWarnExit":null}}' }, data(0.47, g30)).tick();
    };
    const labels: string[] = [];
    for (const g of [0.63, 0.61, 0.63, 0.61]) labels.push(...(await tick(g)).txs.map((t) => t.label));
    expect(labels).toEqual(["requote >=30 100@0.41 / 100@0.53 cancel 2", "requote >=30 100@0.44 / 100@0.5 cancel 2", "requote >=30 100@0.41 / 100@0.53 cancel 2", "requote >=30 100@0.44 / 100@0.5 cancel 2"]);
  });

  it("a lastQuote without the wide flag (adopted from the books or imported from the Mac's state.json) keeps the plain 0.15 threshold", async () => {
    const w = world();
    // the Mac's >=30 quote is the wide one (0.41/0.53, placed when |fair - guard| was above 0.15)
    const m30 = w.strikes[1];
    w.chain.apply(MAKER.address, m30.market, encodeFunctionData({ abi: kuruBookAbi, functionName: "batchCancelOrdersNoRevert", args: [[w.macOrders[30].bid, w.macOrders[30].ask]] }));
    w.chain.place(m30.market, MAKER.address, 0.41, 100, true);
    w.chain.place(m30.market, MAKER.address, 0.53, 100, false);
    await live(w);
    // |0.47 - 0.61| = 0.14: nothing says the resting quote is wide, so it is narrowed, exactly as before the change
    const r = await w.engine({ MAKER_MODE: "live" }, data(0.47, 0.61)).tick();
    expect(r.txs.map((t) => t.label)).toEqual(["requote >=30 100@0.44 / 100@0.5 cancel 2"]);
    expect(w.engine().loadState("live").ladders[`RCSS:${w.date}`].series[30].lastQuote).toMatchObject({ wide: false });
  });
});
