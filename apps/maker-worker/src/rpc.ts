// RPC transport for the Worker: several public Monad testnet endpoints behind one viem client.
//
// Why: the official RPC limits each client IP to 15 requests/s and Cloudflare Workers share egress IPs, so on
// 2026-10-09 the maker's ticks failed for 87 minutes (14:00-15:27 UTC) until RPC_URL was switched to Ankr.
//   - Every endpoint gets a client-side token bucket (RPC_RPS, default 8 requests/s per endpoint), so the maker
//     itself never bursts past a provider's per-IP limit.
//   - A rate-limit or server error (HTTP 408/429/5xx, JSON-RPC -32005/-32007/-32090, "rate limit", "limited to",
//     "too many requests") is retried on the same endpoint with exponential backoff and jitter (RPC_RETRIES, default 2),
//     then the endpoint cools down (RPC_COOLDOWN_SEC, default 30 s) and the request moves on to the next one.
//   - Reads go through viem's `fallback` transport in the configured order, with NO ranking (no background pings that
//     would spend the same per-IP budget). An endpoint that is cooling down is skipped unless it is the last one.
//   - Writes (the wallet client: fees, eth_sendRawTransaction) start at the first healthy endpoint and move on ONLY
//     when that endpoint refused the request as rate-limited (HTTP 429 or a rate-limit error: it was not processed).
//     A timeout or a 5xx is ambiguous (the tx may have been accepted), so it is not replayed elsewhere; the same signed
//     tx may be retried on the same endpoint (identical hash), and the nonce tracker and the receipt wait handle a
//     lost broadcast.
//   - Every endpoint must answer eth_chainId 10143 before it is used (checked at startup and, for an endpoint that
//     was down then, lazily before its first request). One that answers another chain is excluded for good and
//     reported; with no verified endpoint the engine refuses to run.
// The allowlist (env.ts LIVE_RPCS, or loopback anvil forks only) is enforced when the settings are parsed.
import { createPublicClient, createTransport, fallback, http, type Chain, type PublicClient, type Transport } from "viem";
import { monadTestnet } from "viem/chains";

export interface RpcOptions {
  rps: number; // per endpoint
  burst?: number; // token bucket size (default = rps)
  retries: number; // per endpoint, on rate-limit / 5xx
  baseDelayMs: number; // backoff: base * 2^attempt (+ up to 50 % jitter)
  cooldownMs: number;
  timeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** tests inject a fake fetch */
  fetchFn?: typeof fetch;
  random?: () => number;
}

export interface EndpointStatus {
  url: string;
  host: string;
  verified: "unknown" | "ok" | "wrong-chain";
  chainId?: number;
  coolingDownUntil: number | null;
  requests: number;
  retries: number;
  rateLimited: number;
  errors: number;
  lastError: string | null;
}

/** Token bucket: `rate` tokens per second up to `burst`; take() waits for one. Callers are served in order. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private rate: number,
    private burst: number,
    private now: () => number,
    private sleep: (ms: number) => Promise<void>,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  take(): Promise<void> {
    const run = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
        this.last = t;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** HTTP status, JSON-RPC code and message anywhere in a viem error's cause chain. */
function errorFacts(e: unknown): { status?: number; codes: number[]; text: string } {
  const codes: number[] = [];
  let status: number | undefined;
  const texts: string[] = [];
  const seen = new Set<unknown>();
  let x: any = e;
  while (x && typeof x === "object" && !seen.has(x)) {
    seen.add(x);
    if (typeof x.status === "number") status ??= x.status;
    if (typeof x.code === "number") codes.push(x.code);
    for (const k of ["shortMessage", "details", "message"]) if (typeof x[k] === "string") texts.push(x[k]);
    x = x.cause;
  }
  return { status, codes, text: texts.join(" | ").slice(0, 2000) };
}

const REVERT = /execution reverted|revert|insufficient funds|nonce too low|already known|replacement transaction underpriced|invalid opcode/i;
const RATE = /rate.?limit|request limit|limited to \d+|too many requests|reduce calls|exceeded.*(rate|limit|quota|capacity)|capacity exceeded|daily request count/i;
const TRANSIENT = /timed? ?out|timeout|took too long|ECONNRESET|ECONNREFUSED|socket hang up|network ?error|fetch failed|bad gateway|service unavailable|gateway timeout/i;

/** "rate" (provider throttling), "transient" (5xx / network: retry, then the next endpoint) or null (a real answer:
 *  a revert, bad params, ... -- never retried, never moved to another endpoint by us). */
export function classifyRpcError(e: unknown): "rate" | "transient" | null {
  const f = errorFacts(e);
  if (REVERT.test(f.text)) return null;
  if (f.status === 429 || f.codes.some((c) => c === -32005 || c === -32007 || c === -32090 || c === 429) || RATE.test(f.text)) return "rate";
  if ((f.status !== undefined && (f.status === 408 || f.status >= 500)) || TRANSIENT.test(f.text)) return "transient";
  return null;
}

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

class Endpoint {
  readonly status: EndpointStatus;
  readonly bucket: TokenBucket;
  readonly base: Transport;
  private verifyAt = 0;
  constructor(
    readonly url: string,
    private o: RpcOptions,
  ) {
    const now = o.now ?? (() => Date.now());
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.bucket = new TokenBucket(o.rps, o.burst ?? Math.max(1, o.rps), now, sleep);
    this.base = http(url, { retryCount: 0, timeout: o.timeoutMs, fetchFn: o.fetchFn });
    this.status = { url, host: host(url), verified: "unknown", coolingDownUntil: null, requests: 0, retries: 0, rateLimited: 0, errors: 0, lastError: null };
  }
  private now() {
    return (this.o.now ?? Date.now)();
  }
  coolingDown(): boolean {
    return this.status.coolingDownUntil !== null && this.now() < this.status.coolingDownUntil;
  }
  usable(): boolean {
    return this.status.verified !== "wrong-chain" && !this.coolingDown();
  }
  /** One request: throttled, retried with backoff on rate-limit / transient errors, then cooled down. */
  async request(chain: Chain, method: string, params: unknown, raw = false): Promise<unknown> {
    if (this.status.verified === "wrong-chain") throw new Error(`RPC ${this.status.host} is excluded: it answered chain ${this.status.chainId}, not 10143`);
    if (!raw && this.status.verified === "unknown") await this.verify(chain);
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const inner = this.base({ chain, retryCount: 0 });
    for (let attempt = 0; ; attempt++) {
      await this.bucket.take();
      this.status.requests++;
      try {
        const r = await inner.request({ method, params } as any);
        this.status.coolingDownUntil = null;
        return r;
      } catch (e) {
        const kind = classifyRpcError(e);
        if (kind === "rate") this.status.rateLimited++;
        if (!kind) throw e; // a real answer (revert, bad params): the caller sees it as is
        this.status.errors++;
        this.status.lastError = `${kind}: ${errorFacts(e).text.replace(/https?:\/\/\S+/g, "<url>").slice(0, 160)}`;
        if (attempt >= this.o.retries) {
          this.status.coolingDownUntil = this.now() + this.o.cooldownMs;
          throw e;
        }
        this.status.retries++;
        const backoff = this.o.baseDelayMs * 2 ** attempt;
        await sleep(Math.round(backoff * (1 + 0.5 * (this.o.random ?? Math.random)())));
      }
    }
  }
  /** eth_chainId must be 10143. Network failure leaves it "unknown" (retried at most once a minute). */
  async verify(chain: Chain): Promise<void> {
    if (this.status.verified !== "unknown") return;
    if (this.now() < this.verifyAt) throw new Error(`RPC ${this.status.host} not verified yet (eth_chainId unanswered)`);
    this.verifyAt = this.now() + 60_000;
    const id = Number(await this.request(chain, "eth_chainId", [], true));
    this.status.chainId = id;
    this.status.verified = id === 10143 ? "ok" : "wrong-chain";
    if (id !== 10143) throw new Error(`RPC ${this.status.host} answers chain ${id}, not Monad testnet 10143: excluded`);
  }
}

export interface Rpc {
  pub: PublicClient;
  chain: typeof monadTestnet;
  /** viem transport for the wallet client: the first usable endpoint, throttled and retried, no cross-endpoint replay */
  writeTransport(): Transport;
  /** eth_chainId on every endpoint; throws if none answers 10143. Returns one line per endpoint. */
  verifyAll(): Promise<string[]>;
  status(): EndpointStatus[];
  urls: string[];
}

export function makeRpc(urls: string[], opts: Partial<RpcOptions> = {}): Rpc {
  if (!urls.length) throw new Error("no RPC URL");
  const o = { rps: 8, retries: 2, baseDelayMs: 250, cooldownMs: 30_000, timeoutMs: 20_000, ...opts };
  if (!(o.rps > 0)) throw new Error("RPC rps must be > 0");
  const chain = { ...monadTestnet, rpcUrls: { default: { http: [urls[0]] } } } as typeof monadTestnet;
  const eps = urls.map((u) => new Endpoint(u, o));
  const wrap = (i: number): Transport => () =>
    createTransport({
      key: `isotherm-rpc-${i}`,
      name: `isotherm ${eps[i].status.host}`,
      type: "isotherm-throttled",
      retryCount: 0,
      request: (async ({ method, params }: { method: string; params?: unknown }) => {
        const ep = eps[i];
        // skip an endpoint that is cooling down, unless every later one is excluded or cooling down too
        if (!ep.usable() && eps.slice(i + 1).some((x) => x.usable())) throw new Error(`RPC ${ep.status.host} is cooling down after rate-limit / server errors`);
        return ep.request(chain, method, params);
      }) as any,
    }) as any;
  const transport = fallback(eps.map((_, i) => wrap(i)), { rank: false, retryCount: 0 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  return {
    pub,
    chain,
    urls,
    writeTransport() {
      const first = Math.max(0, eps.findIndex((e) => e.usable() && e.status.verified === "ok"));
      return () =>
        createTransport({
          key: "isotherm-rpc-write",
          name: "isotherm write",
          type: "isotherm-write",
          retryCount: 0,
          request: (async ({ method, params }: { method: string; params?: unknown }) => {
            for (let i = first; ; i++) {
              try {
                return await eps[i].request(chain, method, params);
              } catch (e) {
                // move on only past a refusal that was certainly not processed, and only to a usable endpoint
                const next = eps.findIndex((x, j) => j > i && x.usable());
                if (classifyRpcError(e) !== "rate" || next < 0) throw e;
                i = next - 1;
              }
            }
          }) as any,
        }) as any;
    },
    async verifyAll() {
      const out: string[] = [];
      for (const ep of eps) {
        try {
          await ep.verify(chain);
          out.push(`${ep.status.host}: chain ${ep.status.chainId}`);
        } catch (e) {
          out.push(`${ep.status.host}: ${String((e as Error).message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 160)}`);
        }
      }
      if (eps.some((e) => e.status.verified === "wrong-chain")) {
        // a provider answering another chain is a misconfiguration or worse: never use it, and say so loudly
        const bad = eps.filter((e) => e.status.verified === "wrong-chain").map((e) => `${e.status.host} (chain ${e.status.chainId})`);
        out.push(`EXCLUDED: ${bad.join(", ")}`);
      }
      if (!eps.some((e) => e.status.verified === "ok")) throw new Error(`refusing: no RPC endpoint answered Monad testnet 10143 (${out.join("; ")})`);
      return out;
    },
    status: () => eps.map((e) => ({ ...e.status })),
  };
}
