// User transactions. Monad bills the gas LIMIT, so every write estimates first and sends limit = estimate × 1.10.
// Book trades always go through IsothermZap with a min-out computed from the live book (buyYes, sellYes). Buy No is
// vault.mintSet + zap.sellYes (lib/buyNo.ts), never Zap.buyNo, whose bound fails under partial fills.
import { maxUint256, parseSignature, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { GAS_MULTIPLIER_PCT } from '../config';
import type { Client } from '../wallet/wallet';
import { ausdAbi, erc20Abi, vaultAbi, zapAbi } from './abi';
import { api } from './api';
import { chain, explainError, pub } from './chain';
import { DEPLOYMENTS } from './deployments';
import type { StrikeView } from './data';

export interface TxResult {
  hash: Hex;
  receipt: TransactionReceipt;
  gasLimit: bigint;
  ms: number;
}

export async function send(client: Client, req: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }): Promise<TxResult> {
  const t0 = performance.now();
  const account = client.account;
  let est: bigint;
  try {
    est = await pub.estimateContractGas({ ...req, account: account.address } as never);
  } catch (e) {
    throw new Error(explainError(e));
  }
  const gas = (est * GAS_MULTIPLIER_PCT + 99n) / 100n;
  let hash: Hex;
  try {
    hash = await client.writeContract({ ...req, gas, chain, account } as never);
  } catch (e) {
    throw new Error(explainError(e));
  }
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 90_000 });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted (${hash.slice(0, 10)}…)`);
  return { hash, receipt, gasLimit: gas, ms: Math.round(performance.now() - t0) };
}

/** Approve `spender` (the Zap for Buy Yes, the vault for Buy No's mint) for AUSD once (100,000 test AUSD) so later
 *  trades skip the approval. Neither contract can pull a holder's AUSD on anyone else's behalf. */
export async function ensureAusdAllowance(
  client: Client,
  needed: bigint,
  current: bigint,
  spender: Address = DEPLOYMENTS.zap,
): Promise<TxResult | null> {
  if (current >= needed) return null;
  const amount = needed > 100_000_000_000n ? needed : 100_000_000_000n;
  return send(client, { address: DEPLOYMENTS.ausd, abi: ausdAbi as Abi, functionName: 'approve', args: [spender, amount] });
}

export async function ensureYesAllowance(client: Client, s: StrikeView, needed: bigint, current: bigint): Promise<TxResult | null> {
  if (current >= needed) return null;
  return send(client, { address: s.yes, abi: erc20Abi as Abi, functionName: 'approve', args: [DEPLOYMENTS.zap, maxUint256] });
}

export function buyYes(client: Client, s: StrikeView, ausdIn: bigint, minYesOut: bigint) {
  return send(client, {
    address: DEPLOYMENTS.zap,
    abi: zapAbi as Abi,
    functionName: 'buyYes',
    args: [s.seriesId, s.market, ausdIn, minYesOut, client.account.address],
  });
}

export function sellYes(client: Client, s: StrikeView, yesIn: bigint, minAusdOut: bigint) {
  return send(client, {
    address: DEPLOYMENTS.zap,
    abi: zapAbi as Abi,
    functionName: 'sellYes',
    args: [s.seriesId, s.market, yesIn, minAusdOut, client.account.address],
  });
}

/** vault.mintSet: pull `amount` AUSD from the caller, mint `amount` YES + `amount` NO to the caller. */
export function mintSet(client: Client, s: StrikeView, amount: bigint) {
  return send(client, { address: DEPLOYMENTS.vault, abi: vaultAbi as Abi, functionName: 'mintSet', args: [s.seriesId, amount] });
}

export function redeem(client: Client, seriesId: Hex, yes: bigint, no: bigint) {
  return send(client, { address: DEPLOYMENTS.vault, abi: vaultAbi as Abi, functionName: 'redeem', args: [seriesId, yes, no] });
}

export function mergePairs(client: Client, seriesId: Hex, amount: bigint) {
  return send(client, { address: DEPLOYMENTS.vault, abi: vaultAbi as Abi, functionName: 'redeemSet', args: [seriesId, amount] });
}

const AUSD_DOMAIN = () => ({ name: 'Agora Dollar', version: '1', chainId: chain.id, verifyingContract: DEPLOYMENTS.ausd }) as const;

function randomBytes32(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}` as Hex;
}

/** Gasless mint of `amount` complete sets: the user signs, the API relayer submits and pays the gas.
 *  v1 vault: EIP-3009 ReceiveWithAuthorization (front-run safe, bound to series+amount via the nonce).
 *  Feasibility vault: EIP-2612 permit to the vault. */
export async function relayedMint(client: Client, s: StrikeView, amount: bigint, mode: 'authorization' | 'permit') {
  const holder = client.account.address;
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (mode === 'authorization') {
    const salt = randomBytes32();
    const nonce = (await pub.readContract({
      address: DEPLOYMENTS.vault,
      abi: vaultAbi,
      functionName: 'mintAuthorizationNonce',
      args: [s.seriesId, amount, salt],
    })) as Hex;
    const validBefore = now + 900n;
    const signature = await client.signTypedData({
      account: client.account,
      domain: AUSD_DOMAIN(),
      types: {
        ReceiveWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'ReceiveWithAuthorization',
      message: { from: holder, to: DEPLOYMENTS.vault, value: amount, validAfter: 0n, validBefore, nonce },
    });
    parseSignature(signature);
    return api.relayMint({
      mode,
      chainId: chain.id,
      seriesId: s.seriesId,
      amount: amount.toString(),
      holder,
      validAfter: '0',
      validBefore: validBefore.toString(),
      salt,
      signature,
    });
  }
  const permitNonce = (await pub.readContract({ address: DEPLOYMENTS.ausd, abi: ausdAbi, functionName: 'nonces', args: [holder] })) as bigint;
  const deadline = now + 900n;
  const signature = await client.signTypedData({
    account: client.account,
    domain: AUSD_DOMAIN(),
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: holder, spender: DEPLOYMENTS.vault, value: amount, nonce: permitNonce, deadline },
  });
  return api.relayMint({
    mode,
    chainId: chain.id,
    seriesId: s.seriesId,
    amount: amount.toString(),
    holder,
    deadline: deadline.toString(),
    signature,
  });
}
