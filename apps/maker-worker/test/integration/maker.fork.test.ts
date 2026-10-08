// End-to-end: the BUNDLED Worker (wrangler deploy --dry-run output) in Miniflare/workerd -- real sqlite Durable
// Object, KV, a stand-in for the isotherm-api service binding -- against an ANVIL FORK of live Monad testnet with the
// real v1 contracts, AUSD + faucet, Kuru router/margin account and the CRE MockKeystoneForwarder.
//   1. SHADOW: the scheduled roll is simulated (intents recorded) and nothing reaches the fork.
//   2. LIVE (both switches on, fork only): the interlock holds while "another writer" is publishing; then the real roll
//      (createLadder, mint, Kuru markets, canonical, margin, opening quotes) is SENT; ticks follow Polymarket moves, a
//      taker fill and an observed max; the kill switch empties every book at stop time; the snapshot goes through the
//      binding with the bearer token.
//   3. Settlement watch: a WRONG attested result is recomputed from recorded METAR archives with the CRE rule and
//      CHALLENGED by the guardian secret inside the 900 s window (Void); a correct one is a MATCH.
// Throwaway keys only (generated here, fork-only roles granted by impersonating the owner). Ports: anvil 19800,
// stubs 19801, Miniflare 19802 (override with MW_ANVIL_PORT / MW_STUB_PORT / MW_MF_PORT, all within 19800-19849).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Response as MfResponse } from "miniflare";
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  maxUint256,
  parseAbi,
  parseEther,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STATIONS, addDays, localDateOf } from "../../../../packages/forecast/src/stations.ts";
import { sourceUrl } from "../../../../packages/cre-workflow/settle/sources.ts";
import D from "../../../../deployments/testnet.json";
import { recompute } from "../../src/watcher.ts";

const PKG = fileURLToPath(new URL("../..", import.meta.url));
const ANVIL_PORT = Number(process.env.MW_ANVIL_PORT ?? 19800);
const STUB_PORT = Number(process.env.MW_STUB_PORT ?? 19801);
const MF_PORT = Number(process.env.MW_MF_PORT ?? 19802);
for (const p of [ANVIL_PORT, STUB_PORT, MF_PORT]) if (p < 19800 || p > 19849) throw new Error(`port ${p} outside 19800-19849`);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const ANVIL = `${process.env.HOME}/.foundry/bin/anvil`;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = join(PKG, "evidence", `fork-${STAMP}`);
const RUN = join(PKG, ".test-run", STAMP);
const SNAP_TOKEN = "fork-test-snapshot-token";

const chain = defineChain({ id: 10143, name: "fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const transport = http(RPC, { timeout: 120_000, retryCount: 2 });
const pub = createPublicClient({ chain, transport });
const testc = createTestClient({ chain, transport, mode: "anvil" });

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const ownable = parseAbi(["function owner() view returns (address)"]);
const vaultAbi = parseAbi(["function setOperator(address account, bool enabled)", "function ladderSeries(bytes4, uint32) view returns (bytes32[])"]);
const resolverAbi = parseAbi([
  "function setGuardian(address)",
  "function setAttester(address)",
  "function resultOf(bytes4,uint32) view returns ((uint8 status, int16 tmaxC, uint64 resolvedAt, uint64 finalAt, bytes32 sourcesHash))",
]);
const zapAbi = parseAbi(["function canonicalMarket(bytes32) view returns (address)"]);
const bookAbi = parseAbi([
  "function getL2Book() view returns (bytes)",
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
]);
const marginAbi = parseAbi(["function getBalance(address _user, address _token) view returns (uint256)"]);
const faucetAbi = parseAbi(["function requestFunds(address)"]);
const forwarderAbi = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);

// throwaway, fork-only keys (never printed, never funded anywhere real)
const K = { maker: generatePrivateKey(), operator: generatePrivateKey(), guardian: generatePrivateKey(), taker: generatePrivateKey(), attester: generatePrivateKey() };
const A = Object.fromEntries(Object.entries(K).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<keyof typeof K, ReturnType<typeof privateKeyToAccount>>;

// ---------------------------------------------------------------- stand-ins: market data, METAR archives, API binding
let pmLadder: Record<number, number> = { 21: 0.9, 22: 0.65, 23: 0.35, 24: 0.1 };
let obsMax: number | null = null;
const FX = new URL("../../../../packages/forecast/test/fixtures/", import.meta.url);
const sourceBodies = new Map<string, string>();
for (const [icao, ymd] of [["RCSS", "2026-10-05"], ["RJTT", "2026-10-05"], ["RCSS", "2026-05-04"]] as const) {
  const st = STATIONS[icao];
  sourceBodies.set(sourceUrl("iem", icao, ymd, st.utcOffsetMin, st.tzName), readFileSync(new URL(`iem_${icao}_${ymd}.csv`, FX), "utf8"));
  sourceBodies.set(sourceUrl("awc", icao, ymd, st.utcOffsetMin, st.tzName), readFileSync(new URL(`awc_${icao}_${ymd}.json`, FX), "utf8"));
}
const fixtureGet = async (url: string) => {
  const b = sourceBodies.get(url);
  return b === undefined ? { status: 404, body: "" } : { status: 200, body: b };
};

function ladderData(icao: string, isoDate: string, nowMs: number) {
  const strikes = Object.keys(pmLadder).map(Number).sort((a, b) => a - b);
  return {
    pm: { station: icao, city: "tokyo", date: isoDate, slug: "fork-stub", url: "https://polymarket.com/event/fork-stub", apiUrl: "", eventId: "0", title: "fork stub", closed: false, volume: 0, liquidity: 0, endDate: "", settlementSource: `wunderground:${icao}`, unit: "C", fetchedAt: new Date(nowMs).toISOString(), quoteSource: "clob", sumRaw: 1, buckets: [], ladder: { ...pmLadder }, strikes, median: 22, mean: 22.4, sd: 1.1, ok: true, warnings: [] },
    pmFetchedMs: nowMs,
    obs: obsMax === null ? null : { station: icao, date: isoDate, tmaxC: obsMax, nObs: 20, lastObsUtc: nowMs, lastLocal: "11:00", atLocal: "11:00", dayStarted: true, dayOver: false, fetchedAt: new Date(nowMs).toISOString(), sources: [] },
    v0: null,
    intraday: null,
    localMinute: null,
  };
}

let stubServer: Server;
const api = { latest: { version: 1, empty: true, ladders: [] } as any, posts: [] as { auth: string | null; body: any }[], gets: 0 };

// ---------------------------------------------------------------- helpers
const procs: ChildProcess[] = [];
let mf: Miniflare;
const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  console.log(s);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "summary.txt"), lines.join("\n") + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function as(from: Address, to: Address, abi: any, functionName: string, args: readonly unknown[]) {
  await testc.impersonateAccount({ address: from });
  const w = createWalletClient({ chain, transport, account: from });
  const hash = await w.writeContract({ address: to, abi, functionName, args, chain, account: from } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  await testc.stopImpersonatingAccount({ address: from });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}
const warp = async (s: number) => {
  await testc.increaseTime({ seconds: s });
  await testc.mine({ blocks: 1 });
};
const chainNow = async () => Number((await pub.getBlock()).timestamp);
const nonceOf = (a: Address) => pub.getTransactionCount({ address: a });

const vars = (over: Record<string, string> = {}) => ({
  MAKER_MODE: "shadow",
  RPC_URL: RPC,
  STATIONS: "RJTT",
  ROLL_NOT_BEFORE_LOCAL: "00:00",
  ROLL_AUTO: "1",
  TICK_SEC: "60",
  WATCH_EVERY_SEC: "86400", // the watcher runs when a test asks for it (?watch=1)
  WATCH_RECHECK_SEC: "1",
  WATCH_LOOKBACK_BLOCKS: "4000",
  INTERLOCK_FRESH_SEC: "300",
  SHADOW_ROLL_EVERY_SEC: "3600",
  TEST_MARKET_DATA_URL: `${STUB}/data`,
  TEST_SOURCE_PROXY: `${STUB}/src`,
  MAKER_KEY: K.maker,
  OPERATOR_KEY: K.operator,
  GUARDIAN_KEY: K.guardian,
  SNAPSHOT_TOKEN: SNAP_TOKEN,
  ...over,
});
const mfOptions = (v: Record<string, string>) => ({
  modules: true,
  scriptPath: join(RUN, "dist", "index.js"),
  compatibilityDate: "2025-07-18",
  port: MF_PORT,
  durableObjects: { MAKER: { className: "MakerDO", useSQLite: true } },
  kvNamespaces: ["MAKER_KV"],
  durableObjectsPersist: join(RUN, "do"),
  kvPersist: join(RUN, "kv"),
  bindings: v,
  serviceBindings: {
    // the isotherm-api routes the maker uses, as the real Worker answers them (normalised snapshot with receivedAt/source)
    API: async (req: any) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/snapshot" && req.method === "GET") {
        api.gets++;
        return new MfResponse(JSON.stringify(api.latest), { headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/api/snapshot" && req.method === "POST") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${SNAP_TOKEN}`) return new MfResponse(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        const body = JSON.parse(await req.text());
        api.posts.push({ auth, body });
        api.latest = { ...body, version: 1, receivedAt: new Date().toISOString(), source: body.source ?? body.schema };
        return new MfResponse(JSON.stringify({ ok: true, ladders: body.ladders.length }), { headers: { "content-type": "application/json" } });
      }
      return new MfResponse("not found", { status: 404 });
    },
  },
});
async function doStub() {
  const ns = await mf.getDurableObjectNamespace("MAKER");
  return ns.get(ns.idFromName("maker"));
}
async function tick(q = ""): Promise<any> {
  const r = await (await doStub()).fetch(`http://maker.internal/tick?schedule=0${q}`, { method: "POST" });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`tick ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}
async function doGet(path: string): Promise<any> {
  return (await (await doStub()).fetch(`http://maker.internal${path}`)).json();
}
async function control(doc: Record<string, unknown>) {
  const kv = await mf.getKVNamespace("MAKER_KV");
  await kv.put("control", JSON.stringify(doc));
}
async function book(market: Address) {
  const hex = (await pub.readContract({ address: market, abi: bookAbi, functionName: "getL2Book" })) as Hex;
  const w: bigint[] = [];
  for (let i = 2; i + 64 <= hex.length; i += 64) w.push(BigInt("0x" + hex.slice(i, i + 64)));
  const bids: number[] = [], asks: number[] = [];
  let i = 1;
  for (; i < w.length && w[i] !== 0n; i += 2) bids.push(Number(w[i]) / 1e4);
  for (i += 1; i + 1 < w.length; i += 2) asks.push(Number(w[i]) / 1e4);
  return { bids, asks };
}

// ---------------------------------------------------------------- setup
let isoDate = "";
let date = 0;
let owner: Address;

beforeAll(async () => {
  mkdirSync(join(RUN, "dist"), { recursive: true });
  const b = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(RUN, "dist")], { cwd: PKG, encoding: "utf8" });
  if (b.status !== 0) throw new Error(`bundle failed: ${b.stderr || b.stdout}`);
  const anvil = spawn(ANVIL, ["--fork-url", "https://testnet-rpc.monad.xyz", "--port", String(ANVIL_PORT), "--retries", "8", "--fork-retry-backoff", "800", "--timeout", "60000", "--silent"], { stdio: "ignore" });
  procs.push(anvil);
  for (let t = Date.now(); ; ) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      if (Date.now() - t > 90_000) throw new Error("anvil did not start");
      await sleep(500);
    }
  }
  stubServer = createServer((req, res) => {
    const u = new URL(req.url ?? "/", STUB);
    if (u.pathname === "/data") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(ladderData(u.searchParams.get("station")!, u.searchParams.get("date")!, Number(u.searchParams.get("now")))));
    }
    if (u.pathname === "/src") {
      const body = sourceBodies.get(u.searchParams.get("url") ?? "");
      res.statusCode = body === undefined ? 404 : 200;
      return res.end(body ?? "");
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => stubServer.listen(STUB_PORT, "127.0.0.1", () => r()));

  // fork-only roles and money (owner impersonated; throwaway keys)
  owner = (await pub.readContract({ address: D.vault as Address, abi: ownable, functionName: "owner" })) as Address;
  const rOwner = (await pub.readContract({ address: D.resolver as Address, abi: ownable, functionName: "owner" })) as Address;
  for (const a of [owner, rOwner, A.maker.address, A.operator.address, A.guardian.address, A.taker.address]) await testc.setBalance({ address: a, value: parseEther("100") });
  await as(owner, D.vault as Address, vaultAbi, "setOperator", [A.operator.address, true]);
  await as(rOwner, D.resolver as Address, resolverAbi, "setGuardian", [A.guardian.address]);
  await as(rOwner, D.resolver as Address, resolverAbi, "setAttester", [A.attester.address]);
  const tw = createWalletClient({ chain, transport, account: A.taker });
  for (const to of [A.maker.address, A.taker.address]) {
    await warp(120); // the AUSD faucet has one global 60 s cooldown
    await pub.waitForTransactionReceipt({ hash: await tw.writeContract({ address: D.ausdFaucet as Address, abi: faucetAbi, functionName: "requestFunds", args: [to], chain }) });
  }
  // tomorrow in Tokyo (RJTT is not rolled on live, so its ladders are free on the fork)
  const now = await chainNow();
  isoDate = addDays(localDateOf(now * 1000, 540), 1);
  for (let i = 0; i < 3; i++) {
    const ids = (await pub.readContract({ address: D.vault as Address, abi: vaultAbi, functionName: "ladderSeries", args: [stringToHex("RJTT", { size: 4 }), Number(isoDate.replace(/-/g, ""))] })) as Hex[];
    if (!ids.length) break;
    isoDate = addDays(isoDate, 1);
  }
  date = Number(isoDate.replace(/-/g, ""));
  say(`anvil :${ANVIL_PORT} fork of Monad testnet at block ${await pub.getBlockNumber()} (chain time ${new Date(now * 1000).toISOString()}); RJTT ladder date ${isoDate}`);
  say(`fork-only setup: operator authorised on the vault, guardian + attester set on the Resolver (owner impersonated), 10k AUSD from the faucet to maker and taker`);
  mf = new Miniflare(mfOptions(vars()) as any);
  await mf.ready;
}, 600_000);

afterAll(async () => {
  await mf?.dispose().catch(() => undefined);
  stubServer?.close();
  for (const p of procs) p.kill("SIGTERM");
  await sleep(500);
  for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
  rmSync(RUN, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the run
describe("isotherm-maker Worker on a Monad testnet fork", () => {
  it("SHADOW: simulates the scheduled roll and sends nothing", async () => {
    const n0 = [await nonceOf(A.maker.address), await nonceOf(A.operator.address)];
    const r = await tick();
    expect(r.mode).toBe("shadow");
    expect(r.errors).toEqual([]);
    expect(r.rolls).toEqual([expect.objectContaining({ key: `RJTT:${date}`, ok: true })]);
    expect(r.intents.map((i: any) => i.label)).toEqual([`createLadder RJTT ${date} [21,22,23,24]`]);
    expect(r.intents[0]).toMatchObject({ role: "operator", functionName: "createLadder", kind: "roll" });
    expect(r.txs).toEqual([]);
    expect([await nonceOf(A.maker.address), await nonceOf(A.operator.address)]).toEqual(n0);
    expect(api.posts).toEqual([]);
    expect(api.gets).toBeGreaterThan(0);
    const est = r.rolls[0].estimated;
    say(`shadow: roll RJTT ${isoDate} simulated -> would send createLadder [21,22,23,24] (operator, gas limit ${r.intents[0].gasLimit}); estimated MON ${JSON.stringify(est)}; 0 txs, nonces unchanged, no snapshot POST (${api.gets} GETs through the binding)`);
    const again = await tick();
    expect(again.rolls).toEqual([]); // shadow re-plans at most every SHADOW_ROLL_EVERY_SEC
    expect(again.intents).toEqual([]);
  });

  it("LIVE: interlock first, then the real roll + opening quotes through the Worker, snapshot via the binding", async () => {
    await mf.setOptions(mfOptions(vars({ MAKER_MODE: "live" })) as any);
    await control({ seq: 1, live: true, confirm: A.maker.address });
    // another writer published 20 s ago -> live is held back
    api.latest = { version: 1, source: "isotherm.snapshot/v1", receivedAt: new Date(Date.now() - 20_000).toISOString(), ladders: [] };
    const held = await tick();
    expect(held.control).toMatch(/ARMED/);
    expect(held.interlock.blocked).toBe(true);
    expect(held.mode).toBe("shadow");
    expect(held.txs).toEqual([]);
    say(`live armed, interlock: "${held.interlock.detail}" -> tick stayed shadow, 0 txs`);
    api.latest.receivedAt = new Date(Date.now() - 3600_000).toISOString(); // it stopped an hour ago
    const r = await tick();
    expect(r.mode).toBe("live");
    expect(r.errors).toEqual([]);
    expect(r.rolls).toEqual([expect.objectContaining({ key: `RJTT:${date}`, ok: true })]);
    const labels = r.txs.map((t: any) => t.label);
    expect(labels[0]).toBe(`createLadder RJTT ${date} [21,22,23,24]`);
    expect(labels.filter((l: string) => /deployProxy/.test(l))).toHaveLength(4);
    expect(labels.filter((l: string) => /setCanonicalMarket/.test(l))).toHaveLength(4);
    expect(labels.filter((l: string) => /^mintSet/.test(l))).toHaveLength(4);
    expect(r.txs.every((t: any) => t.status === "success")).toBe(true);
    say(`live roll: ${r.txs.length} txs sent by the Worker (${[...new Set(labels.map((l: string) => l.split(" ")[0]))].join(", ")})`);
    // books: one bid + one ask around fair on every strike that is quoted; canonical market in the Zap
    const lad = r.ladders.find((l: any) => l.key === `RJTT:${date}`);
    for (const s of lad.strikes) {
      const fair = pmLadder[s.k];
      expect(s.action).toBe("quote");
      expect(s.resting.bid).toBeLessThan(fair);
      expect(s.resting.ask).toBeGreaterThan(fair);
    }
    const st = await doGet("/status");
    expect(st.mode).toBe("live");
    const markets = await liveMarkets();
    for (const [k, m] of Object.entries(markets)) {
      const bk = await book(m.market);
      expect([bk.bids.length, bk.asks.length]).toEqual([1, 1]);
      expect(bk.bids[0]).toBeLessThan(pmLadder[Number(k)]);
      expect(bk.asks[0]).toBeGreaterThan(pmLadder[Number(k)]);
      expect(((await pub.readContract({ address: D.zap as Address, abi: zapAbi, functionName: "canonicalMarket", args: [m.seriesId] })) as string).toLowerCase()).toBe(m.market.toLowerCase());
      say(`  >=${k} market ${m.market} fair ${pmLadder[Number(k)]} -> book ${bk.bids[0]} / ${bk.asks[0]} (canonical in the Zap)`);
    }
    // the opening quotes were charged to the roll budget; the snapshot went through the binding with the token
    expect(st.budget.spent["maker:roll"]).toBeGreaterThan(0);
    expect(api.posts.length).toBe(1);
    expect(api.posts[0].body).toMatchObject({ schema: "isotherm.snapshot/v1", source: "isotherm-maker-worker", rpcKind: "anvil-fork" });
    expect(api.posts[0].body.ladders[0].strikes).toHaveLength(4);
    say(`snapshot POSTed through the service binding (Bearer token ok): ${api.posts[0].body.ladders[0].strikes.length} strikes, budget ${JSON.stringify(st.budget.spent)}`);
  });

  it("LIVE ticks: a Polymarket move re-quotes, a taker fill is refilled with skew, an observed max pulls the strike", async () => {
    let r = await tick();
    expect(r.txs).toEqual([]);
    say(`tick: nothing changed -> 0 txs`);
    pmLadder = { ...pmLadder, 22: 0.75 };
    r = await tick();
    const a22 = r.ladders[0].strikes.find((s: any) => s.k === 22);
    expect(a22.action).toBe("requote");
    expect(r.txs.map((t: any) => t.label)).toEqual([expect.stringMatching(/^requote >=22 /)]);
    expect(a22.resting.bid).toBeLessThan(0.75);
    expect(a22.resting.ask).toBeGreaterThan(0.75);
    say(`Polymarket >=22 0.65 -> 0.75: requote -> ${a22.resting.bid} / ${a22.resting.ask} (${r.txs[0].hash})`);
    // a taker lifts the whole ask on >=23
    const m = (await liveMarkets())[23];
    const tw = createWalletClient({ chain, transport, account: A.taker });
    await pub.waitForTransactionReceipt({ hash: await tw.writeContract({ address: D.ausd as Address, abi: erc20, functionName: "approve", args: [m.market, maxUint256], chain }) });
    const before = await book(m.market);
    const buy = await tw.writeContract({ address: m.market, abi: bookAbi, functionName: "placeAndExecuteMarketBuy", args: [BigInt(Math.ceil(100 * before.asks[0] + 5) * 10_000), 0n, false, false], chain, gas: 1_500_000n });
    expect((await pub.waitForTransactionReceipt({ hash: buy })).status).toBe("success");
    r = await tick();
    const a23 = r.ladders[0].strikes.find((s: any) => s.k === 23);
    expect(a23.action).toBe("requote");
    expect(a23.reasons.join(" ")).toMatch(/ask side empty \(filled\)/);
    expect(a23.resting.ask).toBeGreaterThanOrEqual(before.asks[0]); // short YES -> skewed up
    say(`taker bought the >=23 ask (${before.asks[0]}): requote "${a23.reasons.join("; ")}" -> ${a23.resting.bid} / ${a23.resting.ask}`);
    // METAR shows 22: YES >=21 and >=22 are certain -> pulled
    obsMax = 22;
    r = await tick();
    const acts = Object.fromEntries(r.ladders[0].strikes.map((s: any) => [s.k, s.action]));
    expect([acts[21], acts[22]]).toEqual(["pull", "pull"]);
    for (const k of [21, 22]) expect((await book((await liveMarkets())[k].market)).bids).toEqual([]);
    say(`observed max 22 C: >=21, >=22 pulled (certain); actions ${JSON.stringify(acts)}`);
  });

  it("LIVE kill switch at stop time empties every book and withdraws the YES margin; later ticks send nothing", async () => {
    await mf.setOptions(mfOptions(vars({ MAKER_MODE: "live", ROLL_AUTO: "0" })) as any); // no new ladders after the warp
    const r0 = await tick();
    const stopAt = r0.ladders[0].stopAt as number;
    await warp(stopAt - 90 - (await chainNow()) + 5);
    const r = await tick();
    expect(r.kill).toEqual([expect.objectContaining({ key: `RJTT:${date}`, leftOpen: 0, mode: "live" })]);
    for (const [k, m] of Object.entries(await liveMarkets())) {
      const bk = await book(m.market);
      expect([k, bk.bids.length + bk.asks.length]).toEqual([k, 0]);
      expect(await pub.readContract({ address: D.kuruMarginAccount as Address, abi: marginAbi, functionName: "getBalance", args: [A.maker.address, m.yes] })).toBe(0n);
    }
    say(`kill switch at ${new Date((await chainNow()) * 1000).toISOString()} (stopAt ${new Date(stopAt * 1000).toISOString()}): ${JSON.stringify(r.kill)}; ${r.txs.length} txs; all books empty, YES margin withdrawn`);
    const after = await tick();
    expect(after.txs).toEqual([]);
  });

  it("settlement watch: a wrong attested result is challenged by the guardian secret (Void); a correct one is a MATCH", async () => {
    // pick station-dates with recorded archives that are not resolved on the fork
    const rr = async (icao: string, d: number) => (await pub.readContract({ address: D.resolver as Address, abi: resolverAbi, functionName: "resultOf", args: [stringToHex(icao, { size: 4 }), d] })) as { status: number };
    const wrong = (await rr("RCSS", 20261005)).status === 0 ? { icao: "RCSS", date: 20261005, ymd: "2026-10-05" } : { icao: "RCSS", date: 20260504, ymd: "2026-05-04" };
    expect((await rr(wrong.icao, wrong.date)).status).toBe(0);
    const right = { icao: "RJTT", date: 20261005 };
    const truth = await recompute(wrong.icao, wrong.date, fixtureGet);
    const rjtt = await recompute(right.icao, right.date, fixtureGet);
    expect(truth.d.status).toBe("SETTLED");
    expect(rjtt.d.status).toBe("SETTLED");
    await deliver(wrong.icao, wrong.date, truth.d.tmaxC! + 2);
    if ((await rr(right.icao, right.date)).status === 0) await deliver(right.icao, right.date, rjtt.d.tmaxC!);
    const r = await tick("&watch=1");
    const v = Object.fromEntries(r.watcher.verdicts.map((x: any) => [x.key, x.verdict]));
    expect(v[`${wrong.icao}:${wrong.date}`]).toBe("MISMATCH-CHALLENGED");
    expect(r.watcher.challenges).toEqual([expect.objectContaining({ key: `${wrong.icao}:${wrong.date}`, ok: true })]);
    expect((await rr(wrong.icao, wrong.date)).status).toBe(2);
    if (v[`${right.icao}:${right.date}`]) expect(v[`${right.icao}:${right.date}`]).toBe("MATCH");
    expect(r.watcher.pages).toBeGreaterThan(0);
    say(`watcher (live, guardian secret): ${wrong.icao} ${wrong.date} attested ${truth.d.tmaxC! + 2} C vs the rule's ${truth.d.tmaxC} C -> challenge ${r.watcher.challenges[0].hash} -> Void; ${right.icao} ${right.date} -> ${v[`${right.icao}:${right.date}`] ?? "already resolved on live"}; getLogs in ${r.watcher.pages} page(s) of <= 100 blocks`);
  });

  it("cron re-arms the Durable Object alarm; the tx log is the evidence", async () => {
    await control({ seq: 2, live: false });
    await tick(); // apply the disarm
    const w = await mf.getWorker();
    await w.scheduled({ cron: "* * * * *" });
    const st = await doGet("/status");
    expect(st.liveFlag).toBe(false);
    expect(st.cron.action).toMatch(/alarm (armed|ok)/);
    expect(st.alarm).not.toBeNull();
    const txs: any[] = await doGet("/log?name=txs:live&limit=500");
    writeFileSync(join(OUT, "txs.tsv"), ["#\trole\tlabel\tgasUsed\tgasLimit\thash", ...txs.map((x, i) => [i + 1, x.role, x.label, x.gasUsed, x.gasLimit, x.hash].join("\t"))].join("\n") + "\n");
    say(`disarmed; cron -> ${st.cron.action}; ${txs.length} live txs in txs.tsv`);
  });
});

async function liveMarkets(): Promise<Record<number, { market: Address; seriesId: Hex; yes: Address }>> {
  const snap = api.latest;
  const l = snap.ladders.find((x: any) => x.station === "RJTT");
  return Object.fromEntries(l.strikes.map((s: any) => [s.strike, { market: s.market, seriesId: s.seriesId, yes: s.yes }]));
}

async function deliver(icao: string, d: number, tmaxC: number) {
  const b4 = stringToHex(icao, { size: 4 });
  const sourcesHash = keccak256(stringToHex(`fork-test ${icao} ${d} ${tmaxC}`));
  const validUntil = BigInt((await chainNow()) + 3600);
  const sig = await A.attester.signTypedData({
    domain: { name: "Isotherm Resolver", version: "1", chainId: 10143, verifyingContract: D.resolver as Address },
    types: { Settlement: [{ name: "station", type: "bytes4" }, { name: "date", type: "uint32" }, { name: "tmaxC", type: "int16" }, { name: "isVoid", type: "bool" }, { name: "sourcesHash", type: "bytes32" }, { name: "validUntil", type: "uint64" }] },
    primaryType: "Settlement",
    message: { station: b4, date: d, tmaxC, isVoid: false, sourcesHash, validUntil },
  });
  const payload = encodeAbiParameters([{ type: "bytes4" }, { type: "uint32" }, { type: "int16" }, { type: "bool" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], [b4, d, tmaxC, false, sourcesHash, validUntil, sig]);
  const raw = concat(["0x01", keccak256("0x1234"), toHex(100, { size: 4 }), toHex(1, { size: 4 }), toHex(1, { size: 4 }), `0x${"11".repeat(32)}`, stringToHex("7721568293", { size: 10 }), "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0x0001", payload]);
  const tw = createWalletClient({ chain, transport, account: A.taker });
  const h = await tw.writeContract({ address: D.mockForwarder as Address, abi: forwarderAbi, functionName: "report", args: [D.resolver as Address, raw, toHex(new Uint8Array(96)), [toHex(new Uint8Array(65))]], gas: 400_000n, chain });
  expect((await pub.waitForTransactionReceipt({ hash: h })).status).toBe("success");
}

