// Worker bindings, vars and secrets, and the parsed runtime settings.
//
// The live/shadow switch has TWO keys and both must be on before anything is broadcast:
//   1. the env var MAKER_MODE = "live" (wrangler.toml [vars]; committed default "shadow"), and
//   2. the Durable Object's own flag, set only by a signed-off control document (scripts/control.mjs arm ...).
// Anything else (either key off, a missing key secret, the other-writer interlock) runs the tick in SHADOW mode:
// every decision is computed and recorded, nothing is sent.

export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  MAKER: DurableObjectNamespace;
  /** Service binding to the API Worker `isotherm-api` (snapshot POST/GET); no URL, no public hostname. */
  API?: ServiceBinding;
  /** Control + outbox KV (scripts/control.mjs): the operator writes `control`, the maker writes status/reports. */
  MAKER_KV?: KVNamespace;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
  // ---- vars
  MAKER_MODE?: string; // "shadow" (default) | "live"
  /** Comma list of Monad testnet RPCs (each in LIVE_RPCS, or all loopback forks), tried in order (src/rpc.ts).
   *  Default: Ankr, thirdweb, the official RPC. */
  RPC_URLS?: string;
  /** Backward-compatible alias: one RPC (used when RPC_URLS is not set). */
  RPC_URL?: string;
  RPC_RPS?: string; // client-side request rate per endpoint (token bucket), default 8/s
  RPC_RETRIES?: string; // retries per endpoint on rate-limit / 5xx before moving on, default 2
  RPC_COOLDOWN_SEC?: string; // an endpoint that kept failing is skipped this long, default 30
  RPC_TIMEOUT_SEC?: string; // per request, default 20 (60 on a loopback fork)
  STATIONS?: string; // "RCSS" or "RCSS,RJTT"
  ROLL_NOT_BEFORE_LOCAL?: string; // station-local HH:MM from which tomorrow's ladder is rolled (default 12:00)
  ROLL_AUTO?: string; // "0" = no scheduled rolls (control-document roll requests only)
  TICK_SEC?: string;
  WATCH_EVERY_SEC?: string;
  WATCH_LOOKBACK_BLOCKS?: string;
  WATCH_RECHECK_SEC?: string;
  WATCH_AUTO_CHALLENGE?: string; // "0" = alert only
  WATCH_BACKSTOP_SEC?: string;
  INTERLOCK_FRESH_SEC?: string; // another writer's snapshot younger than this blocks live sends
  SHADOW_ROLL_EVERY_SEC?: string;
  WATCHDOG_VERIFY_SEC?: string; // re-scan recently closed ladders for open maker orders (Mac: watchdog --verify, 300 s)
  SETTLE_OVERDUE_SEC?: string; // alert "SETTLEMENT OVERDUE" when a vault ladder has no result this long after its local day end
  SETTLE_OVERDUE_REPEAT_SEC?: string; // repeat that alert per ladder at most this often until a result lands
  AUTO_STALE_VOID?: string; // "0" = alert only; otherwise (live mode only) send Resolver.voidIfStale once it is allowed
  ALERT_PUSH_MIN_SEC?: string; // per-title rate limit for the optional ALERT_WEBHOOK_URL push
  CONFIG_OVERRIDES?: string; // JSON merged over config/worker.json (e.g. caps); optional
  // test-only (honoured only when RPC_URL is a loopback anvil): deterministic market data and settlement sources
  TEST_MARKET_DATA_URL?: string;
  TEST_SOURCE_PROXY?: string;
  // watch-only: public addresses the SHADOW can mirror without any key secret (never enough for live)
  MAKER_ADDRESS?: string;
  OPERATOR_ADDRESS?: string;
  // ---- secrets (wrangler secret put, from stdin; never in wrangler.toml)
  MAKER_KEY?: string;
  OPERATOR_KEY?: string;
  GUARDIAN_KEY?: string;
  SNAPSHOT_TOKEN?: string;
  /** Optional push channel for alerts (an ntfy topic URL, a Telegram bot sendMessage URL or any JSON webhook). Absent =
   *  alerts stay in the Durable Object log and the KV outbox only. Never logged or echoed. */
  ALERT_WEBHOOK_URL?: string;
  /** Optional access token for the push channel, sent as `Authorization: Bearer <token>` (an ntfy.sh account token, or
   *  any JSON webhook's bearer token). Never logged or echoed. */
  ALERT_WEBHOOK_TOKEN?: string;
  /** Optional dedicated treasury key (src/treasury.ts): tops up the role keys in LIVE mode. Never the deployer/owner key. */
  TREASURY_KEY?: string;
}

export const LIVE_RPC = "https://testnet-rpc.monad.xyz";
export const ANKR_RPC = "https://rpc.ankr.com/monad_testnet";
export const THIRDWEB_RPC = "https://10143.rpc.thirdweb.com";
/** Public Monad testnet (10143) endpoints the live maker may use. The official one limits each client IP to 15 requests/s,
 *  and Workers share egress IPs, so alternatives are configured; every endpoint must still answer chain id 10143 before
 *  it is used (src/rpc.ts). */
export const LIVE_RPCS: readonly string[] = [LIVE_RPC, ANKR_RPC, THIRDWEB_RPC];
/** RPC_URLS default: the two alternatives first (the official one shares its per-IP limit with every Worker). */
export const DEFAULT_RPCS: readonly string[] = [ANKR_RPC, THIRDWEB_RPC, LIVE_RPC];
/** `source` on every snapshot this Worker publishes; the interlock tells our own snapshots from another writer's. */
export const SNAPSHOT_SOURCE = "isotherm-maker-worker";

export interface Settings {
  envMode: "shadow" | "live";
  /** the first of `rpcs` (for messages) */
  rpc: string;
  rpcs: string[];
  rpcRps: number;
  rpcRetries: number;
  rpcCooldownSec: number;
  rpcTimeoutSec: number;
  rpcIsLoopback: boolean;
  rpcIsLive: boolean;
  stations: string[];
  rollNotBeforeLocal: string;
  rollAuto: boolean;
  tickSec: number;
  watchEverySec: number;
  watchLookbackBlocks: number;
  watchRecheckSec: number;
  watchAutoChallenge: boolean;
  watchBackstopSec: number;
  interlockFreshSec: number;
  shadowRollEverySec: number;
  watchdogVerifySec: number;
  settleOverdueSec: number;
  settleOverdueRepeatSec: number;
  autoStaleVoid: boolean;
  alertPushMinSec: number;
  configOverrides: unknown;
  testMarketDataUrl: string | null;
  testSourceProxy: string | null;
}

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = v === undefined || v.trim() === "" ? d : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`setting out of range: ${v} (want ${min}..${max})`);
  return n;
};

export const isLoopbackRpc = (rpc: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(rpc);

/** RPC_URLS (comma list), else the RPC_URL alias, else DEFAULT_RPCS; each allowlisted, never live and loopback mixed (a
 *  tx signed for chain 10143 on a fork is valid on live). */
export function rpcUrlsFrom(env: Pick<Env, "RPC_URLS" | "RPC_URL">): string[] {
  const list = env.RPC_URLS?.trim() ? env.RPC_URLS.split(",") : env.RPC_URL?.trim() ? [env.RPC_URL] : [...DEFAULT_RPCS];
  const urls = list.map((u) => u.trim()).filter(Boolean);
  if (!urls.length || urls.length > 5) throw new Error(`RPC_URLS must list 1 to 5 URLs, got ${urls.length}`);
  if (new Set(urls).size !== urls.length) throw new Error("RPC_URLS lists a URL twice");
  for (const u of urls) if (!isLoopbackRpc(u) && !LIVE_RPCS.includes(u)) throw new Error(`RPC_URLS: each URL must be one of ${LIVE_RPCS.join(", ")} or a loopback anvil fork, got ${u}`);
  const loops = urls.filter(isLoopbackRpc).length;
  if (loops && loops !== urls.length) throw new Error("RPC_URLS mixes loopback forks and live RPCs: refusing");
  return urls;
}

export function settingsFrom(env: Env): Settings {
  const rpcs = rpcUrlsFrom(env);
  const rpc = rpcs[0];
  const loop = isLoopbackRpc(rpc);
  const hhmm = (env.ROLL_NOT_BEFORE_LOCAL ?? "12:00").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) throw new Error(`ROLL_NOT_BEFORE_LOCAL must be HH:MM, got ${hhmm}`);
  let configOverrides: unknown = {};
  if (env.CONFIG_OVERRIDES?.trim()) configOverrides = JSON.parse(env.CONFIG_OVERRIDES);
  return {
    envMode: (env.MAKER_MODE ?? "shadow").trim().toLowerCase() === "live" ? "live" : "shadow",
    rpc,
    rpcs,
    rpcRps: num(env.RPC_RPS, 8, 0.5, 100),
    rpcRetries: num(env.RPC_RETRIES, 2, 0, 6),
    rpcCooldownSec: num(env.RPC_COOLDOWN_SEC, 30, 0, 3600),
    // a live endpoint that needs > 20 s is better skipped; an anvil fork's first reads fetch upstream state (slow)
    rpcTimeoutSec: num(env.RPC_TIMEOUT_SEC, loop ? 60 : 20, 2, 120),
    rpcIsLoopback: loop,
    rpcIsLive: rpcs.every((u) => LIVE_RPCS.includes(u)),
    stations: (env.STATIONS ?? "RCSS").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    rollNotBeforeLocal: hhmm,
    rollAuto: (env.ROLL_AUTO ?? "1").trim() !== "0",
    tickSec: num(env.TICK_SEC, 60, 10, 600),
    watchEverySec: num(env.WATCH_EVERY_SEC, 120, 0, 86400),
    watchLookbackBlocks: num(env.WATCH_LOOKBACK_BLOCKS, 4000, 100, 20000),
    watchRecheckSec: num(env.WATCH_RECHECK_SEC, 20, 0, 120),
    watchAutoChallenge: (env.WATCH_AUTO_CHALLENGE ?? "1").trim() !== "0",
    watchBackstopSec: num(env.WATCH_BACKSTOP_SEC, 600, 0, 86400),
    interlockFreshSec: num(env.INTERLOCK_FRESH_SEC, 300, 0, 86400),
    shadowRollEverySec: num(env.SHADOW_ROLL_EVERY_SEC, 3600, 0, 86400),
    watchdogVerifySec: num(env.WATCHDOG_VERIFY_SEC, 300, 0, 86400),
    // 3 h after the local day end: the workflow's first attempt is at day end + 2 h (02:00 local), retried hourly
    settleOverdueSec: num(env.SETTLE_OVERDUE_SEC, 10_800, 600, 172_800),
    settleOverdueRepeatSec: num(env.SETTLE_OVERDUE_REPEAT_SEC, 3600, 300, 86_400),
    autoStaleVoid: (env.AUTO_STALE_VOID ?? "1").trim() !== "0",
    alertPushMinSec: num(env.ALERT_PUSH_MIN_SEC, 3600, 0, 86_400),
    configOverrides,
    // test hooks only ever apply to a local fork: a live RPC ignores them
    testMarketDataUrl: loop && env.TEST_MARKET_DATA_URL ? env.TEST_MARKET_DATA_URL : null,
    testSourceProxy: loop && env.TEST_SOURCE_PROXY ? env.TEST_SOURCE_PROXY : null,
  };
}
