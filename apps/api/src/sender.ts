// Relayer transactions over several RPC endpoints: pick the nonce, sign ONCE, broadcast, and settle what happened.
//
// The relayer is one EOA and the Durable Object runs its writes one at a time (relayer.ts queue), so the only nonce
// hazards are the RPCs themselves:
//   - Monad's eth_getTransactionCount('pending') does not count a just-submitted tx (go-live, 2026-10-07), and with
//     several endpoints (or a load-balanced one) the next job can read the count from a node a block behind the one
//     that served the last receipt. So the next nonce is max(RPC count, local floor), where the floor is raised only
//     from receipts of our own transactions: a MINED nonce is final, so the floor is never ahead of the chain.
//   - A broadcast is signed once and the same bytes are retried (by the RPC pool, across endpoints): one hash, one
//     nonce, so a retry can never become a second transaction. If the broadcast call itself fails, the hash decides:
//     "already known" or the tx found by hash = it went out; "nonce too low" and not found = the nonce was used by
//     something else (stale-nonce, nothing of ours went out); a provider rejection = nothing went out; a timeout /
//     5xx / rate limit on every endpoint and not found = uncertain (callers count it as sent, never resend it).
import { keccak256, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { Pub, Wallet } from './chain';
import type { Store } from './limits';
import { classifyRpcError, errorText } from './rpc';
import { errorMessage } from './util';

export interface TxRequest {
  to: Address;
  value?: bigint;
  data?: Hex;
  gas: bigint;
  nonce: number;
}

export type BroadcastFailure = 'rejected' | 'stale-nonce' | 'uncertain';

export class BroadcastError extends Error {
  constructor(
    message: string,
    public kind: BroadcastFailure,
    /** The signed transaction's hash. For 'uncertain' it may still land; for the other kinds it did not go out. */
    public hash: Hex | null,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = 'BroadcastError';
  }
}

const ALREADY_KNOWN = /already known|known transaction|already imported|already exists|already in (the )?(mempool|tx ?pool)/i;
const STALE_NONCE = /nonce too low|nonce (has )?already (been )?used|invalid nonce|nonce .*(lower|less) than|replacement transaction underpriced/i;

/** Per relayer address, so a rotated RELAYER_KEY never inherits the old key's floor. */
export const nonceFloorKey = (address: string) => `relayer:nonceFloor:${address.toLowerCase()}`;

export interface SenderOptions {
  pub: Pub;
  wallet: Wallet;
  store: Store;
  chainId: number;
  /** Lookups by hash after a failed broadcast call (a landed tx is visible within a block or two on Monad). */
  findPolls?: number;
  findDelayMs?: number;
  receiptPollMs?: number;
  receiptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createSender(o: SenderOptions) {
  const address = o.wallet.account.address;
  const floorKey = nonceFloorKey(address);
  const findPolls = o.findPolls ?? 6;
  const findDelayMs = o.findDelayMs ?? 750;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sentNonce = new Map<Hex, number>();
  let floor: number | null = null;

  async function loadFloor(): Promise<number> {
    if (floor === null) floor = (await o.store.get<number>(floorKey)) ?? 0;
    return floor;
  }
  async function raiseFloor(next: number) {
    if (next > (await loadFloor())) {
      floor = next;
      await o.store.put(floorKey, next);
    }
  }

  /** The relayer's next nonce: the RPC's count, or the local floor when the RPC is behind our last mined tx. */
  async function nextNonce(): Promise<number> {
    const [count, f] = await Promise.all([o.pub.getTransactionCount({ address, blockTag: 'pending' }), loadFloor()]);
    return Math.max(count, f);
  }

  async function seen(hash: Hex, polls: number): Promise<boolean> {
    for (let i = 0; i < polls; i++) {
      if (i) await sleep(findDelayMs);
      try {
        await o.pub.getTransaction({ hash });
        return true;
      } catch {
        /* not visible yet, or RPC trouble: look again */
      }
    }
    return false;
  }

  /** Sign once and broadcast. Resolves with the hash once the network has the tx; throws BroadcastError otherwise. */
  async function send(tx: TxRequest): Promise<Hex> {
    const chainId = await o.pub.getChainId();
    if (chainId !== o.chainId) throw new BroadcastError(`RPC serves chain ${chainId}, expected ${o.chainId}`, 'rejected', null);
    let serialized: Hex;
    try {
      const fees = await o.pub.estimateFeesPerGas();
      serialized = await o.wallet.account.signTransaction!({
        type: 'eip1559',
        chainId,
        to: tx.to,
        value: tx.value ?? 0n,
        data: tx.data,
        gas: tx.gas,
        nonce: tx.nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
    } catch (e) {
      throw new BroadcastError(`could not prepare the transaction: ${errorMessage(e)}`, 'rejected', null, e);
    }
    const hash = keccak256(serialized);
    try {
      await o.pub.sendRawTransaction({ serializedTransaction: serialized });
      sentNonce.set(hash, tx.nonce);
      return hash;
    } catch (e) {
      const text = errorText(e) || errorMessage(e);
      const kind = classifyRpcError(e);
      const stale = STALE_NONCE.test(text);
      if (ALREADY_KNOWN.test(text) || (await seen(hash, kind === 'deterministic' && !stale ? 1 : findPolls))) {
        sentNonce.set(hash, tx.nonce);
        return hash;
      }
      if (stale) throw new BroadcastError(`nonce ${tx.nonce} is already used on chain; retry`, 'stale-nonce', hash, e);
      if (kind === 'deterministic') throw new BroadcastError(`the RPC rejected the transaction: ${errorMessage(e)}`, 'rejected', hash, e);
      throw new BroadcastError(`broadcast not confirmed (${kind}): ${errorMessage(e)}`, 'uncertain', hash, e);
    }
  }

  /** Wait for the receipt; a mined tx raises the nonce floor (reverted txs use their nonce too). */
  async function wait(hash: Hex): Promise<TransactionReceipt> {
    const n = sentNonce.get(hash);
    sentNonce.delete(hash);
    const r = await o.pub.waitForTransactionReceipt({ hash, pollingInterval: o.receiptPollMs ?? 400, timeout: o.receiptTimeoutMs ?? 45_000 });
    if (n !== undefined) await raiseFloor(n + 1);
    return r;
  }

  return { address, nextNonce, send, wait };
}

export type Sender = ReturnType<typeof createSender>;
