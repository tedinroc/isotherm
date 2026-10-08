// CUTOVER REHEARSAL on an anvil fork of live Monad testnet, with the REAL ladder the Mac maker is quoting right now
// and the Mac's REAL state.json. The bundled Worker (wrangler deploy --dry-run output) runs in Miniflare/workerd.
//   1. import the Mac's state.json (scripts/import-budget.mjs, as `control.mjs import-state` does) and arm; while the
//      Mac is still publishing, the interlock keeps the tick in shadow;
//   2. "the Mac stopped" (its last snapshot is > 300 s old): the first LIVE ticks quote the real books;
//   3. the chain is warped to the next 12:00 station time: tomorrow's ladder is ROLLED live (strikes from the real
//      Polymarket ladder of that date, createLadder, mint, Kuru markets, canonical in the Zap, margin, opening quotes);
//   4. warped to the stop-quoting time of today's ladder: the close-time KILL SWITCH cancels every maker order on its
//      books and withdraws the YES margin; the new ladder keeps quoting; the verify pass finds nothing left;
//   5. rollback: `pull all` cancels every quote, `disarm` returns to shadow and nothing more is sent.
// Fork-only: throwaway keys (the real maker key is never used; the Mac's own orders stay on the books untouched),
// the operator role is granted on the fork by impersonating the vault owner, and the throwaway maker gets the
// inventory the Mac's roll gave the real maker (mint 300 sets per strike, 300 YES + 400 AUSD margin).
// Market data: the real Polymarket ladder + v0 guard of each date, fetched now, presented as fresh at the warped
// chain time (no METAR conditioning: the warped hours have not been observed yet).
// Opt-in: MW_REHEARSAL=1 npx vitest run test/integration/cutover-rehearsal.fork.test.ts
// Ports: anvil 19810, stub 19811, Miniflare 19812. Reads (never writes) the Mac's state.json + txs.jsonl.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Response as MfResponse } from "miniflare";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, maxUint256, parseAbi, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, STATIONS } from "../../../../packages/forecast/src/stations.ts";
import D from "../../../../deployments/testnet.json";
import { scanOpenOrders } from "../../../../packages/maker/src/kuru.ts";
// @ts-expect-error plain .mjs operator script (no types)
import { prepareImport } from "../../scripts/import-budget.mjs";

const RUN_IT = process.env.MW_REHEARSAL === "1";
const PKG = fileURLToPath(new URL("../..", import.meta.url));
const ANVIL_PORT = 19810, STUB_PORT = 19811, MF_PORT = 19812;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const ANVIL = `${process.env.HOME}/.foundry/bin/anvil`;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = join(PKG, "evidence", `rehearsal-${STAMP}`);
const RUN = join(PKG, ".test-run", `rehearsal-${STAMP}`);
const MAC_VAR = process.env.MAC_MAKER_VAR ?? join(homedir(), "isotherm-live/packages/maker/var");
const SNAP_TOKEN = "rehearsal-snapshot-token";
const REAL_MAKER = "0xd572638F07829D1c3636400FB73CF34Ca6c7448a" as Address; // the Mac maker (public; in every snapshot)

const chain = defineChain({ id: 10143, name: "fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const transport = http(RPC, { timeout: 120_000, retryCount: 2 });
const pub = createPublicClient({ chain, transport });
const testc = createTestClient({ chain, transport, mode: "anvil" });

const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const ownable = parseAbi(["function owner() view returns (address)"]);
const vaultAbi = parseAbi(["function setOperator(address account, bool enabled)", "function mintSet(bytes32 seriesId, uint256 amount)", "function ladderSeries(bytes4, uint32) view returns (bytes32[])"]);
const marginAbi = parseAbi(["function deposit(address _user, address _token, uint256 _amount) payable", "function getBalance(address _user, address _token) view returns (uint256)"]);
const faucetAbi = parseAbi(["function requestFunds(address)"]);
const MULTICALL3 = ((D as any).multicall3 ?? "0xcA11bde05977b3631167028862bE2a173976CA11") as Address;

const K = { maker: generatePrivateKey(), operator: generatePrivateKey(), guardian: generatePrivateKey() };
const A = { maker: privateKeyToAccount(K.maker), operator: privateKeyToAccount(K.operator), guardian: privateKeyToAccount(K.guardian) };

const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  console.log(s);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "summary.txt"), lines.join("\n") + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chainNow = async () => Number((await pub.getBlock()).timestamp);
const warpTo = async (t: number) => {
  await testc.setNextBlockTimestamp({ timestamp: BigInt(t) });
  await testc.mine({ blocks: 1 });
};
const localIso = (unix: number, offMin: number) => new Date(unix * 1000 + offMin * 60_000).toISOString();

// ---------------------------------------------------------------- market data stub: real data, presented at chain time
const pmCache = new Map<string, { at: number; v: any }>();
const v0Cache = new Map<string, any>();
async function realData(icao: string, isoDate: string, nowMs: number) {
  const { livePolymarketLadder } = await import("../../../../packages/forecast/src/polymarket.ts");
  const { v0Ladder } = await import("../../../../packages/forecast/src/v0.ts");
  const key = `${icao}:${isoDate}`;
  let pm = pmCache.get(key);
  if (!pm || Date.now() - pm.at > 60_000) pmCache.set(key, (pm = { at: Date.now(), v: await livePolymarketLadder(icao, isoDate, { gammaTtlSec: 60 }) }));
  if (!v0Cache.has(key)) v0Cache.set(key, await v0Ladder(icao, isoDate, Date.now(), 3600).catch(() => null));
  return { pm: pm.v, pmFetchedMs: pm.v ? nowMs : null, obs: null, v0: v0Cache.get(key), intraday: null, localMinute: null };
}

let stubServer: Server;
const api = { latest: null as any, posts: [] as any[], gets: 0 };
const procs: ChildProcess[] = [];
let mf: Miniflare;

const vars = (over: Record<string, string> = {}) => ({
  MAKER_MODE: "shadow",
  RPC_URL: RPC,
  STATIONS: "RCSS",
  ROLL_NOT_BEFORE_LOCAL: "12:00",
  ROLL_AUTO: "1",
  TICK_SEC: "60",
  WATCH_EVERY_SEC: "86400",
  WATCHDOG_VERIFY_SEC: "300",
  INTERLOCK_FRESH_SEC: "300",
  SHADOW_ROLL_EVERY_SEC: "3600",
  TEST_MARKET_DATA_URL: `${STUB}/data`,
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
    API: async (req: any) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/snapshot" && req.method === "GET") {
        api.gets++;
        return new MfResponse(JSON.stringify(api.latest), { headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/api/snapshot" && req.method === "POST") {
        if (req.headers.get("authorization") !== `Bearer ${SNAP_TOKEN}`) return new MfResponse("unauthorized", { status: 401 });
        const body = JSON.parse(await req.text());
        api.posts.push(body);
        // as the real API normalises it: source = body.source ?? body.schema, receivedAt = now
        api.latest = { ...body, version: 1, receivedAt: new Date().toISOString(), source: body.source ?? body.schema };
        return new MfResponse(JSON.stringify({ ok: true, ladders: body.ladders.length }), { headers: { "content-type": "application/json" } });
      }
      return new MfResponse("not found", { status: 404 });
    },
  },
});
const doStub = async () => {
  const ns = await mf.getDurableObjectNamespace("MAKER");
  return ns.get(ns.idFromName("maker"));
};
async function tick(): Promise<any> {
  const r = await (await doStub()).fetch("http://maker.internal/tick?schedule=0", { method: "POST" });
  const j: any = await r.json();
  if (r.status !== 200) throw new Error(`tick ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}
const doGet = async (path: string): Promise<any> => (await (await doStub()).fetch(`http://maker.internal${path}`)).json();
let seq = 1;
async function control(doc: Record<string, unknown>) {
  const kv = await mf.getKVNamespace("MAKER_KV");
  await kv.put("control", JSON.stringify({ seq: seq++, ...doc }));
}
/** Open orders of `owner` on a book, with the maker's own rule (packages/maker kuru.ts scanOpenOrders). */
async function openOrders(market: Address, owner: Address) {
  return (await scanOpenOrders({ pub: pub as any, dep: { multicall3: MULTICALL3 } as any }, market, owner, 300)).map((o) => ({ id: o.id, isBuy: o.isBuy, price: o.price }));
}
async function sendAs(account: ReturnType<typeof privateKeyToAccount>, to: Address, abi: any, functionName: string, args: readonly unknown[]) {
  const w = createWalletClient({ chain, transport, account });
  const h = await w.writeContract({ address: to, abi, functionName, args, chain, account } as never);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}

// ---------------------------------------------------------------- the Mac's state
let macState: any, imported: any, today: any, rollAt = 0, killAt = 0, tomorrowKey = "";
const macOrdersBefore = new Map<string, number>();

describe.skipIf(!RUN_IT)("cutover rehearsal: the Worker takes over the Mac maker's live ladder (anvil fork)", () => {
  beforeAll(async () => {
    macState = JSON.parse(readFileSync(join(MAC_VAR, "state.json"), "utf8"));
    const txs = existsSync(join(MAC_VAR, "txs.jsonl")) ? readFileSync(join(MAC_VAR, "txs.jsonl"), "utf8") : null;
    const prep = prepareImport(macState, txs);
    imported = prep.state;
    today = Object.values(imported.ladders as Record<string, any>).filter((l) => l.status === "active").sort((a, b) => b.date - a.date)[0];
    if (!today) throw new Error("the Mac state has no active ladder to take over");
    const off = STATIONS[today.station].utcOffsetMin;
    rollAt = Date.parse(`${today.isoDate}T12:00:30Z`) / 1000 - off * 60;
    killAt = today.stopAt - 90 + 5;
    tomorrowKey = `${today.station}:${addDays(today.isoDate, 1).replace(/-/g, "")}`;
    mkdirSync(join(RUN, "dist"), { recursive: true });
    const b = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", join(RUN, "dist")], { cwd: PKG, encoding: "utf8" });
    if (b.status !== 0) throw new Error(`bundle failed: ${b.stderr || b.stdout}`);
    process.env.FORECAST_CACHE_DIR = join(RUN, "fcache"); // keep the forecast HTTP cache out of the repo
    procs.push(spawn(ANVIL, ["--fork-url", "https://testnet-rpc.monad.xyz", "--port", String(ANVIL_PORT), "--retries", "8", "--fork-retry-backoff", "800", "--timeout", "60000", "--silent"], { stdio: "ignore" }));
    for (let t = Date.now(); ; ) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        if (Date.now() - t > 90_000) throw new Error("anvil did not start");
        await sleep(500);
      }
    }
    stubServer = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", STUB);
      if (u.pathname !== "/data") return (res.statusCode = 404), res.end();
      try {
        const d = await realData(u.searchParams.get("station")!, u.searchParams.get("date")!, Number(u.searchParams.get("now")));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(d));
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
    await new Promise<void>((r) => stubServer.listen(STUB_PORT, "127.0.0.1", () => r()));
    const now = await chainNow();
    if (now >= rollAt) throw new Error(`run this before ${new Date(rollAt * 1000).toISOString()} (the next roll of the Mac's ladder)`);
    say(`fork of Monad testnet at block ${await pub.getBlockNumber()} (chain time ${new Date(now * 1000).toISOString()}); taking over ${today.key} [${today.strikes}] (stopAt ${new Date(today.stopAt * 1000).toISOString()})`);
    say(`Mac state imported: ${Object.keys(imported.ladders).length} ladder(s); ${prep.notes.join("; ")}`);
    // fork-only roles, gas money, and the inventory the Mac's roll gave the real maker
    const owner = (await pub.readContract({ address: D.vault as Address, abi: ownable, functionName: "owner" })) as Address;
    for (const a of [owner, A.maker.address, A.operator.address, A.guardian.address]) await testc.setBalance({ address: a, value: parseEther("100") });
    await testc.impersonateAccount({ address: owner });
    const ow = createWalletClient({ chain, transport, account: owner });
    await pub.waitForTransactionReceipt({ hash: await ow.writeContract({ address: D.vault as Address, abi: vaultAbi, functionName: "setOperator", args: [A.operator.address, true], chain, account: owner } as never) });
    await testc.stopImpersonatingAccount({ address: owner });
    await warpTo((await chainNow()) + 120); // the AUSD faucet has one global 60 s cooldown (shared with live users)
    await sendAs(A.maker, D.ausdFaucet as Address, faucetAbi, "requestFunds", [A.maker.address]);
    await sendAs(A.maker, D.ausd as Address, erc20, "approve", [D.vault, maxUint256]);
    await sendAs(A.maker, D.ausd as Address, erc20, "approve", [D.kuruMarginAccount, maxUint256]);
    await sendAs(A.maker, D.kuruMarginAccount as Address, marginAbi, "deposit", [A.maker.address, D.ausd, 400_000_000n]);
    for (const k of today.strikes) {
      const s = today.series[k];
      await sendAs(A.maker, D.vault as Address, vaultAbi, "mintSet", [s.seriesId, 300_000_000n]);
      await sendAs(A.maker, s.yes, erc20, "approve", [D.kuruMarginAccount, maxUint256]);
      await sendAs(A.maker, D.kuruMarginAccount as Address, marginAbi, "deposit", [A.maker.address, s.yes, 300_000_000n]);
      macOrdersBefore.set(String(k), (await openOrders(s.market, REAL_MAKER)).length);
    }
    say(`fork-only setup: throwaway operator authorised on the vault (owner impersonated); throwaway maker: 10k AUSD from the faucet, 300 sets minted per strike, 300 YES per strike + 400 AUSD in the Kuru margin account. The real maker's open orders on the books: ${JSON.stringify(Object.fromEntries(macOrdersBefore))}`);
    // the API as it is now: the Mac's snapshot
    api.latest = await (await fetch("https://isotherm.pages.dev/api/snapshot")).json();
    mf = new Miniflare(mfOptions(vars()) as any);
    await mf.ready;
  }, 900_000);

  afterAll(async () => {
    await mf?.dispose().catch(() => undefined);
    stubServer?.close();
    for (const p of procs) p.kill("SIGTERM");
    await sleep(500);
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
    rmSync(RUN, { recursive: true, force: true });
  });

  it("1. import + arm; while the Mac is still publishing, the interlock keeps the tick in shadow", async () => {
    const kv = await mf.getKVNamespace("MAKER_KV");
    await kv.put("import:state", JSON.stringify(imported));
    await control({ importState: "import:state" });
    const r0 = await tick();
    expect(r0.control).toMatch(/imported live state from import:state/);
    await control({ live: true, confirm: A.maker.address });
    await mf.setOptions(mfOptions(vars({ MAKER_MODE: "live" })) as any);
    api.latest = { ...api.latest, source: "isotherm.snapshot/v1", receivedAt: new Date(Date.now() - 20_000).toISOString() };
    const r = await tick();
    expect(r.control).toMatch(/ARMED/);
    expect(r.interlock).toMatchObject({ checked: true, blocked: true });
    expect(r.mode).toBe("shadow");
    expect(r.txs).toEqual([]);
    expect(api.posts).toEqual([]);
    say(`1. imported (${r0.control}); armed; interlock "${r.interlock.detail}" -> shadow, 0 txs, nothing posted`);
  });

  it("2. the Mac stopped (> 300 s): the first live ticks quote the real books and publish through the binding", async () => {
    api.latest = { ...api.latest, receivedAt: new Date(Date.now() - 360_000).toISOString() };
    const r = await tick();
    expect(r.mode).toBe("live");
    expect(r.errors).toEqual([]);
    const lad = r.ladders.find((l: any) => l.key === today.key);
    const quoted = lad.strikes.filter((s: any) => s.desired && !("pull" in s.desired));
    expect(quoted.length).toBeGreaterThan(0);
    for (const s of quoted) {
      expect(s.action).toBe("quote");
      expect(s.resting.bid ?? 0).toBeLessThan(s.fair);
      expect(s.resting.ask ?? 1).toBeGreaterThan(s.fair);
    }
    expect(r.txs.every((t: any) => t.status === "success")).toBe(true);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toMatchObject({ source: "isotherm-maker-worker" });
    say(`2. first live tick: ${r.txs.length} txs (${r.txs.map((t: any) => t.label).join(" | ")}); snapshot posted (source ${api.posts[0].source})`);
    for (const s of lad.strikes) say(`   ${today.key} >=${s.k} fair ${s.fair} (${s.source}${s.flags.length ? `; ${s.flags}` : ""}) ${s.action} -> book ${s.resting.bid ?? "-"}/${s.resting.ask ?? "-"}`);
    const r2 = await tick();
    expect(r2.mode).toBe("live"); // its own snapshot does not trip the interlock
    expect(r2.interlock.blocked).toBe(false);
    expect(r2.txs).toEqual([]);
    say(`   next tick: live, interlock "${r2.interlock.detail}", 0 txs`);
  });

  it("3. the next 12:00 station time: tomorrow's ladder is rolled live from the real Polymarket ladder", async () => {
    await warpTo(rollAt);
    const r = await tick();
    expect(r.mode).toBe("live");
    expect(r.errors).toEqual([]);
    const roll = r.rolls.find((x: any) => x.key === tomorrowKey);
    expect(roll).toMatchObject({ ok: true });
    const labels = r.txs.map((t: any) => t.label);
    expect(labels[0]).toMatch(/^createLadder /);
    const tl = r.ladders.find((l: any) => l.key === tomorrowKey);
    expect(tl.status).toBe("active");
    expect(labels.filter((l: string) => /deployProxy/.test(l))).toHaveLength(tl.strikes.length);
    expect(labels.filter((l: string) => /setCanonicalMarket/.test(l))).toHaveLength(tl.strikes.length);
    expect(r.txs.every((t: any) => t.status === "success")).toBe(true);
    const st = await doGet("/status");
    const spent = st.budget.spent;
    expect(spent["maker:roll"]).toBeLessThanOrEqual(0.8);
    expect(spent["operator:roll"]).toBeLessThanOrEqual(0.5);
    expect(spent["marketCreator:roll"]).toBeLessThanOrEqual(0.8);
    const byKind: Record<string, number> = {};
    for (const t of r.txs) byKind[t.role] = +((byKind[t.role] ?? 0) + t.mon).toFixed(4);
    say(`3. ${localIso(rollAt, STATIONS[today.station].utcOffsetMin).slice(0, 16)} local: roll ${tomorrowKey} ${roll.steps.find((s: any) => s.step === "plan")?.detail.slice(0, 160)}`);
    say(`   ${r.txs.length} txs (${[...new Set(labels.map((l: string) => l.split(" ")[0]))].join(", ")}); MON by role ${JSON.stringify(byKind)}; meters ${JSON.stringify(spent)}`);
    for (const s of tl.strikes) say(`   ${tomorrowKey} >=${s.k} fair ${s.fair} (${s.source}${s.flags.length ? `; ${s.flags}` : ""}) ${s.action} -> book ${s.resting.bid ?? "-"}/${s.resting.ask ?? "-"}`);
  });

  it("4. the stop-quoting time: the kill switch empties today's books and withdraws the YES margin; tomorrow keeps quoting", async () => {
    await warpTo(killAt);
    const r = await tick();
    expect(r.mode).toBe("live");
    expect(r.kill).toEqual([expect.objectContaining({ key: today.key, leftOpen: 0, mode: "live" })]);
    for (const k of today.strikes) {
      const s = today.series[k];
      expect(await openOrders(s.market, A.maker.address)).toEqual([]);
      expect(await pub.readContract({ address: D.kuruMarginAccount as Address, abi: marginAbi, functionName: "getBalance", args: [A.maker.address, s.yes] })).toBe(0n);
      // the Mac's own orders (another key) are untouched on the fork
      expect((await openOrders(s.market, REAL_MAKER)).length).toBe(macOrdersBefore.get(String(k)));
    }
    const kills = r.txs.filter((t: any) => /^KILL|withdraw/.test(t.label));
    expect(r.ladders.find((l: any) => l.key === tomorrowKey)?.status).toBe("active");
    say(`4. ${localIso(killAt, STATIONS[today.station].utcOffsetMin).slice(0, 19)} local (stopAt - 85 s): kill ${JSON.stringify(r.kill)}; ${kills.map((t: any) => `${t.label} ${t.mon} MON`).join(" | ")}; every ${today.key} book is free of maker orders and the YES margin is 0; ${tomorrowKey} still active`);
    const r2 = await tick();
    expect(r2.kill).toEqual([]);
    expect(r2.txs.filter((t: any) => t.label.includes(`>=`) && /KILL/.test(t.label))).toEqual([]);
    await warpTo(killAt + 310);
    const r3 = await tick(); // the verify pass (every 300 s) re-scans the closed books
    expect(r3.kill).toEqual([]);
    say(`   next tick: no kill; +310 s verify pass: nothing left open`);
  });

  it("5. rollback: pull all cancels every quote, disarm returns to shadow and nothing more is sent", async () => {
    await control({ pull: "all" });
    const r = await tick();
    expect(r.control).toMatch(/pull all queued/);
    const tl = (await doGet("/status")).ladders.find((l: any) => l.key === tomorrowKey);
    expect(tl.paused).toBe(true);
    await control({ live: false });
    const r2 = await tick();
    expect(r2.mode).toBe("shadow");
    expect(r2.txs).toEqual([]);
    say(`5. pull all: ${r.txs.map((t: any) => t.label).join(" | ") || "nothing open"}; disarm -> ${r2.mode}, 0 txs`);
    const txs: any[] = await doGet("/log?name=txs:live&limit=500");
    writeFileSync(join(OUT, "txs.tsv"), ["#\trole\tlabel\tkind\tgasLimit\tMON\thash", ...txs.map((x, i) => [i + 1, x.role, x.label, x.kind, x.gasLimit, x.mon, x.hash].join("\t"))].join("\n") + "\n");
    const mon: Record<string, number> = {};
    for (const t of txs) mon[t.role] = +((mon[t.role] ?? 0) + t.mon).toFixed(4);
    say(`${txs.length} live txs on the fork (txs.tsv); MON by role ${JSON.stringify(mon)}`);
  });
});
