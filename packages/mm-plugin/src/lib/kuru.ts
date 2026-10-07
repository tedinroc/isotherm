// Kuru v1 (Monad testnet) order-book helpers: ABIs, market params, L2 decoding, open-order scan.
// Selectors were checked against the live OrderBook implementation 0x72caE0a9…9374 by the Kuru spike.
import { parseAbi, type Address, type Hex, type PublicClient } from "viem";

export const kuruRouterAbi = parseAbi([
  "function verifiedMarket(address) view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAssetAddress, uint256 baseAssetDecimals, address quoteAssetAddress, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
]);

export const orderBookAbi = parseAbi([
  "function addBuyOrder(uint32 _price, uint96 size, bool _postOnly)",
  "function addSellOrder(uint32 _price, uint96 _size, bool _postOnly)",
  "function batchCancelOrdersNoRevert(uint40[] _orderIds)",
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function bestBidAsk() view returns (uint256, uint256)",
  "function getL2Book() view returns (bytes)",
  "function s_orderIdCounter() view returns (uint40)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function s_buyPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function s_sellPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event OrdersCanceled(uint40[] orderId, address owner)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
  // Error selectors below were each found in the live OrderBook implementation bytecode (PUSH4 scan, 2026-10-07).
  // InsufficientBalance() comes from Kuru's MarginAccount (seen in the e2e spike as 0xf4d678b8).
  "error InsufficientBalance()",
  "error OnlyOwnerAllowedError()",
  "error PostOnlyError()",
  "error SizeError()",
  "error TickSizeError()",
  "error SlippageExceeded()",
  "error InsufficientLiquidity()",
  "error PriceError()",
  "error Uint96Overflow()",
  "error Uint32Overflow()",
  "error LengthMismatch()",
  "error MarketFeeError()",
]);

export const marginAccountAbi = parseAbi([
  "function deposit(address _user, address _token, uint256 _amount) payable",
  "function batchWithdrawMaxTokens(address[] _tokens)",
  "function getBalance(address _user, address _token) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

export type MarketParams = {
  market: Address;
  pricePrecision: bigint;
  sizePrecision: bigint;
  base: Address;
  baseDecimals: bigint;
  quote: Address;
  quoteDecimals: bigint;
  tickSize: bigint;
  minSize: bigint;
  maxSize: bigint;
  takerFeeBps: bigint;
  makerFeeBps: bigint;
};

const ZERO = "0x0000000000000000000000000000000000000000";

/** Router.verifiedMarket(market). Returns undefined when Kuru's router does not know the market. */
export async function readMarketParams(client: PublicClient, router: Address, market: Address): Promise<MarketParams | undefined> {
  const r = (await client.readContract({ address: router, abi: kuruRouterAbi, functionName: "verifiedMarket", args: [market] })) as readonly [
    number, bigint, Address, bigint, Address, bigint, number, bigint, bigint, bigint, bigint,
  ];
  if (r[2] === ZERO && r[4] === ZERO && r[0] === 0) return undefined;
  return {
    market,
    pricePrecision: BigInt(r[0]),
    sizePrecision: r[1],
    base: r[2],
    baseDecimals: r[3],
    quote: r[4],
    quoteDecimals: r[5],
    tickSize: BigInt(r[6]),
    minSize: r[7],
    maxSize: r[8],
    takerFeeBps: r[9],
    makerFeeBps: r[10],
  };
}

// ------------------------------------------------------------------------------------------- L2 book
/** One price level in raw Kuru units: price in pricePrecision units, size in sizePrecision units. */
export type Level = { priceU: bigint; sizeU: bigint };
export type L2 = { block: bigint; bids: Level[]; asks: Level[] };

/**
 * OrderBook.getL2Book(): 32-byte words [block] [price,size]* bids (best first) [0] [price,size]* asks (best first).
 * Price words are pricePrecision units and size words sizePrecision units (checked live by the Kuru spike).
 */
export function decodeL2(data: Hex): L2 {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const words: bigint[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(BigInt("0x" + hex.slice(i, i + 64)));
  const book: L2 = { block: words[0] ?? 0n, bids: [], asks: [] };
  let i = 1;
  for (; i < words.length && words[i] !== 0n; i += 2) book.bids.push({ priceU: words[i], sizeU: words[i + 1] ?? 0n });
  for (i += 1; i + 1 < words.length; i += 2) book.asks.push({ priceU: words[i], sizeU: words[i + 1] });
  return book;
}

export async function readL2(client: PublicClient, market: Address): Promise<L2> {
  const data = (await client.readContract({ address: market, abi: orderBookAbi, functionName: "getL2Book" })) as Hex;
  return decodeL2(data);
}

/** Human-readable book: prices as decimals of quote per base, sizes in base tokens. */
export function humanBook(b: L2, p: Pick<MarketParams, "pricePrecision" | "sizePrecision">, depth = 5) {
  const lvl = (l: Level) => ({ price: Number(l.priceU) / Number(p.pricePrecision), size: Number(l.sizeU) / Number(p.sizePrecision) });
  return {
    block: b.block.toString(),
    bestBid: b.bids[0] ? lvl(b.bids[0]).price : null,
    bestAsk: b.asks[0] ? lvl(b.asks[0]).price : null,
    bids: b.bids.slice(0, depth).map(lvl),
    asks: b.asks.slice(0, depth).map(lvl),
  };
}

// ------------------------------------------------------------------------------------------- unit conversions
export function sizeUToBase(sizeU: bigint, p: Pick<MarketParams, "sizePrecision" | "baseDecimals">): bigint {
  return (sizeU * 10n ** p.baseDecimals) / p.sizePrecision;
}
export function baseToSizeU(base: bigint, p: Pick<MarketParams, "sizePrecision" | "baseDecimals">): bigint {
  return (base * p.sizePrecision) / 10n ** p.baseDecimals;
}
/** Quote-token base units that `sizeU` at `priceU` is worth (rounded down). */
export function notionalQuote(sizeU: bigint, priceU: bigint, p: Pick<MarketParams, "sizePrecision" | "pricePrecision" | "quoteDecimals">): bigint {
  return (sizeU * priceU * 10n ** p.quoteDecimals) / (p.sizePrecision * p.pricePrecision);
}

// ------------------------------------------------------------------------------------------- open orders
export type OpenOrder = { id: bigint; isBuy: boolean; priceU: bigint; sizeU: bigint };

/**
 * Open orders of `owner` among the last `window` order ids. A filled order keeps its struct, so an order is
 * open iff owner matches, price != 0 and the price point's head has not moved past it (Kuru spike finding).
 */
export async function scanOpenOrders(client: PublicClient, multicall: Address, market: Address, owner: Address, window = 300): Promise<OpenOrder[]> {
  const counter = BigInt(await client.readContract({ address: market, abi: orderBookAbi, functionName: "s_orderIdCounter" }));
  const n = counter < BigInt(window) ? Number(counter) : window;
  if (n === 0) return [];
  const ids = Array.from({ length: n }, (_, i) => counter - BigInt(n - 1 - i));
  const orders = await client.multicall({
    multicallAddress: multicall,
    allowFailure: true,
    contracts: ids.map((id) => ({ address: market, abi: orderBookAbi, functionName: "s_orders", args: [Number(id)] }) as const),
  });
  const mine: { id: bigint; o: readonly [Address, bigint, number, number, number, number, number, boolean] }[] = [];
  orders.forEach((r, i) => {
    if (r.status !== "success") return;
    const o = r.result as unknown as readonly [Address, bigint, number, number, number, number, number, boolean];
    if (o[0].toLowerCase() === owner.toLowerCase() && o[5] !== 0) mine.push({ id: ids[i], o });
  });
  if (!mine.length) return [];
  const heads = await client.multicall({
    multicallAddress: multicall,
    allowFailure: true,
    contracts: mine.map(({ o }) => ({ address: market, abi: orderBookAbi, functionName: o[7] ? "s_buyPricePoints" : "s_sellPricePoints", args: [BigInt(o[5])] }) as const),
  });
  const out: OpenOrder[] = [];
  mine.forEach(({ id, o }, i) => {
    const h = heads[i];
    if (h.status !== "success") return;
    const head = BigInt((h.result as unknown as readonly [number, number])[0]);
    if (head !== 0n && head <= id) out.push({ id, isBuy: o[7], priceU: BigInt(o[5]), sizeU: o[1] });
  });
  return out;
}
