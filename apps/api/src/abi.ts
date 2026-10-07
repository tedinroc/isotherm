// Minimal ABIs (selectors verified on Monad testnet by the spikes) plus layout-tolerant decoders for the two
// structs whose layout changed between the feasibility deployment and v1:
//   Series: feasibility (station,date,strikeC,closeTime,yes,no,collateral)            = 7 words
//           v1          (station,date,strikeC,closeTime,gated,yes,no,collateral)      = 8 words
//   Result: feasibility (status,tmaxC,resolvedAt,sourcesHash)                          = 4 words
//           v1          (status,tmaxC,resolvedAt,finalAt,sourcesHash)                  = 5 words
import { decodeAbiParameters, hexToString, parseAbi, parseAbiItem, toFunctionSelector, type Abi, type Address, type Hex } from 'viem';
import bundle from './generated/abi-bundle.json';

export const ABI_BUNDLE = bundle as Record<string, Abi>;

export const ausdAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function nonces(address) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
]);

export const faucetAbi = parseAbi(['function requestFunds(address to)', 'error MaxFrequencyExceeded()']);

export const vaultFragments = parseAbi([
  'function getSeries(bytes32 seriesId) view returns (bytes32)', // placeholder, decoded raw (see decodeSeries)
  'function mintSetWithPermit(bytes32 seriesId, uint256 amount, address holder, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function ladderCount() view returns (uint256)',
  'function ladderSeries(bytes4 station, uint32 date) view returns (bytes32[])',
  'error MintClosed(bytes32 seriesId, uint64 closeTime)',
  'error UnknownSeries(bytes32 seriesId)',
  'error ZeroAmount()',
  'error EnforcedPause()',
]);

/** v1 vault additions (CollateralVault.mintSetWithAuthorization, EIP-3009 receive path). */
export const vaultV1Abi = parseAbi([
  'function mintSetWithAuthorization(bytes32 seriesId, uint256 amount, address holder, uint256 validAfter, uint256 validBefore, bytes32 salt, uint8 v, bytes32 r, bytes32 s)',
  'function mintAuthorizationNonce(bytes32 seriesId, uint256 amount, bytes32 salt) view returns (bytes32)',
  'error NotAllowlisted(bytes32 seriesId, address account)',
  'error CollateralTransferMismatch(uint256 expected, uint256 received)',
]);

export const SELECTORS = {
  mintSetWithAuthorization: toFunctionSelector(vaultV1Abi[0]),
  mintSetWithPermit: toFunctionSelector(
    'function mintSetWithPermit(bytes32 seriesId, uint256 amount, address holder, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  ),
};

export const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export const TRADE_EVENT = parseAbiItem(
  'event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)',
);
export const LADDER_RESOLVED_EVENT = parseAbiItem(
  'event LadderResolved(bytes4 indexed station, uint32 indexed date, uint8 status, int16 tmaxC, bytes32 sourcesHash, address caller)',
);
export const LADDER_CHALLENGED_PREFIX = 'LadderChallenged';
/** v1 Zap registry: every canonical book is announced on-chain, so the scanner can discover markets by itself. */
export const CANONICAL_MARKET_SET_EVENT = parseAbiItem(
  'event CanonicalMarketSet(bytes32 indexed seriesId, address indexed market, address indexed setBy)',
);

export interface SeriesInfo {
  station: string;
  date: number;
  strikeC: number;
  closeTime: number;
  gated: boolean;
  yes: Address;
  no: Address;
  collateral: bigint;
}

export function decodeSeries(data: Hex): SeriesInfo | null {
  const words = (data.length - 2) / 64;
  if (words === 8) {
    const [station, date, strikeC, closeTime, gated, yes, no, collateral] = decodeAbiParameters(
      [
        { type: 'bytes4' },
        { type: 'uint32' },
        { type: 'int16' },
        { type: 'uint64' },
        { type: 'bool' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      data,
    );
    if (/^0x0+$/.test(yes)) return null;
    return { station: bytes4ToString(station), date, strikeC, closeTime: Number(closeTime), gated, yes, no, collateral };
  }
  if (words === 7) {
    const [station, date, strikeC, closeTime, yes, no, collateral] = decodeAbiParameters(
      [
        { type: 'bytes4' },
        { type: 'uint32' },
        { type: 'int16' },
        { type: 'uint64' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      data,
    );
    if (/^0x0+$/.test(yes)) return null;
    return { station: bytes4ToString(station), date, strikeC, closeTime: Number(closeTime), gated: false, yes, no, collateral };
  }
  return null;
}

export interface ResultInfo {
  status: 0 | 1 | 2; // None | Settled | Void
  tmaxC: number;
  resolvedAt: number;
  finalAt: number; // redemption opens (feasibility deployment: == resolvedAt)
  sourcesHash: Hex;
}

export function decodeResult(data: Hex): ResultInfo | null {
  const words = (data.length - 2) / 64;
  if (words === 5) {
    const [status, tmaxC, resolvedAt, finalAt, sourcesHash] = decodeAbiParameters(
      [{ type: 'uint8' }, { type: 'int16' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }],
      data,
    );
    return { status: status as 0 | 1 | 2, tmaxC, resolvedAt: Number(resolvedAt), finalAt: Number(finalAt), sourcesHash };
  }
  if (words === 4) {
    const [status, tmaxC, resolvedAt, sourcesHash] = decodeAbiParameters(
      [{ type: 'uint8' }, { type: 'int16' }, { type: 'uint64' }, { type: 'bytes32' }],
      data,
    );
    return { status: status as 0 | 1 | 2, tmaxC, resolvedAt: Number(resolvedAt), finalAt: Number(resolvedAt), sourcesHash };
  }
  return null;
}

export function bytes4ToString(b: Hex): string {
  try {
    return hexToString(b, { size: 4 }).replace(/\0/g, '');
  } catch {
    return b;
  }
}

/** Returns the ABI item for `name` from the exported contract ABI bundle (packages/abi), if present. */
export function bundledFunction(contract: string, name: string) {
  const abi = ABI_BUNDLE[contract];
  if (!abi) return null;
  return (abi as readonly { type: string; name?: string }[]).find((x) => x.type === 'function' && x.name === name) ?? null;
}
