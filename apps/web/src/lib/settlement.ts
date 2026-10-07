// Verifies a settlement in the browser: fetch the report transaction, strip the CRE forwarder header, decode the
// Isotherm report and recover the EIP-712 attestation signer, then compare it with the Resolver's attester.
import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  hexToString,
  recoverTypedDataAddress,
  slice,
  type Address,
  type Hex,
} from 'viem';
import { SELECTORS, bytes4ToString, forwarderAbi, resolverAbi } from './abi';
import { chain, pub } from './chain';
import { DEPLOYMENTS } from './deployments';

export interface AttestationCheck {
  kind: 'report' | 'stale-void' | 'other';
  to: Address | null;
  forwarderKind: 'mock' | 'keystone' | 'unknown';
  workflowName: string | null;
  workflowOwner: Address | null;
  workflowId: Hex | null;
  station?: string;
  date?: number;
  tmaxC?: number;
  isVoid?: boolean;
  sourcesHash?: Hex;
  validUntil?: number | null;
  signer?: Address | null;
  attester?: Address | null;
  matches?: boolean;
}

const HEADER = 109; // 0x01 | execId 32 | ts 4 | donId 4 | cfgVersion 4 | workflowId 32 | name 10 | owner 20 | reportId 2

export async function checkSettlementTx(hash: Hex): Promise<AttestationCheck> {
  const tx = await pub.getTransaction({ hash });
  const to = tx.to ? getAddress(tx.to) : null;
  const sel = tx.input.slice(0, 10).toLowerCase();
  const forwarderKind =
    to === getAddress(DEPLOYMENTS.mockForwarder) ? 'mock' : to === getAddress(DEPLOYMENTS.keystoneForwarder) ? 'keystone' : 'unknown';
  if (sel === SELECTORS.voidIfStale.toLowerCase()) {
    return { kind: 'stale-void', to, forwarderKind, workflowName: null, workflowOwner: null, workflowId: null };
  }
  if (sel !== SELECTORS.report.toLowerCase()) {
    return { kind: 'other', to, forwarderKind, workflowName: null, workflowOwner: null, workflowId: null };
  }
  const { args } = decodeFunctionData({ abi: forwarderAbi, data: tx.input });
  const raw = args[1] as Hex;
  const workflowId = slice(raw, 45, 77);
  let workflowName: string | null = null;
  try {
    workflowName = hexToString(slice(raw, 77, 87)).replace(/\0/g, '');
  } catch {
    workflowName = null;
  }
  const workflowOwner = getAddress(slice(raw, 87, 107));
  const payload = slice(raw, HEADER);
  const base = { kind: 'report' as const, to, forwarderKind: forwarderKind as AttestationCheck['forwarderKind'], workflowName, workflowOwner, workflowId };

  type V1 = readonly [Hex, number, number, boolean, Hex, bigint, Hex];
  type V0 = readonly [Hex, number, number, boolean, Hex, Hex];
  let decoded: { station: Hex; date: number; tmaxC: number; isVoid: boolean; sourcesHash: Hex; validUntil: bigint | null; sig: Hex } | null = null;
  try {
    const d = decodeAbiParameters(
      [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'bool' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes' }],
      payload,
    ) as unknown as V1;
    if ((d[6].length - 2) / 2 === 65) decoded = { station: d[0], date: d[1], tmaxC: d[2], isVoid: d[3], sourcesHash: d[4], validUntil: d[5], sig: d[6] };
  } catch {
    /* not v1 */
  }
  if (!decoded) {
    try {
      const d = decodeAbiParameters(
        [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'bool' }, { type: 'bytes32' }, { type: 'bytes' }],
        payload,
      ) as unknown as V0;
      decoded = { station: d[0], date: d[1], tmaxC: d[2], isVoid: d[3], sourcesHash: d[4], validUntil: null, sig: d[5] };
    } catch {
      return base;
    }
  }
  const domain = { name: 'Isotherm Resolver', version: '1', chainId: chain.id, verifyingContract: DEPLOYMENTS.resolver } as const;
  const fields = [
    { name: 'station', type: 'bytes4' },
    { name: 'date', type: 'uint32' },
    { name: 'tmaxC', type: 'int16' },
    { name: 'isVoid', type: 'bool' },
    { name: 'sourcesHash', type: 'bytes32' },
  ];
  const message: Record<string, unknown> = {
    station: decoded.station,
    date: decoded.date,
    tmaxC: decoded.tmaxC,
    isVoid: decoded.isVoid,
    sourcesHash: decoded.sourcesHash,
  };
  if (decoded.validUntil !== null) {
    fields.push({ name: 'validUntil', type: 'uint64' });
    message.validUntil = decoded.validUntil;
  }
  let signer: Address | null = null;
  try {
    signer = await recoverTypedDataAddress({ domain, types: { Settlement: fields }, primaryType: 'Settlement', message, signature: decoded.sig } as never);
  } catch {
    signer = null;
  }
  let attester: Address | null = null;
  try {
    attester = getAddress((await pub.readContract({ address: DEPLOYMENTS.resolver, abi: resolverAbi, functionName: 'attester' })) as Address);
  } catch {
    attester = null;
  }
  return {
    ...base,
    station: bytes4ToString(decoded.station),
    date: decoded.date,
    tmaxC: decoded.tmaxC,
    isVoid: decoded.isVoid,
    sourcesHash: decoded.sourcesHash,
    validUntil: decoded.validUntil === null ? null : Number(decoded.validUntil),
    signer,
    attester,
    matches: !!signer && !!attester && signer === attester,
  };
}
