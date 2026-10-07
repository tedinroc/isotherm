// Maker configuration: config/default.json, deep-merged with config/local.json (if present) or $MAKER_CONFIG, then
// a few env overrides. Paths are relative to the package root unless absolute.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StrikePolicy } from "../../forecast/src/polymarket.ts";

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(PKG_ROOT, "../..");

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
  budget: { dayUtcOffsetMin: number; dailyCapMon: Record<Role, number>; reserveMon: Record<Role, number>; minBalanceMon: number };
  quote: QuoteCfg;
  policy: { requoteTicks: number; staleHours: number; refillRatio: number; preStopSec: number };
  fair: { pmMaxAgeSec: number; guardWarn: number; guardPull: number; intradayFromMin: number; minCondMass: number };
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

function deepMerge<T>(a: T, b: any): T {
  if (b === undefined || b === null || typeof b !== "object" || Array.isArray(b)) return (b ?? a) as T;
  const out: any = Array.isArray(a) ? [...(a as any)] : { ...(a as any) };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" ? deepMerge(out[k], v) : v;
  return out;
}

export function resolvePath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : join(PKG_ROOT, p);
}

export function loadConfig(overrides: any = {}): MakerConfig {
  let cfg = JSON.parse(readFileSync(join(PKG_ROOT, "config/default.json"), "utf8"));
  const extra = process.env.MAKER_CONFIG ?? join(PKG_ROOT, "config/local.json");
  if (existsSync(extra)) cfg = deepMerge(cfg, JSON.parse(readFileSync(extra, "utf8")));
  if (process.env.MAKER_RPC ?? process.env.RPC_URL) cfg.rpc = process.env.MAKER_RPC ?? process.env.RPC_URL;
  if (process.env.ISOTHERM_API_URL) cfg.api.url = process.env.ISOTHERM_API_URL;
  if (process.env.MAKER_STATE) cfg.paths.state = process.env.MAKER_STATE;
  if (process.env.MAKER_VAR) for (const k of Object.keys(cfg.paths)) cfg.paths[k] = join(process.env.MAKER_VAR, cfg.paths[k].replace(/^var\//, ""));
  if (process.env.MAKER_STATIONS) cfg.stations = process.env.MAKER_STATIONS.split(",").map((s) => s.trim().toUpperCase());
  cfg = deepMerge(cfg, overrides);
  cfg.allowLive = process.env.ISOTHERM_ALLOW_LIVE === "1";
  cfg.dryRun = Boolean(cfg.dryRun);
  for (const k of Object.keys(cfg.paths)) cfg.paths[k] = resolvePath(cfg.paths[k]);
  cfg.keysDir = resolvePath(cfg.keysDir);
  validateConfig(cfg);
  return cfg as MakerConfig;
}

export function validateConfig(c: MakerConfig) {
  const q = c.quote;
  const ratio = q.tick / q.kuruTick;
  if (Math.abs(ratio - Math.round(ratio)) > 1e-9) throw new Error(`quote.tick ${q.tick} must be a multiple of the Kuru tick ${q.kuruTick}`);
  if (!(q.minPrice > 0 && q.maxPrice < 1 && q.minPrice < q.maxPrice)) throw new Error("quote.minPrice/maxPrice must satisfy 0 < min < max < 1");
  if (q.halfSpreadTicks < 1) throw new Error("quote.halfSpreadTicks must be >= 1");
  if (c.gas.makerMult < 1 || c.gas.opMult < 1 || c.gas.makerMult > 1.5 || c.gas.opMult > 1.5) throw new Error("gas multipliers must be in [1, 1.5] (Monad bills the gas limit)");
  if (c.chainId !== 10143) throw new Error("this maker only runs on Monad testnet (10143)");
}
