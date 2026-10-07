// The house maker's published snapshot (GET <ISOTHERM_API_URL>/api/snapshot, posted by the maker about every 60 s):
// per strike, the fair value the maker quotes around (normally the Polymarket-implied probability) and the maker's
// guard model (Isotherm v0, bias-corrected). DISPLAY ONLY: nothing here sizes a trade, sets a min-out or picks a
// market. Those always come from the chain (L2 book walk, canonical registry). A snapshot strike is used only when
// it is fresh and its seriesId and market agree with what the plugin read on-chain.
import { shortErr, withTimeout } from "./util.js";
import { GUARDRAIL_GAP } from "./weather.js";

export const DEFAULT_API_URL = "<former API host>";
/** The maker posts about every 60 s; older than this and the plugin falls back to its own live Polymarket read. */
export const SNAPSHOT_MAX_AGE_S = 600;

/** ISOTHERM_API_URL overrides the API (https, or http on localhost for tests); "off" disables the snapshot. */
export function apiBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.ISOTHERM_API_URL ?? "").trim();
  if (/^(off|none|0|false|disabled)$/i.test(raw)) return null;
  try {
    const u = new URL(raw || DEFAULT_API_URL);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function maxAgeS(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ISOTHERM_SNAPSHOT_MAX_AGE_S);
  return Number.isFinite(n) && n > 0 ? n : SNAPSHOT_MAX_AGE_S;
}

export type MakerStrike = {
  k: number;
  seriesId: string | null;
  market: string | null;
  fair: number | null;
  /** maker's FairSource: "polymarket" | "certain" | "fallback-v0" | "fallback-intraday" (inferred when the API omits it) */
  fairSource: string | null;
  pmImplied: number | null;
  guard: number | null;
  guardSource: string | null;
  bid: number | null;
  ask: number | null;
  mode: string | null;
  flags: string[];
};

export type MakerLadder = {
  url: string;
  station: string;
  date: number;
  generatedAt: string;
  ageS: number;
  stale: boolean;
  forecastMu: number | null;
  strikes: MakerStrike[];
};

const p01 = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.length ? v.slice(0, max) : null);
const FALLBACK_FLAGS = ["no-polymarket-market", "pm-stale-or-degraded", "pm-strike-not-on-grid"];

/** The API (v1) drops the maker's fairSource; recover it from the fields it keeps. */
export function inferFairSource(s: { fairSource?: unknown; fair: number | null; pmImplied: number | null; flags: string[] }): string | null {
  const given = str(s.fairSource, 40);
  if (given) return given;
  if (s.fair === null) return null;
  if (s.flags.includes("observed-max>=k")) return "certain";
  if (s.flags.some((f) => FALLBACK_FLAGS.includes(f)) || s.pmImplied === null) return "fallback-model";
  return "polymarket";
}

/** Pure: pick the (station, date) ladder out of a GET /api/snapshot body. Unit-tested on a captured response. */
export function pickMakerLadder(
  body: unknown,
  station: string,
  date: number,
  url: string,
  nowMs = Date.now(),
  maxAge = SNAPSHOT_MAX_AGE_S,
): { ladder: MakerLadder | null; error?: string } {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (o.empty === true) return { ladder: null, error: "the maker has not published a snapshot yet" };
  if (Number(o.chainId ?? 10143) !== 10143) return { ladder: null, error: `snapshot is for chain ${String(o.chainId)}, not 10143` };
  const lads = Array.isArray(o.ladders) ? o.ladders : [];
  const l = lads.find((x) => x && typeof x === "object" && (x as any).station === station && Number((x as any).date) === date) as Record<string, unknown> | undefined;
  if (!l) return { ladder: null, error: `the maker snapshot has no ${station} ${date} ladder` };
  const genRaw = str(o.generatedAt, 40) ?? str(o.receivedAt, 40);
  const gen = genRaw ? Date.parse(genRaw) : NaN;
  if (!Number.isFinite(gen)) return { ladder: null, error: "the maker snapshot has no valid generatedAt" };
  const ageS = Math.max(0, Math.round((nowMs - gen) / 1000));
  const strikes: MakerStrike[] = [];
  for (const raw of Array.isArray(l.strikes) ? l.strikes : []) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const k = num(s.k ?? s.strike ?? s.strikeC);
    if (k === null || !Number.isInteger(k)) continue;
    const flags = Array.isArray(s.flags) ? s.flags.filter((f): f is string => typeof f === "string").slice(0, 8) : [];
    const fair = p01(s.fair);
    const pmImplied = p01(s.pmImplied ?? s.pm);
    const sid = str(s.seriesId, 66);
    const mkt = str(s.market, 42);
    strikes.push({
      k,
      seriesId: sid && /^0x[0-9a-fA-F]{64}$/.test(sid) ? sid.toLowerCase() : null,
      market: mkt && /^0x[0-9a-fA-F]{40}$/.test(mkt) ? mkt : null,
      fair,
      fairSource: inferFairSource({ fairSource: s.fairSource, fair, pmImplied, flags }),
      pmImplied,
      guard: p01(s.guard ?? s.model),
      guardSource: str(s.guardSource, 40),
      bid: p01(s.bid),
      ask: p01(s.ask),
      mode: str(s.mode, 40),
      flags,
    });
  }
  strikes.sort((a, b) => a.k - b.k);
  return {
    ladder: {
      url,
      station,
      date,
      generatedAt: new Date(gen).toISOString(),
      ageS,
      stale: ageS > maxAge,
      forecastMu: num(l.forecastMu),
      strikes,
    },
  };
}

export async function makerSnapshot(station: string, date: number, nowMs = Date.now()): Promise<{ ladder: MakerLadder | null; url: string | null; error?: string }> {
  const base = apiBaseUrl();
  if (!base) return { ladder: null, url: null, error: "maker snapshot disabled (ISOTHERM_API_URL=off or not https)" };
  const url = `${base}/api/snapshot`;
  try {
    const res = await withTimeout(fetch(url, { headers: { accept: "application/json", "user-agent": "mm-plugin-isotherm" } }), 6000, new URL(url).host);
    if (!res.ok) return { ladder: null, url, error: `maker snapshot: HTTP ${res.status} from ${new URL(url).host}` };
    const text = await res.text();
    if (text.length > 1_000_000) return { ladder: null, url, error: "maker snapshot: response too large" };
    const r = pickMakerLadder(JSON.parse(text), station, date, url, nowMs, maxAgeS());
    return { ...r, url };
  } catch (e) {
    return { ladder: null, url, error: `maker snapshot unavailable: ${shortErr(e)}` };
  }
}

// ------------------------------------------------------------------------------------------- reference choice
export const GUARDRAIL_ROLE =
  "GUARDRAIL ONLY: a sanity check, not a forecast and not a fair value. Isotherm's v0 forecast loses to Polymarket in backtest (Brier 0.0656 vs 0.0594, 381 station-days).";
export const GUARDRAIL_MODELS = {
  "maker-snapshot": "isotherm-v0 from the maker snapshot (rolling per-model bias correction, empirical residuals)",
  "plugin-v0-lite":
    "isotherm-v0-lite, computed locally by the plugin: raw Open-Meteo 4-model mean, sigma ~1.5 C, NO bias correction. Cruder than v0 and often far from Polymarket; used only when the maker snapshot is unavailable.",
} as const;

export type Reference = {
  /** The price the house maker quotes around: the fresh maker snapshot's fair, else the plugin's own Polymarket read. */
  fairValue: number | null;
  fairValueSource: "maker-snapshot" | "polymarket-live" | null;
  /** What the fair value is made of: "polymarket" (implied, possibly conditioned on today's observed max), "certain", or a model fallback. */
  fairValueBasis: string | null;
  /** What `weather edge` compares the book with: Polymarket-based only, never a model. */
  marketRef: number | null;
  marketRefSource: "maker-snapshot" | "polymarket-live" | null;
  guardrail: { p: number | null; source: keyof typeof GUARDRAIL_MODELS | null; basis: string | null; flag: boolean };
};

/** Pure. Preference: fresh maker snapshot > the plugin's live Polymarket read; guardrail: maker v0 > plugin v0-lite. */
export function chooseReference(maker: MakerStrike | null, pmLive: number | null, v0Lite: number | null): Reference {
  const mFair = maker && maker.fair !== null ? maker.fair : null;
  const mBasis = maker?.fairSource ?? null;
  const marketBased = mBasis === "polymarket" || mBasis === "certain";
  const fairValue = mFair ?? pmLive;
  const fairValueSource = mFair !== null ? "maker-snapshot" : pmLive !== null ? "polymarket-live" : null;
  const marketRef = mFair !== null && marketBased ? mFair : pmLive;
  const marketRefSource = mFair !== null && marketBased ? "maker-snapshot" : pmLive !== null ? "polymarket-live" : null;
  const gMaker = maker && maker.guard !== null ? maker.guard : null;
  const gp = gMaker ?? v0Lite;
  const gSource = gMaker !== null ? "maker-snapshot" : v0Lite !== null ? "plugin-v0-lite" : null;
  return {
    fairValue,
    fairValueSource,
    fairValueBasis: mFair !== null ? mBasis : pmLive !== null ? "polymarket" : null,
    marketRef,
    marketRefSource,
    guardrail: {
      p: gp,
      source: gSource,
      basis: gMaker !== null ? maker?.guardSource ?? "v0" : v0Lite !== null ? "v0-lite" : null,
      flag: gp !== null && marketRef !== null && Math.abs(gp - marketRef) > GUARDRAIL_GAP,
    },
  };
}

/** For `weather doctor`: is the maker snapshot reachable and fresh? (Optional: quotes fall back without it.) */
export async function snapshotStatus(nowMs = Date.now()): Promise<{ ok: boolean; detail: string }> {
  const base = apiBaseUrl();
  if (!base) return { ok: false, detail: "disabled (ISOTHERM_API_URL=off or not https); fair values come from the plugin's own Polymarket read" };
  const url = `${base}/api/snapshot`;
  try {
    const res = await withTimeout(fetch(url, { headers: { accept: "application/json", "user-agent": "mm-plugin-isotherm" } }), 6000, new URL(url).host);
    if (!res.ok) return { ok: false, detail: `${url}: HTTP ${res.status}` };
    const j = (await res.json()) as { generatedAt?: string; ladders?: { station?: string; date?: number }[] };
    const gen = Date.parse(String(j?.generatedAt ?? ""));
    const age = Number.isFinite(gen) ? Math.max(0, Math.round((nowMs - gen) / 1000)) : null;
    const lads = (j?.ladders ?? []).map((l) => `${l.station} ${l.date}`).join(", ") || "none";
    const fresh = age !== null && age <= maxAgeS();
    return { ok: fresh, detail: `${url}: generated ${age === null ? "?" : `${age}s`} ago (limit ${maxAgeS()}s), ladders ${lads}${fresh ? "" : "; stale, so quotes use the plugin's own Polymarket read"}` };
  } catch (e) {
    return { ok: false, detail: `${url}: ${shortErr(e)}` };
  }
}
