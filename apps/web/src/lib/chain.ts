// Read-side chain access. Every screen batches its reads through Multicall3 (one eth_call per refresh) because the
// public Monad testnet RPC allows ~25 requests/s for everyone.
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  fallback,
  http,
  shouldThrow as viemShouldThrow,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
} from 'viem';
import { CHAIN_ID, EXPLORER, RPC_URL, RPC_URLS } from '../config';
import { DEPLOYMENTS } from './deployments';
import { ausdAbi, bookAbi, multicallAbi, resolverAbi, routerAbi, vaultAbi, zapAbi } from './abi';

export const chain = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === 10143 ? 'Monad Testnet' : `Chain ${CHAIN_ID}`,
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'MonadVision', url: EXPLORER } },
  contracts: { multicall3: { address: DEPLOYMENTS.multicall3 } },
  testnet: true,
});

const RPC_TIMING = { primaryTimeoutMs: 5_000, timeoutMs: 10_000, retryDelayMs: 400, cooldownMs: 30_000 };

/** RPC_URL first, then FALLBACK_RPC_URLS in a fixed order (rank off). The fallbacks run a few blocks behind RPC_URL, so
 *  RPC_URL is held on to: a 429 / 5xx / network error is retried there once (step 2 of a trade must not be estimated
 *  against state older than step 1's receipt), and only a second failure or a 5 s timeout moves the request on and
 *  skips RPC_URL for 30 s, so a hung primary costs one timeout per window rather than one per request. Reverts,
 *  rejected signatures and deterministic transaction errors (insufficient balance, nonce too low, already known,
 *  underpriced) are thrown at once, never re-sent. A local fork or another chain keeps one plain endpoint. */
export function rpcTransport(urls: readonly string[] = RPC_URLS, timing: Partial<typeof RPC_TIMING> = {}): Transport {
  const t = { ...RPC_TIMING, ...timing };
  if (urls.length < 2) return http(urls[0] ?? RPC_URL, { retryCount: 2, retryDelay: 400, timeout: 20_000 });
  return fallback([stickyPrimary(urls[0], t), ...urls.slice(1).map((u) => http(u, { timeout: t.timeoutMs }))], {
    rank: false,
    retryCount: 2,
    retryDelay: 400,
    shouldThrow: throwAtOnce,
  });
}

/** JSON-RPC -32000 errors every endpoint would repeat (apps/api/src/rpc.ts classifies them the same way). */
const DETERMINISTIC = /insufficient (funds|balance)|nonce too (low|high)|already known|intrinsic gas|underpriced|exceeds block gas limit/i;
function throwAtOnce(e: Error): boolean {
  const x = e as Error & { code?: unknown; details?: unknown };
  return viemShouldThrow(e) || (x.code === -32000 && DETERMINISTIC.test(String(x.details ?? x.message)));
}

const TRANSIENT_CODES = new Set([429, -32005, -32007]); // rate limits, e.g. the official -32007 "requests limited to 15/sec"
const RATE_LIMIT_TEXT = /rate[ -]?limit|too many requests|limited to \d+|limit (reached|exceeded)/i;

/** timeout: the endpoint hung. transient: 429 / 403 / 408 / 5xx, a network error or a rate-limit reply. */
function failureOf(e: unknown): 'timeout' | 'transient' | 'other' {
  for (let x = e as any, i = 0; x && typeof x === 'object' && i < 8; x = x.cause, i++) {
    if (x.name === 'TimeoutError') return 'timeout';
    if (x.name === 'HttpRequestError') {
      const s = x.status as number | undefined;
      return s === undefined || s === 403 || s === 408 || s === 429 || s >= 500 ? 'transient' : 'other';
    }
    if (typeof x.code === 'number' && TRANSIENT_CODES.has(x.code)) return 'transient';
    if (typeof x.details === 'string' && RATE_LIMIT_TEXT.test(x.details)) return 'transient';
  }
  return 'other';
}

/** RPC_URL with one retry of its own and a cooldown; the cooldown is shared by every client built on one rpcTransport(). */
function stickyPrimary(url: string, t: typeof RPC_TIMING): Transport {
  const base = http(url, { timeout: t.primaryTimeoutMs, retryCount: 0 });
  let skipUntil = 0;
  return (opts) => {
    const inner = base(opts);
    const request = (async (args: any, options?: any) => {
      if (Date.now() < skipUntil) throw Object.assign(new Error(`${url} is skipped after a timeout or repeated failure`), { name: 'RpcCoolingError' });
      for (let attempt = 0; ; attempt++) {
        try {
          return await inner.request(args, options);
        } catch (e) {
          const f = failureOf(e);
          if (f === 'transient' && attempt === 0) {
            await new Promise((r) => setTimeout(r, t.retryDelayMs));
            continue;
          }
          if (f !== 'other') skipUntil = Date.now() + t.cooldownMs;
          throw e;
        }
      }
    }) as typeof inner.request;
    return { ...inner, request };
  };
}

/** The one live transport: reads (pub) and the dev wallet share it, and with it RPC_URL's cooldown. */
const rpc = rpcTransport();

export const pub = createPublicClient({
  chain,
  transport: rpc,
  pollingInterval: 400,
}) as PublicClient;

/** The dev (burner) wallet's client: signs locally, sends through the same fallback transport as every read. */
export const devWalletClient = (account: LocalAccount) => createWalletClient({ account, chain, transport: rpc });

export interface Call {
  target: Address;
  callData: Hex;
}

/** aggregate3 with allowFailure; returns raw return data (or null on failure) per call, in order. */
export async function multicall(calls: Call[]): Promise<(Hex | null)[]> {
  if (!calls.length) return [];
  const out: (Hex | null)[] = [];
  for (let i = 0; i < calls.length; i += 150) {
    const chunk = calls.slice(i, i + 150);
    const { data } = await pub.call({
      to: DEPLOYMENTS.multicall3,
      data: encodeFunctionData({
        abi: multicallAbi,
        functionName: 'aggregate3',
        args: [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
      }),
    });
    const res = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: data ?? '0x' }) as readonly {
      success: boolean;
      returnData: Hex;
    }[];
    for (const r of res) out.push(r.success ? r.returnData : null);
  }
  return out;
}

export const enc = <A extends Abi>(abi: A, functionName: string, args: readonly unknown[] = []) =>
  encodeFunctionData({ abi: abi as Abi, functionName, args } as never) as Hex;

export const dec = <T>(abi: Abi, functionName: string, data: Hex | null): T | null => {
  if (!data || data === '0x') return null;
  try {
    return decodeFunctionResult({ abi, functionName, data } as never) as T;
  } catch {
    return null;
  }
};

export const ABIS = { ausd: ausdAbi, vault: vaultAbi, resolver: resolverAbi, zap: zapAbi, router: routerAbi, book: bookAbi };

const ERROR_ABIS: Abi[] = [zapAbi as Abi, vaultAbi as Abi, bookAbi as Abi];

/** A short human reason for a failed call or transaction. */
export function explainError(e: unknown): string {
  const seen = new Set<unknown>();
  const find = (x: any): Hex | undefined => {
    if (!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if (typeof x.data === 'string' && x.data.startsWith('0x') && x.data.length >= 10) return x.data as Hex;
    if (typeof x.data === 'object' && typeof x.data?.data === 'string') return x.data.data as Hex;
    return find(x.cause) ?? find(x.error);
  };
  const data = find(e);
  if (data) {
    for (const abi of ERROR_ABIS) {
      try {
        const d = decodeErrorResult({ abi, data });
        return friendlyError(d.errorName, (d.args ?? []) as unknown[]);
      } catch {
        /* next */
      }
    }
  }
  const m = (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  // Monad answers a short sender with -32000 "insufficient balance", which viem only shows as "Missing or invalid parameters."
  const nodeSays = String((e as { details?: unknown })?.details ?? ''); // anchored: "execution reverted: ..." is not this
  if (/insufficient funds/i.test(m) || /^insufficient (funds|balance)/i.test(nodeSays)) return 'Not enough MON for the network fee. Tap "Get test funds".';
  if (/user rejected|denied/i.test(m)) return 'Cancelled.';
  return String(m).split('\n')[0].slice(0, 200);
}

function friendlyError(name: string, args: unknown[]): string {
  switch (name) {
    case 'Slippage':
      return 'The price moved more than your slippage limit. Nothing was traded; try again.';
    case 'TradingClosed':
    case 'MintClosed':
      return 'This strike is closed for new positions.';
    case 'MarketMismatch':
      return 'That order book is not the official book for this strike.';
    case 'ZeroMinOut':
      return 'No price available on the book right now.';
    case 'NotFinal':
      return 'The result is in its challenge window; redemption opens soon.';
    case 'NotResolved':
      return 'Not settled yet.';
    case 'InsufficientBalance':
      return 'The order book does not have enough liquidity for this size.';
    case 'EnforcedPause':
      return 'Minting is paused by the guardian right now.';
    default:
      return `${name}(${args.map(String).join(', ')})`;
  }
}
