// Runtime-agnostic fetch contract shared by the forecast cores: the Node side passes http.ts fetchText (file cache,
// polite per-host gaps); the Cloudflare Worker passes its own fetcher (Durable Object SQL cache).
export interface FetchOpts {
  ttlSec?: number; // default: Infinity (never refetch)
  retries?: number;
  timeoutMs?: number;
}

export type TextGetter = (url: string, opts?: FetchOpts) => Promise<string>;
