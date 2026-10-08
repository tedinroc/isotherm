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
// Safety: the LIVE guardian key is refused on a non-live RPC (a tx signed for chain 10143 on a fork is valid on live).
import { encodeFunctionData, formatEther, keccak256, parseAbi, stringToBytes, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
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
]);
const [EV_RESOLVED, EV_CHALLENGED] = [RESOLVER_WATCH_ABI[0], RESOLVER_WATCH_ABI[1]];
const STATUS = ["None", "Settled", "Void"] as const;
export const LOG_PAGE = 100; // Monad: eth_getLogs over at most 100 blocks
const MIN_EXTRA_WEI = 2_000_000_000_000_000n; // keep 0.002 MON above the billed gas

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
  intents: { key: string; what: string; reasonHash: Hex; gasLimit: string }[];
  challenges: { key: string; hash: Hex; ok: boolean }[];
  guardian: string;
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
  const rep: WatchReport = { from: 0, head, pages: 0, events: 0, ladders: null, checked: 0, verdicts: [], intents: [], challenges: [], guardian: guardianWhy };

  // 1. events since the last pass, in <= 100-block pages
  const from = Math.max(state.lastBlock + 1, head - w.lookbackBlocks, 0);
  rep.from = from;
  const keys = new Map<string, { b4: Hex; date: number; via: string }>();
  const challengedSeen = new Set<string>();
  for (let f = from; f <= head; f += LOG_PAGE) {
    const t = Math.min(f + LOG_PAGE - 1, head);
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

  const record = (v: Verdict) => {
    state.results[v.key] = v;
    rep.verdicts.push(v);
  };
  for (const [k, c] of keys) {
    const r = (await w.pub.readContract({ address: w.resolver, abi: RESOLVER_WATCH_ABI, functionName: "resultOf", args: [c.b4, c.date] })) as any;
    const status = STATUS[Number(r.status)];
    if (status === "None") continue;
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
  state.lastBlock = head;
  // keep two weeks of verdicts (final ones older than that can never change again)
  for (const [k, v] of Object.entries(state.results)) if (v.final && now - v.resolvedAt > 14 * 86_400) delete state.results[k];
  w.store.put("watch:state", state);
  return rep;
}
