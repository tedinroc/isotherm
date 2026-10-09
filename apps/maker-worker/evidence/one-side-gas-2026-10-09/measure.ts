// Is a one-side Kuru update cheaper than a full re-quote (cancel 2 + place 2)? Measured on an ANVIL FORK of live Monad
// testnet: the live maker address is impersonated on the fork only (no key involved, nothing is sent to live). For one
// live RCSS book where the maker has one bid and one ask resting, each variant runs from the same fork snapshot and
// reports its gas used; the same calls are also gas-ESTIMATED (eth_estimateGas, read-only, no transaction) against the
// live RPC to check that the fork's gas schedule matches Monad's.
//   node measure.ts [market]      (needs ~/.foundry/bin/anvil; port 19820)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createPublicClient, createTestClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, type Address } from "viem";

const HERE = new URL(".", import.meta.url).pathname;
const LIVE = process.env.LIVE_RPC ?? "https://rpc.ankr.com/monad_testnet";
const PORT = 19820;
const RPC = `http://127.0.0.1:${PORT}`;
const MAKER = "0xd572638F07829D1c3636400FB73CF34Ca6c7448a" as Address;
const MARKET = (process.argv[2] ?? "0xC6806c67a2faCd6e7fd72e26DA9d037eb2E2a7D3") as Address; // RCSS 2026-10-10 >=28 (the API snapshot shows a maker bid and ask there)
const book = parseAbi([
  "function s_orderIdCounter() view returns (uint40)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function s_buyPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function s_sellPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)",
  "function batchCancelOrdersNoRevert(uint40[] _orderIds)",
  "function addSellOrder(uint32 _price, uint96 _size, bool _postOnly)",
  "function addBuyOrder(uint32 _price, uint96 size, bool _postOnly)",
]);
const chain = defineChain({ id: 10143, name: "fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const live = createPublicClient({ transport: http(LIVE, { retryCount: 3 }) });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000, retryCount: 3 }) });
const test = createTestClient({ chain, transport: http(RPC, { timeout: 120_000 }), mode: "anvil" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const anvil = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ["--fork-url", LIVE, "--port", String(PORT), "--silent", "--retries", "8", "--timeout", "60000"], { stdio: "ignore" });
const out: string[] = [];
const say = (s: string) => (console.log(s), out.push(s));
try {
  for (let t = Date.now(); ; await sleep(500)) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      if (Date.now() - t > 90_000) throw new Error("anvil did not start");
    }
  }
  const block = await pub.getBlockNumber();
  // the maker's open orders on this book (last 300 ids; open = owner, price != 0, price-point head <= id)
  const counter = Number(await pub.readContract({ address: MARKET, abi: book, functionName: "s_orderIdCounter" }));
  const open: { id: number; price: number; size: bigint; isBuy: boolean }[] = [];
  for (let id = Math.max(1, counter - 300); id <= counter; id++) {
    const o = await pub.readContract({ address: MARKET, abi: book, functionName: "s_orders", args: [id] });
    if (o[0].toLowerCase() !== MAKER.toLowerCase() || o[5] === 0) continue;
    const head = (await pub.readContract({ address: MARKET, abi: book, functionName: o[7] ? "s_buyPricePoints" : "s_sellPricePoints", args: [BigInt(o[5])] }))[0];
    if (head !== 0 && head <= id) open.push({ id, price: o[5], size: o[1], isBuy: o[7] });
  }
  const bid = open.filter((o) => o.isBuy).at(-1), ask = open.filter((o) => !o.isBuy).at(-1);
  if (!bid || !ask) throw new Error(`the maker has no bid+ask on ${MARKET} at block ${block} (open: ${JSON.stringify(open)})`);
  say(`anvil fork of ${LIVE} at block ${block}; market ${MARKET}; maker bid #${bid.id} @${bid.price / 1e4} x${Number(bid.size) / 1e6}, ask #${ask.id} @${ask.price / 1e4} x${Number(ask.size) / 1e6}`);
  const step = -300; // -0.03 in Kuru price units (1e4): both sides move down (the ask stays below 0.999)
  const V: [string, `0x${string}`][] = [
    ["full re-quote: cancel 2 + place 2 (both sides shifted -0.03)", encodeFunctionData({ abi: book, functionName: "batchUpdate", args: [[bid.price + step], [bid.size], [ask.price + step], [ask.size], [bid.id, ask.id], true] })],
    ["one side: cancel 1 + place 1 (ask shifted -0.03)", encodeFunctionData({ abi: book, functionName: "batchUpdate", args: [[], [], [ask.price + step], [ask.size], [ask.id], true] })],
    ["one side: cancel 1 + place 1 (bid shifted -0.03)", encodeFunctionData({ abi: book, functionName: "batchUpdate", args: [[bid.price + step], [bid.size], [], [], [bid.id], true] })],
    ["refill one side: place 1, no cancel (batchUpdate)", encodeFunctionData({ abi: book, functionName: "batchUpdate", args: [[], [], [ask.price + step], [ask.size], [], true] })],
    ["refill one side: addSellOrder", encodeFunctionData({ abi: book, functionName: "addSellOrder", args: [ask.price + step, ask.size, true] })],
    ["pull: cancel 2 (batchCancelOrdersNoRevert)", encodeFunctionData({ abi: book, functionName: "batchCancelOrdersNoRevert", args: [[bid.id, ask.id]] })],
  ];
  await test.impersonateAccount({ address: MAKER });
  await test.setBalance({ address: MAKER, value: 10n ** 20n });
  const w = createWalletClient({ chain, transport: http(RPC), account: MAKER });
  const rows: { what: string; liveEstimate: number | null; forkEstimate: number; forkUsed: number; mon: number }[] = [];
  for (const [what, data] of V) {
    const snap = await test.snapshot();
    let liveEstimate: number | null = null;
    try {
      liveEstimate = Number(await live.estimateGas({ account: MAKER, to: MARKET, data }));
    } catch (e) {
      say(`  live estimate failed for "${what}": ${String((e as Error).message).split("\n")[0]}`);
    }
    const forkEstimate = Number(await pub.estimateGas({ account: MAKER, to: MARKET, data }));
    const hash = await w.sendTransaction({ to: MARKET, data, chain, gas: BigInt(Math.ceil(forkEstimate * 1.08)) });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${what} reverted on the fork`);
    // Monad bills the LIMIT: the maker sends ceil(estimate x 1.08); at 102 gwei
    const mon = Math.ceil(forkEstimate * 1.08) * 102e-9;
    rows.push({ what, liveEstimate, forkEstimate, forkUsed: Number(r.gasUsed), mon: +mon.toFixed(4) });
    await test.revert({ id: snap });
  }
  const full = rows[0].forkEstimate;
  say("variant | live estimate | fork estimate | fork gas used | billed MON (limit x1.08 @102 gwei) | vs full");
  for (const r of rows) say(`${r.what} | ${r.liveEstimate ?? "-"} | ${r.forkEstimate} | ${r.forkUsed} | ${r.mon} | ${((r.forkEstimate / full) * 100).toFixed(0)} %`);
  writeFileSync(`${HERE}/results.txt`, out.join("\n") + "\n");
  writeFileSync(`${HERE}/results.json`, JSON.stringify({ block: Number(block), market: MARKET, maker: MAKER, bid, ask, rows }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
} finally {
  anvil.kill("SIGTERM");
}
