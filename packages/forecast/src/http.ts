// Cached, polite HTTP fetcher. Zero dependencies (Node >= 22.18 runs this .ts directly).
// Cache key = sha1(url). Immutable data (closed days / resolved markets) uses ttlSec = Infinity.
// Read-only SEED caches (e.g. the weather spike's 72 MB cache) are consulted for immutable entries first, so the
// 2-year IEM/Ogimet archives are not downloaded again.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchOpts } from "./fetch-types.ts";

export type { FetchOpts } from "./fetch-types.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = process.env.FORECAST_CACHE_DIR ?? join(ROOT, "data", "cache");
const SEED_DIRS = (process.env.FORECAST_SEED_CACHE ?? join(ROOT, "../../spikes/weather/data/cache")).split(":").filter(Boolean);

const hostLast = new Map<string, number>();
const HOST_GAP_MS: Record<string, number> = {
  "mesonet.agron.iastate.edu": 1500, // IEM asks for gentle use
  "aviationweather.gov": 700,
  "www.ogimet.com": 5000, // free service that blocks aggressive clients
  "gamma-api.polymarket.com": 100,
  "clob.polymarket.com": 100,
};

async function politeWait(host: string) {
  const gap = HOST_GAP_MS[host] ?? 150;
  const now = Date.now();
  const next = Math.max(now, (hostLast.get(host) ?? 0) + gap);
  hostLast.set(host, next);
  if (next > now) await new Promise((r) => setTimeout(r, next - now));
}

export const stats = { hits: 0, seedHits: 0, misses: 0 };

function cachePath(dir: string, url: string) {
  const host = new URL(url).host;
  const key = createHash("sha1").update(url).digest("hex");
  return join(dir, host, key + ".txt");
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const ttl = opts.ttlSec ?? Infinity;
  const file = cachePath(CACHE_DIR, url);
  if (ttl > 0 && existsSync(file)) {
    const ageSec = (Date.now() - statSync(file).mtimeMs) / 1000;
    if (ageSec < ttl) {
      stats.hits++;
      return readFileSync(file, "utf8");
    }
  }
  if (ttl === Infinity) {
    for (const seed of SEED_DIRS) {
      const f = cachePath(seed, url);
      if (existsSync(f)) {
        stats.seedHits++;
        return readFileSync(f, "utf8");
      }
    }
  }
  stats.misses++;
  const host = new URL(url).host;
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await politeWait(host);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "isotherm/1.0 (testnet weather-strike market maker; keyless public data)" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      if (ttl > 0) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file + ".tmp", body);
        renameSync(file + ".tmp", file);
        writeFileSync(file.replace(/\.txt$/, ".url"), url + "\n");
      }
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 750 * 2 ** attempt));
    }
  }
  throw new Error(`fetch failed after ${retries + 1} tries: ${url}: ${String(lastErr)}`);
}

export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  return JSON.parse(await fetchText(url, opts)) as T;
}

/** Run fn over items with bounded concurrency, preserving order. */
export async function pmap<T, R>(items: T[], conc: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) {
      const j = i++;
      out[j] = await fn(items[j], j);
    }
  });
  await Promise.all(workers);
  return out;
}

export function writeJson(rel: string, obj: unknown) {
  const p = rel.startsWith("/") ? rel : join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify(obj, null, 1) + "\n");
  renameSync(p + ".tmp", p);
  return p;
}

export function readJson<T = any>(rel: string): T {
  return JSON.parse(readFileSync(rel.startsWith("/") ? rel : join(ROOT, rel), "utf8"));
}
