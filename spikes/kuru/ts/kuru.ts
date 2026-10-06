// Isotherm × Kuru v1 (Monad testnet 10143) — reusable viem helpers.
//
//   createMarket(yesToken) -> market         placeQuotes(market, bids, asks, cancelIds?)
//   cancelAll(market, ids?)                  marketBuy(market, amountAUSD) / marketSell(market, amountYES)
//   getBook(market)                          getOpenOrders(market, owner), depositMargin, withdrawAllMargin
//
// Units (Isotherm YES/AUSD market params, see PARAMS):
//   price  : human AUSD per YES (0.001 … 0.999), converted to pricePrecision units (×1e4), must be a multiple of tick (10 = 0.001)
//   size   : human YES (6-dp token), converted to sizePrecision units (×1e6 = token base units)
//   AUSD   : 6 dp
// Monad bills the GAS LIMIT, so every write here estimates gas and sends limit = ceil(estimate × gasMult).
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  maxUint256,
  parseAbi,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- addresses (verified on-chain 2026-10-06)
export const TESTNET = {
  chainId: 10143,
  rpc: "https://testnet-rpc.monad.xyz",
  router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630" as Address, // ERC1967 proxy, impl 0xaaa0f0c4…e1ed
  marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as Address,
  kuruForwarder: "0x681bB1508E14433b148a2549ba2726454aDc9BB4" as Address,
  orderBookImpl: "0x72caE0a99C19B574e8a6De558F43fc1D019c9374" as Address,
  ausd: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" as Address, // 6 dp
  ausdFaucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as Address, // requestFunds(addr): 10,000 AUSD, global 60 s cooldown
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
} as const;

// ---------------------------------------------------------------- market params for a 0.001–0.999 binary token
export const PARAMS = {
  type: 0, // NO_NATIVE (ERC20 base / ERC20 quote)
  sizePrecision: 1_000_000n, // 1 size unit = 1 YES base unit (token has 6 dp)
  pricePrecision: 10_000, // price units of 0.0001 AUSD
  tickSize: 10, // 0.001 AUSD tick (Polymarket-style tail granularity)
  minSize: 1_000_000n, // 1 YES minimum order (anti-spam; ≥ $0.001 notional)
  maxSize: 1_000_000_000_000n, // 1,000,000 YES per order
  takerFeeBps: 10n, // 0.10 % to Kuru protocol (fee taken from the taker's output)
  makerFeeBps: 0n, // must be ≤ takerFeeBps
  kuruAmmSpread: 100n, // backstop vault left empty; must be >0, %10==0, <500
} as const;
export type MarketParams = { [K in keyof typeof PARAMS]: (typeof PARAMS)[K] extends number ? number : bigint };

// ---------------------------------------------------------------- ABIs (selectors checked against live bytecode)
export const routerAbi = parseAbi([
  "function deployProxy(uint8 _type, address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread) returns (address proxy)",
  "function anyToAnySwap(address[] _marketAddresses, bool[] _isBuy, bool[] _nativeSend, address _debitToken, address _creditToken, uint256 _amount, uint256 _minAmountOut) payable returns (uint256)",
  "function verifiedMarket(address) view returns (uint32 pricePrecision, uint96 sizePrecision, address baseAssetAddress, uint256 baseAssetDecimals, address quoteAssetAddress, uint256 quoteAssetDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
  "function owner() view returns (address)",
  "function marginAccountAddress() view returns (address)",
  "event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)",
]);

export const orderBookAbi = parseAbi([
  "function addBuyOrder(uint32 _price, uint96 size, bool _postOnly)",
  "function addSellOrder(uint32 _price, uint96 _size, bool _postOnly)",
  "function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)",
  "function batchCancelOrders(uint40[] _orderIds)",
  "function batchCancelOrdersNoRevert(uint40[] _orderIds)",
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function bestBidAsk() view returns (uint256, uint256)",
  "function getL2Book() view returns (bytes)",
  "function getL2Book(uint32 _bidPricePoints, uint32 _askPricePoints) view returns (bytes)",
  "function getMarketParams() view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)",
  "function s_orderIdCounter() view returns (uint40)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function s_buyPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function s_sellPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function marketState() view returns (uint8)",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event OrderCanceled(uint40 orderId, address owner, uint32 price, uint96 size, bool isBuy)",
  "event OrdersCanceled(uint40[] orderId, address owner)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
]);

export const marginAccountAbi = parseAbi([
  "function deposit(address _user, address _token, uint256 _amount) payable",
  "function withdraw(uint256 _amount, address _token)",
  "function batchWithdrawMaxTokens(address[] _tokens)",
  "function getBalance(address _user, address _token) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const faucetAbi = parseAbi(["function requestFunds(address)", "function lastDripTimestamp() view returns (uint256)"]);

// ---------------------------------------------------------------- unit helpers
export const toPriceUnits = (p: number, pp = PARAMS.pricePrecision, tick = PARAMS.tickSize): number => {
  const u = Math.round(p * pp);
  if (u % tick !== 0) throw new Error(`price ${p} is not on the ${tick / pp} tick`);
  if (u <= 0 || u >= pp) throw new Error(`price ${p} outside (0,1)`);
  return u;
};
export const toSizeUnits = (yes: number, sp = PARAMS.sizePrecision): bigint => BigInt(Math.round(yes * Number(sp)));
export const fromPriceUnits = (u: bigint | number, pp = PARAMS.pricePrecision) => Number(u) / pp;
export const fromSizeUnits = (u: bigint | number, sp = PARAMS.sizePrecision) => Number(u) / Number(sp);
export const ausd = (x: number) => BigInt(Math.round(x * 1e6));

// ---------------------------------------------------------------- clients / keys
export function loadKey(name: string): Hex {
  // ~/.config/isotherm/<name>.key — one hex key per file. Never printed.
  const raw = readFileSync(join(homedir(), ".config/isotherm", `${name}.key`), "utf8").trim();
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

export function clients(rpc = process.env.RPC_URL ?? TESTNET.rpc) {
  const chain = { ...monadTestnet, rpcUrls: { default: { http: [rpc] } } };
  const transport = http(rpc, { retryCount: 3, retryDelay: 400 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = (pk: Hex) => createWalletClient({ chain, transport, account: privateKeyToAccount(pk) });
  return { pub, wallet, chain };
}

// ---------------------------------------------------------------- tx sender that records gas (Monad bills the limit)
export type TxRecord = {
  label: string;
  hash: Hash;
  gasUsed: bigint;
  gasLimit: bigint;
  effectiveGasPrice: bigint;
  costMonAt102Gwei: number; // gasLimit × 102 gwei, in MON
  latencyMs: number; // send -> receipt
  status: "success" | "reverted";
};
export const txLog: TxRecord[] = [];

export async function send(
  pub: PublicClient,
  w: WalletClient,
  req: { to: Address; abi: any; functionName: string; args?: readonly unknown[]; value?: bigint },
  label: string,
  gasMult = Number(process.env.GAS_MULT ?? 1.15),
): Promise<TransactionReceipt> {
  const account = w.account as Account;
  const { request } = await pub.simulateContract({ ...req, account } as any);
  const est = await pub.estimateContractGas({ ...req, account } as any);
  const gas = BigInt(Math.ceil(Number(est) * gasMult));
  const t0 = Date.now();
  const hash = await w.writeContract({ ...(request as any), gas });
  const rcpt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 60_000 });
  const rec: TxRecord = {
    label,
    hash,
    gasUsed: rcpt.gasUsed,
    gasLimit: gas,
    effectiveGasPrice: rcpt.effectiveGasPrice,
    costMonAt102Gwei: Number(gas * 102n) / 1e9,
    latencyMs: Date.now() - t0,
    status: rcpt.status,
  };
  txLog.push(rec);
  if (rcpt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return rcpt;
}

export async function ensureAllowance(pub: PublicClient, w: WalletClient, token: Address, spender: Address, amount: bigint) {
  const owner = (w.account as Account).address;
  const cur = (await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] })) as bigint;
  if (cur >= amount) return;
  await send(pub, w, { to: token, abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }, `approve ${spender.slice(0, 8)}`);
}

// ---------------------------------------------------------------- market lifecycle
/** Permissionless on testnet. Returns the OrderBook proxy address (and its empty backstop vault). */
export async function createMarket(
  pub: PublicClient,
  w: WalletClient,
  yesToken: Address,
  quote: Address = TESTNET.ausd,
  p: typeof PARAMS = PARAMS,
): Promise<{ market: Address; vault: Address; receipt: TransactionReceipt }> {
  const receipt = await send(
    pub,
    w,
    {
      to: TESTNET.router,
      abi: routerAbi,
      functionName: "deployProxy",
      args: [p.type, yesToken, quote, p.sizePrecision, p.pricePrecision, p.tickSize, p.minSize, p.maxSize, p.takerFeeBps, p.makerFeeBps, p.kuruAmmSpread],
    },
    "router.deployProxy (create YES/AUSD market)",
  );
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "MarketRegistered") return { market: ev.args.market, vault: ev.args.vaultAddress, receipt };
    } catch {}
  }
  throw new Error("MarketRegistered not found");
}

/** Maker inventory lives in Kuru's MarginAccount: bids lock AUSD, asks lock YES; fills are credited there. */
export async function depositMargin(pub: PublicClient, w: WalletClient, token: Address, amount: bigint) {
  await ensureAllowance(pub, w, token, TESTNET.marginAccount, amount);
  const me = (w.account as Account).address;
  return send(pub, w, { to: TESTNET.marginAccount, abi: marginAccountAbi, functionName: "deposit", args: [me, token, amount] }, `margin.deposit ${token.slice(0, 8)}`);
}

export async function withdrawAllMargin(pub: PublicClient, w: WalletClient, tokens: Address[]) {
  return send(pub, w, { to: TESTNET.marginAccount, abi: marginAccountAbi, functionName: "batchWithdrawMaxTokens", args: [tokens] }, "margin.batchWithdrawMaxTokens");
}

export type Quote = { price: number; size: number }; // human units

function parseOrderIds(receipt: TransactionReceipt, market: Address) {
  const created: { id: bigint; price: number; size: bigint; isBuy: boolean }[] = [];
  const trades: { orderId: bigint; price: bigint; filled: bigint; isBuy: boolean }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== market.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: orderBookAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "OrderCreated") created.push({ id: BigInt(ev.args.orderId), price: Number(ev.args.price), size: ev.args.size, isBuy: ev.args.isBuy });
      if (ev.eventName === "Trade") trades.push({ orderId: BigInt(ev.args.orderId), price: ev.args.price, filled: ev.args.filledSize, isBuy: ev.args.isBuy });
    } catch {}
  }
  return { created, trades };
}

/** One-tx re-quote: cancels `cancelIds` (filled ones are skipped), then posts bids then asks (post-only). */
export async function placeQuotes(
  pub: PublicClient,
  w: WalletClient,
  market: Address,
  bids: Quote[],
  asks: Quote[],
  cancelIds: bigint[] = [],
  postOnly = true,
  label = `batchUpdate ${bids.length}b/${asks.length}a cancel ${cancelIds.length}`,
) {
  const receipt = await send(
    pub,
    w,
    {
      to: market,
      abi: orderBookAbi,
      functionName: "batchUpdate",
      args: [
        bids.map((q) => toPriceUnits(q.price)),
        bids.map((q) => toSizeUnits(q.size)),
        asks.map((q) => toPriceUnits(q.price)),
        asks.map((q) => toSizeUnits(q.size)),
        cancelIds.map(Number),
        postOnly,
      ],
    },
    label,
  );
  return { receipt, ...parseOrderIds(receipt, market) };
}

export async function placeLimit(pub: PublicClient, w: WalletClient, market: Address, side: "bid" | "ask", q: Quote, postOnly = true) {
  const receipt = await send(
    pub,
    w,
    { to: market, abi: orderBookAbi, functionName: side === "bid" ? "addBuyOrder" : "addSellOrder", args: [toPriceUnits(q.price), toSizeUnits(q.size), postOnly] },
    `${side === "bid" ? "addBuyOrder" : "addSellOrder"} ${q.size}@${q.price}`,
  );
  return { receipt, ...parseOrderIds(receipt, market) };
}

/** Active orders of `owner` (scan of the last `window` ids; bots should track ids from placeQuotes instead). */
export async function getOpenOrders(pub: PublicClient, market: Address, owner: Address, window = 500) {
  const counter = Number(await pub.readContract({ address: market, abi: orderBookAbi, functionName: "s_orderIdCounter" }));
  const ids = Array.from({ length: Math.min(counter, window) }, (_, i) => BigInt(counter - i)).reverse();
  if (!ids.length) return [];
  const orders = await pub.multicall({
    allowFailure: false,
    multicallAddress: TESTNET.multicall3,
    contracts: ids.map((id) => ({ address: market, abi: orderBookAbi, functionName: "s_orders", args: [Number(id)] }) as const),
  });
  const mine = ids
    .map((id, i) => ({ id, o: orders[i] as unknown as readonly [Address, bigint, number, number, number, number, number, boolean] }))
    .filter(({ o }) => o[0].toLowerCase() === owner.toLowerCase() && o[5] !== 0);
  if (!mine.length) return [];
  // filled orders keep their struct; they are filled iff the price-point head has moved past them
  const heads = await pub.multicall({
    allowFailure: false,
    multicallAddress: TESTNET.multicall3,
    contracts: mine.map(({ o }) => ({ address: market, abi: orderBookAbi, functionName: o[7] ? "s_buyPricePoints" : "s_sellPricePoints", args: [BigInt(o[5])] }) as const),
  });
  return mine
    .filter((_, i) => {
      const head = BigInt((heads[i] as unknown as readonly [number, number])[0]);
      return head !== 0n && head <= mine[i].id;
    })
    .map(({ id, o }) => ({ id, isBuy: o[7], price: fromPriceUnits(o[5]), size: fromSizeUnits(o[1]) }));
}

/** Cancel all of the caller's resting orders (tracked `ids`, or a scan). Funds return to the MarginAccount. */
export async function cancelAll(pub: PublicClient, w: WalletClient, market: Address, ids?: bigint[]) {
  const me = (w.account as Account).address;
  const live = ids ?? (await getOpenOrders(pub, market, me)).map((o) => o.id);
  if (!live.length) return null;
  return send(pub, w, { to: market, abi: orderBookAbi, functionName: "batchCancelOrdersNoRevert", args: [live.map(Number)] }, `batchCancelOrdersNoRevert x${live.length}`);
}

/** Taker: spend `amountAUSD` (wallet -> wallet, no margin deposit). IOC by default; `fok` reverts unless fully filled. */
export async function marketBuy(pub: PublicClient, w: WalletClient, market: Address, amountAUSD: number, minYesOut = 0n, fok = false) {
  const amount = ausd(amountAUSD);
  await ensureAllowance(pub, w, TESTNET.ausd, market, amount); // the OrderBook (not the router) pulls the AUSD
  const quoteUnits = (amount * BigInt(PARAMS.pricePrecision)) / 1_000_000n;
  const receipt = await send(
    pub,
    w,
    { to: market, abi: orderBookAbi, functionName: "placeAndExecuteMarketBuy", args: [quoteUnits, minYesOut, false, fok] },
    `placeAndExecuteMarketBuy ${amountAUSD} AUSD`,
    Number(process.env.TAKER_GAS_MULT ?? 1.3), // book can change between estimate and inclusion
  );
  return { receipt, ...parseOrderIds(receipt, market) };
}

export async function marketSell(pub: PublicClient, w: WalletClient, market: Address, yesToken: Address, amountYES: number, minAusdOut = 0n, fok = false) {
  const size = toSizeUnits(amountYES);
  await ensureAllowance(pub, w, yesToken, market, size);
  const receipt = await send(
    pub,
    w,
    { to: market, abi: orderBookAbi, functionName: "placeAndExecuteMarketSell", args: [size, minAusdOut, false, fok] },
    `placeAndExecuteMarketSell ${amountYES} YES`,
    Number(process.env.TAKER_GAS_MULT ?? 1.3),
  );
  return { receipt, ...parseOrderIds(receipt, market) };
}

/** Zero-deploy "zap": Kuru Router swap (user approves the ROUTER; always fill-or-kill). */
export async function routerBuy(pub: PublicClient, w: WalletClient, market: Address, yesToken: Address, amountAUSD: number, minYesOut = 1n) {
  const amount = ausd(amountAUSD);
  await ensureAllowance(pub, w, TESTNET.ausd, TESTNET.router, amount);
  return send(
    pub,
    w,
    { to: TESTNET.router, abi: routerAbi, functionName: "anyToAnySwap", args: [[market], [true], [false], TESTNET.ausd, yesToken, amount, minYesOut] },
    `router.anyToAnySwap ${amountAUSD} AUSD->YES`,
    Number(process.env.TAKER_GAS_MULT ?? 1.3),
  );
}

// ---------------------------------------------------------------- reads
export type Book = { block: bigint; bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; bestBid?: number; bestAsk?: number };

/** Decodes OrderBook.getL2Book(): [block][price,size]* bids (desc) [0] [price,size]* asks (asc), 32-byte words. */
export function decodeL2(data: Hex): Book {
  const hex = data.slice(2);
  const words: bigint[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(BigInt("0x" + hex.slice(i, i + 64)));
  const book: Book = { block: words[0], bids: [], asks: [] };
  let i = 1;
  for (; i < words.length && words[i] !== 0n; i += 2) book.bids.push({ price: fromPriceUnits(words[i]), size: fromSizeUnits(words[i + 1]) });
  for (i += 1; i + 1 < words.length; i += 2) book.asks.push({ price: fromPriceUnits(words[i]), size: fromSizeUnits(words[i + 1]) });
  book.bestBid = book.bids[0]?.price;
  book.bestAsk = book.asks[0]?.price;
  return book;
}

export async function getBook(pub: PublicClient, market: Address, depth?: number): Promise<Book> {
  const data = (await pub.readContract(
    depth
      ? { address: market, abi: orderBookAbi, functionName: "getL2Book", args: [depth, depth] }
      : { address: market, abi: orderBookAbi, functionName: "getL2Book" },
  )) as Hex;
  return decodeL2(data);
}

export const fmtBook = (b: Book) =>
  [
    `  L2 @block ${b.block}`,
    ...b.asks.slice().reverse().map((l) => `    ask ${l.price.toFixed(3)}  ${l.size.toFixed(6)} YES`),
    `    ----- spread ${b.bestBid && b.bestAsk ? (b.bestAsk - b.bestBid).toFixed(3) : "n/a"} -----`,
    ...b.bids.map((l) => `    bid ${l.price.toFixed(3)}  ${l.size.toFixed(6)} YES`),
  ].join("\n");
