// JSON snapshot for the API/PWA: fair values, the Polymarket ladder, our quotes, the Kuru books, the observed max
// and the MON budget. Written to var/snapshot.json and POSTed to <api>/api/snapshot with a bearer token.
// Schema id: "isotherm.snapshot/v1" (documented in RESULT.md; example in examples/snapshot.example.json).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { formatEther } from "viem";
import { stringToHex } from "viem";
import { erc20Abi } from "./abis.ts";
import { read, type Ctx } from "./chain.ts";
import { marginBalance } from "./kuru.ts";
import type { LadderTick } from "./tick.ts";
import { STATIONS } from "../../forecast/src/stations.ts";

export const SNAPSHOT_SCHEMA = "isotherm.snapshot/v1";

export const HONESTY = [
  "Monad TESTNET only. AUSD here is free faucet test money; nothing has monetary value.",
  "Fair values are the Polymarket-implied probabilities. Our own v0 forecast does NOT beat Polymarket in backtest (Brier 0.0656 vs 0.0594); it is only a guardrail and a wider-spread fallback.",
  "Settlement rule matches Polymarket's resolved winner on 183/184 Taipei (RCSS) and 209/209 Tokyo (RJTT) station-sourced days.",
  "Maker fills are the house bot trading with users; they are reported separately and are not organic volume.",
];

const r4 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : +x.toFixed(4));

export async function buildSnapshot(ctx: Ctx, ticks: Map<string, LadderTick>) {
  const block = await ctx.pub.getBlock({ blockTag: "latest" });
  const [mon, ausd, ausdMargin] = await Promise.all([
    ctx.pub.getBalance({ address: ctx.addr.maker }),
    read<bigint>(ctx, ctx.dep.ausd, erc20Abi, "balanceOf", [ctx.addr.maker]),
    marginBalance(ctx, ctx.addr.maker, ctx.dep.ausd),
  ]);
  const ladders = [];
  const recent = Object.values(ctx.state.ladders)
    .filter((l) => l.status !== "closed" || Number(block.timestamp) - (l.closedAt ?? 0) < 36 * 3600)
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const lad of recent) {
    const t = ticks.get(lad.key);
    const d = t?.data ?? null;
    let result: { status: string; tmaxC: number | null } | null = null;
    try {
      const rr = await read<any>(ctx, ctx.dep.resolver, ctx.dep.resultAbi, "resultOf", [stringToHex(lad.station, { size: 4 }), lad.date]);
      result = { status: ["none", "settled", "void"][Number(rr.status)] ?? String(rr.status), tmaxC: Number(rr.status) === 1 ? Number(rr.tmaxC) : null };
    } catch {}
    const st = STATIONS[lad.station];
    ladders.push({
      key: lad.key,
      station: lad.station,
      city: st?.city ?? null,
      date: lad.isoDate,
      status: lad.status,
      paused: lad.paused ?? false,
      strikeList: lad.strikes,
      strikeSource: lad.strikeSource,
      closeTime: lad.closeTime,
      stopAt: lad.stopAt,
      dayEnd: lad.dayEnd,
      closeLocal: st ? new Date((lad.closeTime + st.utcOffsetMin * 60) * 1000).toISOString().slice(11, 16) : null,
      stopLocal: st ? new Date((lad.stopAt + st.utcOffsetMin * 60) * 1000).toISOString().slice(11, 16) : null,
      result,
      polymarket: d?.pm
        ? {
            url: d.pm.url,
            slug: d.pm.slug,
            volume: d.pm.volume,
            sumRaw: d.pm.sumRaw,
            fetchedAt: d.pm.fetchedAt,
            quoteSource: d.pm.quoteSource,
            ok: d.pm.ok,
            warnings: d.pm.warnings,
            median: d.pm.median,
            ladder: d.pm.ladder,
            buckets: d.pm.buckets.map((b) => ({ label: b.label, bid: b.bestBid, ask: b.bestAsk, price: r4(b.price), p: r4(b.p), source: b.priceSource })),
          }
        : lad.polymarket ? { url: lad.polymarket.url, slug: lad.polymarket.slug, stale: true } : null,
      observedMaxC: d?.obs?.tmaxC ?? null,
      observedAt: d?.obs?.lastObsUtc ? new Date(d.obs.lastObsUtc).toISOString() : null,
      forecast: d?.v0 ? { mu: d.v0.mu, role: "guardrail only (does not beat Polymarket)" } : null,
      observed: d?.obs ? { tmaxC: d.obs.tmaxC, nObs: d.obs.nObs, lastLocal: d.obs.lastLocal, atLocal: d.obs.atLocal, dayStarted: d.obs.dayStarted, fetchedAt: d.obs.fetchedAt } : null,
      v0: d?.v0 ? { mu: d.v0.mu, lead: d.v0.lead, residSd: d.v0.residSd, ladder: Object.fromEntries(lad.strikes.map((k) => [k, d.v0!.ladder[k] ?? null])), fetchedAt: d.v0.fetchedAt } : null,
      strikes: lad.strikes.map((k) => {
        const s = lad.series[k];
        const v = t?.strikes.find((x) => x.strike === k);
        const f = v?.fair ?? t?.fairs.find((x) => x.k === k) ?? null;
        const a = t?.actions.find((x) => x.strike === k);
        return {
          strike: k,
          seriesId: s?.seriesId ?? null,
          yes: s?.yes ?? null,
          no: s?.no ?? null,
          market: s?.market ?? null,
          marketBlock: s?.marketBlock ?? null,
          canonical: s?.canonical ?? null,
          mode: s?.mode ?? "pending",
          reason: s?.reason ?? null,
          fair: f?.fair ?? null,
          fairSource: f?.source ?? null,
          pm: f?.pm ?? null,
          pmImplied: f?.pm ?? null,
          pmCond: f?.pmCond ?? null,
          guard: f?.guard ?? null,
          model: f?.guard ?? null,
          guardSource: f?.guardSource ?? null,
          divergence: f?.divergence ?? null,
          flags: f?.flags ?? [],
          bid: s?.orders.bid?.price ?? null,
          bidSize: s?.orders.bid?.size ?? 0,
          ask: s?.orders.ask?.price ?? null,
          askSize: s?.orders.ask?.size ?? 0,
          quote: s?.orders.bid || s?.orders.ask ? { bid: s.orders.bid?.price ?? null, bidSize: s.orders.bid?.size ?? 0, ask: s.orders.ask?.price ?? null, askSize: s.orders.ask?.size ?? 0, at: s.lastQuote?.at ?? null } : null,
          resting: v?.resting ?? null,
          book: v?.book ? { bestBid: v.book.bestBid, bestAsk: v.book.bestAsk, bids: v.book.bids.slice(0, 5).map((l) => [l.price, +l.size.toFixed(6)]), asks: v.book.asks.slice(0, 5).map((l) => [l.price, +l.size.toFixed(6)]) } : null,
          inventory: v?.inventory ?? null,
          lastAction: a ? { kind: a.kind, reasons: a.reasons, tx: a.tx ?? null, error: a.error ?? null } : null,
        };
      }),
    });
  }
  const caps = ctx.cfg.budget.dailyCapMon;
  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: new Date().toISOString(),
    chainId: 10143,
    network: "monad-testnet",
    block: Number(block.number),
    blockTime: Number(block.timestamp),
    rpcKind: ctx.isAnvil ? "anvil-fork" : "public",
    honesty: HONESTY,
    maker: { address: ctx.addr.maker, mon: +Number(formatEther(mon)).toFixed(4), ausdWallet: Number(ausd) / 1e6, ausdMargin: Number(ausdMargin) / 1e6 },
    deployment: { variant: ctx.dep.variant, vault: ctx.dep.vault, resolver: ctx.dep.resolver, zap: ctx.dep.zap, kuruRouter: ctx.dep.kuruRouter, source: ctx.dep.source },
    budget: {
      day: ctx.state.budget.day,
      note: "testnet MON billed (gas limit x gas price) per role today; quotes stop at the cap, the close-time kill switch never does",
      byRole: Object.fromEntries(
        (["maker", "operator", "marketCreator"] as const).map((r) => [r, { key: ctx.keyNames[r], address: ctx.addr[r], spentMon: r4(ctx.state.budget.spent[r] ?? 0), capMon: caps[r] ?? null, txs: ctx.state.budget.txs[r] ?? 0 }]),
      ),
    },
    ladders,
    events: ctx.state.events.slice(-30),
  };
}

export type Snapshot = Awaited<ReturnType<typeof buildSnapshot>>;

export function writeSnapshot(file: string, snap: Snapshot) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(snap, null, 1));
  renameSync(file + ".tmp", file);
}

let warnedNoApi = false;
export async function postSnapshot(ctx: Ctx, snap: Snapshot): Promise<{ ok: boolean; status?: number; error?: string; skipped?: string }> {
  const url = ctx.cfg.api.url;
  const token = process.env[ctx.cfg.api.tokenEnv];
  if (!url || !token) {
    if (!warnedNoApi) ctx.log.info(`snapshot POST skipped: set ISOTHERM_API_URL and ${ctx.cfg.api.tokenEnv}`);
    warnedNoApi = true;
    return { ok: false, skipped: "no api url/token" };
  }
  try {
    const res = await fetch(url.replace(/\/$/, "") + ctx.cfg.api.path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(snap),
      signal: AbortSignal.timeout(ctx.cfg.api.timeoutMs),
    });
    if (!res.ok) ctx.log.warn(`snapshot POST ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    ctx.log.warn(`snapshot POST failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
    return { ok: false, error: String(e) };
  }
}
