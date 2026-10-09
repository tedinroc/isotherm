// The treasury top-up (src/treasury.ts) against the fake chain: the key gates, top-up sizing, the per-role / global
// daily caps and the floor, live-only sending through the nonce tracker, the LOW alerts (also without any key), and
// the engine wiring (every treasury.everySec; status shows it).
import { parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { NonceTracker } from "../../src/nonces.ts";
import { MemStore } from "../../src/store.ts";
import { keyProblem, parseTreasuryCfg, treasuryPass, type TreasuryCfg } from "../../src/treasury.ts";
import { FakeChain } from "./fake-chain.ts";
import { macSnapshot, MAKER, TREASURY_CFG, world } from "./helpers.ts";

// throwaway keys, unit tests only (never funded anywhere)
const TKEY = "0x4444444444444444444444444444444444444444444444444444444444444444" as const;
const TREASURY = privateKeyToAccount(TKEY);
const OTHER = privateKeyToAccount("0x5555555555555555555555555555555555555555555555555555555555555555");
const R = (n: number) => `0x${String(n).repeat(40)}`.slice(0, 42) as Address;
const ROLES = { maker: R(1), operator: R(2), relayer: R(3), attester: R(6), guardian: R(7) };

const cfg = (over: Partial<TreasuryCfg> = {}): TreasuryCfg =>
  parseTreasuryCfg({
    address: TREASURY.address,
    everySec: 600,
    floorMon: 2,
    lowAlertMon: 10,
    globalDailyCapMon: 6,
    minSendMon: 0.05,
    alertRepeatSec: 3600,
    roles: {
      maker: { address: ROLES.maker, minMon: 1.5, targetMon: 4, dailyCapMon: 4 },
      operator: { address: ROLES.operator, minMon: 1.2, targetMon: 2.5, dailyCapMon: 1.5 },
      relayer: { address: ROLES.relayer, minMon: 3, targetMon: 8, dailyCapMon: 3 },
      attester: { address: ROLES.attester, minMon: 0.3, targetMon: 0.8, dailyCapMon: 0.5 },
      guardian: { address: ROLES.guardian, minMon: 0.05, targetMon: 0.15, dailyCapMon: 0.2 },
    },
    ...over,
  })!;

function setup(bal: Partial<Record<keyof typeof ROLES | "treasury", string>> = {}) {
  const chain = new FakeChain(1_791_600_000);
  const balances = { treasury: "50", maker: "3", operator: "2", relayer: "5", attester: "0.5", guardian: "0.1", ...bal };
  chain.mon.set(TREASURY.address.toLowerCase(), parseEther(balances.treasury));
  for (const [k, a] of Object.entries(ROLES)) chain.mon.set(a.toLowerCase(), parseEther(balances[k as keyof typeof ROLES]));
  const store = new MemStore();
  const alerts: string[] = [];
  const nonces = new NonceTracker(store, () => chain.time * 1000);
  const deps = (o: Partial<Parameters<typeof treasuryPass>[0]> = {}) => ({
    pub: chain.publicClient(),
    store,
    cfg: cfg(),
    live: true,
    key: TREASURY,
    liveRpc: true,
    liveTreasury: null,
    forbidden: [MAKER.address],
    wallet: chain.wallet(),
    chain: {},
    nonces,
    dayUtcOffsetMin: 480,
    alert: (t: string) => alerts.push(t),
    log: () => {},
    sleep: async () => {
      chain.mine(); // a block passes while the pass waits for the 5-block spacing
    },
    now: () => chain.time * 1000,
    ...o,
  });
  const mon = (a: Address) => Number(chain.mon.get(a.toLowerCase()) ?? 0n) / 1e18;
  return { chain, store, alerts, deps, mon };
}

describe("treasury config and key gates", () => {
  it("validates the config; the bundled one has the five roles and their thresholds", () => {
    const c = parseTreasuryCfg(TREASURY_CFG)!;
    expect(Object.keys(c.roles)).toEqual(["maker", "operator", "relayer", "attester", "guardian"]);
    expect(Object.fromEntries(Object.entries(c.roles).map(([k, r]) => [k, [r.minMon, r.targetMon, r.dailyCapMon]]))).toEqual({ maker: [1.5, 4, 4], operator: [1.2, 2.5, 1.5], relayer: [3, 8, 3], attester: [0.3, 0.8, 0.5], guardian: [0.05, 0.15, 0.2] });
    expect([c.floorMon, c.lowAlertMon, c.everySec]).toEqual([2, 10, 600]);
    expect(parseTreasuryCfg(null)).toBeNull();
    expect(() => cfg({ roles: { maker: { address: ROLES.maker, minMon: 2, targetMon: 1, dailyCapMon: 1 } } as any })).toThrow(/targetMon must be above minMon/);
    expect(() => cfg({ roles: { maker: { address: TREASURY.address, minMon: 1, targetMon: 2, dailyCapMon: 1 } } as any })).toThrow(/repeats/);
    expect(() => cfg({ everySec: 10 })).toThrow(/everySec/);
  });
  it("refuses a key that is not the configured treasury, is a maker/owner key, a funded role, or the LIVE treasury on a fork", () => {
    const base = { cfg: cfg(), forbidden: [MAKER.address], liveRpc: true, liveTreasury: null };
    expect(keyProblem({ ...base, key: null })).toBe("no TREASURY_KEY secret");
    expect(keyProblem({ ...base, key: TREASURY })).toBeNull();
    expect(keyProblem({ ...base, key: OTHER })).toMatch(/^REFUSED: TREASURY_KEY is 0x.* not treasury.address/);
    expect(keyProblem({ ...base, cfg: cfg({ address: MAKER.address }), key: MAKER as any })).toMatch(/owner\/deployer or a maker role key/);
    expect(keyProblem({ ...base, liveRpc: false, liveTreasury: TREASURY.address, key: TREASURY })).toMatch(/LIVE treasury key on a non-live RPC/);
    expect(keyProblem({ ...base, liveRpc: false, liveTreasury: OTHER.address, key: TREASURY })).toBeNull(); // a throwaway treasury on a fork
  });
});

describe("treasury pass", () => {
  it("LIVE: tops each low role up to its target (gas limit 21,000, through the nonce tracker), alerts every top-up, meters the day", async () => {
    const t = setup({ maker: "1.2", guardian: "0.01" });
    const r = await treasuryPass(t.deps());
    expect(r.actions.map((a) => [a.role, a.amountMon, a.outcome])).toEqual([
      ["maker", 2.8, "sent"],
      ["guardian", 0.14, "sent"],
    ]);
    expect(t.chain.sent.map((x) => [x.from, x.to, x.gas, x.nonce, Number(x.value) / 1e18])).toEqual([
      [TREASURY.address, ROLES.maker, 21_000n, 0, 2.8],
      [TREASURY.address, ROLES.guardian, 21_000n, 1, 0.14],
    ]);
    expect(t.mon(ROLES.maker)).toBeCloseTo(4, 9);
    expect(t.mon(ROLES.guardian)).toBeCloseTo(0.15, 9);
    expect(t.alerts).toEqual(["TOPUP MAKER", "TOPUP GUARDIAN"]);
    expect(r.meter).toMatchObject({ sent: { maker: 2.8, guardian: 0.14 }, total: 2.94 });
    // Monad's reserve-balance rule: the second transfer waited until >= 5 blocks after the first
    const [b1, b2] = t.chain.sent.map((x) => t.chain.receipts.get(x.hash).blockNumber as bigint);
    expect(b2 - b1).toBeGreaterThanOrEqual(5n);
    expect(t.store.get<any>("treasury:state")).toMatchObject({ n: 2 });
    // nothing low any more: the next pass sends nothing
    const again = await treasuryPass(t.deps());
    expect(again.actions).toEqual([]);
    expect(t.chain.sent).toHaveLength(2);
  });

  it("per-role daily cap: a capped role alerts '<ROLE> LOW' (at most hourly) and is topped up again the next budget day", async () => {
    const t = setup({ relayer: "0.5" });
    let r = await treasuryPass(t.deps());
    expect(r.actions.map((a) => [a.role, a.needMon, a.amountMon, a.outcome])).toEqual([["relayer", 7.5, 3, "sent"]]); // cap 3
    expect(t.alerts).toEqual(["TOPUP RELAYER"]); // 3.5 MON is above its minimum 3
    t.chain.mon.set(ROLES.relayer.toLowerCase(), parseEther("1")); // drips spent it
    t.chain.mine(1, 600);
    r = await treasuryPass(t.deps());
    expect(r.actions[0].outcome).toMatch(/not sent: the relayer daily top-up cap 3 MON is used/);
    expect(t.alerts).toEqual(["TOPUP RELAYER", "RELAYER LOW"]);
    t.chain.mine(1, 600);
    await treasuryPass(t.deps()); // 10 min later: no repeat
    expect(t.alerts).toHaveLength(2);
    t.chain.mine(1, 3600);
    await treasuryPass(t.deps()); // an hour later: repeated
    expect(t.alerts).toEqual(["TOPUP RELAYER", "RELAYER LOW", "RELAYER LOW"]);
    t.chain.mine(1, 86_400); // the next Taipei day: the cap is fresh
    r = await treasuryPass(t.deps());
    expect(r.actions.map((a) => [a.role, a.amountMon, a.outcome])).toEqual([["relayer", 3, "sent"]]);
    expect(t.store.get<any>("treasury:state").history).toEqual([expect.objectContaining({ sent: { relayer: 3 }, total: 3 })]);
  });

  it("global daily cap and the treasury floor; 'TREASURY LOW' below 10 MON", async () => {
    const t = setup({ maker: "0", operator: "0.5" });
    let r = await treasuryPass(t.deps({ cfg: cfg({ globalDailyCapMon: 3 }) }));
    expect(r.actions.map((a) => [a.role, a.amountMon, a.outcome.split(":")[0]])).toEqual([
      ["maker", 3, "sent"], // needs 4, the global cap leaves 3
      ["operator", 0, "not sent"],
    ]);
    expect(r.actions[1].outcome).toMatch(/global daily top-up cap 3 MON is used/);
    expect(t.alerts).toEqual(["TOPUP MAKER", "OPERATOR LOW"]);
    // a treasury of 3 MON keeps its 2 MON floor (and the transfer gas): the maker gets just under 1 MON
    const u = setup({ treasury: "3", maker: "1", relayer: "1" });
    r = await treasuryPass(u.deps());
    expect(r.actions[0]).toMatchObject({ role: "maker", outcome: "sent" });
    expect(r.actions[0].amountMon).toBeCloseTo(1 - 21_000 * 102e-9, 5);
    expect(r.actions[1]).toMatchObject({ role: "relayer", amountMon: 0 });
    expect(r.actions[1].outcome).toMatch(/keeps a floor of 2/);
    expect(u.mon(TREASURY.address)).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(u.alerts).toEqual(["TREASURY LOW", "TOPUP MAKER", "RELAYER LOW"]);
  });

  it("without any TREASURY_KEY: no transfer, but the balance check and the '<ROLE> LOW' alerts still run", async () => {
    const t = setup({ maker: "0.4", attester: "0.1", treasury: "8" });
    const r = await treasuryPass(t.deps({ key: null }));
    expect(r.treasury.key).toBe("no TREASURY_KEY secret");
    expect(r.actions.map((a) => [a.role, a.outcome])).toEqual([
      ["maker", "not sent: no TREASURY_KEY secret"],
      ["attester", "not sent: no TREASURY_KEY secret"],
    ]);
    expect(t.chain.sent).toEqual([]);
    expect(t.alerts).toEqual(["TREASURY LOW", "MAKER LOW", "ATTESTER LOW"]);
  });

  it("SHADOW records intents only (and says the roles stay low); a refused key never sends", async () => {
    const t = setup({ maker: "0.4" });
    let r = await treasuryPass(t.deps({ live: false }));
    expect(r.actions.map((a) => [a.role, a.amountMon, a.outcome])).toEqual([["maker", 3.6, "intent (shadow: not sent)"]]);
    expect(t.chain.sent).toEqual([]);
    expect(t.alerts).toEqual(["MAKER LOW"]);
    r = await treasuryPass(t.deps({ key: OTHER }));
    expect(r.actions[0].outcome).toMatch(/not sent: REFUSED: TREASURY_KEY is/);
    expect(t.chain.sent).toEqual([]);
    expect(t.store.get<any>("treasury:state")).toMatchObject({ total: 0, n: 0 });
  });

  it("a refused broadcast gives the meter back; a recipient with code is never sent to", async () => {
    const t = setup({ maker: "0.4", operator: "0.2" });
    t.chain.refuseSends = 1;
    t.chain.codes.set(ROLES.operator.toLowerCase(), "0x6080");
    const r = await treasuryPass(t.deps());
    expect(r.actions.map((a) => [a.role, a.outcome.split(":")[0]])).toEqual([
      ["maker", "failed"],
      ["operator", "not sent"],
    ]);
    expect(r.actions[1].outcome).toMatch(/has code/);
    expect(t.chain.sent).toEqual([]);
    expect(t.store.get<any>("treasury:state")).toMatchObject({ total: 0, n: 0, sent: { maker: 0 } });
    expect(t.alerts).toEqual(["MAKER LOW", "OPERATOR LOW"]);
    // the nonce was not burned: the next pass uses nonce 0
    t.chain.mine(1, 3600);
    const again = await treasuryPass(t.deps());
    expect(again.actions[0]).toMatchObject({ role: "maker", outcome: "sent" });
    expect(t.chain.sent[0].nonce).toBe(0);
  });

  it("a top-up whose receipt is not confirmed stops the pass: the floor holds and nothing more is sent unspaced", async () => {
    // treasury 7, floor 2: the maker gets 3; had the pass gone on from the balance read before that transfer, the
    // relayer would get 3 more and the treasury would end near 1 MON, under its floor
    const t = setup({ treasury: "7", maker: "1", relayer: "1" });
    const pub = t.chain.publicClient();
    let lost = 1;
    const flaky = {
      ...pub,
      async waitForTransactionReceipt(a: { hash: `0x${string}` }) {
        if (lost-- > 0) throw new Error("Timed out while waiting for transaction");
        return pub.waitForTransactionReceipt(a);
      },
    };
    const r = await treasuryPass(t.deps({ pub: flaky as any }));
    expect(r.actions.map((a) => [a.role, a.outcome.split(":")[0]])).toEqual([
      ["maker", "sent, receipt not confirmed"],
      ["relayer", "not sent"],
    ]);
    expect(r.actions[1].outcome).toMatch(/has no receipt yet; the next pass re-reads the balances/);
    expect(t.chain.sent).toHaveLength(1);
    expect(t.mon(TREASURY.address)).toBeGreaterThanOrEqual(2);
    expect(r.meter).toMatchObject({ sent: { maker: 3 }, total: 3 }); // metered: a lost receipt never tops up twice beyond the caps
    // the next pass: the maker's balance shows the transfer, the relayer gets what the floor allows
    t.chain.mine(1, 600);
    const again = await treasuryPass(t.deps());
    expect(again.actions.map((a) => a.role)).toEqual(["relayer"]);
    expect(t.mon(TREASURY.address)).toBeGreaterThanOrEqual(2 - 1e-9);
  });
});

describe("treasury in the engine", () => {
  const OVER = JSON.stringify({ treasury: { address: TREASURY.address } });
  it("LIVE: tops up a low role every treasury.everySec from the TREASURY_KEY secret; status shows it", async () => {
    const w = world();
    w.kv.m.set("control", JSON.stringify({ seq: 1, live: true, confirm: MAKER.address }));
    w.api.snapshot = macSnapshot(w, 3600);
    const guardian = TREASURY_CFG.roles.guardian.address;
    w.chain.mon.set(guardian.toLowerCase(), parseEther("0.02"));
    w.chain.mon.set(TREASURY.address.toLowerCase(), parseEther("30"));
    const keys = { maker: "0x" + "11".repeat(32), operator: "0x" + "22".repeat(32), guardian: "0x" + "33".repeat(32), snapshotToken: "t", treasury: TKEY };
    const e = w.engine({ MAKER_MODE: "live", CONFIG_OVERRIDES: OVER }, undefined, keys);
    const r = await e.tick({ forceTreasury: true });
    expect(r.mode).toBe("live");
    expect(r.errors).toEqual([]);
    const sent = w.chain.sent.filter((x) => x.functionName === "(transfer)");
    expect(sent.map((x) => [x.from, x.to, x.gas, Number(x.value) / 1e18])).toEqual([[TREASURY.address, guardian, 21_000n, 0.13]]);
    expect(r.alerts).toContain("TOPUP GUARDIAN");
    expect(r.txs).toEqual(expect.arrayContaining([expect.objectContaining({ role: "treasury", label: "topup guardian 0.13 MON", status: "success" })]));
    expect(w.store.tail<any>("txs:live", 10).filter((x) => x.kind === "topup")).toEqual([expect.objectContaining({ role: "treasury", to: guardian, valueMon: 0.13 })]);
    expect(w.kv.json("status").treasury).toMatchObject({ mode: "live", key: "ok", address: TREASURY.address, today: { sent: { guardian: 0.13 } } });
    // within treasury.everySec (600 s): skipped
    w.chain.time += 60;
    const r2 = await e.tick();
    expect(r2.treasury).toMatchObject({ skipped: expect.stringMatching(/^next pass in/) });
  });

  it("a malformed TREASURY_KEY is ignored (no top-ups, reported), it never stops the maker", async () => {
    const w = world();
    const e = w.engine({}, undefined, { maker: "0x" + "11".repeat(32), operator: "0x" + "22".repeat(32), treasury: "0xnotakey" });
    const r = await e.tick();
    expect(r.errors).toEqual([]);
    expect(r.treasury).toMatchObject({ treasury: { key: "TREASURY_KEY secret is not a 32-byte hex private key: ignored, no top-ups" } });
    expect(w.kv.json("status").treasury.key).toMatch(/^TREASURY_KEY secret is not a 32-byte hex private key/);
    expect(JSON.stringify(w.kv.json("status"))).not.toContain("notakey");
  });

  it("SHADOW without a TREASURY_KEY: the role's LOW alert still fires, nothing is sent", async () => {
    const w = world();
    w.chain.mon.set(TREASURY_CFG.roles.attester.address.toLowerCase(), parseEther("0.05"));
    const r = await w.engine().tick();
    expect(r.mode).toBe("shadow");
    expect(r.treasury).toMatchObject({ mode: "shadow", treasury: { key: "no TREASURY_KEY secret" } });
    expect(r.alerts).toContain("ATTESTER LOW");
    expect(w.chain.sent).toEqual([]);
    expect(w.kv.json("status").treasury.actions).toEqual([expect.objectContaining({ role: "attester", outcome: "not sent: no TREASURY_KEY secret" })]);
  });
});
