// Kuru v1 order-book reads for the maker (ported from spikes/kuru/ts/kuru.ts and spikes/e2e/ts/e2e.ts).
// Units: price is human AUSD per YES (Kuru stores 1e-4 AUSD units; tick 10 = 0.001); size is YES (6 dp = Kuru size units).
import { decodeEventLog, maxUint256, type Address, type Hex, type TransactionReceipt } from "viem";
import { kuruBookAbi, marginAbi } from "./abis.ts";
import type { Ctx } from "./chain.ts";

export const PRICE_UNITS = 10_000; // pricePrecision
export const SIZE_UNITS = 1_000_000; // sizePrecision == YES base units

export const toPriceUnits = (p: number): number => Math.round(p * PRICE_UNITS);
export const toSizeUnits = (yes: number): bigint => BigInt(Math.round(yes * SIZE_UNITS));
export const fromPriceUnits = (u: bigint | number) => Number(u) / PRICE_UNITS;
export const fromSizeUnits = (u: bigint | number) => Number(u) / SIZE_UNITS;

export type Level = { price: number; size: number };
export type Book = { block: bigint; bids: Level[]; asks: Level[]; bestBid: number | null; bestAsk: number | null };

/** OrderBook.getL2Book(): [block][price,size]* bids (desc) [0] [price,size]* asks (asc), 32-byte words. */
export function decodeL2(data: Hex): Book {
  const hex = data.slice(2);
  const words: bigint[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(BigInt("0x" + hex.slice(i, i + 64)));
  const book: Book = { block: words[0] ?? 0n, bids: [], asks: [], bestBid: null, bestAsk: null };
  let i = 1;
  for (; i < words.length && words[i] !== 0n; i += 2) book.bids.push({ price: fromPriceUnits(words[i]), size: fromSizeUnits(words[i + 1]) });
  for (i += 1; i + 1 < words.length; i += 2) book.asks.push({ price: fromPriceUnits(words[i]), size: fromSizeUnits(words[i + 1]) });
  book.bestBid = book.bids[0]?.price ?? null;
  book.bestAsk = book.asks[0]?.price ?? null;
  return book;
}

export async function getBook(ctx: Pick<Ctx, "pub">, market: Address): Promise<Book> {
  return decodeL2((await ctx.pub.readContract({ address: market, abi: kuruBookAbi, functionName: "getL2Book" })) as Hex);
}

/** Best bid/ask of everybody else: subtract our own resting size at our price levels (pure). */
export function othersBest(book: Book, ours: { bid?: { price: number; size: number }; ask?: { price: number; size: number } }) {
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const bid = book.bids.find((l) => l.size - (ours.bid && eq(ours.bid.price, l.price) ? ours.bid.size : 0) > 1e-9)?.price ?? null;
  const ask = book.asks.find((l) => l.size - (ours.ask && eq(ours.ask.price, l.price) ? ours.ask.size : 0) > 1e-9)?.price ?? null;
  return { bid, ask };
}

export type OpenOrder = { id: number; open: boolean; remaining: number; price: number; isBuy: boolean };

/** Remaining size of tracked orders. Open iff owner matches, price != 0 and the price point's head is non-zero and
 *  <= id (a fully filled order keeps its struct; rule from the Kuru spike). One multicall for all ids. */
export async function orderStatus(ctx: Pick<Ctx, "pub" | "dep">, market: Address, owner: Address, ids: number[]): Promise<OpenOrder[]> {
  if (!ids.length) return [];
  const os = (await ctx.pub.multicall({
    allowFailure: false,
    multicallAddress: ctx.dep.multicall3,
    contracts: ids.map((id) => ({ address: market, abi: kuruBookAbi, functionName: "s_orders", args: [id] }) as const),
  })) as unknown as readonly [Address, bigint, number, number, number, number, number, boolean][];
  const heads = (await ctx.pub.multicall({
    allowFailure: false,
    multicallAddress: ctx.dep.multicall3,
    contracts: os.map((o) => ({ address: market, abi: kuruBookAbi, functionName: o[7] ? "s_buyPricePoints" : "s_sellPricePoints", args: [BigInt(o[5])] }) as const),
  })) as unknown as readonly [number, number][];
  return ids.map((id, i) => {
    const [own, size, , , , price, , isBuy] = os[i];
    const head = Number(heads[i][0]);
    const open = own.toLowerCase() === owner.toLowerCase() && Number(price) !== 0 && head !== 0 && head <= id;
    return { id, open, remaining: open ? fromSizeUnits(size) : 0, price: fromPriceUnits(price), isBuy };
  });
}

/** Scan the last `window` order ids for open orders of `owner` (kill-switch fallback when state is lost). */
export async function scanOpenOrders(ctx: Pick<Ctx, "pub" | "dep">, market: Address, owner: Address, window = 300): Promise<OpenOrder[]> {
  const counter = Number(await ctx.pub.readContract({ address: market, abi: kuruBookAbi, functionName: "s_orderIdCounter" }));
  const ids = Array.from({ length: Math.min(counter, window) }, (_, i) => counter - i).filter((x) => x > 0).reverse();
  const out: OpenOrder[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await orderStatus(ctx, market, owner, ids.slice(i, i + 100))));
  return out.filter((o) => o.open);
}

export async function marginBalance(ctx: Pick<Ctx, "pub" | "dep">, owner: Address, token: Address): Promise<bigint> {
  return (await ctx.pub.readContract({ address: ctx.dep.marginAccount, abi: marginAbi, functionName: "getBalance", args: [owner, token] })) as bigint;
}

export function createdOrders(receipt: TransactionReceipt, market: Address) {
  const out: { id: number; price: number; size: number; isBuy: boolean }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== market.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: kuruBookAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "OrderCreated") out.push({ id: Number(ev.args.orderId), price: fromPriceUnits(ev.args.price), size: fromSizeUnits(ev.args.size), isBuy: ev.args.isBuy });
    } catch {}
  }
  return out;
}

export async function bestBidAsk(ctx: Pick<Ctx, "pub">, market: Address) {
  const [b, a] = (await ctx.pub.readContract({ address: market, abi: kuruBookAbi, functionName: "bestBidAsk" })) as [bigint, bigint];
  return { bid: b === maxUint256 || b === 0n ? null : Number(b) / 1e18, ask: a === 0n || a === maxUint256 ? null : Number(a) / 1e18 };
}
