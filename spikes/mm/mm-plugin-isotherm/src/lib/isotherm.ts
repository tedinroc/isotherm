// Shared Isotherm config + helpers for the mm plugin (spike).
// Chain reads go through the host's authenticated client when it can serve
// Monad testnet, and fall back to a direct public RPC otherwise (mm 7.0.0's
// hosted gateway answers HTTP 400 "Invalid chainId" for 10143).
import { createPublicClient, erc20Abi, http, type Address, type PublicClient } from "viem";

export const MONAD_TESTNET_ID = 10143;
export const DEFAULT_RPC = "https://testnet-rpc.monad.xyz";
export const AUSD: Address = "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC";
export const KURU_ROUTER: Address = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";

export type City = {
  key: string;
  name: string;
  station: string; // METAR station Polymarket resolves on
  lat: number;
  lon: number;
  tz: string;
};

export const CITIES: Record<string, City> = {
  taipei: { key: "taipei", name: "Taipei", station: "RCSS", lat: 25.0697, lon: 121.5525, tz: "Asia/Taipei" },
  tokyo: { key: "tokyo", name: "Tokyo", station: "RJTT", lat: 35.5523, lon: 139.7797, tz: "Asia/Tokyo" },
  seoul: { key: "seoul", name: "Seoul", station: "RKSS", lat: 37.5583, lon: 126.7906, tz: "Asia/Seoul" },
  hongkong: { key: "hongkong", name: "Hong Kong", station: "VHHH", lat: 22.308, lon: 113.9185, tz: "Asia/Hong_Kong" },
};

export function resolveCity(raw: string): City | undefined {
  return CITIES[raw.trim().toLowerCase().replace(/[\s_-]/g, "")];
}

export type ChainReader = {
  client: PublicClient;
  source: "mm-gateway" | "direct-rpc";
  rpcUrl?: string;
  gatewayError?: string;
};

/**
 * Prefer ctx.publicClient(10143) (wallet-read capability). If the host can't
 * serve the chain (no session projectId, or gateway rejects the chainId), fall
 * back to a plain viem client on the public Monad testnet RPC.
 */
export async function chainReader(
  hostClient: (() => PublicClient) | undefined,
  rpcOverride?: string,
): Promise<ChainReader> {
  let gatewayError: string | undefined;
  if (hostClient && !rpcOverride) {
    try {
      const client = hostClient();
      const id = await withTimeout(client.getChainId(), 8000);
      if (id === MONAD_TESTNET_ID) return { client, source: "mm-gateway" };
      gatewayError = `gateway returned chainId ${id}`;
    } catch (e) {
      gatewayError = shortErr(e);
    }
  }
  const rpcUrl = rpcOverride || process.env.ISOTHERM_RPC_URL || DEFAULT_RPC;
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }) }) as PublicClient;
  return { client, source: "direct-rpc", rpcUrl, ...(gatewayError ? { gatewayError } : {}) };
}

export async function readAusd(client: PublicClient, holder?: Address) {
  const [symbol, decimals, totalSupply, balance] = await Promise.all([
    client.readContract({ address: AUSD, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: AUSD, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: AUSD, abi: erc20Abi, functionName: "totalSupply" }),
    holder
      ? client.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [holder] })
      : Promise.resolve(undefined),
  ]);
  return { symbol, decimals, totalSupply, balance };
}

export type Forecast = { date: string; tmaxC: number; source: string };

/** Open-Meteo daily max-temperature forecast for the city's local "tomorrow" (falls back to today). */
export async function forecastTmax(city: City): Promise<Forecast> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
    `&daily=temperature_2m_max&timezone=${encodeURIComponent(city.tz)}&forecast_days=2`;
  const res = await withTimeout(fetch(url), 10_000);
  if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
  const body = (await res.json()) as { daily?: { time: string[]; temperature_2m_max: number[] } };
  const d = body.daily;
  if (!d || d.time.length === 0) throw new Error("open-meteo returned no daily data");
  const i = d.time.length > 1 ? 1 : 0;
  return { date: d.time[i], tmaxC: d.temperature_2m_max[i], source: "open-meteo:temperature_2m_max" };
}

/** P(Tmax_int >= k) under N(mu, sigma) with METAR integer rounding (k - 0.5 boundary). */
export function ladder(mu: number, sigma = 1.6, width = 3) {
  const center = Math.round(mu);
  const rungs = [];
  for (let k = center - width; k <= center + width; k++) {
    const p = 1 - normCdf((k - 0.5 - mu) / sigma);
    rungs.push({ strike: `Tmax>=${k}C`, k, fairYes: round4(p), fairNo: round4(1 - p) });
  }
  return rungs;
}

function normCdf(z: number) {
  // Abramowitz-Stegun 7.1.26 erf approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function shortErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0].slice(0, 240);
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function formatUnits6(v: bigint, decimals: number) {
  const s = v.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}
