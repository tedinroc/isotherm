// Unit tests: pure logic only (no network, no chain). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, type Abi } from "viem";
import { fmtAllowance, fmtUnits, parsePrice, parseUnitsStrict } from "../src/lib/util.js";
import { decodeL2, type MarketParams } from "../src/lib/kuru.js";
import { applyBpsDown, avgPrice, planBuyNo, quoteForExactOut, roundQuoteToPricePrecision, walkBuy, walkSell } from "../src/lib/plan.js";
import { apiBaseUrl, chooseReference, inferFairSource, pickMakerLadder, type MakerStrike } from "../src/lib/snapshot.js";
import { addDays, impliedAt, impliedFromEvent, localDate, metarTempC, observedFromReports, parseBucket, parseDateArg, v0Prob } from "../src/lib/weather.js";
import { ASSETS, CITIES, normalizeDeployment, resolveCity } from "../src/lib/config.js";
import { checkBookParams, decodeResult, findRegistryFn, ladderState } from "../src/lib/isotherm.js";
import { encodeZap } from "../src/lib/cmd.js";
import { mapExecutorError } from "../src/lib/exec.js";
import { customChainRpc, selectedAddress } from "../src/lib/chain.js";

const FIX = join(process.cwd(), "test", "fixtures");
const fx = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const P: MarketParams = {
  market: "0x0000000000000000000000000000000000000001",
  pricePrecision: 10_000n,
  sizePrecision: 1_000_000n,
  base: "0x0000000000000000000000000000000000000002",
  baseDecimals: 6n,
  quote: "0x0000000000000000000000000000000000000003",
  quoteDecimals: 6n,
  tickSize: 10n,
  minSize: 1_000_000n,
  maxSize: 1_000_000_000_000n,
  takerFeeBps: 10n,
  makerFeeBps: 0n,
};
const lvl = (price: number, size: number) => ({ priceU: BigInt(Math.round(price * 1e4)), sizeU: BigInt(Math.round(size * 1e6)) });

// ------------------------------------------------------------------------------------------- units
test("fmtUnits / parseUnitsStrict / parsePrice are exact and strict", () => {
  assert.equal(fmtUnits(1_234_567n, 6), "1.234567");
  assert.equal(fmtUnits(5n, 6), "0.000005");
  assert.equal(fmtUnits(-1_500_000n, 6), "-1.500000");
  assert.equal(parseUnitsStrict("10", 6), 10_000_000n);
  assert.equal(parseUnitsStrict("0.000001", 6), 1n);
  assert.throws(() => parseUnitsStrict("0.0000001", 6), /more than 6 decimals/);
  assert.throws(() => parseUnitsStrict("-1", 6), /positive decimal/);
  assert.throws(() => parseUnitsStrict("1e3", 6), /positive decimal/);
  assert.equal(parsePrice("0.55", 10_000), 5_500n);
  assert.throws(() => parsePrice("0.12345", 10_000), /more than 4 decimals/);
  assert.equal(fmtAllowance(2n ** 256n - 1n, 6), "unlimited");
  assert.equal(fmtAllowance(1_000_000n, 6), "1.000000");
});

// ------------------------------------------------------------------------------------------- Kuru L2 + book walks
test("decodeL2 parses [block][bids][0][asks] words", () => {
  const words = [68_000_000n, 4_200n, 50_000_000n, 4_100n, 10_000_000n, 0n, 4_400n, 30_000_000n];
  const hex = ("0x" + words.map((w) => w.toString(16).padStart(64, "0")).join("")) as `0x${string}`;
  const b = decodeL2(hex);
  assert.equal(b.block, 68_000_000n);
  assert.deepEqual(b.bids, [lvl(0.42, 50), lvl(0.41, 10)]);
  assert.deepEqual(b.asks, [lvl(0.44, 30)]);
  assert.deepEqual(decodeL2(("0x" + [1n, 0n].map((w) => w.toString(16).padStart(64, "0")).join("")) as `0x${string}`), { block: 1n, bids: [], asks: [] });
});

test("walkBuy reproduces the live Kuru spike fill exactly (20 AUSD at 0.44 -> 45.409090 YES)", () => {
  const w = walkBuy([lvl(0.44, 1000)], 20_000_000n, null, P);
  assert.equal(w.netBase, 45_409_090n);
  assert.equal(w.spendQuote, 20_000_000n);
  assert.equal(w.limitedByPrice, false);
});

test("walkBuy reproduces the e2e fork fill (50 AUSD at the 0.57 ask -> 87,631,578 YES units)", () => {
  assert.equal(walkBuy([lvl(0.57, 1000)], 50_000_000n, null, P).netBase, 87_631_578n);
});

test("walkBuy stops at max price and reports the cap", () => {
  const asks = [lvl(0.5, 10), lvl(0.52, 10), lvl(0.6, 100)];
  const w = walkBuy(asks, 100_000_000n, 5_200n, P);
  assert.equal(w.spendQuote, 10_200_000n); // 10*0.50 + 10*0.52
  assert.equal(w.grossBase, 20_000_000n);
  assert.equal(w.netBase, 19_980_000n);
  assert.equal(w.limitedByPrice, true);
  assert.equal(w.worstPriceU, 5_200n);
  assert.equal(walkBuy(asks, 100_000_000n, 4_900n, P).spendQuote, 0n);
});

test("walkSell reproduces the e2e buyNo proceeds (40 YES into the 0.28 bid -> 11,188,800 AUSD)", () => {
  const w = walkSell([lvl(0.28, 1000)], 40_000_000n, null, P);
  assert.equal(w.netQuote, 11_188_800n);
  assert.equal(w.soldBase, 40_000_000n);
});

test("walkSell respects min price and partial depth", () => {
  const bids = [lvl(0.6, 5), lvl(0.55, 5), lvl(0.4, 100)];
  const w = walkSell(bids, 20_000_000n, 5_500n, P);
  assert.equal(w.soldBase, 10_000_000n);
  assert.equal(w.grossQuote, 5_750_000n);
  assert.equal(w.limitedByPrice, true);
});

test("quoteForExactOut buys at least the requested net amount after the fee", () => {
  const asks = [lvl(0.3, 2), lvl(0.35, 50)];
  const need = quoteForExactOut(asks, 4_000_000n, null, P);
  assert.ok(need);
  const got = walkBuy(asks, roundQuoteToPricePrecision(need!.quote + 99n, P), null, P).netBase;
  assert.ok(got >= 4_000_000n, `got ${got}`);
  assert.equal(quoteForExactOut([lvl(0.3, 1)], 4_000_000n, null, P), null);
  assert.equal(quoteForExactOut(asks, 4_000_000n, 3_000n, P), null);
});

test("roundQuoteToPricePrecision and avgPrice", () => {
  assert.equal(roundQuoteToPricePrecision(19_999_999n, P), 19_999_900n);
  assert.equal(avgPrice(1_000_000n, 2_000_000n, 6n, 6n), 0.5);
  assert.equal(avgPrice(1n, 0n, 6n, 6n), null);
});

// ------------------------------------------------------------------------------------------- buy NO (N1 mitigation)
test("planBuyNo reproduces the e2e buy-NO numbers (10 sets, YES leg into the 0.818 bid -> 8.171820 AUSD, min 8.130960)", () => {
  const nb = planBuyNo([lvl(0.818, 100)], 10_000_000n, 2_000n, P, 50n);
  assert.equal(nb.sets, 10_000_000n);
  assert.equal(nb.expectedAusd, 8_171_820n);
  assert.equal(nb.minAusdOut, 8_130_960n);
  assert.equal(nb.minBidU, 8_009n); // ceil((1 - 0.2) / 0.999 * 1e4): NO at <= 0.2 needs a bid >= 0.8009
  assert.equal(nb.cappedByMaxPrice, false);
});

test("planBuyNo spends only the bids inside --max-price and caps the sets", () => {
  const bids = [lvl(0.85, 4), lvl(0.81, 3), lvl(0.7, 100)];
  const nb = planBuyNo(bids, 20_000_000n, 2_000n, P, 50n);
  assert.equal(nb.sets, 7_000_000n); // 4 + 3 YES at bids >= 0.8009; the 0.70 level would make NO cost ~0.30
  assert.equal(nb.levelsUsed, 2);
  assert.equal(nb.worstBidU, 8_100n);
  assert.equal(nb.cappedByMaxPrice, true);
  assert.equal(planBuyNo([lvl(0.7, 100)], 20_000_000n, 2_000n, P, 50n).sets, 0n);
});

test("N1: after a bid-draining sandwich, Zap.buyNo's bound still passes but the mintSet + sellYes bound reverts", () => {
  // The verifier's scenario: the plan sees the maker's 0.43 bid; an attacker sells into it first and leaves 0.001 x 50.
  const plan = planBuyNo([lvl(0.43, 1000)], 100_000_000n, 6_000n, P, 200n);
  const drained = [lvl(0.001, 50)];
  const w = walkSell(drained, plan.sets, null, P);
  // Zap.buyNo: ausdBack = proceeds + unsold YES merged back at par, checked against the same min.
  const buyNoAusdBack = w.netQuote + (plan.sets - w.soldBase);
  const buyNoMin = applyBpsDown(plan.expectedAusd, 200n);
  assert.ok(buyNoAusdBack >= buyNoMin, "old bound passes");
  const noOut = plan.sets - (plan.sets - w.soldBase);
  assert.ok(Number(plan.sets - buyNoAusdBack) / Number(noOut) > 0.99, "...at ~0.999 per NO for half the NO");
  // mintSet + sellYes: the user sells exactly `sets` YES; the AUSD out is only what the bids pay.
  assert.ok(w.netQuote < plan.minAusdOut, "new bound: Zap.sellYes reverts with Slippage");
});

// ------------------------------------------------------------------------------------------- weather
test("parseBucket handles Polymarket's °C grid labels and refuses °F", () => {
  assert.deepEqual(parseBucket("24°C or below"), { lo: -Infinity, hi: 24 });
  assert.deepEqual(parseBucket("34°C or higher"), { lo: 34, hi: Infinity });
  assert.deepEqual(parseBucket("29°C"), { lo: 29, hi: 29 });
  assert.deepEqual(parseBucket("24-25°C"), { lo: 24, hi: 25 });
  assert.equal(parseBucket("86-87°F"), null);
});

test("impliedFromEvent on a captured gamma response (Taipei 2026-10-08)", () => {
  const pm = impliedFromEvent(fx("gamma-taipei-2026-10-08.json")[0]);
  assert.ok(pm);
  assert.equal(pm!.slug, "highest-temperature-in-taipei-on-october-8-2026");
  assert.equal(pm!.sumMid, 1.038);
  // P(>=30) = (0.39 + 0.075 + 0.0135 + 0.0045 + 0.0025) / 1.038, hand-computed from the bid/ask mids
  assert.ok(Math.abs((impliedAt(pm, 30) as number) - 0.4855 / 1.038) < 1e-9);
  assert.ok(Math.abs((impliedAt(pm, 25) as number) - (1.038 - 0.0015) / 1.038) < 1e-9);
  assert.equal(impliedAt(pm, 40), null); // off the grid
  for (let k = 25; k < 34; k++) assert.ok((impliedAt(pm, k) as number) >= (impliedAt(pm, k + 1) as number), "monotone");
});

test("metarTempC follows the settlement parser (M = minus, RMK ignored)", () => {
  assert.equal(metarTempC("METAR RCSS 070430Z 09012KT 9999 FEW016 28/20 Q1019 NOSIG RMK A3011"), 28);
  assert.equal(metarTempC("METAR UHMA 010000Z 00000MPS CAVOK M05/M10 Q1020"), -5);
  assert.equal(metarTempC("SPECI RJTT 010000Z 05/// Q1020"), 5);
  assert.equal(metarTempC("METAR RCSS 010000Z NIL"), null);
});

test("observedFromReports uses the station-local day only (captured AWC reports)", () => {
  const rows = fx("awc-rcss-2026-10-07.json").map((r: any) => ({ obsTime: Number(r.obsTime), rawOb: String(r.rawOb) }));
  const now = Date.parse("2026-10-07T05:30:00Z");
  const o = observedFromReports(rows, "RCSS", 20261007, 480, now);
  assert.equal(o.status, "in-progress");
  assert.ok(o.nReports > 0 && o.nReports <= rows.length);
  const expect = Math.max(...rows.filter((r: any) => r.obsTime >= Date.parse("2026-10-06T16:00:00Z") / 1000).map((r: any) => metarTempC(r.rawOb) ?? -99));
  assert.equal(o.maxC, expect);
  assert.equal(observedFromReports(rows, "RCSS", 20261008, 480, now).status, "future");
});

test("dates are station-local", () => {
  const t = Date.parse("2026-10-07T17:30:00Z"); // 01:30 Taipei on Oct 8
  assert.equal(localDate(t, 480), 20261008);
  assert.equal(localDate(t, 0), 20261007);
  assert.equal(addDays(20261231, 1), 20270101);
  assert.equal(parseDateArg("tomorrow", CITIES.taipei, t), 20261009);
  assert.equal(parseDateArg("2026-10-09", CITIES.taipei), 20261009);
  assert.throws(() => parseDateArg("next week", CITIES.taipei), /date/);
});

test("v0Prob: monotone in k, METAR rounding boundary, observed floor", () => {
  assert.ok(Math.abs(v0Prob(27.5, 1.5, 28) - 0.5) < 1e-6); // P(int Tmax >= 28) = P(T >= 27.5)
  assert.ok(v0Prob(28, 1.5, 27) > v0Prob(28, 1.5, 28));
  assert.ok(Math.abs(v0Prob(28, 1.5, 28) - (1 - 0.3694)) < 1e-3); // 1 - Phi(-0.5/1.5)
  assert.equal(v0Prob(20, 1.5, 28, 28), 1); // observed max already >= k
});

test("resolveCity accepts names and ICAO codes", () => {
  assert.equal(resolveCity("Taipei")?.station, "RCSS");
  assert.equal(resolveCity("rjtt")?.key, "tokyo");
  assert.equal(resolveCity("hong kong"), undefined);
});

// ------------------------------------------------------------------------------------------- deployments + ABIs
test("normalizeDeployment reads the v1 flat deployments/testnet.json", () => {
  const d = normalizeDeployment(fx("deployments-v1.json"), "fixture", "v1", join(ASSETS, "abi"));
  assert.equal(d.vault, "0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39");
  assert.equal(d.resolver, "0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B");
  assert.equal(d.zap, "0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0");
  assert.equal(d.marginAccount, "0xd029C2D98ff85D8F64799017fE00a59B1159CE02");
  assert.deepEqual(d.markets, {});
});

test("normalizeDeployment reads the nested feasibility file and its market map", () => {
  const raw = JSON.parse(readFileSync(join(ASSETS, "deployments.feasibility.json"), "utf8"));
  const d = normalizeDeployment(raw, "fixture", "feas", join(ASSETS, "abi"));
  assert.equal(d.abiSet, "feasibility");
  assert.ok(d.abiDir.endsWith("abi-feasibility"));
  assert.equal(d.markets["0xcb6bf583d9761e49568b11bfc8b69b52f73e24a11fb516c618cb188b2241a9b3"], "0x900793BD5091380fe14F2714A7B82de8eA314beB");
});

test("normalizeDeployment: market lists as arrays, wrong chain refused", () => {
  const id = "0x" + "ab".repeat(32);
  const d = normalizeDeployment(
    { chainId: 10143, vault: "0x" + "11".repeat(20), resolver: "0x" + "22".repeat(20), zap: "0x" + "33".repeat(20), ladders: [{ series: [{ seriesId: id, market: "0x" + "44".repeat(20) }] }] },
    "x",
    "x",
    join(ASSETS, "abi"),
  );
  assert.equal(d.markets[id], "0x4444444444444444444444444444444444444444");
  assert.throws(() => normalizeDeployment({ chainId: 143, vault: "0x" + "11".repeat(20), resolver: "0x" + "22".repeat(20) }, "x", "x", ASSETS), /only serves Monad testnet/);
});

const feasZap = JSON.parse(readFileSync(join(ASSETS, "abi-feasibility", "IsothermZap.json"), "utf8")) as Abi;
const v1Zap = JSON.parse(readFileSync(join(ASSETS, "abi", "IsothermZap.json"), "utf8")) as Abi;

test("encodeZap matches parameters by name (feasibility and v1 ABIs)", () => {
  const v = { seriesId: ("0x" + "cd".repeat(32)) as `0x${string}`, market: "0x5555555555555555555555555555555555555555" as const, amountIn: 7n, minOut: 6n, to: "0x6666666666666666666666666666666666666666" as const };
  for (const abi of [feasZap, v1Zap]) {
    const { data } = encodeZap(abi, "buyNo", v);
    const d = decodeFunctionData({ abi, data });
    assert.equal(d.functionName, "buyNo");
    assert.deepEqual(d.args, [v.seriesId, v.market, 7n, 6n, v.to]);
  }
});

test("encodeZap adapts to a future signature (no market arg, minNoOut, deadline) and refuses unknown params", () => {
  const future = [
    { type: "function", name: "buyNo", stateMutability: "nonpayable", inputs: [{ name: "seriesId", type: "bytes32" }, { name: "ausdIn", type: "uint256" }, { name: "minAusdBack", type: "uint256" }, { name: "minNoOut", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "to", type: "address" }], outputs: [] },
    { type: "function", name: "sellYes", stateMutability: "nonpayable", inputs: [{ name: "seriesId", type: "bytes32" }, { name: "weird", type: "uint256" }], outputs: [] },
  ] as unknown as Abi;
  const v = { seriesId: ("0x" + "cd".repeat(32)) as `0x${string}`, market: "0x5555555555555555555555555555555555555555" as const, amountIn: 7n, minOut: 6n, minNoOut: 5n, deadline: 99n, to: "0x6666666666666666666666666666666666666666" as const };
  const r = encodeZap(future, "buyNo", v);
  assert.equal(r.usedMinNoOut, true);
  assert.deepEqual(decodeFunctionData({ abi: future, data: r.data }).args, [v.seriesId, 7n, 6n, 5n, 99n, v.to]);
  assert.throws(() => encodeZap(future, "sellYes", v), /does not understand/);
  assert.throws(() => encodeZap(future, "buyYes", v), /no 'buyYes'/);
});

test("findRegistryFn finds v1 canonicalMarket and nothing on the feasibility Zap", () => {
  const vault = JSON.parse(readFileSync(join(ASSETS, "abi", "CollateralVault.json"), "utf8")) as Abi;
  const dep = { zap: "0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0", vault: "0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39" } as any;
  assert.equal(findRegistryFn({ vaultAbi: vault, resolverAbi: [], zapAbi: v1Zap, tokenAbi: [] }, dep)?.fn, "canonicalMarket");
  const feasVault = JSON.parse(readFileSync(join(ASSETS, "abi-feasibility", "CollateralVault.json"), "utf8")) as Abi;
  assert.equal(findRegistryFn({ vaultAbi: feasVault, resolverAbi: [], zapAbi: feasZap, tokenAbi: [] }, dep), undefined);
});

test("checkBookParams rejects the hostile-book pattern (security finding #4)", () => {
  const yes = { yes: P.base };
  assert.deepEqual(checkBookParams(P, yes, P.quote), []);
  assert.match(checkBookParams({ ...P, takerFeeBps: 9000n }, yes, P.quote).join(";"), /hostile-book/);
  assert.match(checkBookParams({ ...P, base: "0x0000000000000000000000000000000000000009" }, yes, P.quote).join(";"), /not this series' YES/);
  assert.match(checkBookParams({ ...P, pricePrecision: 100n }, yes, P.quote).join(";"), /pricePrecision/);
  assert.match(checkBookParams({ ...P, makerFeeBps: 20n }, yes, P.quote).join(";"), /makerFeeBps/);
  assert.match(checkBookParams(undefined, yes, P.quote).join(";"), /does not list/);
});

test("ladder state machine incl. the v1 challenge window", () => {
  const none = decodeResult({ status: 0, tmaxC: 0, resolvedAt: 0n, sourcesHash: "0x" });
  assert.equal(ladderState(100, 200, 300, none), "open");
  assert.equal(ladderState(250, 200, 300, none), "closed");
  assert.equal(ladderState(350, 200, 300, none), "awaiting-settlement");
  const v1 = decodeResult({ status: 1, tmaxC: 29, resolvedAt: 400n, finalAt: 1300n, sourcesHash: "0x" });
  assert.equal(v1.tmaxC, 29);
  assert.equal(ladderState(500, 200, 300, v1), "settled-in-challenge-window");
  assert.equal(ladderState(1300, 200, 300, v1), "settled");
  const feas = decodeResult({ status: 1, tmaxC: 28, resolvedAt: 400n, sourcesHash: "0x" });
  assert.equal(feas.finalAt, null);
  assert.equal(ladderState(401, 200, 300, feas), "settled");
  assert.equal(ladderState(401, 200, 300, decodeResult({ status: 2, tmaxC: 0, resolvedAt: 1n, finalAt: 1n })), "void");
});

// ------------------------------------------------------------------------------------------- host interaction
test("mapExecutorError: policy denial, gateway 400, sign-in", () => {
  const denied = Object.assign(new Error("stub Guard: 0xabc not on allowlist"), { code: "TRANSACTION_REQUEST_FAILED", terminalStatus: "DENIED" });
  assert.equal(mapExecutorError(denied, "x", "").code, "ISOTHERM_TX_DENIED");
  const gw = Object.assign(new Error("Non-200 status code: '400'"), { data: { error: "Invalid chainId" } });
  assert.equal(mapExecutorError(gw, "x", "").code, "ISOTHERM_CHAIN_NOT_CONFIGURED");
  assert.equal(mapExecutorError(new Error("No CLI refresh token available — run `mm login` to sign in."), "x", "").code, "ISOTHERM_NOT_SIGNED_IN");
  assert.equal(mapExecutorError(Object.assign(new Error("e"), { terminalStatus: "EXPIRED" }), "x", "").code, "ISOTHERM_APPROVAL_EXPIRED");
  assert.equal(mapExecutorError(new Error("boom"), "x", "").code, "ISOTHERM_EXECUTOR_ERROR");
});

test("wallet + custom chain discovery from mm wallet state", () => {
  const ctx = {
    walletStateManager: {
      read: () => ({
        byokWallets: [{ namespace: "evm", address: "0x9f6af0b5e8091b867500d9e2a3240bd92259a543" }],
        customEvmChains: [{ chainId: 10143, rpcTarget: "http://127.0.0.1:19251" }],
      }),
    },
  };
  assert.deepEqual(selectedAddress(ctx), { address: "0x9F6AF0b5E8091B867500D9E2a3240Bd92259a543", source: "mm-wallet-state" });
  assert.equal(customChainRpc(ctx), "http://127.0.0.1:19251");
  assert.equal(customChainRpc({ walletStateManager: { read: () => ({}) } }), undefined);
  assert.equal(selectedAddress({ walletStateManager: { read: () => { throw new Error("locked"); } } }).address, undefined);
});

// ------------------------------------------------------------------------------------------- manifest contract
test("package.json#mm and the oclif manifest agree, and every command declares the right capability", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "oclif.manifest.json"), "utf8"));
  const ids = pkg.mm.commands.map((c: any) => c.id).sort();
  assert.deepEqual(ids, Object.keys(manifest.commands).sort());
  const submit = new Set(["weather:buy", "weather:sell", "weather:redeem", "kuru:limit", "kuru:cancel"]);
  for (const c of pkg.mm.commands) {
    assert.ok(c.capabilities.includes("wallet-read"), c.id);
    assert.equal(c.capabilities.includes("wallet-submit"), submit.has(c.id), c.id);
    assert.deepEqual(c.targetChains, [10143]);
  }
  assert.equal(pkg.peerDependencies["@metamask/agent-wallet"], "^7.0.0");
  assert.equal(pkg.scripts.postinstall, undefined);
  for (const id of ids) {
    const src = readFileSync(join(process.cwd(), "src", "commands", ...id.split(":")) + ".ts", "utf8");
    assert.match(src, new RegExp(`pluginCommandId = "${id}"`), id);
  }
});

export const _unused = encodeAbiParameters;

// ------------------------------------------------------------------------------------------- maker snapshot (fair value)
test("pickMakerLadder reads the live API snapshot (captured 2026-10-07) and infers the fair-value basis", () => {
  const body = fx("api-snapshot-2026-10-07.json");
  const now = Date.parse(body.generatedAt) + 90_000;
  const r = pickMakerLadder(body, "RCSS", 20261008, "https://x/api/snapshot", now);
  assert.ok(r.ladder, r.error);
  const l = r.ladder!;
  assert.equal(l.ageS, 90);
  assert.equal(l.stale, false);
  assert.deepEqual(l.strikes.map((s) => s.k), [28, 29, 30, 31]);
  const s30 = l.strikes.find((s) => s.k === 30)!;
  assert.equal(s30.fair, 0.3986);
  assert.equal(s30.fairSource, "polymarket");
  assert.equal(s30.guard, 0.5907); // the API calls the maker's guard model "model"
  assert.equal(s30.seriesId, "0xb020bdde35a3212b69e836e2f78f56b4560e75bc74eb7a6b790342f58de00064");
  assert.equal(pickMakerLadder(body, "RCSS", 20261008, "u", now + 3_600_000).ladder!.stale, true);
  assert.match(pickMakerLadder(body, "RJTT", 20261008, "u", now).error ?? "", /no RJTT 20261008 ladder/);
  assert.match(pickMakerLadder({ version: 1, empty: true, ladders: [] }, "RCSS", 20261008, "u").error ?? "", /not published/);
  assert.match(pickMakerLadder({ ...body, chainId: 1 }, "RCSS", 20261008, "u").error ?? "", /chain 1/);
  // out-of-range numbers are dropped, never trusted
  const bad = { ...body, ladders: [{ ...body.ladders[0], strikes: [{ k: 30, fair: 7, model: -1, pmImplied: "x" }] }] };
  const b30 = pickMakerLadder(bad, "RCSS", 20261008, "u", now).ladder!.strikes[0];
  assert.equal(b30.fair, null);
  assert.equal(b30.guard, null);
});

test("inferFairSource: passthrough, certain, model fallback, polymarket", () => {
  assert.equal(inferFairSource({ fairSource: "fallback-intraday", fair: 0.3, pmImplied: 0.2, flags: [] }), "fallback-intraday");
  assert.equal(inferFairSource({ fair: 1, pmImplied: 0.9, flags: ["observed-max>=k"] }), "certain");
  assert.equal(inferFairSource({ fair: 0.4, pmImplied: null, flags: ["no-polymarket-market"] }), "fallback-model");
  assert.equal(inferFairSource({ fair: 0.4, pmImplied: 0.41, flags: ["guard-wide"] }), "polymarket");
  assert.equal(inferFairSource({ fair: null, pmImplied: 0.41, flags: [] }), null);
});

test("chooseReference prefers the maker snapshot, labels the guardrail, and never lets a model drive edge", () => {
  const ms = (o: Partial<MakerStrike>): MakerStrike => ({ k: 30, seriesId: null, market: null, fair: 0.3986, fairSource: "polymarket", pmImplied: 0.3986, guard: 0.5907, guardSource: null, bid: null, ask: null, mode: "quoting", flags: [], ...o });
  // live 2026-10-07: maker fair 0.40, maker v0 guard 0.59, plugin v0-lite 0.145
  const a = chooseReference(ms({}), 0.408, 0.145);
  assert.equal(a.fairValue, 0.3986);
  assert.equal(a.fairValueSource, "maker-snapshot");
  assert.equal(a.marketRefSource, "maker-snapshot");
  assert.equal(a.guardrail.source, "maker-snapshot");
  assert.equal(a.guardrail.p, 0.5907);
  assert.equal(a.guardrail.flag, true); // |0.59 - 0.40| > 0.15
  // no (fresh) snapshot: the plugin's own Polymarket read, guardrail falls back to v0-lite and says so
  const b = chooseReference(null, 0.408, 0.145);
  assert.equal(b.fairValueSource, "polymarket-live");
  assert.equal(b.fairValue, 0.408);
  assert.equal(b.guardrail.source, "plugin-v0-lite");
  assert.equal(b.guardrail.basis, "v0-lite");
  // the maker fell back to its model: fairValue shows it, but edge's reference stays Polymarket (or nothing)
  const c = chooseReference(ms({ fair: 0.5, fairSource: "fallback-v0", pmImplied: null, guard: 0.5 }), null, 0.2);
  assert.equal(c.fairValue, 0.5);
  assert.equal(c.fairValueBasis, "fallback-v0");
  assert.equal(c.marketRef, null);
  const d = chooseReference(null, null, null);
  assert.equal(d.fairValue, null);
  assert.equal(d.guardrail.source, null);
});

test("apiBaseUrl: default, override, off, and no plain http except localhost", () => {
  assert.equal(apiBaseUrl({}), "https://isotherm.pages.dev");
  assert.equal(apiBaseUrl({ ISOTHERM_API_URL: "https://api.example.org/" }), "https://api.example.org");
  assert.equal(apiBaseUrl({ ISOTHERM_API_URL: "off" }), null);
  assert.equal(apiBaseUrl({ ISOTHERM_API_URL: "http://evil.example" }), null);
  assert.equal(apiBaseUrl({ ISOTHERM_API_URL: "http://127.0.0.1:19543" }), "http://127.0.0.1:19543");
});
