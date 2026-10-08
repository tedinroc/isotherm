// Shared fixtures for the engine unit tests: a fake chain world with the Mac maker's quotes resting on the books,
// deterministic market data, fake API binding / control KV, and the recorded METAR archive answers.
import { readFileSync } from "node:fs";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addDays, localDateOf, STATIONS } from "../../../../packages/forecast/src/stations.ts";
import type { LadderData, MarketData } from "../../../../packages/maker/src/data-core.ts";
import { sourceUrl } from "../../../../packages/cre-workflow/settle/sources.ts";
import type { ApiClient } from "../../src/api.ts";
import { MakerEngine, type Keys, type KvLike } from "../../src/engine.ts";
import { settingsFrom, type Env } from "../../src/env.ts";
import { MemStore } from "../../src/store.ts";
import { FakeChain } from "./fake-chain.ts";

// throwaway keys, unit tests only (never funded anywhere)
export const KEYS = {
  maker: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
  operator: "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex,
  guardian: "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex,
};
export const MAKER = privateKeyToAccount(KEYS.maker);
export const OPERATOR = privateKeyToAccount(KEYS.operator);
export const GUARDIAN = privateKeyToAccount(KEYS.guardian);

export class FakeKv implements KvLike {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
  json(k: string) {
    const v = this.m.get(k);
    return v === undefined ? undefined : JSON.parse(v);
  }
}

export class FakeApi implements ApiClient {
  snapshot: any = { version: 1, empty: true, ladders: [] };
  posted: { body: any; token: string }[] = [];
  gets = 0;
  async getSnapshot() {
    this.gets++;
    return { ok: true, status: 200, body: this.snapshot };
  }
  async postSnapshot(body: unknown, token: string) {
    this.posted.push({ body: JSON.parse(JSON.stringify(body)), token });
    return { ok: true, status: 200, body: { ok: true } };
  }
}

/** The next 03:00Z (11:00 Taipei) at least a minute ahead of the wall clock: chain time always leads Date.now(). */
export function worldStart(): number {
  const t = Math.floor(Date.now() / 1000) + 60;
  const d = new Date(t * 1000);
  let s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 0, 0) / 1000;
  if (s < t) s += 86_400;
  return s;
}

export const PM: Record<number, number> = { 28: 0.95, 29: 0.85, 30: 0.47, 31: 0.09 };

export function stubData(pm: Record<number, number>, obs: { max: number | null } = { max: null }): MarketData {
  return {
    async get(icao, isoDate, nowMs): Promise<LadderData> {
      const strikes = Object.keys(pm).map(Number).sort((a, b) => a - b);
      return {
        pm: { station: icao, city: "taipei", date: isoDate, slug: "stub", url: "https://polymarket.com/event/stub", apiUrl: "", eventId: "1", title: "stub", closed: false, volume: 1000, liquidity: 1000, endDate: "", settlementSource: `wunderground:${icao}`, unit: "C", fetchedAt: new Date(nowMs).toISOString(), quoteSource: "clob", sumRaw: 1, buckets: [], ladder: { ...pm }, strikes, median: 29, mean: 29.5, sd: 1, ok: true, warnings: [] },
        pmFetchedMs: nowMs,
        obs: obs.max === null ? null : { station: icao, date: isoDate, tmaxC: obs.max, nObs: 20, lastObsUtc: nowMs, lastLocal: "10:00", atLocal: "10:00", dayStarted: true, dayOver: false, fetchedAt: new Date(nowMs).toISOString(), sources: [] },
        v0: null,
        intraday: null,
        localMinute: null,
      };
    },
  };
}

const FX = new URL("../../../../packages/forecast/test/fixtures/", import.meta.url);
/** Recorded archive answers (packages/forecast/test/fixtures), served for the URLs the CRE sources would fetch. */
export function fixtureSources() {
  const map = new Map<string, string>();
  for (const [icao, ymd] of [["RCSS", "2026-10-05"], ["RJTT", "2026-10-05"]] as const) {
    const st = STATIONS[icao];
    map.set(sourceUrl("iem", icao, ymd, st.utcOffsetMin, st.tzName), readFileSync(new URL(`iem_${icao}_${ymd}.csv`, FX), "utf8"));
    map.set(sourceUrl("awc", icao, ymd, st.utcOffsetMin, st.tzName), readFileSync(new URL(`awc_${icao}_${ymd}.json`, FX), "utf8"));
  }
  const seen: string[] = [];
  const get = async (url: string) => {
    seen.push(url);
    const body = map.get(url);
    return body === undefined ? { status: 404, body: "" } : { status: 200, body };
  };
  return Object.assign(get, { seen });
}

export interface World {
  chain: FakeChain;
  store: MemStore;
  kv: FakeKv;
  api: FakeApi;
  isoToday: string;
  date: number;
  strikes: { seriesId: Hex; yes: Address; no: Address; market: Address; k: number }[];
  closeTime: number;
  macOrders: Record<number, { bid: number; ask: number }>;
  engine(env?: Partial<Env>, data?: MarketData, keys?: Keys): MakerEngine;
}

export function world(): World {
  const t0 = worldStart();
  const chain = new FakeChain(t0);
  for (const a of [MAKER, OPERATOR, GUARDIAN]) chain.mon.set(a.address.toLowerCase(), parseEther("10"));
  const isoToday = localDateOf(t0 * 1000, 480);
  const date = Number(isoToday.replace(/-/g, ""));
  const closeTime = Date.parse(`${isoToday}T00:00:00Z`) / 1000 - 480 * 60 + (17 * 60 + 30) * 60; // 17:30 Taipei
  const strikes = chain.addLadder("RCSS", date, [29, 30, 31], closeTime, MAKER.address);
  // the Mac maker's quotes (same maker key), resting on the books
  const macOrders: Record<number, { bid: number; ask: number }> = {};
  const quotes: Record<number, [number, number]> = { 29: [0.82, 0.88], 30: [0.44, 0.51], 31: [0.06, 0.12] };
  for (const s of strikes) macOrders[s.k] = { bid: chain.place(s.market, MAKER.address, quotes[s.k][0], 100, true), ask: chain.place(s.market, MAKER.address, quotes[s.k][1], 100, false) };
  const store = new MemStore();
  const kv = new FakeKv();
  const api = new FakeApi();
  const w: World = {
    chain,
    store,
    kv,
    api,
    isoToday,
    date,
    strikes,
    closeTime,
    macOrders,
    engine(env: Partial<Env> = {}, data: MarketData = stubData(PM), keys?: Keys) {
      return new MakerEngine({
        settings: settingsFrom({ RPC_URL: "https://testnet-rpc.monad.xyz", WATCH_EVERY_SEC: "0", WATCH_RECHECK_SEC: "0", ...env } as Env),
        store,
        kv,
        api,
        keys: keys ?? { maker: KEYS.maker, operator: KEYS.operator, guardian: KEYS.guardian, snapshotToken: "test-snapshot-token" },
        now: () => chain.time * 1000,
        pub: chain.publicClient(),
        wallet: chain.wallet(),
        data,
        sources: fixtureSources(),
        sleep: async () => {},
      });
    },
  };
  return w;
}

export function macSnapshot(w: World, ageSec: number) {
  return {
    version: 1,
    source: "isotherm.snapshot/v1",
    receivedAt: new Date((w.chain.time - ageSec) * 1000).toISOString(),
    ladders: [{ station: "RCSS", date: w.date, strikes: [{ k: 29, fair: 0.85, bid: 0.82, ask: 0.88, mode: "quoting", action: "none" }, { k: 30, fair: 0.47, bid: 0.44, ask: 0.51, mode: "quoting", action: "none" }, { k: 31, fair: 0.09, bid: 0.06, ask: 0.12, mode: "quoting", action: "none" }] }],
  };
}

export { addDays };
