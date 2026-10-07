// Addresses, ABIs and cities. Nothing here talks to the network.
//
// Deployment selection (first match wins):
//   1. env ISOTHERM_DEPLOYMENTS=<path to a deployments JSON>          (tests, forks, a newer deploy)
//   2. assets/deployments.testnet.json  (copied from repo deployments/testnet.json at build time)
//   3. assets/deployments.feasibility.json (the 2026-10-06 feasibility deployment; always shipped)
// ABI set: env ISOTHERM_ABI_DIR, else the deployment's "abiSet" field, else assets/abi (copied from
// packages/abi at build) when the deployment is the bundled testnet.json, else assets/abi-feasibility.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Abi, type Address, type Hex } from "viem";

export const CHAIN_ID = 10143;
export const PUBLIC_RPC = "https://testnet-rpc.monad.xyz";
export const EXPLORER = "https://testnet.monadexplorer.com";

/** Live-testnet addresses that do not depend on an Isotherm deployment (verified on chain 2026-10-06). */
export const EXTERNAL = {
  ausd: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" as Address, // 6 dp, EIP-712 "Agora Dollar" v1
  ausdFaucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as Address,
  kuruRouter: "0x7EFbE105Ca7415dE98F96622173458ac1c054630" as Address,
  marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as Address,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
} as const;

/**
 * What a canonical Isotherm YES/AUSD book must look like. Mirrors IsothermZap v1 `validateMarket` (6/6 decimals,
 * pricePrecision 1e4, sizePrecision 1e6, taker fee <= 30 bps, maker fee <= taker fee), so the feasibility Zap,
 * which has no registry, gets the same protection client-side (security review finding #4).
 */
export const CANONICAL_BOOK = {
  pricePrecision: 10_000n,
  sizePrecision: 1_000_000n,
  baseDecimals: 6n,
  quoteDecimals: 6n,
  maxTakerFeeBps: 30n,
} as const;

// ------------------------------------------------------------------------------------------- cities
export type City = {
  key: string;
  name: string;
  station: string; // METAR station the ladder settles on
  utcOffsetMin: number; // fixed offset (no DST at any of these stations)
  lat: number;
  lon: number;
  tz: string;
  polymarketCity: string; // slug fragment of Polymarket's "highest-temperature-in-<city>-on-..." events
  fidelity: string; // our settlement rule vs Polymarket's resolved bucket, station-sourced days
};

export const CITIES: Record<string, City> = {
  taipei: { key: "taipei", name: "Taipei", station: "RCSS", utcOffsetMin: 480, lat: 25.069, lon: 121.552, tz: "Asia/Taipei", polymarketCity: "taipei", fidelity: "183/184 RCSS days match Polymarket" },
  tokyo: { key: "tokyo", name: "Tokyo", station: "RJTT", utcOffsetMin: 540, lat: 35.553, lon: 139.781, tz: "Asia/Tokyo", polymarketCity: "tokyo", fidelity: "209/209 RJTT days match Polymarket" },
  shenzhen: { key: "shenzhen", name: "Shenzhen", station: "ZGSZ", utcOffsetMin: 480, lat: 22.639, lon: 113.811, tz: "Asia/Shanghai", polymarketCity: "shenzhen", fidelity: "not measured" },
  seoul: { key: "seoul", name: "Seoul", station: "RKSI", utcOffsetMin: 540, lat: 37.469, lon: 126.451, tz: "Asia/Seoul", polymarketCity: "seoul", fidelity: "not measured" },
};

export function resolveCity(raw: string): City | undefined {
  const k = String(raw ?? "").trim().toLowerCase().replace(/[\s_-]/g, "");
  if (CITIES[k]) return CITIES[k];
  return Object.values(CITIES).find((c) => c.station.toLowerCase() === k);
}

export function cityByStation(station: string): City | undefined {
  return Object.values(CITIES).find((c) => c.station === station);
}

// ------------------------------------------------------------------------------------------- package root
function findPkgRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pj = join(d, "package.json");
    if (existsSync(pj) && existsSync(join(d, "assets"))) {
      try {
        if (JSON.parse(readFileSync(pj, "utf8")).name === "mm-plugin-isotherm") return d;
      } catch {}
    }
    d = dirname(d);
  }
  throw new Error("mm-plugin-isotherm: cannot locate the package root (assets/ missing)");
}
export const PKG_ROOT = findPkgRoot();
export const ASSETS = join(PKG_ROOT, "assets");

// ------------------------------------------------------------------------------------------- deployments
export type Deployment = {
  source: string; // where it was read from
  label: string; // "testnet (bundled)", "feasibility (bundled)", "env:<path>"
  chainId: number;
  vault: Address;
  resolver: Address;
  zap?: Address;
  ausd: Address;
  ausdFaucet: Address;
  kuruRouter: Address;
  marginAccount: Address;
  multicall3: Address;
  /** seriesId (lowercase) -> canonical Kuru market, when the deployment file lists them. */
  markets: Record<string, Address>;
  abiDir: string;
  abiSet: string;
  warnings: string[];
};

type Found = { path: string[]; key: string; value: Address };
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const B32_RE = /^0x[0-9a-fA-F]{64}$/;

function collectAddresses(node: unknown, path: string[] = [], out: Found[] = []): Found[] {
  if (Array.isArray(node)) node.forEach((x, i) => collectAddresses(x, [...path, String(i)], out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === "string" && ADDR_RE.test(v)) {
        const key = k.toLowerCase() === "address" && path.length ? path[path.length - 1] : k;
        out.push({ path: [...path, k], key, value: getAddress(v) });
      } else collectAddresses(v, [...path, k], out);
    }
  }
  return out;
}

function collectMarkets(node: unknown, out: Record<string, Address>, underMarkets = false) {
  if (Array.isArray(node)) {
    for (const x of node) collectMarkets(x, out, underMarkets);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  // { seriesId|id: 0x…32, market|kuruMarket|book: 0x…20 }
  const idKey = Object.keys(o).find((k) => /^(series_?id|id)$/i.test(k) && typeof o[k] === "string" && B32_RE.test(o[k] as string));
  const mkKey = Object.keys(o).find((k) => /(market|book)/i.test(k) && typeof o[k] === "string" && ADDR_RE.test(o[k] as string));
  if (idKey && mkKey) out[(o[idKey] as string).toLowerCase()] = getAddress(o[mkKey] as string);
  for (const [k, v] of Object.entries(o)) {
    // { markets: { "0x<seriesId>": "0x<market>" } }
    if (underMarkets && B32_RE.test(k) && typeof v === "string" && ADDR_RE.test(v)) out[k.toLowerCase()] = getAddress(v);
    else if (underMarkets && B32_RE.test(k) && v && typeof v === "object") {
      const m = Object.entries(v as Record<string, unknown>).find(([kk, vv]) => /(market|book)/i.test(kk) && typeof vv === "string" && ADDR_RE.test(vv));
      if (m) out[k.toLowerCase()] = getAddress(m[1] as string);
    }
    collectMarkets(v, out, underMarkets || /market|ladder|series/i.test(k));
  }
}

function pick(found: Found[], patterns: RegExp[], exclude?: RegExp): Address | undefined {
  for (const re of patterns) {
    const hit = found.find((f) => re.test(f.key) && !(exclude && exclude.test(f.key)));
    if (hit) return hit.value;
  }
  return undefined;
}

export function normalizeDeployment(raw: unknown, source: string, label: string, abiDirDefault: string): Deployment {
  const found = collectAddresses(raw);
  const warnings: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const vault = pick(found, [/^collateralvault$/i, /^vault$/i, /vault/i], /kuru|backstop|amm/i);
  const resolver = pick(found, [/^resolver$/i, /resolver/i]);
  const zap = pick(found, [/^isothermzap$/i, /^zap$/i, /zap/i], /kuru/i);
  if (!vault) throw new Error(`deployment ${source}: no CollateralVault address found`);
  if (!resolver) throw new Error(`deployment ${source}: no Resolver address found`);
  if (!zap) warnings.push("no IsothermZap address in the deployment: weather buy/sell are disabled");
  const markets: Record<string, Address> = {};
  collectMarkets(raw, markets);
  const chainId = Number(r.chainId ?? r.chain_id ?? CHAIN_ID);
  if (chainId !== CHAIN_ID) throw new Error(`deployment ${source} is for chain ${chainId}; this plugin only serves Monad testnet ${CHAIN_ID}`);
  const abiSetRaw = typeof r.abiSet === "string" ? r.abiSet : undefined;
  const abiDir = process.env.ISOTHERM_ABI_DIR
    ? resolve(process.env.ISOTHERM_ABI_DIR)
    : abiSetRaw
      ? join(ASSETS, abiSetRaw === "feasibility" ? "abi-feasibility" : abiSetRaw)
      : abiDirDefault;
  return {
    source,
    label,
    chainId,
    vault,
    resolver,
    zap,
    ausd: pick(found, [/^ausd$/i, /^collateral(token)?$/i]) ?? EXTERNAL.ausd,
    ausdFaucet: pick(found, [/faucet/i]) ?? EXTERNAL.ausdFaucet,
    kuruRouter: pick(found, [/^kururouter$/i, /kuru.*router/i, /^router$/i]) ?? EXTERNAL.kuruRouter,
    marginAccount: pick(found, [/margin/i]) ?? EXTERNAL.marginAccount,
    multicall3: pick(found, [/multicall/i]) ?? EXTERNAL.multicall3,
    markets,
    abiDir,
    abiSet: abiSetRaw ?? (abiDir.endsWith("abi-feasibility") ? "feasibility" : "v1"),
    warnings,
  };
}

let cached: Deployment | undefined;
export function loadDeployment(): Deployment {
  if (cached) return cached;
  const env = process.env.ISOTHERM_DEPLOYMENTS;
  const bundledAbi = join(ASSETS, "abi");
  const feasAbi = join(ASSETS, "abi-feasibility");
  const haveBundledAbi = existsSync(bundledAbi) && readdirSync(bundledAbi).some((f) => f.endsWith(".json"));
  if (env) {
    const p = isAbsolute(env) ? env : resolve(env);
    cached = normalizeDeployment(JSON.parse(readFileSync(p, "utf8")), p, `env:${p}`, haveBundledAbi ? bundledAbi : feasAbi);
  } else if (existsSync(join(ASSETS, "deployments.testnet.json"))) {
    const p = join(ASSETS, "deployments.testnet.json");
    cached = normalizeDeployment(JSON.parse(readFileSync(p, "utf8")), p, "testnet (bundled)", haveBundledAbi ? bundledAbi : feasAbi);
  } else {
    const p = join(ASSETS, "deployments.feasibility.json");
    cached = normalizeDeployment(JSON.parse(readFileSync(p, "utf8")), p, "feasibility (bundled)", feasAbi);
  }
  return cached;
}

/** Test hook. */
export function _resetDeploymentCache() {
  cached = undefined;
}

// ------------------------------------------------------------------------------------------- ABIs
const abiCache = new Map<string, Abi>();
export function loadAbi(name: "CollateralVault" | "Resolver" | "IsothermZap" | "OutcomeToken", dep = loadDeployment()): Abi {
  const key = `${dep.abiDir}:${name}`;
  const hit = abiCache.get(key);
  if (hit) return hit;
  const tryFiles = [join(dep.abiDir, `${name}.json`), join(ASSETS, "abi-feasibility", `${name}.json`)];
  for (const f of tryFiles) {
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8"));
    const abi = (Array.isArray(j) ? j : j.abi) as Abi | undefined;
    if (Array.isArray(abi)) {
      abiCache.set(key, abi);
      return abi;
    }
  }
  throw new Error(`ABI ${name} not found in ${dep.abiDir}`);
}

export type AbiFn = Extract<Abi[number], { type: "function" }>;
export function abiFunction(abi: Abi, name: string): AbiFn | undefined {
  return abi.find((x) => x.type === "function" && x.name === name) as AbiFn | undefined;
}

export function asAddress(v: string, what = "address"): Address {
  if (!isAddress(v)) throw new Error(`'${v}' is not a valid ${what}`);
  return getAddress(v);
}

export const isBytes32 = (v: string): v is Hex => B32_RE.test(v);
