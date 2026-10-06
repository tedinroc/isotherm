// Cached, polite HTTP fetcher. Zero dependencies (Node >= 22.18 runs this .ts directly).
// Cache key = sha1(url). Immutable data (closed days / resolved markets) uses ttlSec = Infinity.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "data", "cache");

export interface FetchOpts {
  ttlSec?: number; // default: Infinity (never refetch)
  retries?: number;
  timeoutMs?: number;
}

const hostLast = new Map<string, number>();
const HOST_GAP_MS: Record<string, number> = {
  "mesonet.agron.iastate.edu": 1500, // IEM asks for gentle use
  "aviationweather.gov": 700,
  "www.ogimet.com": 5000, // free service that blocks aggressive clients
  "gamma-api.polymarket.com": 60,
  "clob.polymarket.com": 60,
};

async function politeWait(host: string) {
  const gap = HOST_GAP_MS[host] ?? 150;
  // serialize per-host spacing even under concurrency
  const now = Date.now();
  const next = Math.max(now, (hostLast.get(host) ?? 0) + gap);
  hostLast.set(host, next);
  if (next > now) await new Promise((r) => setTimeout(r, next - now));
}

export const stats = { hits: 0, misses: 0 };

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const ttl = opts.ttlSec ?? Infinity;
  const host = new URL(url).host;
  const key = createHash("sha1").update(url).digest("hex");
  const file = join(CACHE_DIR, host, key + ".txt");
  if (existsSync(file)) {
    const ageSec = (Date.now() - statSync(file).mtimeMs) / 1000;
    if (ageSec < ttl) {
      stats.hits++;
      return readFileSync(file, "utf8");
    }
  }
  stats.misses++;
  const retries = opts.retries ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await politeWait(host);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "isotherm-research/0.1 (hackathon spike)" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      writeFileSync(file.replace(/\.txt$/, ".url"), url + "\n");
      return body;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
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
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 1) + "\n");
  return p;
}

export function readJson<T = any>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}
