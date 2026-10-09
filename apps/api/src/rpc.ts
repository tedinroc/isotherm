// Monad testnet RPC access for the Worker: several public endpoints behind one viem `fallback` transport.
//
// Why: the official https://testnet-rpc.monad.xyz limits each client IP to 15 requests/s, and Cloudflare Workers share
// egress IPs with other tenants, so the API can be rate-limited by traffic that is not ours. The pool therefore
//   - tries the endpoints in order (default: Ankr, thirdweb, official) and moves on when one is rate-limited, failing
//     or cooling down (viem `fallback`, never ranked: ranking would ping every endpoint in the background);
//   - verifies every endpoint's eth_chainId once before its first use and never uses one that serves another chain;
//   - paces each endpoint with a small client-side throttle (RPC_MAX_RPS, default 8/s, below the official 15/s);
//   - puts an endpoint that answered 429 / 403 / a rate-limit error, a 5xx, a timeout or a network error into an
//     exponential cooldown (Retry-After honoured, capped), so later requests skip it instead of hammering it;
//   - retries a request whose every endpoint was rate-limited, failing or cooling, with backoff (at most 4 attempts);
//   - answers eth_getLogs only from an endpoint whose last seen head covers the requested toBlock: every endpoint
//     tested on 2026-10-09 returns a silently TRUNCATED result (HTTP 200, no error) for a range that ends beyond
//     its own head, so a lagging endpoint must never serve a window that the scanner believes complete.
// Deterministic errors (execution reverted, invalid params, 413 range too large, nonce too low, ...) are not retried and
// do not cool an endpoint down. The pool never re-signs anything: a retried eth_sendRawTransaction resends the same
// signed bytes (same hash, same nonce), see sender.ts.
import { createTransport, fallback, http, type EIP1193RequestFn, type Transport } from 'viem';

export const DEFAULT_RPC_URLS: readonly string[] = [
  'https://rpc.ankr.com/monad_testnet',
  'https://10143.rpc.thirdweb.com',
  'https://testnet-rpc.monad.xyz',
];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackUrl(u: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(u).hostname);
  } catch {
    return false;
  }
}

/** https anywhere; plain http only for a loopback fork (anvil / wrangler dev). */
export function validRpcUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export interface RpcUrlChoice {
  urls: string[];
  /** Entries that were not valid RPC URLs (shown by host or position only, never in full). */
  ignored: string[];
  source: 'RPC_URL' | 'RPC_URLS' | 'default';
}

/**
 * Which endpoints to use. `RPC_URL` (one URL, e.g. an anvil fork for `wrangler dev` or the fork test) wins over
 * `RPC_URLS` (comma list, the live setting); without either, DEFAULT_RPC_URLS. Invalid entries are dropped and
 * reported, never guessed at; if nothing valid is left the defaults are used.
 */
export function chooseRpcUrls(env: { RPC_URL?: string; RPC_URLS?: string }): RpcUrlChoice {
  const ignored: string[] = [];
  const pick = (raw: string[]) => {
    const out: string[] = [];
    raw.forEach((u, i) => {
      if (!validRpcUrl(u)) ignored.push(`entry ${i + 1}`);
      else if (!out.includes(u)) out.push(u);
    });
    return out;
  };
  const single = (env.RPC_URL ?? '').trim();
  if (single) {
    const urls = pick([single]);
    if (urls.length) return { urls, ignored, source: 'RPC_URL' };
  }
  const list = (env.RPC_URLS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (list.length) {
    const urls = pick(list);
    if (urls.length) return { urls, ignored, source: 'RPC_URLS' };
  }
  return { urls: [...DEFAULT_RPC_URLS], ignored, source: 'default' };
}

/** Public label for an endpoint: the host for the known public endpoints and loopback, otherwise a position, so an
 *  RPC URL that carries a key (in its host, path or query) is never published by /api/health. */
export function endpointLabel(url: string, index: number): string {
  if (DEFAULT_RPC_URLS.includes(url) || isLoopbackUrl(url)) {
    try {
      return new URL(url).host;
    } catch {
      /* fall through */
    }
  }
  return `endpoint-${index + 1}`;
}

// ------------------------------------------------------------------------------------------------ errors
/** Raised by the pool itself when it skips an endpoint for one request. Code -32005 (limit exceeded) so the viem
 *  fallback moves on to the next endpoint; the pool's own retry loop decides whether to try again. */
export class EndpointSkipError extends Error {
  readonly code = -32005;
  constructor(
    public endpoint: string,
    public reason: 'cooling' | 'busy' | 'wrong-chain' | 'behind',
    detail: string,
  ) {
    super(`${endpoint}: ${detail}`);
    this.name = 'EndpointSkipError';
  }
}

export type RpcFailure = 'rate-limited' | 'transient' | 'skip' | 'deterministic';

const FAILURE = Symbol.for('isotherm.rpcFailure');
const RATE_LIMIT_CODES = new Set([429, -32005, -32007, -32029, -32090]);
const RATE_LIMIT_TEXT =
  /rate[ -]?limit|too many requests|requests? limit|limited to \d+|limit (reached|exceeded)|exceeded .*(rate|quota|capacity|limit)|over (the )?(rate|quota)|throttl/i;
const TRANSIENT_TEXT = /upstream|backend (error|unavailable)|service unavailable|temporar|overload|timed? ?out|try again later|bad gateway|ECONNRESET|socket hang up/i;

function chain(e: unknown): any[] {
  const out: any[] = [];
  let x: any = e;
  for (let i = 0; x && typeof x === 'object' && i < 10; i++) {
    out.push(x);
    x = x.cause;
  }
  return out;
}

/** The provider-supplied text of an error (JSON-RPC message, HTTP details), without the request URL viem appends. */
export function errorText(e: unknown): string {
  return chain(e)
    .filter((x) => !(x instanceof EndpointSkipError))
    .map((x) => [x.details, x.shortMessage].filter((s) => typeof s === 'string').join(' '))
    .join(' | ');
}

/**
 * rate-limited: 429 / 403, JSON-RPC limit codes, "requests limited to 15/sec"-style text.
 * transient:    5xx, 408, timeouts, network failures (no HTTP status), upstream/overload text.
 * skip:         the pool skipped every endpoint it reached (cooling, throttle queue full, behind, wrong chain).
 * deterministic: anything else (reverts, invalid params, 413 range too large, nonce too low, ...): never retried.
 */
export function classifyRpcError(e: unknown, httpStatus?: number): RpcFailure {
  const links = chain(e);
  if (httpStatus === 429 || httpStatus === 403) return 'rate-limited';
  // set by the endpoint that saw the HTTP status (viem keeps only the JSON-RPC code when a 429 carries a JSON body)
  for (const x of links) if (x[FAILURE] === 'rate-limited' || x[FAILURE] === 'transient') return x[FAILURE];
  for (const x of links) {
    if (x.name === 'HttpRequestError' && typeof x.status === 'number' && (x.status === 429 || x.status === 403)) return 'rate-limited';
    if (typeof x.code === 'number' && RATE_LIMIT_CODES.has(x.code) && !(x instanceof EndpointSkipError) && !isWrapperOfSkip(x)) return 'rate-limited';
  }
  if (links.some((x) => x instanceof EndpointSkipError)) return 'skip';
  const text = errorText(e);
  if (RATE_LIMIT_TEXT.test(text)) return 'rate-limited';
  if (httpStatus !== undefined && (httpStatus === 408 || httpStatus >= 500)) return 'transient';
  for (const x of links) {
    if (x.name === 'TimeoutError') return 'transient';
    if (x.name === 'HttpRequestError') {
      if (x.status === undefined || x.status === 408 || x.status >= 500) return 'transient';
      return 'deterministic';
    }
  }
  if (TRANSIENT_TEXT.test(text)) return 'transient';
  return 'deterministic';
}

/** viem wraps our -32005 skip in LimitExceededRpcError; that wrapper is a skip, not a provider rate limit. */
function isWrapperOfSkip(x: any): boolean {
  return chain(x.cause).some((y) => y instanceof EndpointSkipError);
}

function retryAfterMs(headers: Headers | null | undefined): number {
  const v = headers?.get('retry-after');
  if (!v) return 0;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

// ------------------------------------------------------------------------------------------------ pacing
/** Client-side throttle (GCRA): `rps` per second sustained, `burst` back to back. `reserve` returns how long the caller
 *  must wait before sending, or null when that wait would exceed `maxWaitMs` (nothing is reserved then). */
export class Pacer {
  private tat = 0;
  constructor(
    private rps: number,
    private burst = Math.max(1, Math.ceil(rps)),
  ) {}
  reserve(now: number, maxWaitMs: number): number | null {
    if (!(this.rps > 0)) return 0;
    const t = 1000 / this.rps;
    const tau = (this.burst - 1) * t;
    const tat = Math.max(this.tat, now);
    const wait = Math.max(0, tat - tau - now);
    if (wait > maxWaitMs) return null;
    this.tat = tat + t;
    return wait;
  }
}

// ------------------------------------------------------------------------------------------------ endpoints
export interface RpcOptions {
  urls: string[];
  chainId: number;
  /** Requests per second per endpoint (client-side throttle). 0 disables it. */
  maxRps?: number;
  /** Longest wait in an endpoint's throttle queue before the request spills to the next endpoint. */
  maxQueueMs?: number;
  /** HTTP timeout per request. */
  timeoutMs?: number;
  /** Attempts over the whole endpoint list for one request (first try included). */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** First cooldown after a rate limit / a transient failure; doubles per consecutive failure up to the caps. */
  rateLimitCooldownMs?: number;
  transientCooldownMs?: number;
  maxCooldownMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface EndpointStatus {
  endpoint: string;
  state: 'ok' | 'unverified' | 'cooling' | 'wrong-chain';
  coolingForSec?: number;
  head: string | null;
  ok: number;
  rateLimited: number;
  failed: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Endpoint {
  readonly label: string;
  private pacer: Pacer;
  private coolUntil = 0;
  private strikes = 0;
  private chainOk = false;
  private chainHex: string;
  private chainProbe: Promise<void> | null = null;
  wrongChain = false;
  head: bigint | null = null;
  private counts = { ok: 0, rateLimited: 0, failed: 0 };
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;

  constructor(
    readonly url: string,
    index: number,
    private o: Required<Omit<RpcOptions, 'urls' | 'fetchFn'>> & { fetchFn?: typeof fetch },
  ) {
    this.label = endpointLabel(url, index);
    this.pacer = new Pacer(o.maxRps);
    this.chainHex = `0x${o.chainId.toString(16)}`;
  }

  /** ms until this endpoint may be used again (0 = now); Infinity if it serves another chain. */
  readyInMs(now: number): number {
    if (this.wrongChain) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.coolUntil - now);
  }

  readonly transport: Transport = ({ retryCount: _r, timeout } = {}) =>
    createTransport({
      key: 'isotherm-endpoint',
      name: this.label,
      type: 'isotherm-endpoint',
      retryCount: 0,
      timeout,
      request: (async ({ method, params }: { method: string; params?: unknown }) => this.request(method, params)) as EIP1193RequestFn,
    });

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.wrongChain) throw new EndpointSkipError(this.label, 'wrong-chain', `serves another chain (expected ${this.o.chainId})`);
    if (!this.chainOk) await this.verifyChain();
    if (method === 'eth_chainId') return this.chainHex; // verified above; saves a request per signed transaction
    if (method === 'eth_getLogs') await this.guardRange(params);
    return this.send(method, params);
  }

  private verifyChain(): Promise<void> {
    this.chainProbe ??= (async () => {
      try {
        const res = await this.send('eth_chainId', []);
        const id = typeof res === 'string' ? Number(BigInt(res)) : NaN;
        if (id !== this.o.chainId) {
          this.wrongChain = true;
          this.note('failed', `chain id ${Number.isFinite(id) ? id : String(res).slice(0, 20)}, expected ${this.o.chainId}`);
          throw new EndpointSkipError(this.label, 'wrong-chain', `serves chain ${id}, expected ${this.o.chainId}`);
        }
        this.chainOk = true;
      } finally {
        this.chainProbe = null; // a failed probe (rate limit, timeout) is retried by the next request
      }
    })();
    return this.chainProbe;
  }

  /** eth_getLogs with a numeric toBlock is sent only if this endpoint has been seen at or past that block. */
  private async guardRange(params: unknown) {
    const f = Array.isArray(params) ? (params[0] as { toBlock?: unknown } | undefined) : undefined;
    const raw = f && typeof f.toBlock === 'string' && /^0x[0-9a-f]+$/i.test(f.toBlock) ? f.toBlock : null;
    if (!raw) return;
    const to = BigInt(raw);
    if (this.head !== null && this.head >= to) return;
    const h = await this.send('eth_blockNumber', []);
    if (typeof h !== 'string' || BigInt(h) < to) {
      throw new EndpointSkipError(this.label, 'behind', `head ${typeof h === 'string' ? BigInt(h) : '?'} is below toBlock ${to}`);
    }
  }

  private async send(method: string, params: unknown): Promise<unknown> {
    const now = this.o.now();
    if (now < this.coolUntil) {
      throw new EndpointSkipError(this.label, 'cooling', `cooling down for ${Math.ceil((this.coolUntil - now) / 1000)} s`);
    }
    const wait = this.pacer.reserve(now, this.o.maxQueueMs);
    if (wait === null) throw new EndpointSkipError(this.label, 'busy', 'client-side throttle queue is full');
    if (wait > 0) {
      await this.o.sleep(wait);
      // a request that waited in the queue must not go out if the endpoint started cooling down meanwhile
      if (this.o.now() < this.coolUntil) throw new EndpointSkipError(this.label, 'cooling', 'started cooling down while this request was queued');
    }
    // One http transport per request, so the HTTP status and Retry-After of THIS response are known even when the
    // body is a JSON-RPC error (viem then reports only the JSON-RPC code).
    const meta: { status?: number; headers?: Headers } = {};
    const baseFetch = this.o.fetchFn ?? fetch;
    const t = http(this.url, {
      retryCount: 0,
      timeout: this.o.timeoutMs,
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const r = await baseFetch(input as RequestInfo, init);
        meta.status = r.status;
        meta.headers = r.headers;
        return r;
      }) as typeof fetch,
    })({ retryCount: 0 });
    try {
      const res = await t.request({ method, params } as never);
      this.strikes = 0;
      this.counts.ok++;
      if (method === 'eth_blockNumber' && typeof res === 'string') {
        const h = BigInt(res);
        if (this.head === null || h > this.head) this.head = h;
      }
      return res;
    } catch (e) {
      const kind = classifyRpcError(e, meta.status);
      if (kind === 'rate-limited' || kind === 'transient') {
        const t = this.o.now();
        // Answers to requests that were already in flight when the cooldown began count once, not once each: a burst
        // of 429s is one strike, so the cooldown doubles per failed period, not per concurrent request.
        if (t >= this.coolUntil) {
          this.strikes = Math.min(this.strikes + 1, 8);
          const base = kind === 'rate-limited' ? this.o.rateLimitCooldownMs : this.o.transientCooldownMs;
          const backoff = base * 2 ** (this.strikes - 1);
          const ms = Math.min(this.o.maxCooldownMs, Math.max(backoff, kind === 'rate-limited' ? retryAfterMs(meta.headers ?? (e as any)?.headers) : 0));
          this.coolUntil = t + ms;
        }
        this.note(kind === 'rate-limited' ? 'rateLimited' : 'failed', kind === 'rate-limited' ? `rate-limited${meta.status ? ` (HTTP ${meta.status})` : ''}` : transientLabel(e, meta.status));
        if (e && typeof e === 'object') (e as Record<symbol, unknown>)[FAILURE] = kind;
      } else {
        this.strikes = 0; // the endpoint answered; the request itself was wrong
      }
      throw e;
    }
  }

  private note(kind: 'rateLimited' | 'failed', label: string) {
    this.counts[kind]++;
    this.lastError = label;
    this.lastErrorAt = this.o.now();
  }

  status(now: number): EndpointStatus {
    const cooling = now < this.coolUntil;
    return {
      endpoint: this.label,
      state: this.wrongChain ? 'wrong-chain' : cooling ? 'cooling' : this.chainOk ? 'ok' : 'unverified',
      ...(cooling ? { coolingForSec: Math.ceil((this.coolUntil - now) / 1000) } : {}),
      head: this.head?.toString() ?? null,
      ...this.counts,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
    };
  }
}

function transientLabel(e: unknown, status?: number): string {
  if (status && status >= 400) return `HTTP ${status}`;
  if (chain(e).some((x) => x.name === 'TimeoutError')) return 'timeout';
  if (chain(e).some((x) => x.name === 'HttpRequestError' && x.status === undefined)) return 'network error';
  return 'upstream error';
}

export interface Rpc {
  transport: Transport;
  urls: readonly string[];
  /** True when every endpoint is a loopback fork (anvil): one node, no cross-endpoint lag. */
  allLoopback: boolean;
  status(): EndpointStatus[];
  /** ms until some endpoint can be tried again (0 = one is ready now). */
  readyInMs(): number;
}

export function createRpc(opts: RpcOptions): Rpc {
  if (!opts.urls.length) throw new Error('createRpc: no RPC URLs');
  const o = {
    chainId: opts.chainId,
    maxRps: opts.maxRps ?? 8,
    maxQueueMs: opts.maxQueueMs ?? 2_000,
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxAttempts: Math.max(1, opts.maxAttempts ?? 4),
    retryBaseMs: opts.retryBaseMs ?? 250,
    retryMaxMs: opts.retryMaxMs ?? 4_000,
    rateLimitCooldownMs: opts.rateLimitCooldownMs ?? 2_000,
    transientCooldownMs: opts.transientCooldownMs ?? 1_000,
    maxCooldownMs: opts.maxCooldownMs ?? 30_000,
    fetchFn: opts.fetchFn,
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? defaultSleep,
  };
  const endpoints = opts.urls.map((u, i) => new Endpoint(u, i, o));
  const readyInMs = () => Math.min(...endpoints.map((e) => e.readyInMs(o.now())));
  const fb = fallback(
    endpoints.map((e) => e.transport),
    { rank: false, retryCount: 0 },
  );

  const transport: Transport = ({ chain, pollingInterval, timeout } = {}) => {
    const inner = fb({ chain, pollingInterval, retryCount: 0, timeout });
    return createTransport({
      key: 'isotherm-rpc',
      name: 'Isotherm RPC pool',
      type: 'isotherm-rpc',
      retryCount: 0,
      timeout,
      request: (async ({ method, params }: { method: string; params?: unknown }) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await inner.request({ method, params } as never);
          } catch (e) {
            const kind = classifyRpcError(e);
            const retryable = kind === 'rate-limited' || kind === 'transient' || (kind === 'skip' && Number.isFinite(readyInMs()));
            if (!retryable || attempt >= o.maxAttempts) throw e;
            const backoff = o.retryBaseMs * 2 ** (attempt - 1);
            await o.sleep(Math.min(o.retryMaxMs, Math.max(backoff, readyInMs())));
          }
        }
      }) as EIP1193RequestFn,
    });
  };

  return {
    transport,
    urls: opts.urls,
    allLoopback: opts.urls.every(isLoopbackUrl),
    status: () => endpoints.map((e) => e.status(o.now())),
    readyInMs,
  };
}
