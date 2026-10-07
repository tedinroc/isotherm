import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { F, encodeZap, ensureAllowance, envSummary, fail, findLadder, intArg, needCity, numArg, optAddress, pickSeries, runner, setupEnv } from "../../lib/cmd.js";
import { describeSeries } from "../../lib/isotherm.js";
import { applyBpsDown, BPS, priceUToString, roundQuoteToPricePrecision, walkBuy, walkSell } from "../../lib/plan.js";
import { balanceOf, book, canonicalBook, gatedGuard, observedGuard, requireOpen, simulate, slippageBps, zapEvents } from "../../lib/trade.js";
import { fmtUnits, parsePrice, parseUnitsStrict, shortErr } from "../../lib/util.js";
import { isoOf } from "../../lib/weather.js";

const inputs = {
  city: F.city(0, true),
  strike: F.strike(),
  side: F.side(),
  amount: { type: InputFieldType.Text, flag: "amount", message: "AUSD to spend (YES: on the book; NO: complete sets minted)", required: true },
  maxPrice: { type: InputFieldType.Text, flag: "max-price", message: "Highest price you accept per YES (or per NO), in AUSD, e.g. 0.62", required: true },
  date: F.date(),
  slippage: F.slippage(),
  market: F.market(),
  approve: F.approve(),
  gasMult: F.gasMult(),
  ignoreObserved: { type: InputFieldType.Boolean, flag: "ignore-observed", message: "Allow buying a side that today's observed max already ruled out", required: false, prompt: false },
  dryRun: F.dryRun(),
  rpc: F.rpc(),
} satisfies InputSchema;

export default class WeatherBuy extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Buy YES or NO of a city's 'Tmax >= k' strike through the IsothermZap (YES: market-buy on the canonical Kuru book; NO: mint a complete set and sell the YES leg), with a max-price book walk and a min-out guard.";
  static override examples = [
    "<%= config.bin %> weather buy taipei --strike 28 --side yes --amount 10 --max-price 0.6 --dry-run --json",
    "<%= config.bin %> weather buy taipei --strike 30 --side no --amount 25 --max-price 0.9 --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "weather:buy";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const city = needCity(i.city);
    const strike = intArg(i.strike, "strike");
    const side = String(i.side) as "yes" | "no";
    const env = await setupEnv(this.ctx, i.rpc);
    if (!env.dep.zap || !env.c.zapAbi) fail("ISOTHERM_NO_ZAP", "This deployment has no IsothermZap.", "Use a deployment with a Zap (see `mm weather doctor`).");
    const zap = env.dep.zap as Address;
    if (!env.self) fail("ISOTHERM_NO_WALLET", "No wallet selected in mm.", "Run `mm init` first.");
    const me = env.self as Address;

    const ladder = await findLadder(env, city, i.date);
    if (!ladder) fail("ISOTHERM_NO_LADDER", `No Isotherm ladder for ${city.name}${i.date ? ` on ${i.date}` : ""}.`, "List ladders with `mm weather markets`.");
    const l = ladder!;
    const s = pickSeries(l, strike);
    requireOpen(l, env.nowS);
    const { check, params, market } = await canonicalBook(env, s, optAddress(i.market, "market"));
    const observed = await observedGuard(city, s, side, "buy", Boolean(i.ignoreObserved));
    if (side === "no") await gatedGuard(env, s, me);

    let amount: bigint, maxPU: bigint;
    try {
      amount = parseUnitsStrict(String(i.amount), 6, "amount");
      maxPU = parsePrice(String(i.maxPrice), Number(params.pricePrecision), "max-price");
    } catch (e) {
      return fail("ISOTHERM_BAD_INPUT", shortErr(e), "Example: --amount 10 --max-price 0.62 (prices have at most 4 decimals).");
    }
    if (amount <= 0n) fail("ISOTHERM_BAD_INPUT", "amount must be > 0", "Example: --amount 10");
    if (maxPU <= 0n || maxPU >= params.pricePrecision) fail("ISOTHERM_BAD_INPUT", "max-price must be strictly between 0 and 1", "Example: --max-price 0.62");
    const slip = slippageBps(i.slippage);
    const gasMult = numArg(i.gasMult, "--gas-mult", 1.25, 1.0, 3.0);
    const fee = params.takerFeeBps;
    const l2 = await book(env, market);

    // ---------------------------------------------------------------- plan (book walk, integer math)
    let spend: bigint;
    let expectedOut: bigint; // YES (side yes) or AUSD back (side no)
    let minOut: bigint;
    let minNoOut: bigint | undefined;
    let fn: "buyYes" | "buyNo";
    let planDetail: Record<string, unknown>;
    if (side === "yes") {
      const w0 = walkBuy(l2.asks, amount, maxPU, params);
      spend = roundQuoteToPricePrecision(w0.spendQuote, params);
      const w = walkBuy(l2.asks, spend, maxPU, params);
      if (spend === 0n || w.netBase === 0n)
        fail("ISOTHERM_NO_LIQUIDITY", `No YES asks at or below ${String(i.maxPrice)} on the Tmax>=${strike}C book (best ask ${priceUToString(l2.asks[0]?.priceU ?? null, params.pricePrecision) ?? "none"}).`, "Raise --max-price, wait for the maker to quote, or place a resting bid: mm kuru limit <market> --side buy …");
      expectedOut = w.netBase;
      minOut = applyBpsDown(expectedOut, slip);
      fn = "buyYes";
      planDetail = {
        spendAusd: fmtUnits(spend, 6),
        requestedAusd: fmtUnits(amount, 6),
        expectedYes: fmtUnits(expectedOut, 6),
        minYesOut: fmtUnits(minOut, 6),
        avgPricePerYes: Number(spend) / Number(expectedOut),
        worstLevel: priceUToString(w.worstPriceU, params.pricePrecision),
        levelsUsed: w.levelsUsed,
        cappedByMaxPrice: w0.limitedByPrice,
      };
    } else {
      // NO costs 1 - bid*(1-fee) per set, so require bid >= (1 - maxPrice) / (1 - fee).
      const pp = params.pricePrecision;
      const minBidU = ((pp - maxPU) * BPS + (BPS - fee) - 1n) / (BPS - fee);
      const w0 = walkSell(l2.bids, amount, minBidU, params);
      spend = w0.soldBase < amount ? w0.soldBase : amount;
      if (spend === 0n)
        fail("ISOTHERM_NO_LIQUIDITY", `No YES bids at or above ${priceUToString(minBidU, pp)} on the Tmax>=${strike}C book, so NO cannot be bought at <= ${String(i.maxPrice)} (best bid ${priceUToString(l2.bids[0]?.priceU ?? null, pp) ?? "none"}).`, "Raise --max-price, or wait for the maker to quote.");
      const w = walkSell(l2.bids, spend, minBidU, params);
      expectedOut = w.netQuote; // AUSD back from selling the YES leg
      minOut = applyBpsDown(expectedOut, slip);
      minNoOut = applyBpsDown(spend, slip);
      fn = "buyNo";
      planDetail = {
        setsMinted: fmtUnits(spend, 6),
        requestedAusd: fmtUnits(amount, 6),
        expectedNo: fmtUnits(spend, 6),
        expectedAusdBack: fmtUnits(expectedOut, 6),
        minAusdBack: fmtUnits(minOut, 6),
        netAusdCost: fmtUnits(spend - expectedOut, 6),
        avgPricePerNo: Number(spend - expectedOut) / Number(spend),
        worstYesBid: priceUToString(w.worstPriceU, pp),
        levelsUsed: w.levelsUsed,
        cappedByMaxPrice: spend < amount,
      };
    }
    const ausdBal = await balanceOf(env, env.dep.ausd, me);
    if (ausdBal < spend) fail("ISOTHERM_INSUFFICIENT_AUSD", `Need ${fmtUnits(spend, 6)} AUSD, wallet has ${fmtUnits(ausdBal, 6)}.`, `Claim testnet AUSD: requestFunds(${me}) on the faucet ${env.dep.ausdFaucet}.`);

    const base = {
      action: `buy ${side.toUpperCase()}`,
      series: describeSeries(s),
      date: isoOf(s.date),
      market,
      marketSource: check.source,
      zap,
      takerFeeBps: Number(fee),
      slippageBps: Number(slip),
      maxPrice: String(i.maxPrice),
      plan: planDetail,
      observed,
      wallet: me,
    };
    if (i.dryRun) return { ...base, dryRun: true, steps: [`approve AUSD -> Zap (if allowance < ${fmtUnits(spend, 6)})`, `Zap.${fn}`], ...envSummary(env) };

    // ---------------------------------------------------------------- execute through the mm executor
    const run = runner(this, io, env, "weather:buy", gasMult);
    await ensureAllowance(run, env, env.dep.ausd, zap, spend, i.approve, "AUSD for the Isotherm Zap");
    const call = encodeZap(env.c.zapAbi!, fn, { seriesId: s.seriesId, market, amountIn: spend, minOut, to: me, minNoOut });
    const errAbis = [env.c.zapAbi!, env.c.vaultAbi];
    const sim = await simulate(env, me, zap, call.data, env.c.zapAbi!, fn, errAbis);
    if (side === "no") {
      // The feasibility Zap bounds only the AUSD coming back; if the book thins between quote and fill, unsold YES is
      // merged back at par and the NO actually received can be fewer. Refuse when the simulated NO price is above max.
      const noOut = BigInt(sim[0] as bigint);
      const back = BigInt(sim[1] as bigint);
      if (noOut === 0n || ((spend - back) * params.pricePrecision) / noOut > maxPU)
        fail("ISOTHERM_PRICE_LIMIT", `Simulated NO price ${noOut === 0n ? "n/a" : (Number(spend - back) / Number(noOut)).toFixed(4)} is above --max-price ${String(i.maxPrice)}.`, "The book moved; re-run to re-plan. The approval (if any) is confirmed and harmless.");
    }
    const { result, receipt } = await run.send({ label: `Isotherm ${fn} Tmax>=${strike}C ${city.name} ${isoOf(s.date)}`, to: zap, data: call.data });
    const [yesAfter, noAfter, ausdAfter] = await Promise.all([balanceOf(env, s.yes, me), balanceOf(env, s.no, me), balanceOf(env, env.dep.ausd, me)]);
    return {
      ...base,
      zapCall: call.signature,
      simulated: sim.map((x) => String(x)),
      steps: run.steps,
      events: zapEvents(env.c.zapAbi, receipt, zap),
      tx: result.hash,
      balancesAfter: { YES: fmtUnits(yesAfter, 6), NO: fmtUnits(noAfter, 6), AUSD: fmtUnits(ausdAfter, 6) },
      ...(side === "no" && !call.usedMinNoOut ? { guardNote: "This Zap's buyNo has no minNoOut; the plugin re-checked the NO price by simulation just before signing." } : {}),
      ...envSummary(env),
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return d.dryRun ? "dry run: nothing signed" : `confirmed ${String(d.tx ?? "")}`;
  }
}
