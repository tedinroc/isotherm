// Read-side chain access. Every screen batches its reads through Multicall3 (one eth_call per refresh) because the
// public Monad testnet RPC allows ~25 requests/s for everyone.
import {
  createPublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { CHAIN_ID, EXPLORER, RPC_URL } from '../config';
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

export const pub = createPublicClient({
  chain,
  transport: http(RPC_URL, { retryCount: 2, retryDelay: 400, timeout: 20_000 }),
  pollingInterval: 400,
}) as PublicClient;

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
  if (/insufficient funds/i.test(m)) return 'Not enough MON for the network fee. Tap "Get test funds".';
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
