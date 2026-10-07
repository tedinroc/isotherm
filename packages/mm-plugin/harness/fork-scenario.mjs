// TEST HARNESS ONLY (anvil fork, never the live chain). Builds a realistic Isotherm market on a fork of live Monad
// testnet so every plugin command can run in the real mm host:
//   - registers RCSS (+8h) on the resolver, creates today's and tomorrow's Taipei ladders
//   - creates one Kuru v1 YES/AUSD book per strike through the live Kuru router bytecode (standard params)
//   - the maker mints complete sets and quotes two levels per side around the Polymarket-implied fair value
//   - funds the harness BYOK wallet with MON (anvil_setBalance) and AUSD (transfer from the maker)
//   - on a v1 deployment (Zap has canonicalMarket), also registers each book on the Zap (owner, impersonated)
// Accounts are IMPERSONATED on the fork (anvil_impersonateAccount): no private key is read.
// Usage: node harness/fork-scenario.mjs <deployments-in.json> <deployments-out.json>
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, http, parseAbi, stringToHex, maxUint256, getAddress } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS, CITIES, abiFunction, loadAbi, normalizeDeployment } from "../dist/lib/config.js";
import { polymarketImplied, impliedAt, v0Forecast, v0Prob } from "../dist/lib/weather.js";

const RPC = process.env.ANVIL_RPC || "http://127.0.0.1:19251";
const [inFile, outFile] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(inFile, "utf8"));
const dep = normalizeDeployment(raw, inFile, "scenario", join(ASSETS, "abi"));
const VAULT = dep.vault, RESOLVER = dep.resolver, ZAP = dep.zap;
const AUSD = dep.ausd, ROUTER = dep.kuruRouter, MARGIN = dep.marginAccount;
const vaultJsonAbi = loadAbi("CollateralVault", dep);
const V1 = !!abiFunction(loadAbi("IsothermZap", dep), "canonicalMarket");
console.log(`deployment ${inFile}: abiSet ${dep.abiSet}, ${V1 ? "v1 (on-chain canonical market registry)" : "feasibility (no registry)"}`);
const OWNER = getAddress(process.env.OWNER || "0xb855f2bCA7C12Db2aA9D70740c6cF40808325c11");
const MAKER = getAddress(process.env.MAKER || "0xd572638F07829D1c3636400FB73CF34Ca6c7448a");
const USER = getAddress(readFileSync(new URL("./.secrets/address.txt", import.meta.url), "utf8").trim());

const chain = { id: 10143, name: "Monad Testnet (fork)", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const transport = http(RPC, { timeout: 60_000 });
const pub = createPublicClient({ chain, transport });
const test = createTestClient({ chain, transport, mode: "anvil" });
const as = (account) => createWalletClient({ chain, transport, account });

const vaultAbi = vaultJsonAbi; // createLadder / ladderSeries / getSeries / mintSet, layout differs between v1 and feasibility
const resolverAbi = parseAbi(["function registerStation(bytes4, int32)", "function stations(bytes4) view returns (int32, bool)", "function dayEnd(bytes4, uint32) view returns (uint256)"]);
const routerAbi = parseAbi([
  "function deployProxy(uint8, address, address, uint96, uint32, uint32, uint96, uint96, uint256, uint256, uint96) returns (address)",
  "event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)",
]);
const bookAbi = parseAbi(["function batchUpdate(uint32[], uint96[], uint32[], uint96[], uint40[], bool)"]);
const marginAbi = parseAbi(["function deposit(address, address, uint256) payable"]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)", "function transfer(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const zapAbi = parseAbi(["function setCanonicalMarket(bytes32, address)", "function canonicalMarket(bytes32) view returns (address)"]);

let n = 0;
async function tx(from, to, abi, functionName, args, label) {
  const hash = await as(from).writeContract({ address: to, abi, functionName, args, chain });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted ${hash}`);
  console.log(`#${++n} ${label}  gasUsed ${r.gasUsed}  ${hash}`);
  return r;
}

const RCSS = stringToHex("RCSS", { size: 4 });
for (const a of [OWNER, MAKER, USER]) await test.impersonateAccount({ address: a });
await test.setBalance({ address: OWNER, value: 100n * 10n ** 18n });
await test.setBalance({ address: MAKER, value: 100n * 10n ** 18n });
await test.setBalance({ address: USER, value: 10n * 10n ** 18n });

const [, registered] = await pub.readContract({ address: RESOLVER, abi: resolverAbi, functionName: "stations", args: [RCSS] });
if (!registered) await tx(OWNER, RESOLVER, resolverAbi, "registerStation", [RCSS, 28800], "resolver.registerStation(RCSS, +8h)");

const now = Number((await pub.getBlock()).timestamp);
const ymd = (s) => Number(new Date((s + 8 * 3600) * 1000).toISOString().slice(0, 10).replaceAll("-", ""));
const today = ymd(now), tomorrow = ymd(now + 86400);
const ladders = [
  { date: today, strikes: [27, 28, 29, 30] },
  { date: tomorrow, strikes: [27, 28, 29, 30, 31] },
];
const out = { ...raw, note: `FORK ONLY (anvil ${RPC}, fork block ${process.env.FORK_BLOCK ?? "?"}). Ladders/books created by harness/fork-scenario.mjs.`, markets: { ...(raw.markets ?? {}) }, ladders: [] };
const seriesAll = [];
for (const l of ladders) {
  let ids = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "ladderSeries", args: [RCSS, l.date] });
  if (!ids.length) {
    const dayEnd = Number(await pub.readContract({ address: RESOLVER, abi: resolverAbi, functionName: "dayEnd", args: [RCSS, l.date] }));
    await tx(OWNER, VAULT, vaultAbi, "createLadder", [RCSS, l.date, l.strikes, BigInt(dayEnd - 3600)], `vault.createLadder(RCSS, ${l.date}, [${l.strikes}], close=dayEnd-1h)`);
    ids = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "ladderSeries", args: [RCSS, l.date] });
  }
  const city = CITIES.taipei;
  const { pm } = await polymarketImplied(city, l.date);
  const { v0 } = await v0Forecast(city, l.date);
  const lad = { date: l.date, series: [] };
  for (const id of ids) {
    const s = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "getSeries", args: [id] });
    let market = V1 ? await pub.readContract({ address: ZAP, abi: zapAbi, functionName: "canonicalMarket", args: [id] }) : undefined;
    if (market && market !== "0x0000000000000000000000000000000000000000") {
      console.log(`reusing the live canonical book ${market} for >=${s.strikeC}C ${l.date}`);
    } else {
      const r = await tx(MAKER, ROUTER, routerAbi, "deployProxy", [0, s.yes, AUSD, 1_000_000n, 10_000, 10, 1_000_000n, 1_000_000_000_000n, 10n, 0n, 100n], `kuru.deployProxy YES>=${s.strikeC}C ${l.date}`);
      for (const log of r.logs) {
        try {
          const ev = decodeEventLog({ abi: routerAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "MarketRegistered") market = ev.args.market;
        } catch {}
      }
    }
    let fv = impliedAt(pm, s.strikeC);
    let fvSource = "polymarket-implied";
    if (fv === null && v0) {
      fv = v0Prob(v0.mu, v0.sigma, s.strikeC);
      fvSource = "v0-lite";
    }
    fv = Math.min(0.98, Math.max(0.02, fv ?? 0.5));
    out.markets[id] = market;
    lad.series.push({ seriesId: id, strikeC: s.strikeC, yes: s.yes, no: s.no, market, fairValue: Number(fv.toFixed(3)), fairSource: fvSource });
    seriesAll.push({ id, s, market, fv });
  }
  out.ladders.push(lad);
}

// maker inventory: AUSD -> vault (sets) + MarginAccount; YES -> MarginAccount
await tx(MAKER, AUSD, erc20, "approve", [VAULT, maxUint256], "maker approve AUSD -> vault");
await tx(MAKER, AUSD, erc20, "approve", [MARGIN, maxUint256], "maker approve AUSD -> MarginAccount");
await tx(MAKER, MARGIN, marginAbi, "deposit", [MAKER, AUSD, 3_000_000_000n], "maker MarginAccount.deposit 3000 AUSD");
for (const { id, s, market, fv } of seriesAll) {
  await tx(MAKER, VAULT, vaultAbi, "mintSet", [id, 300_000_000n], `maker mintSet YES/NO>=${s.strikeC}C x300`);
  await tx(MAKER, s.yes, erc20, "approve", [MARGIN, maxUint256], `maker approve YES>=${s.strikeC} -> MarginAccount`);
  await tx(MAKER, MARGIN, marginAbi, "deposit", [MAKER, s.yes, 300_000_000n], `maker deposit 300 YES>=${s.strikeC}`);
  const tick = (p) => Math.min(9990, Math.max(10, Math.round(p * 1000) * 10));
  const bid = tick(Math.floor((fv - 0.03) * 1000) / 1000), ask = Math.max(bid + 20, tick(Math.ceil((fv + 0.03) * 1000) / 1000));
  const bids = [bid, Math.max(10, bid - 200)].filter((v, i, a) => a.indexOf(v) === i);
  const asks = [ask, Math.min(9990, ask + 200)].filter((v, i, a) => a.indexOf(v) === i && v > bid);
  await tx(MAKER, market, bookAbi, "batchUpdate", [bids, bids.map((_, i) => (i ? 50_000_000n : 100_000_000n)), asks, asks.map((_, i) => (i ? 50_000_000n : 100_000_000n)), [], true], `maker quote >=${s.strikeC}C fv=${fv.toFixed(3)} bids ${bids.map((b) => b / 1e4)} asks ${asks.map((a) => a / 1e4)}`);
  if (V1) {
    const cur = await pub.readContract({ address: ZAP, abi: zapAbi, functionName: "canonicalMarket", args: [id] });
    if (cur === "0x0000000000000000000000000000000000000000") await tx(OWNER, ZAP, zapAbi, "setCanonicalMarket", [id, market], `zap.setCanonicalMarket(>=${s.strikeC}C)`);
  }
}
await tx(MAKER, AUSD, erc20, "transfer", [USER, 2_000_000_000n], "maker -> harness BYOK wallet 2000 AUSD");
if (V1) delete out.markets; // v1: the plugin must find markets through the on-chain registry, not the file
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(`wrote ${outFile}: ${seriesAll.length} series, user ${USER} funded with 10 MON + 2000 AUSD`);
