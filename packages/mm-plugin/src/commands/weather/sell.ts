import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, type Address } from "viem";
import { F, encodeZap, ensureAllowance, envSummary, fail, findLadder, intArg, needCity, numArg, optAddress, pickSeries, runner, setupEnv } from "../../lib/cmd.js";
import { describeSeries } from "../../lib/isotherm.js";
import { applyBpsDown, priceUToString, quoteForExactOut, walkSell } from "../../lib/plan.js";
import { balanceOf, book, canonicalBook, observedGuard, requireOpen, simulate, slippageBps, zapEvents } from "../../lib/trade.js";
import { fmtUnits, parsePrice, parseUnitsStrict, shortErr } from "../../lib/util.js";
import { isoOf } from "../../lib/weather.js";

const inputs = {
  city: F.city(0, true),
  strike: F.strike(),
  side: F.side(),
  amount: { type: InputFieldType.Text, flag: "amount", message: "How many YES (or NO) tokens to sell, e.g. 25.5", required: true },
  minPrice: { type: InputFieldType.Text, flag: "min-price", message: "Lowest price you accept per token, in AUSD, e.g. 0.55", required: true },
  date: F.date(),
  slippage: F.slippage(),
  market: F.market(),
  approve: F.approve(),
  gasMult: F.gasMult(),
  ignoreObserved: { type: InputFieldType.Boolean, flag: "ignore-observed", message: "Allow selling a side that today's observed max already decided in your favour", required: false, prompt: false },
  dryRun: F.dryRun(),
  rpc: F.rpc(),
} satisfies InputSchema;

export default class WeatherSell extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Sell YES (Zap.sellYes into the canonical Kuru book, unsold YES refunded) or NO (buy the matching YES on the book, then merge YES+NO back into AUSD), with a min-price book walk and min-out guards.";
  static override examples = [
    "<%= config.bin %> weather sell taipei --strike 28 --side yes --amount 20 --min-price 0.5 --json",
    "<%= config.bin %> weather sell taipei --strike 30 --side no --amount 10 --min-price 0.85 --dry-run --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "weather:sell";

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

    const l = await findLadder(env, city, i.date);
    if (!l) fail("ISOTHERM_NO_LADDER", `No Isotherm ladder for ${city.name}${i.date ? ` on ${i.date}` : ""}.`, "List ladders with `mm weather markets`.");
    const s = pickSeries(l, strike);
    requireOpen(l, env.nowS);
    const { check, params, market } = await canonicalBook(env, s, optAddress(i.market, "market"));
    const observed = await observedGuard(city, s, side, "sell", Boolean(i.ignoreObserved));

    let amount: bigint, minPU: bigint;
    try {
      amount = parseUnitsStrict(String(i.amount), 6, "amount");
      minPU = parsePrice(String(i.minPrice), Number(params.pricePrecision), "min-price");
    } catch (e) {
      return fail("ISOTHERM_BAD_INPUT", shortErr(e), "Example: --amount 20 --min-price 0.55");
    }
    if (amount <= 0n) fail("ISOTHERM_BAD_INPUT", "amount must be > 0", "Example: --amount 20");
    if (minPU <= 0n || minPU >= params.pricePrecision) fail("ISOTHERM_BAD_INPUT", "min-price must be strictly between 0 and 1", "Example: --min-price 0.55");
    const slip = slippageBps(i.slippage);
    const gasMult = numArg(i.gasMult, "--gas-mult", 1.25, 1.0, 3.0);
    const l2 = await book(env, market);
    const pp = params.pricePrecision;
    const held = await balanceOf(env, side === "yes" ? s.yes : s.no, me);
    if (held < amount) fail("ISOTHERM_INSUFFICIENT_TOKENS", `You hold ${fmtUnits(held, 6)} ${side.toUpperCase()} of Tmax>=${strike}C, less than ${fmtUnits(amount, 6)}.`, "See `mm weather positions`.");

    const base = {
      action: `sell ${side.toUpperCase()}`,
      series: describeSeries(s),
      date: isoOf(s.date),
      market,
      marketSource: check.source,
      zap,
      takerFeeBps: Number(params.takerFeeBps),
      slippageBps: Number(slip),
      minPrice: String(i.minPrice),
      observed,
      wallet: me,
    };

    if (side === "yes") {
      const w0 = walkSell(l2.bids, amount, minPU, params);
      const sellAmt = w0.soldBase < amount ? w0.soldBase : amount;
      if (sellAmt === 0n)
        fail("ISOTHERM_NO_LIQUIDITY", `No YES bids at or above ${String(i.minPrice)} (best bid ${priceUToString(l2.bids[0]?.priceU ?? null, pp) ?? "none"}).`, "Lower --min-price, or rest an ask: mm kuru limit <market> --side sell …");
      const w = walkSell(l2.bids, sellAmt, minPU, params);
      const minOut = applyBpsDown(w.netQuote, slip);
      const plan = {
        sellYes: fmtUnits(sellAmt, 6),
        requestedYes: fmtUnits(amount, 6),
        expectedAusd: fmtUnits(w.netQuote, 6),
        minAusdOut: fmtUnits(minOut, 6),
        avgPricePerYes: Number(w.netQuote) / Number(sellAmt),
        worstBid: priceUToString(w.worstPriceU, pp),
        cappedByMinPrice: sellAmt < amount,
      };
      if (i.dryRun) return { ...base, plan, dryRun: true, steps: ["approve YES -> Zap (if needed)", "Zap.sellYes"], ...envSummary(env) };
      const run = runner(this, io, env, "weather:sell", gasMult);
      await ensureAllowance(run, env, s.yes, zap, sellAmt, i.approve, `YES Tmax>=${strike}C for the Isotherm Zap`);
      const call = encodeZap(env.c.zapAbi!, "sellYes", { seriesId: s.seriesId, market, amountIn: sellAmt, minOut, to: me });
      const sim = await simulate(env, me, zap, call.data, env.c.zapAbi!, "sellYes", [env.c.zapAbi!, env.c.vaultAbi]);
      const { result, receipt } = await run.send({ label: `Isotherm sellYes Tmax>=${strike}C ${city.name} ${isoOf(s.date)}`, to: zap, data: call.data });
      const [yesAfter, ausdAfter] = await Promise.all([balanceOf(env, s.yes, me), balanceOf(env, env.dep.ausd, me)]);
      return { ...base, plan, zapCall: call.signature, simulated: sim.map(String), steps: run.steps, events: zapEvents(env.c.zapAbi, receipt, zap), tx: result.hash, balancesAfter: { YES: fmtUnits(yesAfter, 6), AUSD: fmtUnits(ausdAfter, 6) }, ...envSummary(env) };
    }

    // side NO: buy exactly `amount` YES on the book, then merge YES+NO -> AUSD (vault.redeemSet, 1:1).
    const need = quoteForExactOut(l2.asks, amount, null, params);
    if (!need) fail("ISOTHERM_NO_LIQUIDITY", `The YES book is too thin to buy back ${fmtUnits(amount, 6)} YES (needed to close NO).`, "Sell a smaller amount, hold NO to settlement, or wait for the maker.");
    const unit = 10n ** params.quoteDecimals / pp;
    const cost = ((need!.quote + unit - 1n) / unit) * unit;
    const proceeds = amount - cost; // AUSD per merged set is 1
    const minTotal = (amount * minPU) / pp;
    if (cost >= amount || proceeds < minTotal)
      fail("ISOTHERM_PRICE_LIMIT", `Closing NO now yields ${fmtUnits(proceeds > 0n ? proceeds : 0n, 6)} AUSD for ${fmtUnits(amount, 6)} NO (${(Number(proceeds) / Number(amount)).toFixed(4)} per NO), below --min-price ${String(i.minPrice)}.`, "Lower --min-price or hold NO to settlement.");
    const plan = {
      closeNo: fmtUnits(amount, 6),
      buyYesWithAusd: fmtUnits(cost, 6),
      minYesOut: fmtUnits(amount, 6),
      expectedAusdNet: fmtUnits(proceeds, 6),
      pricePerNo: Number(proceeds) / Number(amount),
      worstAsk: priceUToString(need!.worstPriceU, pp),
      steps: ["Zap.buyYes (exact-out sized from the L2 book, minYesOut = amount)", "CollateralVault.redeemSet(amount): YES+NO -> AUSD 1:1"],
    };
    const ausdBal = await balanceOf(env, env.dep.ausd, me);
    if (ausdBal < cost) fail("ISOTHERM_INSUFFICIENT_AUSD", `Closing NO needs ${fmtUnits(cost, 6)} AUSD up front to buy the YES leg; wallet has ${fmtUnits(ausdBal, 6)}.`, `Claim testnet AUSD from ${env.dep.ausdFaucet}.`);
    if (i.dryRun) return { ...base, plan, dryRun: true, ...envSummary(env) };
    const run = runner(this, io, env, "weather:sell", gasMult);
    await ensureAllowance(run, env, env.dep.ausd, zap, cost, i.approve, "AUSD for the Isotherm Zap");
    const call = encodeZap(env.c.zapAbi!, "buyYes", { seriesId: s.seriesId, market, amountIn: cost, minOut: amount, to: me });
    const sim = await simulate(env, me, zap, call.data, env.c.zapAbi!, "buyYes", [env.c.zapAbi!, env.c.vaultAbi]);
    const r1 = await run.send({ label: `Isotherm buyYes (to close NO) Tmax>=${strike}C ${city.name} ${isoOf(s.date)}`, to: zap, data: call.data });
    const merge = encodeFunctionData({ abi: env.c.vaultAbi, functionName: "redeemSet", args: [s.seriesId, amount] });
    const r2 = await run.send({ label: `Isotherm merge ${fmtUnits(amount, 6)} YES+NO -> AUSD`, to: env.dep.vault, data: merge, gasMult: 1.1 });
    const [yesAfter, noAfter, ausdAfter] = await Promise.all([balanceOf(env, s.yes, me), balanceOf(env, s.no, me), balanceOf(env, env.dep.ausd, me)]);
    return {
      ...base,
      plan,
      simulated: sim.map(String),
      steps: run.steps,
      events: zapEvents(env.c.zapAbi, r1.receipt, zap),
      tx: r2.result.hash,
      balancesAfter: { YES: fmtUnits(yesAfter, 6), NO: fmtUnits(noAfter, 6), AUSD: fmtUnits(ausdAfter, 6) },
      note: "Any YES bought above the exact amount (rounding buffer) stays in your wallet.",
      ...envSummary(env),
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return d.dryRun ? "dry run: nothing signed" : `confirmed ${String(d.tx ?? "")}`;
  }
}
