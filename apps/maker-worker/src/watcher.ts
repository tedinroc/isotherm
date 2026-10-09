// CHALLENGE WATCHER, Worker edition (port of packages/cre-workflow/settle/ops/challenge-watch.ts, the Mac's
// xyz.isotherm.challenge-watch job). One pass every WATCH_EVERY_SEC from the maker tick:
//
//   1. Resolver LadderResolved / LadderChallenged events since the last pass, read in eth_getLogs pages of at most
//      100 blocks (Monad's limit), bounded by WATCH_LOOKBACK_BLOCKS; plus, every WATCH_BACKSTOP_SEC, the vault's newest
//      64 ladders (one multicall), so a missed event is still checked; non-final verdicts are re-examined.
//   2. Every resolved station-date is recomputed from the public METAR archives with the CRE workflow's own code:
//      sources.ts observe() -> toDayStats() -> settle-core decide() (IEM + AWC; Ogimet only if one is incomplete).
//   3. Settled, and the recompute SETTLES a different Tmax -> MISMATCH: alert, re-fetch after WATCH_RECHECK_SEC to rule
//      out a glitch, then -- ONLY in live mode, only with WATCH_AUTO_CHALLENGE on, only if the GUARDIAN_KEY secret is
//      set, matches Resolver.guardian() and holds the MON -- call challenge() inside the 900 s window. In shadow mode
//      the challenge is simulated and recorded as an intent. A recompute that cannot settle is UNVERIFIED: alert, no
//      automatic challenge (a challenge voids the ladder 0.5/0.5).
//   4. A reported Void is final at once on v1: recomputed, alerted if the rule would have settled it.
//   5. Liveness guardrails, for a vault ladder with NO result yet (the CRE settlement still runs off-Cloudflare):
//      - SETTLEMENT OVERDUE: chain time > Resolver.dayEnd + SETTLE_OVERDUE_SEC (3 h) -> alert, repeated per ladder at
//        most every SETTLE_OVERDUE_REPEAT_SEC (1 h); "OVERDUE CLEARED" once a result lands. Overdue ladders are
//        re-read every pass (not only at the backstop), so the clear is prompt.
//      - automatic stale void: chain time >= Resolver.staleAt(station, date) (day end + STALE_WINDOW 48 h, later after
//        an unpause) and the Resolver is NOT paused -> eth_call simulation of voidIfStale, then, ONLY in live mode with
//        AUTO_STALE_VOID on, send it from OPERATOR_KEY through the nonce tracker with gas = estimate x the operator
//        multiplier (1.10; the Worker refuses multipliers outside 1.05..1.10 because Monad bills the limit), within a
//        0.05 MON/day void meter, at most once per ladder per hour, with an alert either way. Shadow records an intent.
//        voidIfStale is permissionless: the operator key only pays the gas. A paused Resolver is never voided here.
// Safety: the LIVE guardian key, and the LIVE operator key for a void, are refused on a non-live RPC (a tx signed for
// chain 10143 on a fork is valid on live).
import { encodeFunctionData, formatEther, keccak256, parseAbi, stringToBytes, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { budgetDay } from "../../../packages/maker/src/budget.ts";
import { STATIONS, ymdToIso } from "../../../packages/forecast/src/stations.ts";
import { observe, sourceUrl, toDayStats, type SourceKind, type SourceStats } from "../../../packages/cre-workflow/settle/sources.ts";
import { decide } from "../../../packages/cre-workflow/settle/settle-core.ts";
import type { NonceSource } from "../../../packages/maker/src/chain.ts";
import { explainRevert } from "../../../packages/maker/src/chain.ts";
import type { SourceGet } from "./fetcher.ts";
import type { Store } from "./store.ts";

export const RESOLVER_WATCH_ABI = parseAbi([
  "event LadderResolved(bytes4 indexed station, uint32 indexed date, uint8 status, int16 tmaxC, bytes32 sourcesHash, address caller)",
  "event LadderChallenged(bytes4 indexed station, uint32 indexed date, int16 previousTmaxC, bytes32 reasonHash, address guardian)",
  "function resultOf(bytes4 station, uint32 date) view returns ((uint8 status, int16 tmaxC, uint64 resolvedAt, uint64 finalAt, bytes32 sourcesHash))",
  "function guardian() view returns (address)",
  "function challenge(bytes4 station, uint32 date, bytes32 reasonHash)",
  "function ladderCount() view returns (uint256)",
  "function ladderAt(uint256 index) view returns ((bytes4 station, uint32 date))",
  "function dayEnd(bytes4 station, uint32 date) view returns (uint256)",
  "function staleAt(bytes4 station, uint32 date) view returns (uint256)",
  "function paused() view returns (bool)",
  "function voidIfStale(bytes4 station, uint32 date)",
]);
const [EV_RESOLVED, EV_CHALLENGED] = [RESOLVER_WATCH_ABI[0], RESOLVER_WATCH_ABI[1]];
const STATUS = ["None", "Settled", "Void"] as const;
export const LOG_PAGE = 100; // Monad: eth_getLogs over at most 100 blocks
/** Log pages stop this many blocks behind the head: with several RPC endpoints (src/rpc.ts) the head can come from one
 *  endpoint and the page from another, and an endpoint answers a page past its own head with a truncated result and
 *  no error (seen on the public Monad testnet RPCs on 2026-10-09). The backstop scan re-reads results anyway. */
export const LOG_LAG = 5;
const MIN_EXTRA_WEI = 2_000_000_000_000_000n; // keep 0.002 MON above the billed gas
/** Resolver v1 constants (src/Resolver.sol; deployments/testnet.json params): staleAt >= dayEnd + STALE_WINDOW always. */
export const STALE_WINDOW_SEC = 172_800;
/** The CRE workflow's own VOID deadlines (packages/cre-workflow/settle/config.ts defaults voidAfterSec, hardVoidAfterSec). */
const WORKFLOW_VOID_SEC = 129_600;
const WORKFLOW_HARD_VOID_SEC = 165_600;
/** A stale-void attempt per ladder at most this often (whatever its outcome). */
export const VOID_RETRY_SEC = 3600;
/** Daily cap for automatic stale voids (Taipei day, MON billed = gas limit x gas price). One void on the anvil fork:
 *  76,537 gas used, limit 84,191 (estimate x 1.10), so about 0.0086 MON at 102 gwei: the cap allows 5 a day. */
export const VOID_DAILY_CAP_MON = 0.05;
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const hrs = (s: number) => (s / 3600).toFixed(1);

// ---------------------------------------------------------------- canonical source summary (CRE report.ts, verbatim rule)
export type NamedStats = { name: "IEM" | "AWC" | "OGIMET"; stats: (SourceStats | null) };
const fmtStats = (s: SourceStats | null): string =>
  s === null ? "-" : s.healthy === false ? "unavailable" : `${s.tmaxC === null ? "null" : s.tmaxC},${s.nObs},${s.nHours},${s.lastLocal ?? "-"},${s.complete ? 1 : 0}`;
/** isotherm-sources-v1|RCSS|20261005|SETTLED|IEM:29,50,24,23:30,1|AWC:29,50,24,23:30,1|OGIMET:- (= CRE canonicalSources). */
export const canonicalSources = (icao: string, date: number, status: string, sources: NamedStats[]): string =>
  ["isotherm-sources-v1", icao, String(date), status, ...sources.map((s) => `${s.name}:${fmtStats(s.stats)}`)].join("|");
export const reasonHashOf = (icao: string, date: number, reported: number, canonical: string) =>
  keccak256(stringToBytes(`isotherm-challenge-v1|${icao}|${date}|reported=${reported}|recomputed:${canonical}`));
export const bytes4ToStation = (b4: Hex) => {
  let s = "";
  for (let i = 2; i < 10; i += 2) s += String.fromCharCode(Number.parseInt(b4.slice(i, i + 2), 16));
  return s;
};

export interface Recompute {
  d: { status: "SETTLED" | "PENDING" | "VOID"; tmaxC: number | null; reason: string };
  canonical: string;
  usedOgimet: boolean;
  text: string;
}

const fmt = (s: SourceStats | null) => (s === null ? "not fetched" : !s.healthy ? "UNAVAILABLE" : `${s.tmaxC ?? "-"}C h=${s.nHours} last=${s.lastLocal ?? "-"} ${s.complete ? "complete" : "incomplete"}`);

/** The workflow's own decision for (icao, date), single node: observe() -> toDayStats() -> decide(). */
export async function recompute(icao: string, date: number, get: SourceGet): Promise<Recompute> {
  const st = STATIONS[icao];
  const ymd = ymdToIso(date);
  const one = async (kind: SourceKind) => {
    const a = await get(sourceUrl(kind, icao, ymd, st.utcOffsetMin, st.tzName));
    return toDayStats(observe(kind, a.body, ymd, st.utcOffsetMin, a.status));
  };
  const a = await one("iem");
  const b = await one("awc");
  const c = a.complete && b.complete ? null : await one("ogimet");
  const d = decide([a, b], c ? [c] : [], false);
  const canonical = canonicalSources(icao, date, d.status, [
    { name: "IEM", stats: a },
    { name: "AWC", stats: b },
    { name: "OGIMET", stats: c },
  ]);
  return { d, canonical, usedOgimet: c !== null, text: `IEM ${fmt(a)} | AWC ${fmt(b)} | OGIMET ${fmt(c)}` };
}

// ---------------------------------------------------------------- one pass
export interface Verdict {
  key: string;
  status: string;
  tmaxC: number;
  resolvedAt: number;
  finalAt: number;
  sourcesHash: Hex;
  verdict: string;
  final: boolean;
  detail: string;
  recomputed?: { status: string; tmaxC: number | null; reason: string; canonical: string };
  action?: string;
  checkedAt: string;
}
interface WatchState {
  lastBlock: number;
  results: Record<string, Verdict>;
  lastBackstopAt?: number;
  /** ladders with no result past day end + SETTLE_OVERDUE_SEC (entry made at the first alert, removed once resolved) */
  overdue?: Record<string, { dayEnd: number; firstAt: number; lastAlertAt: number; alerts: number }>;
  /** the last automatic stale-void attempt per ladder */
  voids?: Record<string, { at: number; outcome: string; hash?: Hex }>;
  /** the void meter (Taipei day) */
  voidSpend?: { day: string; mon: number; n: number };
}

/** A void tx for the engine's tx log and meters. */
export interface VoidTx {
  label: string;
  role: "operator";
  from: Address;
  hash: Hex;
  nonce: number;
  block: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
  mon: number; // billed: gas limit x effective gas price (unrounded; the engine meters it)
  status: string;
}

export interface WatchDeps {
  pub: PublicClient;
  store: Store;
  resolver: Address;
  vault: Address;
  stations: string[]; // stations the settlement rule is configured for (deployments/testnet.json)
  liveRpc: boolean;
  liveGuardian: Address; // deployments/testnet.json roles.guardian
  live: boolean; // the maker's mode for this tick
  guardian: PrivateKeyAccount | null;
  autoChallenge: boolean;
  lookbackBlocks: number;
  recheckSec: number;
  backstopSec: number;
  gasMult: number;
  sources: SourceGet;
  wallet: (account: PrivateKeyAccount) => { sendTransaction(args: any): Promise<Hex> };
  nonces: NonceSource;
  /** OPERATOR_KEY: pays for an automatic voidIfStale (live mode only). null = no key (alerts and intents only). */
  operator?: PrivateKeyAccount | null;
  liveOperator?: Address; // deployments/testnet.json roles.operator: refused on a non-live RPC
  overdueSec?: number; // default 10800
  overdueRepeatSec?: number; // default 3600
  autoStaleVoid?: boolean; // default true
  onVoidTx?(tx: VoidTx): void;
  alert(title: string, body: string): void;
  log(msg: string): void;
  sleep(ms: number): Promise<void>;
  now(): number; // ms
}

export interface WatchReport {
  from: number;
  head: number;
  pages: number;
  events: number;
  ladders: number | null;
  checked: number;
  verdicts: Verdict[];
  intents: { key: string; what: string; reasonHash?: Hex; gasLimit: string }[];
  challenges: { key: string; hash: Hex; ok: boolean }[];
  guardian: string;
  /** vault ladders with no result past day end + SETTLE_OVERDUE_SEC, as seen this pass */
  overdue: { key: string; hoursLate: number; staleAt: number | null }[];
  /** automatic stale-void attempts this pass */
  voids: { key: string; outcome: string; ok: boolean; hash?: Hex }[];
}

export async function watchPass(w: WatchDeps): Promise<WatchReport> {
  const state = w.store.get<WatchState>("watch:state") ?? { lastBlock: 0, results: {} };
  const latest = await w.pub.getBlock({ blockTag: "latest" });
  const head = Number(latest.number);
  const now = Number(latest.timestamp);
  const onchainGuardian = (await w.pub.readContract({ address: w.resolver, abi: RESOLVER_WATCH_ABI, functionName: "guardian" })) as Address;
  let guardianWhy = w.guardian ? `guardian key ${w.guardian.address}` : "no GUARDIAN_KEY secret";
  let guardian = w.guardian;
  if (guardian && !w.liveRpc && guardian.address.toLowerCase() === w.liveGuardian.toLowerCase()) {
    guardian = null;
    guardianWhy = "REFUSED: the LIVE guardian key on a non-live RPC";
  }
  const rep: WatchReport = { from: 0, head, pages: 0, events: 0, ladders: null, checked: 0, verdicts: [], intents: [], challenges: [], guardian: guardianWhy, overdue: [], voids: [] };

  // 1. events since the last pass, in <= 100-block pages
  const scanTo = Math.max(0, head - LOG_LAG);
  const from = Math.max(state.lastBlock + 1, scanTo - w.lookbackBlocks, 0);
  rep.from = from;
  const keys = new Map<string, { b4: Hex; date: number; via: string }>();
  const challengedSeen = new Set<string>();
  for (let f = from; f <= scanTo; f += LOG_PAGE) {
    const t = Math.min(f + LOG_PAGE - 1, scanTo);
    rep.pages++;
    const logs = (await w.pub.getLogs({ address: w.resolver, events: [EV_RESOLVED, EV_CHALLENGED], fromBlock: BigInt(f), toBlock: BigInt(t) })) as any[];
    for (const l of logs) {
      rep.events++;
      const k = `${bytes4ToStation(l.args.station)}:${l.args.date}`;
      if (l.eventName === "LadderChallenged") challengedSeen.add(k);
      w.log(`event ${l.eventName} ${k} (block ${l.blockNumber}, tx ${l.transactionHash})`);
      keys.set(k, { b4: l.args.station, date: Number(l.args.date), via: `event@${l.blockNumber}` });
    }
  }
  // 2. backstop: the vault's newest 64 ladders (one multicall), every backstopSec
  if (now * 1000 - (state.lastBackstopAt ?? 0) >= w.backstopSec * 1000) {
    const count = Number(await w.pub.readContract({ address: w.vault, abi: RESOLVER_WATCH_ABI, functionName: "ladderCount" }));
    rep.ladders = count;
    const idx = Array.from({ length: Math.min(64, count) }, (_, i) => BigInt(count - 1 - i));
    if (idx.length) {
      const refs = (await w.pub.multicall({ allowFailure: false, contracts: idx.map((i) => ({ address: w.vault, abi: RESOLVER_WATCH_ABI, functionName: "ladderAt", args: [i] }) as const) })) as unknown as { station: Hex; date: number }[];
      for (const r of refs) {
        const k = `${bytes4ToStation(r.station)}:${r.date}`;
        if (!keys.has(k) && !state.results[k]?.final) keys.set(k, { b4: r.station, date: Number(r.date), via: "backstop" });
      }
    }
    state.lastBackstopAt = now * 1000;
  }
  for (const [k, r] of Object.entries(state.results)) if (!r.final && !keys.has(k)) keys.set(k, { b4: stringToHex(k.split(":")[0], { size: 4 }), date: Number(k.split(":")[1]), via: "state" });
  // overdue ladders are re-read every pass: the clear (or the stale void) does not wait for the next backstop
  for (const k of Object.keys(state.overdue ?? {})) if (!keys.has(k)) keys.set(k, { b4: stringToHex(k.split(":")[0], { size: 4 }), date: Number(k.split(":")[1]), via: "overdue" });

  const record = (v: Verdict) => {
    state.results[v.key] = v;
    rep.verdicts.push(v);
  };
  const g = guardrails(w, state, rep, now);
  for (const [k, c] of keys) {
    const r = (await w.pub.readContract({ address: w.resolver, abi: RESOLVER_WATCH_ABI, functionName: "resultOf", args: [c.b4, c.date] })) as any;
    const status = STATUS[Number(r.status)];
    if (status === "None") {
      await g.unresolved(k, c);
      continue;
    }
    g.resolved(k, status, Number(r.tmaxC), Number(r.resolvedAt));
    const sig = `${status}:${r.tmaxC}:${r.resolvedAt}:${r.finalAt}`;
    const prev = state.results[k];
    if (prev && prev.final && `${prev.status}:${prev.tmaxC}:${prev.resolvedAt}:${prev.finalAt}` === sig) continue;
    rep.checked++;
    const icao = k.split(":")[0];
    const base = { key: k, status, tmaxC: Number(r.tmaxC), resolvedAt: Number(r.resolvedAt), finalAt: Number(r.finalAt), sourcesHash: r.sourcesHash as Hex, checkedAt: new Date(w.now()).toISOString() };
    const windowLeft = Number(r.finalAt) - now;
    if (!w.stations.includes(icao) || !STATIONS[icao]) {
      record({ ...base, verdict: "UNKNOWN-STATION", final: true, detail: "station not configured for the settlement rule: cannot recompute" });
      w.alert(`cannot verify ${k}`, `${status} ${r.tmaxC}: station ${icao} is not configured, so the watcher cannot recompute it.`);
      continue;
    }
    if (status === "Void") {
      if (challengedSeen.has(k) || Number(r.finalAt) > Number(r.resolvedAt)) {
        record({ ...base, verdict: "CHALLENGED", final: true, detail: "Void after a guardian challenge (finalAt > resolvedAt)" });
        continue;
      }
      if (/^0x0+$/.test(r.sourcesHash)) {
        record({ ...base, verdict: "STALE-VOID", final: true, detail: "voidIfStale (no sourcesHash)" });
        continue;
      }
      const x = await recompute(icao, c.date, w.sources);
      const settles = x.d.status === "SETTLED";
      record({ ...base, verdict: settles ? "VOID-BUT-RULE-SETTLES" : "VOID-CONSISTENT", final: true, detail: x.text, recomputed: { ...x.d, canonical: x.canonical } });
      if (settles) w.alert(`reported VOID for ${k}, but the rule settles ${x.d.tmaxC} C`, `A reported Void is final at once on v1: the guardian cannot challenge it.\nRecomputed: ${x.text}\nEscalate: the attester key may be compromised; rotate it from the owner key (setAttester).`);
      continue;
    }
    // Settled
    let x = await recompute(icao, c.date, w.sources);
    const mismatch = (y: Recompute) => y.d.status === "SETTLED" && y.d.tmaxC !== Number(r.tmaxC);
    if (x.d.status === "SETTLED" && x.d.tmaxC === Number(r.tmaxC)) {
      record({ ...base, verdict: "MATCH", final: true, detail: x.text, recomputed: { ...x.d, canonical: x.canonical } });
      w.log(`${k}: MATCH reported Settled ${r.tmaxC} == recomputed ${x.d.tmaxC} (${x.d.reason}); sourcesHash ${keccak256(stringToBytes(x.canonical)) === r.sourcesHash ? "matches" : "differs"}`);
      continue;
    }
    if (windowLeft <= 0) {
      const v = mismatch(x) ? "MISMATCH-WINDOW-CLOSED" : "UNVERIFIED-WINDOW-CLOSED";
      if (!prev || prev.verdict !== v) w.alert(`${v} ${k}`, `Reported Settled ${r.tmaxC}; recomputed ${x.d.status} ${x.d.tmaxC ?? ""} (${x.d.reason}).\n${x.text}\nThe challenge window closed at ${new Date(Number(r.finalAt) * 1000).toISOString()}: challenge() would revert. Owner actions only (rotate the attester).`);
      record({ ...base, verdict: v, final: Number(r.finalAt) + 3600 < now, detail: x.text, recomputed: { ...x.d, canonical: x.canonical } });
      continue;
    }
    if (!mismatch(x)) {
      if (!prev || prev.verdict !== "UNVERIFIED") w.alert(`UNVERIFIED ${k}: could not reproduce Settled ${r.tmaxC}`, `Recomputed ${x.d.status} (${x.d.reason}): ${x.text}\nNot challenged automatically (a challenge voids the ladder 0.5/0.5). Re-checked every pass until ${new Date(Number(r.finalAt) * 1000).toISOString()} (${windowLeft}s left).`);
      record({ ...base, verdict: "UNVERIFIED", final: false, detail: x.text, recomputed: { ...x.d, canonical: x.canonical } });
      continue;
    }
    // MISMATCH: confirm on a fresh fetch, then act
    w.alert(`MISMATCH ${k}: reported Settled ${r.tmaxC} C, the rule gives ${x.d.tmaxC} C`, `${x.text}\nre-fetching in ${w.recheckSec}s to rule out a glitch; challenge window ${windowLeft}s left`);
    await w.sleep((x.usedOgimet ? Math.max(w.recheckSec, 45) : w.recheckSec) * 1000);
    const y = await recompute(icao, c.date, w.sources);
    if (!mismatch(y)) {
      record({ ...base, verdict: "MISMATCH-NOT-REPRODUCED", final: false, detail: `first ${x.text} / re-fetch ${y.text}`, recomputed: { ...y.d, canonical: y.canonical } });
      continue;
    }
    x = y;
    const rh = reasonHashOf(icao, c.date, Number(r.tmaxC), x.canonical);
    const data = encodeFunctionData({ abi: RESOLVER_WATCH_ABI, functionName: "challenge", args: [c.b4, c.date, rh] });
    let action = "";
    let gasLimit = 80_000n;
    const from = guardian?.address ?? onchainGuardian;
    try {
      const est = await w.pub.estimateGas({ account: from, to: w.resolver, data });
      gasLimit = BigInt(Math.ceil(Number(est) * w.gasMult));
    } catch (e) {
      action = `estimateGas from ${from} failed: ${explainRevert(e)}`;
    }
    if (!action) {
      if (!w.live) action = "shadow mode: challenge NOT sent (would send it now)";
      else if (!w.autoChallenge) action = "WATCH_AUTO_CHALLENGE=0";
      else if (!guardian) action = guardianWhy;
      else if (guardian.address.toLowerCase() !== onchainGuardian.toLowerCase()) action = `guardian key ${guardian.address} != Resolver.guardian() ${onchainGuardian}`;
    }
    rep.intents.push({ key: k, what: `Resolver.challenge(${c.b4}, ${c.date}, reasonHash) from ${from}`, reasonHash: rh, gasLimit: gasLimit.toString() });
    if (!action && guardian) {
      const [bal, price] = await Promise.all([w.pub.getBalance({ address: guardian.address }), w.pub.getGasPrice()]);
      const need = gasLimit * price + MIN_EXTRA_WEI;
      if (bal < need) action = `guardian ${guardian.address} holds ${formatEther(bal)} MON < ${formatEther(need)} MON needed`;
      else {
        try {
          const nonce = await w.nonces.next(guardian.address, () => w.pub.getTransactionCount({ address: guardian!.address, blockTag: "pending" }));
          const hash = await w.wallet(guardian).sendTransaction({ account: guardian, to: w.resolver, data, gas: gasLimit, nonce });
          w.nonces.sent(guardian.address, nonce, hash, `challenge ${k}`);
          const rc = await w.pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 400 });
          w.nonces.mined(guardian.address, nonce, hash);
          const after = (await w.pub.readContract({ address: w.resolver, abi: RESOLVER_WATCH_ABI, functionName: "resultOf", args: [c.b4, c.date] })) as any;
          const ok = rc.status === "success" && Number(after.status) === 2;
          rep.challenges.push({ key: k, hash, ok });
          record({ ...base, verdict: ok ? "MISMATCH-CHALLENGED" : "MISMATCH-CHALLENGE-FAILED", final: ok, detail: x.text, recomputed: { ...x.d, canonical: x.canonical }, action: `challenge tx ${hash} status=${rc.status} gasUsed=${rc.gasUsed} gasLimit=${gasLimit}; resultOf now ${STATUS[Number(after.status)]}` });
          w.alert(ok ? `CHALLENGED ${k}` : `CHALLENGE FAILED ${k}`, `tx ${hash}; reasonHash ${rh}`);
          continue;
        } catch (e) {
          action = `challenge send failed: ${explainRevert(e)}`;
        }
      }
    }
    record({ ...base, verdict: "MISMATCH-NOT-CHALLENGED", final: false, detail: x.text, recomputed: { ...x.d, canonical: x.canonical }, action });
    w.alert(`MISMATCH ${k} NOT CHALLENGED automatically`, `Why: ${action}\nThe guardian must challenge before ${new Date(Number(r.finalAt) * 1000).toISOString()} (${Number(r.finalAt) - now}s left): Resolver.challenge(${c.b4}, ${c.date}, ${rh}) with gas limit ${gasLimit}.`);
  }
  state.lastBlock = Math.max(state.lastBlock, scanTo);
  // keep two weeks of verdicts (final ones older than that can never change again)
  for (const [k, v] of Object.entries(state.results)) if (v.final && now - v.resolvedAt > 14 * 86_400) delete state.results[k];
  // an overdue entry leaves when its ladder resolves; one still unresolved after 14 days (e.g. a long pause) is kept
  // while it is still seen, or every backstop would re-create it and re-alert every 10 min instead of hourly
  const seenOverdue = new Set(rep.overdue.map((o) => o.key));
  for (const [k, v] of Object.entries(state.overdue ?? {})) if (now - v.dayEnd > 14 * 86_400 && !seenOverdue.has(k)) delete state.overdue![k];
  for (const [k, v] of Object.entries(state.voids ?? {})) if (now - v.at > 14 * 86_400) delete state.voids![k];
  w.store.put("watch:state", state);
  return rep;
}

// ---------------------------------------------------------------- liveness guardrails (no result yet)
type LadderRef = { b4: Hex; date: number };

function guardrails(w: WatchDeps, state: WatchState, rep: WatchReport, now: number) {
  const overdueSec = w.overdueSec ?? 10_800;
  const repeatSec = w.overdueRepeatSec ?? 3600;
  const auto = w.autoStaleVoid ?? true;
  let paused: boolean | undefined;
  const isPaused = async () => (paused ??= (await w.pub.readContract({ address: w.resolver, abi: RESOLVER_WATCH_ABI, functionName: "paused" })) as boolean);
  const read = async <T>(functionName: "dayEnd" | "staleAt" | "resultOf", c: LadderRef) => (await w.pub.readContract({ address: w.resolver, abi: RESOLVER_WATCH_ABI, functionName, args: [c.b4, c.date] })) as T;

  const stage = (late: number) =>
    late < WORKFLOW_VOID_SEC
      ? "the settlement workflow retries hourly; on its own it voids only from day end + 36 h (healthy sources) or 46 h (backstop)"
      : late < WORKFLOW_HARD_VOID_SEC
        ? "past the workflow's 36 h VOID deadline: a running workflow that could not settle would void now, unless a source is failing"
        : "past the workflow's 46 h backstop: the settlement workflow is not delivering at all";

  async function unresolved(k: string, c: LadderRef) {
    let end: number;
    try {
      end = Number(await read<bigint>("dayEnd", c));
    } catch (e) {
      w.log(`${k}: Resolver.dayEnd unreadable (${explainRevert(e)}): no overdue check`);
      return;
    }
    if (now <= end + overdueSec) return; // not overdue (yet)
    state.overdue ??= {};
    const od = state.overdue[k];
    const alertDue = !od || now - od.lastAlertAt >= repeatSec;
    // staleAt >= dayEnd + STALE_WINDOW always, so before that nothing needs the extra reads except the alert text
    const mayBeStale = now >= end + STALE_WINDOW_SEC;
    let staleAt: number | null = null;
    if (alertDue || mayBeStale) staleAt = Number(await read<bigint>("staleAt", c));
    const p = staleAt !== null ? await isPaused() : false;
    rep.overdue.push({ key: k, hoursLate: +hrs(now - end), staleAt });
    if (alertDue) {
      const voidLine =
        staleAt === null
          ? ""
          : p
            ? `Stale void: the Resolver is PAUSED, so voidIfStale is blocked until ${iso(staleAt)} (day end + 7 d); this Worker never voids a paused Resolver.`
            : `Stale void: allowed from ${iso(staleAt)}${auto ? "; this Worker then sends Resolver.voidIfStale (live mode only; pays 0.5/0.5)" : "; AUTO_STALE_VOID=0, so call Resolver.voidIfStale by hand then (permissionless)"}.`;
      w.alert(
        `SETTLEMENT OVERDUE ${k}`,
        [
          `No result on the Resolver ${hrs(now - end)} h after the local day end (${iso(end)}). The CRE settlement normally lands from day end + 2 h.`,
          `Stage: ${stage(now - end)}.`,
          `Check the settlement job: "path" in its latest evidence record (packages/cre-workflow/var/evidence/LATEST.json) should be "official"; \`cre whoami\` should succeed; the attester needs about 0.0204 MON per report.`,
          voidLine,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      state.overdue[k] = { dayEnd: end, firstAt: od?.firstAt ?? now, lastAlertAt: now, alerts: (od?.alerts ?? 0) + 1 };
    }
    if (staleAt !== null && now >= staleAt) await staleVoid(k, c, end, staleAt, p);
  }

  function resolved(k: string, status: string, tmaxC: number, resolvedAt: number) {
    const od = state.overdue?.[k];
    if (!od) return;
    delete state.overdue![k];
    w.alert(`OVERDUE CLEARED ${k}`, `${status}${status === "Settled" ? ` ${tmaxC} C` : ""} at ${iso(resolvedAt)}, ${hrs(resolvedAt - od.dayEnd)} h after the local day end (${od.alerts} overdue alert(s) before).`);
  }

  async function staleVoid(k: string, c: LadderRef, end: number, staleAt: number, isPausedNow: boolean) {
    state.voids ??= {};
    const prev = state.voids[k];
    if (prev && now - prev.at < VOID_RETRY_SEC) return; // at most once per ladder per hour
    const what = `Resolver.voidIfStale(${c.b4}, ${c.date})`;
    const mark = (outcome: string, hash?: Hex) => (state.voids![k] = { at: now, outcome: outcome.slice(0, 300), ...(hash ? { hash } : {}) });
    const done = (outcome: string, ok = false, hash?: Hex) => {
      mark(outcome, hash);
      rep.voids.push({ key: k, outcome: outcome.slice(0, 300), ok, ...(hash ? { hash } : {}) });
    };
    if (isPausedNow) {
      done("held: the Resolver is paused");
      w.alert(`STALE VOID HELD ${k}`, `${what} is allowed by time (staleAt ${iso(staleAt)}) but the Resolver is PAUSED (guardian/owner emergency stop). This Worker never voids a paused Resolver: owner decision (unpause, or void by hand).`);
      return;
    }
    if (!auto) {
      done("AUTO_STALE_VOID=0: not sent");
      w.alert(`STALE VOID DUE ${k}`, `AUTO_STALE_VOID=0: call ${what} by hand (permissionless; pays 0.5/0.5). Allowed since ${iso(staleAt)}.`);
      return;
    }
    let op = w.operator ?? null;
    let opWhy = op ? `operator ${op.address}` : "no OPERATOR_KEY secret";
    if (op && !w.liveRpc && w.liveOperator && op.address.toLowerCase() === w.liveOperator.toLowerCase()) {
      op = null;
      opWhy = "REFUSED: the LIVE operator key on a non-live RPC";
    }
    const from = (op?.address ?? w.liveOperator ?? "0x0000000000000000000000000000000000000000") as Address;
    const data = encodeFunctionData({ abi: RESOLVER_WATCH_ABI, functionName: "voidIfStale", args: [c.b4, c.date] });
    // 1. simulate, 2. estimate: gas limit = ceil(estimate x the operator multiplier) (Monad bills the limit)
    let gasLimit: bigint;
    try {
      await w.pub.call({ account: from, to: w.resolver, data });
      const est = await w.pub.estimateGas({ account: from, to: w.resolver, data });
      gasLimit = BigInt(Math.ceil(Number(est) * w.gasMult));
    } catch (e) {
      done(`simulation reverted: ${explainRevert(e)}`);
      w.alert(`STALE VOID REFUSED ${k}`, `The eth_call simulation of ${what} from ${from} reverts: ${explainRevert(e)}. Nothing sent; retried in ${VOID_RETRY_SEC / 60} min.`);
      return;
    }
    rep.intents.push({ key: k, what: `${what} from ${from}`, gasLimit: gasLimit.toString() });
    if (!w.live) {
      done("shadow mode: not sent (would send it now)");
      w.alert(`STALE VOID DUE ${k} (shadow: not sent)`, `${what} simulates fine (gas limit ${gasLimit}); live mode would send it now from the operator key.`);
      return;
    }
    if (!op) {
      done(`not sent: ${opWhy}`);
      w.alert(`STALE VOID NOT SENT ${k}`, `Why: ${opWhy}. Anyone may call ${what} (permissionless; gas limit about ${gasLimit}).`);
      return;
    }
    // 3. the void meter and the balance
    const price = await w.pub.getGasPrice();
    const cost = gasLimit * price;
    const mon = Number(formatEther(cost));
    const day = budgetDay(now * 1000, 480);
    const meter = state.voidSpend?.day === day ? state.voidSpend : { day, mon: 0, n: 0 };
    if (meter.mon + mon > VOID_DAILY_CAP_MON + 1e-12) {
      done(`not sent: void meter ${meter.mon.toFixed(4)} + ${mon.toFixed(4)} MON > ${VOID_DAILY_CAP_MON} MON/day`);
      w.alert(`STALE VOID NOT SENT ${k}`, `The automatic void meter is spent for ${day} (${meter.mon.toFixed(4)} of ${VOID_DAILY_CAP_MON} MON). Anyone may call ${what} (permissionless).`);
      return;
    }
    const bal = await w.pub.getBalance({ address: op.address });
    if (bal < cost + MIN_EXTRA_WEI) {
      done(`not sent: operator ${op.address} holds ${formatEther(bal)} MON < ${formatEther(cost + MIN_EXTRA_WEI)} MON`);
      w.alert(`STALE VOID NOT SENT ${k}`, `The operator ${op.address} holds ${formatEther(bal)} MON, needs ${formatEther(cost + MIN_EXTRA_WEI)}. Fund it, or call ${what} from any funded wallet (permissionless).`);
      return;
    }
    // 4. send through the nonce tracker; the attempt is stored before the tx leaves
    mark("sending");
    w.store.put("watch:state", state);
    const label = `voidIfStale ${k}`;
    let hash: Hex | undefined;
    try {
      const nonce = await w.nonces.next(op.address, () => w.pub.getTransactionCount({ address: op!.address, blockTag: "pending" }));
      try {
        hash = await w.wallet(op).sendTransaction({ account: op, to: w.resolver, data, gas: gasLimit, nonce });
      } catch (e) {
        w.nonces.failed(op.address, nonce, explainRevert(e));
        throw e;
      }
      w.nonces.sent(op.address, nonce, hash, label);
      meter.mon = +(meter.mon + mon).toFixed(9); // billed at send: Monad charges the limit even on a revert
      meter.n++;
      state.voidSpend = meter;
      w.store.put("watch:state", state); // the meter survives a later failure in this pass
      const rc = await w.pub.waitForTransactionReceipt({ hash, timeout: 60_000, pollingInterval: 400 });
      w.nonces.mined(op.address, nonce, hash);
      // logged and metered on the receipt, before any further read can fail
      w.onVoidTx?.({ label, role: "operator", from: op.address, hash, nonce, block: rc.blockNumber, gasUsed: rc.gasUsed, gasLimit, mon: Number(formatEther(gasLimit * (rc.effectiveGasPrice ?? price))), status: rc.status });
      const after = await read<any>("resultOf", c);
      const ok = rc.status === "success" && Number(after.status) === 2 && /^0x0+$/.test(after.sourcesHash);
      done(ok ? "voided" : `tx ${rc.status}; resultOf now ${STATUS[Number(after.status)]}`, ok, hash);
      if (ok) delete state.overdue?.[k];
      w.alert(
        ok ? `STALE VOIDED ${k}` : `STALE VOID FAILED ${k}`,
        ok
          ? `${what} from the operator key: tx ${hash} (gas used ${rc.gasUsed} of limit ${gasLimit}). The ladder pays 0.5/0.5; redemption is open. No CRE result had landed ${hrs(now - end)} h after the local day end.`
          : `tx ${hash} status ${rc.status}; Resolver.resultOf is ${STATUS[Number(after.status)]}. Retried in ${VOID_RETRY_SEC / 60} min if still unresolved.`,
      );
    } catch (e) {
      done(`${hash ? "error after broadcast" : "send failed"}: ${explainRevert(e)}`, false, hash);
      w.alert(`STALE VOID FAILED ${k}`, `${what}: ${explainRevert(e)}${hash ? ` (tx ${hash} was broadcast and may still land; the next pass reads Resolver.resultOf)` : ""}. Retried in ${VOID_RETRY_SEC / 60} min if still unresolved.`);
    }
  }

  return { unresolved, resolved };
}
