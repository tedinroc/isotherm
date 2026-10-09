// A small in-memory Monad testnet for the engine's unit tests: the v1 vault/resolver/zap reads the maker makes, Kuru
// books with real order-id semantics (counter, s_orders, price-point heads, L2 book bytes, OrderCreated logs), the
// Kuru margin account, ERC-20 balances, gas (Monad bills the limit), nonces, receipts and Resolver events. Every
// broadcast goes through `wallet()` and lands in `sent`, so a test can prove that shadow mode sends nothing.
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  numberToHex,
  stringToHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi, faucetAbi, kuruBookAbi, kuruRouterAbi, marginAbi, resolverCommonAbi, resultAbiV1, seriesAbiV1, vaultCommonAbi, zapRegistryAbi } from "../../../../packages/maker/src/abis.ts";
import deployments from "../../../../deployments/testnet.json";
import { RESOLVER_WATCH_ABI } from "../../src/watcher.ts";

export const D = {
  vault: deployments.vault as Address,
  resolver: deployments.resolver as Address,
  zap: deployments.zap as Address,
  ausd: deployments.ausd as Address,
  margin: deployments.kuruMarginAccount as Address,
  router: deployments.kuruRouter as Address,
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
  guardian: deployments.roles.guardian as Address,
};
const ALL_ABIS = [vaultCommonAbi, seriesAbiV1, resolverCommonAbi, resultAbiV1, zapRegistryAbi, kuruRouterAbi, kuruBookAbi, marginAbi, erc20Abi, faucetAbi, RESOLVER_WATCH_ABI] as unknown as Abi[];
const GWEI = 1_000_000_000n;
const lc = (a: string) => a.toLowerCase();

interface Order {
  owner: Address;
  size: bigint; // 1e6 units
  price: number; // 1e4 units
  isBuy: boolean;
  open: boolean;
}
interface Market {
  yes: Address;
  counter: number;
  orders: Map<number, Order>;
}
interface Series {
  station: Hex;
  date: number;
  strikeC: number;
  closeTime: bigint;
  yes: Address;
  no: Address;
}
export interface SentTx {
  from: Address;
  to: Address;
  functionName: string;
  args: readonly unknown[];
  gas: bigint;
  nonce: number;
  hash: Hex;
  value?: bigint;
}

let addrSeq = 0x1000;
export const fakeAddr = (tag: string): Address => `0x${(addrSeq++).toString(16).padStart(8, "0")}${keccak256(stringToHex(tag)).slice(2, 34)}` as Address;

export class FakeChain {
  block = 70_000_000n;
  time: number; // unix s of the latest block
  gasPrice = 102n * GWEI;
  mon = new Map<string, bigint>();
  tokens = new Map<string, Map<string, bigint>>();
  marginBal = new Map<string, bigint>();
  nonces = new Map<string, number>();
  series = new Map<Hex, Series>();
  ladders = new Map<string, Hex[]>(); // "RCSS:20261009"
  canonical = new Map<Hex, Address>();
  markets = new Map<string, Market>();
  results = new Map<string, { status: number; tmaxC: number; resolvedAt: bigint; finalAt: bigint; sourcesHash: Hex }>();
  guardian: Address = D.guardian;
  paused = false; // Resolver.paused()
  lastUnpausedAt = 0; // Resolver.lastUnpausedAt
  logs: { address: Address; eventName: string; args: any; blockNumber: bigint; transactionHash: Hex }[] = [];
  receipts = new Map<Hex, any>();
  sent: SentTx[] = [];
  getLogsRanges: [bigint, bigint][] = [];
  revertOn = new Set<string>(); // function names whose simulation reverts
  codes = new Map<string, Hex>(); // contract code per address (getCode); EOAs have none
  refuseSends = 0; // the next N broadcasts are refused by the "RPC"
  calls = { reads: 0, sims: 0 };

  constructor(nowSec: number) {
    this.time = nowSec;
  }

  // ------------------------------------------------------------ world setup
  token(t: Address) {
    if (!this.tokens.has(lc(t))) this.tokens.set(lc(t), new Map());
    return this.tokens.get(lc(t))!;
  }
  bal(t: Address, who: Address) {
    return this.token(t).get(lc(who)) ?? 0n;
  }
  setBal(t: Address, who: Address, v: bigint) {
    this.token(t).set(lc(who), v);
  }
  addLadder(station: string, date: number, strikes: number[], closeTime: number, maker: Address): { seriesId: Hex; yes: Address; no: Address; market: Address; k: number }[] {
    const b4 = stringToHex(station, { size: 4 });
    const out = [];
    const ids: Hex[] = [];
    for (const k of strikes) {
      const seriesId = keccak256(encodeAbiParameters([{ type: "bytes4" }, { type: "uint32" }, { type: "int16" }], [b4, date, k]));
      const yes = fakeAddr(`yes${station}${date}${k}`), no = fakeAddr(`no${station}${date}${k}`), market = fakeAddr(`mkt${station}${date}${k}`);
      this.series.set(seriesId, { station: b4, date, strikeC: k, closeTime: BigInt(closeTime), yes, no });
      this.canonical.set(seriesId, market);
      this.markets.set(lc(market), { yes, counter: 0, orders: new Map() });
      this.setBal(no, maker, 300_000_000n);
      this.marginBal.set(`${lc(maker)}:${lc(yes)}`, 300_000_000n);
      ids.push(seriesId);
      out.push({ seriesId, yes, no, market, k });
    }
    this.ladders.set(`${station}:${date}`, ids);
    this.marginBal.set(`${lc(maker)}:${lc(D.ausd)}`, 600_000_000n);
    return out;
  }
  /** A resting order placed by `owner` (e.g. the Mac maker's quote). Returns its id. Locks margin like Kuru. */
  place(market: Address, owner: Address, price: number, sizeYes: number, isBuy: boolean): number {
    const m = this.markets.get(lc(market))!;
    return this.add(m, owner, BigInt(Math.round(sizeYes * 1e6)), Math.round(price * 1e4), isBuy);
  }
  private lockKey(m: Market, owner: Address, isBuy: boolean) {
    return `${lc(owner)}:${lc(isBuy ? D.ausd : m.yes)}`;
  }
  private locked(size: bigint, price: number, isBuy: boolean) {
    return isBuy ? (size * BigInt(price)) / 10_000n : size; // AUSD (6 dp) for a bid, YES for an ask
  }
  private add(m: Market, owner: Address, size: bigint, price: number, isBuy: boolean): number {
    const id = ++m.counter;
    m.orders.set(id, { owner, size, price, isBuy, open: true });
    const k = this.lockKey(m, owner, isBuy);
    this.marginBal.set(k, (this.marginBal.get(k) ?? 0n) - this.locked(size, price, isBuy));
    return id;
  }
  private cancel(m: Market, id: number) {
    const o = m.orders.get(id);
    if (!o || !o.open) return;
    o.open = false;
    const k = this.lockKey(m, o.owner, o.isBuy);
    this.marginBal.set(k, (this.marginBal.get(k) ?? 0n) + this.locked(o.size, o.price, o.isBuy));
  }
  openOrders(market: Address, owner?: Address) {
    const m = this.markets.get(lc(market))!;
    return [...m.orders.entries()].filter(([, o]) => o.open && (!owner || lc(o.owner) === lc(owner))).map(([id, o]) => ({ id, ...o }));
  }
  mine(n = 1, dt = 1) {
    this.block += BigInt(n);
    this.time += dt;
  }
  resolve(station: string, date: number, tmaxC: number, status = 1, window = 900) {
    const b4 = stringToHex(station, { size: 4 });
    const at = BigInt(this.time);
    this.results.set(`${b4}:${date}`, { status, tmaxC, resolvedAt: at, finalAt: status === 1 ? at + BigInt(window) : at, sourcesHash: keccak256(stringToHex(`fake ${station} ${date}`)) });
    this.mine();
    this.logs.push({ address: D.resolver, eventName: "LadderResolved", args: { station: b4, date, status, tmaxC, sourcesHash: "0x" + "11".repeat(32), caller: D.resolver }, blockNumber: this.block, transactionHash: keccak256(stringToHex(`resolve${date}${this.block}`)) });
  }

  // ------------------------------------------------------------ reads
  read(address: Address, functionName: string, args: readonly any[] = []): any {
    this.calls.reads++;
    const a = lc(address);
    const m = this.markets.get(a);
    if (m) {
      if (functionName === "s_orderIdCounter") return m.counter;
      if (functionName === "s_orders") {
        const o = m.orders.get(Number(args[0]));
        // a cancelled or filled order reads as empty here (price 0 -> not open under the maker's Kuru rule)
        return o?.open ? [o.owner, o.size, 0, 0, 0, o.price, 0, o.isBuy] : ["0x0000000000000000000000000000000000000000", 0n, 0, 0, 0, 0, 0, false];
      }
      if (functionName === "s_buyPricePoints" || functionName === "s_sellPricePoints") {
        const isBuy = functionName === "s_buyPricePoints";
        const at = [...m.orders.entries()].filter(([, o]) => o.open && o.isBuy === isBuy && o.price === Number(args[0])).map(([id]) => id);
        return [at.length ? Math.min(...at) : 0, at.length ? Math.max(...at) : 0];
      }
      if (functionName === "getL2Book") return this.l2(m);
      if (functionName === "bestBidAsk") return [0n, 0n];
    }
    if (a === lc(D.vault)) {
      if (functionName === "owner") return deployments.roles.owner;
      if (functionName === "isOperator") return true;
      if (functionName === "ladderSeries") return this.ladders.get(`${Buffer.from(String(args[0]).slice(2), "hex").toString()}:${args[1]}`) ?? [];
      if (functionName === "getSeries") {
        const s = this.series.get(args[0]);
        if (!s) throw new Error("UnknownSeries");
        return { station: s.station, date: s.date, strikeC: s.strikeC, closeTime: s.closeTime, gated: false, yes: s.yes, no: s.no, collateral: 0n };
      }
      if (functionName === "seriesIdOf") return keccak256(encodeAbiParameters([{ type: "bytes4" }, { type: "uint32" }, { type: "int16" }], [args[0], args[1], args[2]]));
      if (functionName === "ladderCount") return BigInt(this.ladders.size);
      if (functionName === "ladderAt") {
        const k = [...this.ladders.keys()][Number(args[0])];
        return { station: stringToHex(k.split(":")[0], { size: 4 }), date: Number(k.split(":")[1]) };
      }
    }
    if (a === lc(D.resolver)) {
      if (functionName === "dayEnd") {
        const ymd = String(args[1]);
        const off = String(args[0]).toLowerCase() === stringToHex("RJTT", { size: 4 }).toLowerCase() ? 540 : 480;
        return BigInt(Date.parse(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`) / 1000 - off * 60 + 86400);
      }
      if (functionName === "resultOf") return this.results.get(`${String(args[0]).toLowerCase()}:${args[1]}`) ?? { status: 0, tmaxC: 0, resolvedAt: 0n, finalAt: 0n, sourcesHash: `0x${"00".repeat(32)}` };
      if (functionName === "guardian") return this.guardian;
      if (functionName === "paused") return this.paused;
      if (functionName === "staleAt") return BigInt(this.staleAt(args[0], args[1]));
    }
    if (a === lc(D.zap) && functionName === "canonicalMarket") return this.canonical.get(args[0]) ?? "0x0000000000000000000000000000000000000000";
    if (a === lc(D.router) && functionName === "verifiedMarket") {
      const mk = this.markets.get(lc(args[0]));
      return [10000, 1000000n, mk?.yes, 6n, D.ausd, 6n, 10, 1000000n, 1000000000000n, 10n, 0n];
    }
    if (a === lc(D.margin) && functionName === "getBalance") return this.marginBal.get(`${lc(args[0])}:${lc(args[1])}`) ?? 0n;
    if (functionName === "balanceOf") return this.bal(address, args[0]);
    if (functionName === "allowance") return 2n ** 255n;
    throw new Error(`fake chain: no read ${functionName} on ${address}`);
  }

  private l2(m: Market): Hex {
    const open = [...m.orders.values()].filter((o) => o.open);
    const lvl = (isBuy: boolean) => {
      const by = new Map<number, bigint>();
      for (const o of open.filter((x) => x.isBuy === isBuy)) by.set(o.price, (by.get(o.price) ?? 0n) + o.size);
      return [...by.entries()].sort((x, y) => (isBuy ? y[0] - x[0] : x[0] - y[0]));
    };
    const words: bigint[] = [this.block];
    for (const [p, s] of lvl(true)) words.push(BigInt(p), s);
    words.push(0n);
    for (const [p, s] of lvl(false)) words.push(BigInt(p), s);
    return ("0x" + words.map((w) => w.toString(16).padStart(64, "0")).join("")) as Hex;
  }

  /** Resolver.staleAt (src/Resolver.sol): paused -> dayEnd + 7 d; else min(max(dayEnd + 48 h, lastUnpausedAt + 24 h), dayEnd + 7 d). */
  staleAt(b4: Hex, date: number): number {
    const end = Number(this.read(D.resolver, "dayEnd", [b4, date]));
    const hard = end + 7 * 86_400;
    if (this.paused) return hard;
    return Math.min(Math.max(end + 48 * 3600, this.lastUnpausedAt + 24 * 3600), hard);
  }
  /** Resolver.voidIfStale's checks (NotStale / AlreadyResolved), at the next block's time. */
  private checkVoid(b4: Hex, date: number) {
    const t = this.staleAt(b4, date);
    if (this.time < t) throw Object.assign(new Error("execution reverted"), { shortMessage: `NotStale(${b4}, ${date}, ${t})` });
    if ((this.results.get(`${String(b4).toLowerCase()}:${date}`)?.status ?? 0) !== 0) throw Object.assign(new Error("execution reverted"), { shortMessage: `AlreadyResolved(${b4}, ${date})` });
  }

  // ------------------------------------------------------------ writes
  private gasFor(fn: string) {
    return ({ batchUpdate: 450_000n, batchCancelOrdersNoRevert: 250_000n, batchWithdrawMaxTokens: 330_000n, deposit: 150_000n, approve: 60_000n, mintSet: 277_000n, challenge: 44_000n, voidIfStale: 52_000n } as Record<string, bigint>)[fn] ?? 200_000n;
  }
  decode(data: Hex) {
    for (const abi of ALL_ABIS)
      try {
        return decodeFunctionData({ abi, data });
      } catch {}
    throw new Error(`fake chain: cannot decode ${data.slice(0, 10)}`);
  }

  apply(from: Address, to: Address, data: Hex): { logs: any[] } {
    const { functionName, args = [] } = this.decode(data) as { functionName: string; args: readonly any[] };
    const logs: any[] = [];
    const m = this.markets.get(lc(to));
    if (m && (functionName === "batchUpdate" || functionName === "batchCancelOrdersNoRevert")) {
      const cancel: readonly number[] = functionName === "batchUpdate" ? args[4] : args[0];
      for (const id of cancel) {
        const o = m.orders.get(Number(id));
        if (o && lc(o.owner) === lc(from)) this.cancel(m, Number(id));
      }
      if (functionName === "batchUpdate") {
        const place = (prices: readonly number[], sizes: readonly bigint[], isBuy: boolean) =>
          prices.forEach((p, i) => {
            const id = this.add(m, from, sizes[i], Number(p), isBuy);
            const ev = kuruBookAbi.find((x: any) => x.type === "event" && x.name === "OrderCreated") as any;
            logs.push({ address: to, topics: encodeEventTopics({ abi: [ev], eventName: "OrderCreated" }), data: encodeAbiParameters(ev.inputs, [id, from, sizes[i], Number(p), isBuy]) });
          });
        place(args[0], args[1], true);
        place(args[2], args[3], false);
      }
    } else if (lc(to) === lc(D.margin) && functionName === "batchWithdrawMaxTokens") {
      for (const t of args[0] as Address[]) {
        const k = `${lc(from)}:${lc(t)}`;
        this.setBal(t, from, this.bal(t, from) + (this.marginBal.get(k) ?? 0n));
        this.marginBal.set(k, 0n);
      }
    } else if (lc(to) === lc(D.resolver) && functionName === "challenge") {
      const r = this.results.get(`${String(args[0]).toLowerCase()}:${args[1]}`);
      if (!r || r.status !== 1 || BigInt(this.time) >= r.finalAt || lc(from) !== lc(this.guardian)) throw new Error("NotChallengeable");
      r.status = 2;
      r.finalAt = BigInt(this.time);
    } else if (lc(to) === lc(D.resolver) && functionName === "voidIfStale") {
      this.checkVoid(args[0], Number(args[1]));
      const at = BigInt(this.time);
      this.results.set(`${String(args[0]).toLowerCase()}:${args[1]}`, { status: 2, tmaxC: 0, resolvedAt: at, finalAt: at, sourcesHash: `0x${"00".repeat(32)}` });
      this.logs.push({ address: D.resolver, eventName: "LadderResolved", args: { station: args[0], date: Number(args[1]), status: 2, tmaxC: 0, sourcesHash: `0x${"00".repeat(32)}`, caller: from }, blockNumber: this.block + 1n, transactionHash: keccak256(stringToHex(`void${args[1]}${this.block}`)) });
    }
    return { logs };
  }

  // ------------------------------------------------------------ viem-shaped clients
  publicClient(): any {
    const self = this;
    return {
      async getChainId() {
        return 10143;
      },
      async request({ method }: { method: string }) {
        if (method === "web3_clientVersion") return "fakechain/1.0";
        throw new Error(`fake: ${method}`);
      },
      async getBlock() {
        return { number: self.block, timestamp: BigInt(self.time) };
      },
      async getBlockNumber() {
        return self.block;
      },
      async getGasPrice() {
        return self.gasPrice;
      },
      async getBalance({ address }: { address: Address }) {
        return self.mon.get(lc(address)) ?? 0n;
      },
      async getCode({ address }: { address: Address }) {
        return self.codes.get(lc(address)) ?? "0x";
      },
      async getTransactionCount({ address }: { address: Address }) {
        return self.nonces.get(lc(address)) ?? 0;
      },
      async readContract({ address, functionName, args }: any) {
        return self.read(address, functionName, args ?? []);
      },
      async multicall({ contracts }: any) {
        return contracts.map((c: any) => self.read(c.address, c.functionName, c.args ?? []));
      },
      async simulateContract() {
        return { result: null };
      },
      async call({ account, to, data }: any) {
        self.calls.sims++;
        const { functionName, args = [] } = self.decode(data) as { functionName: string; args: readonly any[] };
        if (self.revertOn.has(functionName)) throw Object.assign(new Error("execution reverted"), { shortMessage: `${functionName} reverted (fake)` });
        if (functionName === "voidIfStale") self.checkVoid(args[0], Number(args[1]));
        void account;
        void to;
        return { data: "0x" };
      },
      async estimateGas({ data }: any) {
        const { functionName, args = [] } = self.decode(data) as { functionName: string; args: readonly any[] };
        if (self.revertOn.has(functionName)) throw new Error(`${functionName} would revert (fake)`);
        if (functionName === "voidIfStale") self.checkVoid(args[0], Number(args[1]));
        return self.gasFor(functionName);
      },
      async waitForTransactionReceipt({ hash }: { hash: Hex }) {
        const r = self.receipts.get(hash);
        if (!r) throw new Error("no receipt");
        return r;
      },
      async getTransactionReceipt({ hash }: { hash: Hex }) {
        const r = self.receipts.get(hash);
        if (!r) throw new Error("TransactionReceiptNotFoundError");
        return r;
      },
      async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
        self.getLogsRanges.push([fromBlock, toBlock]);
        if (toBlock - fromBlock + 1n > 100n) throw new Error("eth_getLogs is limited to a 100 block range");
        return self.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
    };
  }

  wallet() {
    const self = this;
    return (account: { address: Address }) => ({
      async sendTransaction({ to, data, gas, nonce, value }: { to: Address; data?: Hex; gas: bigint; nonce: number; value?: bigint }) {
        const from = account.address;
        if (self.refuseSends > 0) {
          self.refuseSends--;
          throw new Error("fake RPC: transaction refused");
        }
        const want = self.nonces.get(lc(from)) ?? 0;
        if (nonce !== want) throw new Error(`nonce ${nonce} != expected ${want}`);
        if (!data || data === "0x") {
          // a plain MON transfer (the treasury's top-ups): Monad bills the gas limit
          if (gas < 21_000n) throw new Error("intrinsic gas too low");
          const cost = gas * self.gasPrice + (value ?? 0n);
          const bal = self.mon.get(lc(from)) ?? 0n;
          if (bal < cost) throw new Error("insufficient MON");
          self.mon.set(lc(from), bal - cost);
          self.mon.set(lc(to), (self.mon.get(lc(to)) ?? 0n) + (value ?? 0n));
          self.nonces.set(lc(from), want + 1);
          self.mine();
          const hash = keccak256(toHex(`${from}${nonce}${self.block}`)) as Hex;
          self.receipts.set(hash, { status: "success", blockNumber: self.block, gasUsed: 21_000n, effectiveGasPrice: self.gasPrice, logs: [], transactionHash: hash });
          self.sent.push({ from, to, functionName: "(transfer)", args: [], gas, nonce, hash, value: value ?? 0n });
          return hash;
        }
        const cost = gas * self.gasPrice; // Monad bills the gas limit
        const bal = self.mon.get(lc(from)) ?? 0n;
        if (bal < cost) throw new Error("insufficient MON");
        const { logs } = self.apply(from, to, data);
        const { functionName, args = [] } = self.decode(data) as { functionName: string; args: readonly unknown[] };
        self.mon.set(lc(from), bal - cost);
        self.nonces.set(lc(from), want + 1);
        self.mine();
        const hash = keccak256(toHex(`${from}${nonce}${self.block}`)) as Hex;
        self.receipts.set(hash, { status: "success", blockNumber: self.block, gasUsed: (gas * 9n) / 10n, effectiveGasPrice: self.gasPrice, logs, transactionHash: hash });
        self.sent.push({ from, to, functionName, args, gas, nonce, hash });
        return hash;
      },
    });
  }
}

export const hex32 = (n: number) => numberToHex(n, { size: 32 });
