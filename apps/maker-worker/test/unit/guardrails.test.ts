// Liveness guardrails of the settlement watcher (the CRE settlement itself still runs off-Cloudflare) and the optional
// alert push, against the fake chain:
//   - SETTLEMENT OVERDUE: gate edges at day end + SETTLE_OVERDUE_SEC, hourly dedupe, OVERDUE CLEARED once a result
//     lands, nothing more after that;
//   - automatic stale void: nothing before Resolver.staleAt; at staleAt, LIVE sends voidIfStale from the operator key
//     (gas = estimate x 1.10) exactly once; held while the Resolver is paused (even past day end + 7 d); SHADOW only
//     records an intent; at most one attempt per ladder per hour; the live operator key refused on a fork;
//     AUTO_STALE_VOID=0, the void meter and an unfunded operator alert instead of sending;
//   - the engine: a live tick logs and meters the void tx; a shadow tick sends nothing;
//   - push: ntfy / Telegram / JSON requests, per-title rate limit, failures and timeouts never break a tick, an
//     invalid URL is ignored without being echoed.
import { stringToHex, type Address } from "viem";
import { describe, expect, it } from "vitest";
import deployments from "../../../../deployments/testnet.json";
import { parseWebhook, pushAlerts, pushRequest, type Webhook } from "../../src/alert-push.ts";
import { NonceTracker } from "../../src/nonces.ts";
import { MemStore } from "../../src/store.ts";
import { STALE_WINDOW_SEC, watchPass, type VoidTx, type WatchDeps } from "../../src/watcher.ts";
import { D, FakeChain } from "./fake-chain.ts";
import { fixtureSources, GUARDIAN, macSnapshot, MAKER, OPERATOR, world } from "./helpers.ts";

const LIVE_OPERATOR = deployments.roles.operator as Address;
const b4 = (s: string) => stringToHex(s, { size: 4 });
const KEY = "RCSS:20261005";

/** A world whose vault also holds RCSS 2026-10-05 (recorded archives settle it at 29), with no result yet. */
function past() {
  const w = world();
  const c = w.chain;
  c.addLadder("RCSS", 20261005, [29, 30], 0, MAKER.address);
  const end = Number(c.read(D.resolver, "dayEnd", [b4("RCSS"), 20261005]));
  return { w, c, end };
}

function deps(chain: FakeChain, over: Partial<WatchDeps> = {}) {
  const store = new MemStore();
  const alerts: { title: string; body: string }[] = [];
  const voidTxs: VoidTx[] = [];
  const d: WatchDeps = {
    pub: chain.publicClient(),
    store,
    resolver: D.resolver,
    vault: D.vault,
    stations: ["RCSS", "RJTT"],
    liveRpc: true,
    liveGuardian: D.guardian,
    live: false,
    guardian: GUARDIAN,
    autoChallenge: true,
    lookbackBlocks: 4000,
    recheckSec: 0,
    backstopSec: 0,
    gasMult: 1.1,
    sources: fixtureSources(),
    wallet: chain.wallet() as any,
    nonces: new NonceTracker(store, () => chain.time * 1000),
    operator: OPERATOR,
    liveOperator: LIVE_OPERATOR,
    overdueSec: 10_800,
    overdueRepeatSec: 3600,
    autoStaleVoid: true,
    onVoidTx: (t) => voidTxs.push(t),
    alert: (title, body) => alerts.push({ title, body }),
    log: () => {},
    sleep: async () => {},
    now: () => chain.time * 1000,
    ...over,
  };
  return { d, alerts, voidTxs, titles: () => alerts.map((a) => a.title) };
}
const at = (c: FakeChain, t: number) => {
  c.time = t;
  c.mine(1, 0);
};
const result = (c: FakeChain) => c.results.get(`${b4("RCSS").toLowerCase()}:20261005`);

describe("SETTLEMENT OVERDUE alert", () => {
  it("fires only after day end + 3 h, repeats at most hourly, clears once settled and stays quiet after", async () => {
    const { c, end } = past();
    const { d, alerts, titles } = deps(c);
    at(c, end + 10_800);
    let r = await watchPass(d);
    expect(titles()).toEqual([]); // exactly day end + 3 h: not yet
    expect(r.overdue).toEqual([]);
    at(c, end + 10_801);
    r = await watchPass(d);
    expect(titles()).toEqual([`SETTLEMENT OVERDUE ${KEY}`]);
    expect(r.overdue).toEqual([{ key: KEY, hoursLate: 3, staleAt: end + STALE_WINDOW_SEC }]);
    expect(alerts[0].body).toMatch(/No result on the Resolver 3\.0 h after the local day end \(2026-10-05T16:00:00Z\)/);
    expect(alerts[0].body).toMatch(/Stale void: allowed from 2026-10-07T16:00:00Z; this Worker then sends Resolver.voidIfStale/);
    at(c, end + 10_801 + 600);
    await watchPass(d);
    at(c, end + 10_801 + 3599);
    await watchPass(d);
    expect(titles()).toHaveLength(1); // deduped within the hour
    at(c, end + 10_801 + 3600);
    await watchPass(d);
    expect(titles()).toEqual([`SETTLEMENT OVERDUE ${KEY}`, `SETTLEMENT OVERDUE ${KEY}`]);
    // the CRE result lands (the rule settles 29): cleared, and the watcher recomputes it as usual
    c.resolve("RCSS", 20261005, 29);
    r = await watchPass(d);
    expect(titles().at(-1)).toBe(`OVERDUE CLEARED ${KEY}`);
    expect(alerts.at(-1)!.body).toMatch(/^Settled 29 C at .*, 4\.0 h after the local day end \(2 overdue alert\(s\) before\)/);
    expect(r.verdicts.find((v) => v.key === KEY)?.verdict).toBe("MATCH");
    at(c, end + 30 * 3600);
    r = await watchPass(d);
    expect(titles()).toHaveLength(3);
    expect(r.overdue).toEqual([]);
    expect(c.sent).toEqual([]);
  });

  it("a ladder still unresolved more than 14 days after its day end keeps the hourly cadence (not one alert per backstop)", async () => {
    const { c, end } = past();
    c.paused = true; // a long pause: the Worker holds the void, the ladder stays unresolved
    const { d, titles: all } = deps(c, { live: true, backstopSec: 600 });
    const titles = () => all().filter((t) => t.endsWith(KEY)); // the world's other ladder is overdue too
    const t0 = end + 15 * 86_400;
    at(c, t0);
    await watchPass(d);
    expect(titles()).toEqual([`SETTLEMENT OVERDUE ${KEY}`, `STALE VOID HELD ${KEY}`]);
    at(c, t0 + 600); // the next backstop scan sees the ladder again
    await watchPass(d);
    at(c, t0 + 1200);
    await watchPass(d);
    expect(titles()).toHaveLength(2);
    at(c, t0 + 3600);
    await watchPass(d);
    expect(titles()).toEqual([`SETTLEMENT OVERDUE ${KEY}`, `STALE VOID HELD ${KEY}`, `SETTLEMENT OVERDUE ${KEY}`, `STALE VOID HELD ${KEY}`]);
    expect(d.store.get<any>("watch:state").overdue[KEY]).toMatchObject({ alerts: 2 });
    expect(c.sent).toEqual([]);
  });
});

describe("automatic stale void", () => {
  it("LIVE: nothing before staleAt; at staleAt one voidIfStale from the operator key (estimate x 1.10), then STALE-VOID", async () => {
    const { c, end } = past();
    const { d, alerts, voidTxs, titles } = deps(c, { live: true });
    at(c, end + STALE_WINDOW_SEC - 1);
    let r = await watchPass(d);
    expect(c.sent).toEqual([]);
    expect([r.voids, r.intents]).toEqual([[], []]);
    expect(titles()).toEqual([`SETTLEMENT OVERDUE ${KEY}`]);
    expect(alerts[0].body).toMatch(/past the workflow's 46 h backstop/);
    at(c, end + STALE_WINDOW_SEC);
    r = await watchPass(d);
    const gas = BigInt(Math.ceil(52_000 * 1.1));
    expect(c.sent.map((t) => [t.functionName, t.from, t.gas, t.nonce, t.args])).toEqual([["voidIfStale", OPERATOR.address, gas, 0, [b4("RCSS"), 20261005]]]);
    expect(r.voids).toEqual([{ key: KEY, outcome: "voided", ok: true, hash: c.sent[0].hash }]);
    expect(r.intents).toEqual([{ key: KEY, what: `Resolver.voidIfStale(${b4("RCSS")}, 20261005) from ${OPERATOR.address}`, gasLimit: String(gas) }]);
    expect(result(c)).toMatchObject({ status: 2, tmaxC: 0, sourcesHash: `0x${"00".repeat(32)}` });
    expect(titles().at(-1)).toBe(`STALE VOIDED ${KEY}`);
    expect(alerts.at(-1)!.body).toMatch(/pays 0\.5\/0\.5; redemption is open\. No CRE result had landed 48\.0 h after the local day end/);
    expect(voidTxs).toEqual([expect.objectContaining({ label: `voidIfStale ${KEY}`, role: "operator", from: OPERATOR.address, gasLimit: gas, status: "success", mon: expect.closeTo(Number(gas) * 102e-9, 12) })]);
    expect(d.store.get<any>(`nonce:${OPERATOR.address.toLowerCase()}`)).toMatchObject({ next: 1, inflight: {}, lastMined: { nonce: 0 } });
    // the next pass reads the LadderResolved(Void, sourcesHash 0) event: a stale void, final; nothing else is sent
    at(c, end + STALE_WINDOW_SEC + 120);
    r = await watchPass(d);
    expect(r.verdicts.map((v) => [v.key, v.verdict])).toEqual([[KEY, "STALE-VOID"]]);
    expect(r.overdue).toEqual([]);
    expect(c.sent).toHaveLength(1);
    expect(titles().filter((t) => /CLEARED/.test(t))).toEqual([]); // the STALE VOIDED alert said it
  });

  it("refuses while the Resolver is paused, even once day end + 7 d allows anyone to void", async () => {
    const { c, end } = past();
    c.paused = true;
    const { d, alerts, titles } = deps(c, { live: true });
    at(c, end + STALE_WINDOW_SEC + 10);
    let r = await watchPass(d);
    expect(r.overdue[0].staleAt).toBe(end + 7 * 86_400); // paused: staleAt is the 7-day hard bound
    expect(alerts[0].body).toMatch(/the Resolver is PAUSED, so voidIfStale is blocked until 2026-10-12T16:00:00Z/);
    expect(r.voids).toEqual([]);
    at(c, end + 7 * 86_400);
    r = await watchPass(d);
    expect(r.voids).toEqual([{ key: KEY, outcome: "held: the Resolver is paused", ok: false }]);
    expect(titles()).toContain(`STALE VOID HELD ${KEY}`);
    at(c, end + 7 * 86_400 + 1800);
    r = await watchPass(d);
    expect(r.voids).toEqual([]); // once per hour
    expect(c.sent).toEqual([]);
    expect(c.calls.sims).toBe(0); // not even simulated
  });

  it("SHADOW never sends: it simulates, records the intent and alerts, at most once per hour", async () => {
    const { c, end } = past();
    const { d, titles } = deps(c, { live: false });
    at(c, end + STALE_WINDOW_SEC + 60);
    let r = await watchPass(d);
    expect(r.intents).toEqual([expect.objectContaining({ key: KEY, gasLimit: String(Math.ceil(52_000 * 1.1)) })]);
    expect(r.voids).toEqual([{ key: KEY, outcome: "shadow mode: not sent (would send it now)", ok: false }]);
    expect(titles()).toEqual([`SETTLEMENT OVERDUE ${KEY}`, `STALE VOID DUE ${KEY} (shadow: not sent)`]);
    at(c, end + STALE_WINDOW_SEC + 60 + 1800);
    r = await watchPass(d);
    expect([r.intents, r.voids]).toEqual([[], []]);
    at(c, end + STALE_WINDOW_SEC + 60 + 3600);
    r = await watchPass(d);
    expect(r.voids).toHaveLength(1);
    expect(c.sent).toEqual([]);
    expect(result(c)).toBeUndefined();
  });

  it("a mined void is logged and metered even if the read-back after the receipt fails; no second send within the hour", async () => {
    const { c, end } = past();
    const base = c.publicClient();
    let hiccups = 0;
    const pub = {
      ...base,
      readContract: async (a: any) => {
        // the read-back of this ladder right after the receipt fails once
        if (a.functionName === "resultOf" && a.args?.[1] === 20261005 && c.sent.length && hiccups++ === 0) throw new Error("rpc hiccup");
        return (base as any).readContract(a);
      },
    } as any;
    const { d, voidTxs, titles } = deps(c, { live: true, pub });
    at(c, end + STALE_WINDOW_SEC);
    const r = await watchPass(d);
    expect(c.sent.map((t) => t.functionName)).toEqual(["voidIfStale"]);
    expect(voidTxs).toEqual([expect.objectContaining({ label: `voidIfStale ${KEY}`, status: "success" })]);
    expect(r.voids).toEqual([expect.objectContaining({ key: KEY, ok: false, hash: c.sent[0].hash, outcome: expect.stringMatching(/rpc hiccup/) })]);
    expect(titles().at(-1)).toBe(`STALE VOID FAILED ${KEY}`);
    expect(d.store.get<any>("watch:state").voidSpend).toMatchObject({ n: 1 });
    at(c, end + STALE_WINDOW_SEC + 1800);
    const r2 = await watchPass(d); // the void landed: read as a stale void, nothing re-sent
    expect(r2.verdicts.find((v) => v.key === KEY)?.verdict).toBe("STALE-VOID");
    expect(c.sent).toHaveLength(1);
  });

  it("a refused simulation is retried after an hour, not before", async () => {
    const { c, end } = past();
    const { d, alerts, titles } = deps(c, { live: true });
    c.revertOn.add("voidIfStale");
    at(c, end + STALE_WINDOW_SEC);
    let r = await watchPass(d);
    expect(r.voids[0].outcome).toMatch(/^simulation reverted: voidIfStale reverted \(fake\)/);
    expect(titles().at(-1)).toBe(`STALE VOID REFUSED ${KEY}`);
    expect(alerts.at(-1)!.body).toMatch(/Nothing sent; retried in 60 min/);
    c.revertOn.clear();
    at(c, end + STALE_WINDOW_SEC + 1800);
    r = await watchPass(d);
    expect([r.voids, c.sent]).toEqual([[], []]);
    at(c, end + STALE_WINDOW_SEC + 3600);
    r = await watchPass(d);
    expect(r.voids).toEqual([expect.objectContaining({ outcome: "voided", ok: true })]);
    expect(c.sent).toHaveLength(1);
  });

  it("alerts instead of sending: the LIVE operator key on a fork, AUTO_STALE_VOID=0, the void meter, an unfunded operator, no key", async () => {
    const cases: [Partial<WatchDeps>, (c: FakeChain) => void, RegExp, string][] = [
      [{ liveRpc: false, liveOperator: OPERATOR.address }, () => {}, /^not sent: REFUSED: the LIVE operator key on a non-live RPC$/, "STALE VOID NOT SENT"],
      [{ autoStaleVoid: false }, () => {}, /^AUTO_STALE_VOID=0: not sent$/, "STALE VOID DUE"],
      [{}, (c) => (c.gasPrice = 2_000_000_000_000n), /^not sent: void meter 0\.0000 \+ 0\.1144 MON > 0\.05 MON\/day$/, "STALE VOID NOT SENT"],
      [{}, (c) => c.mon.set(OPERATOR.address.toLowerCase(), 1_000_000_000_000_000n), /^not sent: operator 0x[0-9a-fA-F]{40} holds 0\.001 MON < 0\.007834502 MON$/, "STALE VOID NOT SENT"],
      [{ operator: null }, () => {}, /^not sent: no OPERATOR_KEY secret$/, "STALE VOID NOT SENT"],
    ];
    for (const [over, setup, outcome, title] of cases) {
      const { c, end } = past();
      setup(c);
      const { d, titles } = deps(c, { live: true, ...over });
      at(c, end + STALE_WINDOW_SEC);
      const r = await watchPass(d);
      expect(r.voids).toEqual([{ key: KEY, outcome: expect.stringMatching(outcome), ok: false }]);
      expect(titles().at(-1)).toBe(`${title} ${KEY}`);
      expect(c.sent).toEqual([]);
    }
  });
});

describe("the engine wiring", () => {
  const armedLive = (w: ReturnType<typeof world>) => {
    w.kv.m.set("control", JSON.stringify({ seq: 1, live: true, confirm: MAKER.address }));
    w.api.snapshot = macSnapshot(w, 3600); // the Mac stopped an hour ago
  };

  it("LIVE: voids a stale vault ladder from the operator key, logs the tx and meters it on the operator", async () => {
    const { w } = past(); // the world's chain time is days after 2026-10-07 16:00Z (staleAt)
    armedLive(w);
    const e = w.engine({ MAKER_MODE: "live" });
    const r = await e.tick();
    expect(r.mode).toBe("live");
    expect(r.errors).toEqual([]);
    expect(w.chain.sent.map((t) => [t.functionName, t.from])).toEqual([["voidIfStale", OPERATOR.address]]);
    expect(r.txs).toEqual([expect.objectContaining({ label: `voidIfStale ${KEY}`, role: "operator", status: "success" })]);
    expect(r.alerts).toEqual([`SETTLEMENT OVERDUE ${KEY}`, `STALE VOIDED ${KEY}`]);
    expect((r.watcher as any).voids).toEqual([expect.objectContaining({ key: KEY, ok: true })]);
    expect(w.store.tail<any>("txs:live", 5)).toEqual([expect.objectContaining({ label: `voidIfStale ${KEY}`, kind: "void", role: "operator" })]);
    expect(e.loadState("live").budget.spent.operator).toBeCloseTo(Math.ceil(52_000 * 1.1) * 102e-9, 9);
    expect(w.kv.json("status").watcher.staleVoids[KEY]).toMatchObject({ outcome: "voided" });
    expect(w.kv.json("status").push).toEqual({ channel: "off (no ALERT_WEBHOOK_URL secret)" });
  });

  it("SHADOW (and the interlock) never send: the void is an intent", async () => {
    const { w } = past();
    w.kv.m.set("control", JSON.stringify({ seq: 1, live: true, confirm: MAKER.address }));
    w.api.snapshot = macSnapshot(w, 30); // another writer is active: live is held back
    const r = await w.engine({ MAKER_MODE: "live" }).tick();
    expect(r.mode).toBe("shadow");
    expect(r.alerts).toEqual(["live mode blocked: another writer is active", `SETTLEMENT OVERDUE ${KEY}`, `STALE VOID DUE ${KEY} (shadow: not sent)`]);
    expect((r.watcher as any).intents).toEqual([expect.objectContaining({ key: KEY })]);
    expect(w.chain.sent).toEqual([]);
  });
});

describe("alert push (ALERT_WEBHOOK_URL)", () => {
  type Call = { url: string; init: RequestInit };
  const stubFetch = (impl?: (c: Call) => Promise<Response>) => {
    const calls: Call[] = [];
    const f = async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return impl ? impl({ url: String(url), init }) : new Response("ok", { status: 200 });
    };
    return Object.assign(f, { calls });
  };

  it("builds ntfy, Telegram and plain JSON requests; refuses bad URLs without echoing them", () => {
    const ntfy = parseWebhook("https://ntfy.sh/isotherm-alerts-example", false);
    expect(ntfy).toMatchObject({ kind: "ntfy" });
    const n = pushRequest(ntfy as any, "SETTLEMENT OVERDUE RCSS:20261005 °", "body");
    expect(n.init.headers).toMatchObject({ Title: "SETTLEMENT OVERDUE RCSS:20261005 ?" });
    expect(n.init.body).toBe("body");
    const tg = parseWebhook("https://api.telegram.org/bot123:abc/sendMessage?chat_id=42", false);
    expect(JSON.parse(String(pushRequest(tg as any, "T", "B").init.body))).toEqual({ chat_id: "42", text: "T\n\nB", disable_web_page_preview: true });
    const js = parseWebhook("https://hooks.example.org/x", false);
    expect(JSON.parse(String(pushRequest(js as any, "T", "B").init.body))).toEqual({ title: "T", body: "B", text: "T\nB" });
    for (const [raw, loop] of [
      ["http://hooks.example.org/x", true],
      ["http://127.0.0.1:19801/hook", false],
      ["https://api.telegram.org/bot123:abc/sendMessage", false],
      ["https://user:pw@hooks.example.org/x", false],
      ["not a url", false],
    ] as const) {
      const r = parseWebhook(raw, loop) as { error: string };
      expect(r.error).toMatch(/^ALERT_WEBHOOK_URL/);
      expect(r.error).not.toContain("example.org");
      expect(r.error).not.toContain("abc");
    }
    expect(parseWebhook("http://127.0.0.1:19801/hook", true)).toMatchObject({ kind: "json" });
    expect(parseWebhook(undefined, false)).toBeNull();
  });

  it("pushes each alert once per title per ALERT_PUSH_MIN_SEC; never breaks a tick on failure or timeout", async () => {
    const w = world();
    w.kv.m.set("control", JSON.stringify({ seq: 1, live: true, confirm: MAKER.address }));
    w.api.snapshot = macSnapshot(w, 30); // the interlock alert repeats every tick
    const keys = { maker: "0x" + "11".repeat(32), operator: "0x" + "22".repeat(32), alertWebhook: "https://ntfy.sh/isotherm-alerts-example" };
    const f = stubFetch();
    const mk = (fetch: any, timeout?: number) => {
      const e = w.engine({ MAKER_MODE: "live" }, undefined, keys);
      (e as any).deps.fetch = fetch;
      (e as any).deps.pushTimeoutMs = timeout;
      return e;
    };
    let r = await mk(f).tick();
    expect(r.push).toEqual([{ title: "live mode blocked: another writer is active", result: "sent 200" }]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://ntfy.sh/isotherm-alerts-example");
    expect(f.calls[0].init).toMatchObject({ method: "POST", redirect: "manual", headers: { Title: "live mode blocked: another writer is active" } });
    w.chain.time += 60;
    w.api.snapshot = macSnapshot(w, 30);
    r = await mk(f).tick();
    expect(r.push).toEqual([{ title: "live mode blocked: another writer is active", result: "rate-limited" }]);
    expect(f.calls).toHaveLength(1);
    // an hour later: due again, but the endpoint fails -> logged, the tick is fine
    w.chain.time += 3600;
    w.api.snapshot = macSnapshot(w, 30);
    r = await mk(stubFetch(async () => Promise.reject(new TypeError("network down at https://ntfy.sh/isotherm-alerts-example")))).tick();
    expect(r.push).toEqual([{ title: "live mode blocked: another writer is active", result: "failed: TypeError" }]);
    expect(r.errors).toEqual([]);
    // another hour later: the endpoint hangs -> aborted after the timeout
    w.chain.time += 3600;
    w.api.snapshot = macSnapshot(w, 30);
    const hang = stubFetch(({ init }) => new Promise((_, rej) => (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted")))));
    r = await mk(hang, 20).tick();
    expect(r.push).toEqual([{ title: "live mode blocked: another writer is active", result: "failed: timeout after 20 ms" }]);
    expect(r.errors).toEqual([]);
    const status = w.kv.json("status");
    expect(status.push.channel).toBe("ntfy");
    expect(status.push.last.map((p: any) => p.result)).toEqual(["sent 200", "rate-limited", "failed: TypeError", "failed: timeout after 20 ms"]);
    expect(JSON.stringify(status)).not.toContain("isotherm-alerts-example"); // the URL is never in the outbox
    expect(JSON.stringify(w.kv.json("tick:last"))).not.toContain("isotherm-alerts-example");
  });

  it("an hourly repeat (chain time) that lands a few seconds early by the wall clock is still pushed", async () => {
    const store = new MemStore();
    const hook = parseWebhook("https://ntfy.sh/isotherm-alerts-example", false) as Webhook;
    const f = stubFetch();
    let t = Date.parse("2026-10-09T19:00:40Z");
    const run = () => pushAlerts({ store, hook, minSec: 3600, now: () => t, fetch: f as any }, [{ title: `SETTLEMENT OVERDUE ${KEY}`, body: "b" }]);
    expect(await run()).toEqual([{ title: `SETTLEMENT OVERDUE ${KEY}`, result: "sent 200" }]);
    t += 120_000; // the next watcher pass: deduped upstream anyway, and rate-limited here
    expect(await run()).toEqual([{ title: `SETTLEMENT OVERDUE ${KEY}`, result: "rate-limited" }]);
    t += 3_600_000 - 120_000 - 9_000; // the hourly repeat, 9 s early by the wall clock (a shorter tick)
    expect(await run()).toEqual([{ title: `SETTLEMENT OVERDUE ${KEY}`, result: "sent 200" }]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].init).toMatchObject({ method: "POST", body: "b", headers: { Title: `SETTLEMENT OVERDUE ${KEY}` } });
  });

  it("control test-alert raises one TEST ALERT on the next tick and pushes it (Telegram)", async () => {
    const w = world();
    const e = w.engine({}, undefined, { maker: "0x" + "11".repeat(32), operator: "0x" + "22".repeat(32), alertWebhook: "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42" });
    const f = stubFetch();
    (e as any).deps.fetch = f;
    w.kv.m.set("control", JSON.stringify({ seq: 7, testAlert: true }));
    const r = await e.tick();
    expect(r.control).toBe("test alert raised");
    expect(r.alerts).toEqual(["TEST ALERT 7 (isotherm-maker)"]);
    expect(r.push).toEqual([{ title: "TEST ALERT 7 (isotherm-maker)", result: "sent 200" }]);
    expect(JSON.parse(String(f.calls[0].init.body))).toMatchObject({ chat_id: "42", text: expect.stringMatching(/^TEST ALERT 7 \(isotherm-maker\)\n\nRaised on request/) });
    const again = await e.tick();
    expect(again.alerts).toEqual([]); // once per control document
  });

  it("an invalid ALERT_WEBHOOK_URL is ignored (alerts stay in KV) and the status says so without the URL", async () => {
    const w = world();
    const e = w.engine({}, undefined, { maker: "0x" + "11".repeat(32), operator: "0x" + "22".repeat(32), alertWebhook: "http://hooks.example.org/secret-path" });
    const f = stubFetch();
    (e as any).deps.fetch = f;
    const r = await e.tick();
    expect(r.push).toEqual([]);
    expect(f.calls).toEqual([]);
    const status = w.kv.json("status");
    expect(status.push.channel).toBe("invalid ALERT_WEBHOOK_URL, ignored (ALERT_WEBHOOK_URL must be https://)");
    expect(JSON.stringify(status)).not.toContain("secret-path");
  });
});

