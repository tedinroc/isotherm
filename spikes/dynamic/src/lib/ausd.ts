// AUSD (Agora Dollar) typed-data helpers shared by the PWA (signs with the
// Dynamic embedded wallet) and the relayer / e2e script (verifies + submits).
//
// Verified against the live Monad testnet contract (see RESULT.md):
//   eip712Domain() = ("Agora Dollar", "1", 10143, 0xa901…22dC)
//   DOMAIN_SEPARATOR() = 0x7ff7d6b4…3ea1 (recomputed locally, identical)
//   TRANSFER/RECEIVE_WITH_AUTHORIZATION_TYPEHASH = standard EIP-3009 values
// NOTE: name() returns "AUSD" but the EIP-712 domain name is "Agora Dollar".
import { parseAbi, type Address, type Hex } from 'viem';

export const AUSD_DECIMALS = 6;

export const AUSD_ADDRESS: Record<number, Address> = {
  10143: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC', // Monad testnet (faucet-mintable)
  143: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', // Monad mainnet (real money — never used by this spike)
};

/** Testnet-only faucet: requestFunds(address) mints 10,000 AUSD to `address`. */
export const AUSD_TESTNET_FAUCET: Address = '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C';

export const ausdAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  // EIP-3009, bytes-signature variants (also accept ERC-1271 smart-wallet signatures)
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, bytes signature)',
  // EIP-2612
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, bytes signature)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);

/** Faucet custom error 0x20e5bc67 = MaxFrequencyExceeded(): one GLOBAL 60 s cooldown for all callers. */
export const faucetAbi = parseAbi(['function requestFunds(address to)', 'error MaxFrequencyExceeded()']);

export function ausdDomain(chainId: number) {
  const verifyingContract = AUSD_ADDRESS[chainId];
  if (!verifyingContract) throw new Error(`AUSD not configured for chain ${chainId}`);
  return { name: 'Agora Dollar', version: '1', chainId, verifyingContract } as const;
}

const AUTH_FIELDS = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = { TransferWithAuthorization: AUTH_FIELDS } as const;
export const RECEIVE_WITH_AUTHORIZATION_TYPES = { ReceiveWithAuthorization: AUTH_FIELDS } as const;
export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type AuthKind = 'transfer' | 'receive';

export interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** JSON-safe wire format the PWA POSTs to the relayer (bigints as decimal strings). */
export interface AuthorizationWire {
  kind: AuthKind;
  chainId: number;
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
}

export function randomNonce(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}` as Hex;
}

export function newAuthorization(p: {
  from: Address;
  to: Address;
  value: bigint;
  ttlSeconds?: number;
  nowSeconds?: number;
}): Authorization {
  const now = BigInt(p.nowSeconds ?? Math.floor(Date.now() / 1000));
  return {
    from: p.from,
    to: p.to,
    value: p.value,
    validAfter: 0n,
    validBefore: now + BigInt(p.ttlSeconds ?? 600),
    nonce: randomNonce(),
  };
}

export function transferAuthorizationTypedData(chainId: number, a: Authorization) {
  return {
    domain: ausdDomain(chainId),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization' as const,
    message: a,
  };
}

export function receiveAuthorizationTypedData(chainId: number, a: Authorization) {
  return {
    domain: ausdDomain(chainId),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization' as const,
    message: a,
  };
}

/** Typed data ready for viem `walletClient.signTypedData({ account, ...typedData })`. */
export function authorizationTypedData(kind: 'transfer', chainId: number, a: Authorization): ReturnType<typeof transferAuthorizationTypedData>;
export function authorizationTypedData(kind: 'receive', chainId: number, a: Authorization): ReturnType<typeof receiveAuthorizationTypedData>;
export function authorizationTypedData(kind: AuthKind, chainId: number, a: Authorization) {
  return kind === 'transfer' ? transferAuthorizationTypedData(chainId, a) : receiveAuthorizationTypedData(chainId, a);
}

export function permitTypedData(
  chainId: number,
  p: { owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint },
) {
  return { domain: ausdDomain(chainId), types: PERMIT_TYPES, primaryType: 'Permit' as const, message: p };
}

export function toWire(kind: AuthKind, chainId: number, a: Authorization, signature: Hex): AuthorizationWire {
  return {
    kind,
    chainId,
    from: a.from,
    to: a.to,
    value: a.value.toString(),
    validAfter: a.validAfter.toString(),
    validBefore: a.validBefore.toString(),
    nonce: a.nonce,
    signature,
  };
}

export function fromWire(w: AuthorizationWire): { kind: AuthKind; chainId: number; auth: Authorization; signature: Hex } {
  return {
    kind: w.kind,
    chainId: w.chainId,
    auth: {
      from: w.from,
      to: w.to,
      value: BigInt(w.value),
      validAfter: BigInt(w.validAfter),
      validBefore: BigInt(w.validBefore),
      nonce: w.nonce,
    },
    signature: w.signature,
  };
}

export function formatAusd(v: bigint): string {
  const whole = v / 10n ** BigInt(AUSD_DECIMALS);
  const frac = (v % 10n ** BigInt(AUSD_DECIMALS)).toString().padStart(AUSD_DECIMALS, '0').slice(0, 2);
  return `${whole.toString()}.${frac}`;
}
