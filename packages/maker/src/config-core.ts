// Maker configuration types, deep merge and validation (runtime-agnostic: no Node APIs). config.ts (Node) loads the
// JSON files and env overrides and re-exports everything here; the Cloudflare Worker bundles config/default.json and
// merges its own overlay with the same functions.
import type { StrikePolicy } from "../../forecast/src/polymarket-core.ts";

export type Role = "maker" | "operator" | "marketCreator";

export interface QuoteCfg {
  tick: number; // the maker's price grid (0.01 = whole cents); must be a multiple of kuruTick
  kuruTick: number; // Kuru market tick (0.001)
  halfSpreadTicks: number;
  minPrice: number;
  maxPrice: number;
  pullBelow: number; // fair at/below this -> no quotes (outcome ~known)
  pullAbove: number;
  guardWidenMult: number;
  fallbackWidenMult: number;
  sizeYes: number;
  maxPositionYes: number; // |net YES delta| cap per strike
  skewTicksAtCap: number;
  minOrderYes: number;
}

export interface MakerConfig {
  rpc: string;
  chainId: number;
  stations: string[];
  keysDir: string;
  roles: { maker: string; operator: string; operatorFallback: string; marketCreator: "operator" | "maker" | string };
  paths: { state: string; snapshot: string; log: string; lock: string; heartbeat: string };
  api: { url: string | null; path: string; tokenEnv: string; timeoutMs: number };
  gas: { makerMult: number; opMult: number; fixedGasPriceGwei: number | null };
  budget: {
    dayUtcOffsetMin: number;
    dailyCapMon: Record<Role, number>; // quoting (and, without rollCapMon, the roll too)
    reserveMon: Record<Role, number>;
    minBalanceMon: number;
    /** Separate daily cap for the ladder roll per role. When set, roll spend (kind "roll") is metered apart from quoting,
     *  so a day of re-quotes can never block the next day's roll (the 2026-10-08 incident). Absent = one shared meter. */
    rollCapMon?: Partial<Record<Role, number>> | null;
    /** Budget tiers on the quoting meter (budget.ts quotingTier): above softRatio x dailyCapMon the spreads widen by
     *  softWidenMult and only urgent re-quotes are sent; at the cap no new quotes (urgent strikes are pulled). Absent = off. */
    softRatio?: number | null;
    softWidenMult?: number | null;
  };
  quote: QuoteCfg;
  /** requoteTicks: re-quote when the desired price or the fair moved >= requoteTicks x quote.tick since the resting
   *  quote (per runtime: the Worker sets its own in config/worker.json). `lazy` replaces those rules (policy.ts): re-quote
   *  only when urgent, after a fill, when the fair moved >= requoteFairMove since the quote, or when the quote is older
   *  than staleRefreshHours and the fair moved >= staleRefreshMinMove. `oneSided`: replace only the side that needs it
   *  (a fill, a crossed side) when the other side is still good (Kuru batchUpdate; 55-66 % of a full re-quote's gas). */
  policy: {
    requoteTicks: number;
    staleHours: number;
    refillRatio: number;
    preStopSec: number;
    lazy?: boolean | null;
    requoteFairMove?: number | null;
    staleRefreshHours?: number | null;
    staleRefreshMinMove?: number | null;
    oneSided?: boolean | null;
  };
  /** guardWarnExit: guard-wide hysteresis (see forecast/src/fair.ts FairCfg); absent/null = none. */
  fair: { pmMaxAgeSec: number; guardWarn: number; guardWarnExit?: number | null; guardPull: number; intradayFromMin: number; minCondMass: number };
  roll: {
    strikePolicy: Partial<StrikePolicy>;
    mintSets: number;
    marginYes: number;
    marginAusd: number;
    closeMarginMin: number;
    faucetIfAusdBelow: number;
    maxDaysAhead: number;
    minLeadMin: number;
    kuru: { type: number; sizePrecision: string; pricePrecision: number; tickSize: number; minSize: string; maxSize: string; takerFeeBps: string; makerFeeBps: string; kuruAmmSpread: string };
  };
  replenish: { enabled: boolean; minFreeYes: number; mintSets: number; minFreeAusd: number; topUpAusd: number };
  afterClose: { withdrawYes: boolean };
  loop: { tickSec: number; watchdogSec: number; v0RefreshSec: number; obsTtlSec: number; pmTtlSec: number; heartbeatStaleSec: number };
  allowLive: boolean; // env ISOTHERM_ALLOW_LIVE=1: required to broadcast to a non-anvil RPC
  dryRun: boolean;
}

export function deepMerge<T>(a: T, b: any): T {
  if (b === undefined || b === null || typeof b !== "object" || Array.isArray(b)) return (b ?? a) as T;
  const out: any = Array.isArray(a) ? [...(a as any)] : { ...(a as any) };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" ? deepMerge(out[k], v) : v;
  return out;
}

export function validateConfig(c: MakerConfig) {
  const q = c.quote;
  const ratio = q.tick / q.kuruTick;
  if (Math.abs(ratio - Math.round(ratio)) > 1e-9) throw new Error(`quote.tick ${q.tick} must be a multiple of the Kuru tick ${q.kuruTick}`);
  if (!(q.minPrice > 0 && q.maxPrice < 1 && q.minPrice < q.maxPrice)) throw new Error("quote.minPrice/maxPrice must satisfy 0 < min < max < 1");
  if (q.halfSpreadTicks < 1) throw new Error("quote.halfSpreadTicks must be >= 1");
  if (c.gas.makerMult < 1 || c.gas.opMult < 1 || c.gas.makerMult > 1.5 || c.gas.opMult > 1.5) throw new Error("gas multipliers must be in [1, 1.5] (Monad bills the gas limit)");
  if (c.chainId !== 10143) throw new Error("this maker only runs on Monad testnet (10143)");
  if (!(c.policy.requoteTicks >= 1)) throw new Error(`policy.requoteTicks ${c.policy.requoteTicks} must be >= 1`);
  const P = c.policy;
  if (P.lazy) {
    if (!(typeof P.requoteFairMove === "number" && P.requoteFairMove > 0 && P.requoteFairMove <= 0.5)) throw new Error(`policy.requoteFairMove ${P.requoteFairMove} must be in (0, 0.5] when policy.lazy is on`);
    if (!(typeof P.staleRefreshHours === "number" && P.staleRefreshHours > 0)) throw new Error(`policy.staleRefreshHours ${P.staleRefreshHours} must be > 0 when policy.lazy is on`);
    if (!(typeof P.staleRefreshMinMove === "number" && P.staleRefreshMinMove >= 0 && P.staleRefreshMinMove <= P.requoteFairMove)) throw new Error(`policy.staleRefreshMinMove ${P.staleRefreshMinMove} must be in [0, requoteFairMove]`);
  }
  const sr = c.budget.softRatio;
  if (sr !== undefined && sr !== null && !(sr > 0 && sr < 1)) throw new Error(`budget.softRatio ${sr} must be in (0, 1)`);
  const sw = c.budget.softWidenMult;
  if (sw !== undefined && sw !== null && !(sw >= 1 && sw <= 4)) throw new Error(`budget.softWidenMult ${sw} must be in [1, 4]`);
  const exit = c.fair.guardWarnExit;
  if (exit !== undefined && exit !== null && !(exit > 0 && exit <= c.fair.guardWarn)) throw new Error(`fair.guardWarnExit ${exit} must be in (0, guardWarn ${c.fair.guardWarn}]`);
}
