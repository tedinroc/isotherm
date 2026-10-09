// Settings, config, nonce tracker and store: the small pieces the Durable Object relies on.
import { describe, expect, it } from "vitest";
import { workerConfig } from "../../src/config.ts";
import { settingsFrom, type Env } from "../../src/env.ts";
import { NonceTracker, STALE_MS } from "../../src/nonces.ts";
import { MemStore, stringify } from "../../src/store.ts";
import { meterKey, budgetCfgOf } from "../../../../packages/maker/src/budget.ts";
import { parseKey } from "../../src/engine.ts";

const A = "0x00000000000000000000000000000000000000a1" as const;

describe("settings", () => {
  it("defaults to SHADOW on the allowlisted live testnet RPCs and refuses any other RPC", () => {
    const s = settingsFrom({} as Env);
    expect(s).toMatchObject({ envMode: "shadow", rpc: "https://rpc.ankr.com/monad_testnet", rpcIsLive: true, stations: ["RCSS"], rollNotBeforeLocal: "12:00", tickSec: 60 });
    // RPC_URLS default: Ankr, thirdweb, then the official RPC (it limits each client IP; Workers share egress IPs)
    expect(s.rpcs).toEqual(["https://rpc.ankr.com/monad_testnet", "https://10143.rpc.thirdweb.com", "https://testnet-rpc.monad.xyz"]);
    expect([s.rpcRps, s.rpcRetries, s.rpcCooldownSec, s.rpcTimeoutSec]).toEqual([8, 2, 30, 20]);
    expect(settingsFrom({ MAKER_MODE: "LIVE" } as Env).envMode).toBe("live");
    expect(settingsFrom({ MAKER_MODE: "yes" } as Env).envMode).toBe("shadow");
    expect(() => settingsFrom({ RPC_URL: "https://rpc.monad.xyz" } as Env)).toThrow(/loopback/);
    expect(() => settingsFrom({ RPC_URL: "http://10.0.0.2:8545" } as Env)).toThrow(/loopback/);
  });
  it("RPC_URLS: a comma list of allowlisted RPCs; RPC_URL is the one-endpoint alias; never live and loopback mixed", () => {
    expect(settingsFrom({ RPC_URL: "https://testnet-rpc.monad.xyz" } as Env).rpcs).toEqual(["https://testnet-rpc.monad.xyz"]);
    const two = settingsFrom({ RPC_URLS: " https://10143.rpc.thirdweb.com , https://testnet-rpc.monad.xyz ", RPC_URL: "https://rpc.ankr.com/monad_testnet" } as Env);
    expect([two.rpc, two.rpcs]).toEqual(["https://10143.rpc.thirdweb.com", ["https://10143.rpc.thirdweb.com", "https://testnet-rpc.monad.xyz"]]); // RPC_URLS wins
    expect(() => settingsFrom({ RPC_URLS: "https://rpc.ankr.com/monad_testnet,https://evil.example/rpc" } as Env)).toThrow(/must be one of/);
    expect(() => settingsFrom({ RPC_URLS: "http://127.0.0.1:8545,https://rpc.ankr.com/monad_testnet" } as Env)).toThrow(/mixes loopback/);
    expect(() => settingsFrom({ RPC_URLS: "https://rpc.ankr.com/monad_testnet,https://rpc.ankr.com/monad_testnet" } as Env)).toThrow(/twice/);
    const fork = settingsFrom({ RPC_URLS: "http://127.0.0.1:19803,http://127.0.0.1:19800" } as Env);
    expect([fork.rpcIsLoopback, fork.rpcIsLive]).toEqual([true, false]);
    expect(() => settingsFrom({ RPC_RPS: "0" } as Env)).toThrow(/out of range/);
  });
  it("settlement guardrails: overdue after 3 h, repeated hourly, automatic stale void on, push limited to 1 per title per hour", () => {
    expect(settingsFrom({} as Env)).toMatchObject({ settleOverdueSec: 10_800, settleOverdueRepeatSec: 3600, autoStaleVoid: true, alertPushMinSec: 3600 });
    expect(settingsFrom({ AUTO_STALE_VOID: "0", SETTLE_OVERDUE_SEC: "7200" } as Env)).toMatchObject({ autoStaleVoid: false, settleOverdueSec: 7200 });
    expect(() => settingsFrom({ SETTLE_OVERDUE_SEC: "60" } as Env)).toThrow(/out of range/); // below 10 min
    expect(() => settingsFrom({ SETTLE_OVERDUE_SEC: "200000" } as Env)).toThrow(/out of range/); // beyond the 48 h stale window
    expect(() => settingsFrom({ SETTLE_OVERDUE_REPEAT_SEC: "10" } as Env)).toThrow(/out of range/);
  });
  it("honours the test hooks only on a loopback fork", () => {
    const live = settingsFrom({ TEST_MARKET_DATA_URL: "http://127.0.0.1:1/x", TEST_SOURCE_PROXY: "http://127.0.0.1:1/s" } as Env);
    expect([live.testMarketDataUrl, live.testSourceProxy]).toEqual([null, null]);
    const fork = settingsFrom({ RPC_URL: "http://127.0.0.1:19800", TEST_MARKET_DATA_URL: "http://127.0.0.1:1/x" } as Env);
    expect(fork).toMatchObject({ rpcIsLoopback: true, rpcIsLive: false, testMarketDataUrl: "http://127.0.0.1:1/x" });
  });
});

describe("worker config", () => {
  it("is the Mac's defaults plus a separate roll budget, dry-run in shadow, gas multipliers within 1.05..1.10", () => {
    const sh = workerConfig(settingsFrom({} as Env), "shadow");
    expect([sh.dryRun, sh.allowLive]).toEqual([true, false]);
    expect(sh.budget.rollCapMon).toEqual({ maker: 0.8, operator: 0.5, marketCreator: 0.8 });
    // the quoting budget with tiers (the cutover-day 6.9 cap is gone): soft at 60 %, x2 spreads above it
    expect(sh.budget.dailyCapMon.maker).toBe(1.2);
    expect([sh.budget.softRatio, sh.budget.softWidenMult]).toEqual([0.6, 2]);
    expect(sh.budget.reserveMon.maker).toBe(0.5);
    // the lazy re-quote policy is the shared default (both runtimes); requoteTicks only matters with lazy off
    expect(sh.policy).toMatchObject({ lazy: true, requoteFairMove: 0.04, staleRefreshHours: 2, staleRefreshMinMove: 0.02, oneSided: true, requoteTicks: 3 });
    // the roll: at most 4 strikes nearest the Polymarket median, none outside [0.05, 0.95]
    expect(sh.roll.strikePolicy).toMatchObject({ mode: "nearest", count: 4, minP: 0.05, maxP: 0.95 });
    expect([sh.fair.guardWarn, sh.fair.guardWarnExit]).toEqual([0.15, 0.13]);
    expect([sh.gas.makerMult, sh.gas.opMult]).toEqual([1.08, 1.1]);
    expect(sh.quote.halfSpreadTicks).toBe(3);
    expect(sh.api.url).toBeNull();
    const lv = workerConfig(settingsFrom({} as Env), "live");
    expect([lv.dryRun, lv.allowLive]).toEqual([false, true]);
    expect(meterKey("maker", "roll", budgetCfgOf(lv))).toBe("maker:roll");
    expect(meterKey("maker", "quote", budgetCfgOf(lv))).toBe("maker");
    expect(() => workerConfig(settingsFrom({ CONFIG_OVERRIDES: '{"gas":{"makerMult":1.3}}' } as Env), "shadow")).toThrow(/1.05..1.1/);
    expect(workerConfig(settingsFrom({ CONFIG_OVERRIDES: '{"budget":{"dailyCapMon":{"maker":1}}}' } as Env), "shadow").budget.dailyCapMon).toEqual({ maker: 1, operator: 0.5, marketCreator: 0.8 });
  });
  it("parses key secrets without ever echoing them", () => {
    expect(parseKey(undefined, "MAKER_KEY")).toBeNull();
    expect(parseKey("11".repeat(32), "MAKER_KEY")!.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    let msg = "";
    try {
      parseKey("0xdeadbeefnotakey", "MAKER_KEY");
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toBe("MAKER_KEY secret is not a 32-byte hex private key");
  });
});

describe("nonce tracker", () => {
  it("uses the chain count, then its own next while the chain lags just after a receipt", async () => {
    let t = 1_000_000;
    const n = new NonceTracker(new MemStore(), () => t);
    expect(await n.next(A, async () => 5)).toBe(5);
    n.sent(A, 5, "0x01", "q");
    n.mined(A, 5, "0x01");
    expect(await n.next(A, async () => 5)).toBe(6); // Monad's pending count has not caught up yet
    t += 61_000;
    expect(await n.next(A, async () => 5)).toBe(5); // a minute later: trust the chain (the tx is gone)
  });
  it("keeps a fresh in-flight nonce, drops a stale one, and does not burn a nonce the RPC refused", async () => {
    let t = 0;
    const n = new NonceTracker(new MemStore(), () => t);
    expect(await n.next(A, async () => 7)).toBe(7);
    n.sent(A, 7, "0x07", "a");
    expect(await n.next(A, async () => 7)).toBe(8); // 7 is in flight (pending not counted yet)
    t += STALE_MS + 1;
    expect(await n.next(A, async () => 7)).toBe(7); // 7 never landed: reuse it
    expect(n.record(A).resets).toBe(1);
    n.failed(A, 7, "nonce too low");
    expect(await n.next(A, async () => 8)).toBe(8);
    n.sent(A, 8, "0x08", "b");
    expect(n.stale(A, 0)).toEqual([{ nonce: 8, hash: "0x08", label: "b", at: t }]);
    expect(await n.next(A, async () => 9)).toBe(9); // the chain counted it: in-flight entry pruned
    expect(n.record(A).inflight).toEqual({});
  });
});

describe("store", () => {
  it("serialises bigints, keeps bounded logs and lists by prefix", () => {
    const s = new MemStore();
    s.put("a:1", { x: 1n });
    s.put("a:2", { x: 2n });
    s.put("b:1", 3);
    expect(s.get("a:1")).toEqual({ x: "1" });
    expect(s.list("a:").map(([k]) => k)).toEqual(["a:1", "a:2"]);
    for (let i = 0; i < 10; i++) s.append("log", { i }, 3);
    expect(s.tail("log", 10)).toEqual([{ i: 7 }, { i: 8 }, { i: 9 }]);
    expect(stringify({ a: 10n })).toBe('{"a":"10"}');
  });
});
