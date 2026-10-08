// The Worker's text GET for packages/forecast (TextGetter): the same TTL contract as the Node http.ts fetchText,
// cached in memory for the isolate and, for TTLs of 10 minutes or more (the immutable Open-Meteo year chunks, the
// v0 history), in the Durable Object's SQL cache, so an evicted isolate does not download 1.3 MB again.
import type { FetchOpts, TextGetter } from "../../../packages/forecast/src/fetch-types.ts";
import type { Store } from "./store.ts";

export const USER_AGENT = "isotherm/1.0 (testnet weather-strike market maker; keyless public data)";
const MEM_MAX = 64;

export interface FetcherOpts {
  store?: Store | null;
  now?: () => number;
  fetch?: typeof fetch;
}

export function makeGetter(o: FetcherOpts = {}): TextGetter & { stats: { hits: number; storeHits: number; misses: number } } {
  const now = o.now ?? (() => Date.now());
  const doFetch = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const mem = new Map<string, { at: number; body: string }>();
  const stats = { hits: 0, storeHits: 0, misses: 0 };
  const get = async (url: string, opts: FetchOpts = {}): Promise<string> => {
    const ttlMs = (opts.ttlSec ?? Infinity) * 1000;
    const t = now();
    if (ttlMs > 0) {
      const m = mem.get(url);
      if (m && t - m.at < ttlMs) {
        stats.hits++;
        return m.body;
      }
      if (o.store && ttlMs >= 600_000) {
        const c = o.store.cacheGet(url);
        if (c && t - c.at < ttlMs) {
          stats.storeHits++;
          remember(url, c);
          return c.body;
        }
      }
    }
    stats.misses++;
    const retries = opts.retries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        if (ttlMs > 0) {
          remember(url, { at: now(), body });
          if (o.store && ttlMs >= 600_000) o.store.cachePut(url, body, now());
        }
        return body;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 750 * 2 ** attempt));
      }
    }
    throw new Error(`fetch failed after ${retries + 1} tries: ${url}: ${String(lastErr)}`);
  };
  function remember(url: string, v: { at: number; body: string }) {
    mem.delete(url);
    mem.set(url, v);
    while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value as string);
  }
  return Object.assign(get, { stats });
}

/** A settlement-source GET as the CRE workflow's node mode sees it: status + body, never throws (status 0 = transport
 *  error). The test proxy (loopback forks only) serves recorded archive answers. */
export type SourceGet = (url: string) => Promise<{ status: number; body: string }>;

export function makeSourceGet(o: { proxy: string | null; fetch?: typeof fetch; timeoutMs?: number; agent?: string }): SourceGet {
  const doFetch = o.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return async (url) => {
    const target = o.proxy ? `${o.proxy}${o.proxy.includes("?") ? "&" : "?"}url=${encodeURIComponent(url)}` : url;
    try {
      const res = await doFetch(target, { headers: { "User-Agent": o.agent ?? "isotherm-challenge-watch/1.0" }, signal: AbortSignal.timeout(o.timeoutMs ?? 25_000) });
      return { status: res.status, body: await res.text() };
    } catch {
      return { status: 0, body: "" };
    }
  };
}
