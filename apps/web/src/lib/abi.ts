// ABIs used by the app (selectors verified on Monad testnet by the spikes / the v1 source) and decoders that accept
// both the feasibility and the v1 struct layouts (see apps/api/src/abi.ts for the layouts).
import { decodeAbiParameters, hexToString, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function symbol() view returns (string)',
]);

export const ausdAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function nonces(address) view returns (uint256)',
]);

export const vaultAbi = parseAbi([
  'function getSeries(bytes32 seriesId) view returns (bytes32)', // decoded raw: layout differs between deployments
  'function ladderCount() view returns (uint256)',
  'function ladderAt(uint256 index) view returns (bytes4 station, uint32 date)',
  'function ladderSeries(bytes4 station, uint32 date) view returns (bytes32[])',
  'function redeem(bytes32 seriesId, uint256 yesAmount, uint256 noAmount) returns (uint256)',
  'function redeemSet(bytes32 seriesId, uint256 amount)',
  'function mintSet(bytes32 seriesId, uint256 amount)',
  'event SetMinted(bytes32 indexed seriesId, address indexed payer, address indexed to, uint256 amount)',
  'event SetRedeemed(bytes32 indexed seriesId, address indexed account, uint256 amount)',
  'function previewRedeem(bytes32 seriesId, uint256 yesAmount, uint256 noAmount) view returns (uint256)',
  'function mintAuthorizationNonce(bytes32 seriesId, uint256 amount, bytes32 salt) view returns (bytes32)',
  'event Redeemed(bytes32 indexed seriesId, address indexed account, uint256 yesAmount, uint256 noAmount, uint256 payout)',
  'error MintClosed(bytes32 seriesId, uint64 closeTime)',
  'error NotResolved(bytes32 seriesId)',
  'error NotFinal(bytes32 seriesId, uint64 finalAt)',
  'error UnknownSeries(bytes32 seriesId)',
  'error ZeroAmount()',
  'error EnforcedPause()',
  'error NotAllowlisted(bytes32 seriesId, address account)',
]);

export const resolverAbi = parseAbi([
  'function resultOf(bytes4 station, uint32 date) view returns (bytes32)', // decoded raw
  'function dayEnd(bytes4 station, uint32 date) view returns (uint256)',
  'function attester() view returns (address)',
  'function forwarder() view returns (address)',
  'function challengeWindow() view returns (uint256)',
  'function guardian() view returns (address)',
]);

export const zapAbi = parseAbi([
  'function buyYes(bytes32 seriesId, address market, uint256 ausdIn, uint256 minYesOut, address to) returns (uint256 yesOut, uint256 ausdRefund)',
  'function sellYes(bytes32 seriesId, address market, uint256 yesIn, uint256 minAusdOut, address to) returns (uint256 ausdOut, uint256 yesRefund)',
  // Zap.buyNo is deliberately NOT in this ABI: its minAusdBack bound fails under partial fills (verifier N1).
  // "Buy No" is vault.mintSet + zap.sellYes(minAusdOut); see lib/buyNo.ts.
  'function canonicalMarket(bytes32 seriesId) view returns (address)',
  'error MarketMismatch(address market)',
  'error MarketMismatch(address market, address canonical)',
  'error TradingClosed(bytes32 seriesId, uint64 closeTime)',
  'error Slippage(uint256 got, uint256 min)',
  'error ZeroMinOut()',
  'error ZeroAmount()',
  'error ZeroAddress()',
  'event ZapBuyYes(address indexed user, bytes32 indexed seriesId, address market, uint256 ausdIn, uint256 yesOut, uint256 ausdRefund)',
  'event ZapSellYes(address indexed user, bytes32 indexed seriesId, address market, uint256 yesIn, uint256 ausdOut, uint256 yesRefund)',
]);

export const routerAbi = parseAbi([
  'function verifiedMarket(address) view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAssetAddress, uint256 baseAssetDecimals, address quoteAssetAddress, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)',
]);

export const bookAbi = parseAbi([
  'function getL2Book() view returns (bytes)',
  'function bestBidAsk() view returns (uint256, uint256)',
  'error InsufficientBalance()',
]);

export const multicallAbi = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
]);

export const forwarderAbi = parseAbi([
  'function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)',
]);

export const SELECTORS = {
  canonicalMarket: toFunctionSelector('function canonicalMarket(bytes32)'),
  mintSetWithAuthorization: toFunctionSelector(
    'function mintSetWithAuthorization(bytes32,uint256,address,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
  ),
  mintSetWithPermit: toFunctionSelector('function mintSetWithPermit(bytes32,uint256,address,uint256,uint8,bytes32,bytes32)'),
  voidIfStale: toFunctionSelector('function voidIfStale(bytes4,uint32)'),
  report: toFunctionSelector('function report(address,bytes,bytes,bytes[])'),
};

export function bytecodeHasSelector(code: string, selector: string): boolean {
  const c = code.toLowerCase();
  const sel = selector.slice(2).toLowerCase();
  if (c.includes(`63${sel}`)) return true;
  return sel.startsWith('00') && c.includes(`62${sel.slice(2)}`);
}

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
      [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'uint64' }, { type: 'bool' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      data,
    );
    if (/^0x0+$/.test(yes)) return null;
    return { station: bytes4ToString(station), date, strikeC, closeTime: Number(closeTime), gated, yes, no, collateral };
  }
  if (words === 7) {
    const [station, date, strikeC, closeTime, yes, no, collateral] = decodeAbiParameters(
      [{ type: 'bytes4' }, { type: 'uint32' }, { type: 'int16' }, { type: 'uint64' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
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
  finalAt: number;
  sourcesHash: Hex;
  hasFinalAt: boolean;
}

export function decodeResult(data: Hex): ResultInfo | null {
  const words = (data.length - 2) / 64;
  if (words === 5) {
    const [status, tmaxC, resolvedAt, finalAt, sourcesHash] = decodeAbiParameters(
      [{ type: 'uint8' }, { type: 'int16' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }],
      data,
    );
    return { status: status as 0 | 1 | 2, tmaxC, resolvedAt: Number(resolvedAt), finalAt: Number(finalAt), sourcesHash, hasFinalAt: true };
  }
  if (words === 4) {
    const [status, tmaxC, resolvedAt, sourcesHash] = decodeAbiParameters(
      [{ type: 'uint8' }, { type: 'int16' }, { type: 'uint64' }, { type: 'bytes32' }],
      data,
    );
    return { status: status as 0 | 1 | 2, tmaxC, resolvedAt: Number(resolvedAt), finalAt: Number(resolvedAt), sourcesHash, hasFinalAt: false };
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

export const station4 = (code: string): Hex =>
  `0x${[...code].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(8, '0')}` as Hex;
