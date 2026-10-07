import { CommandError, type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, type Address } from "viem";
import { F, encodeZap, ensureAllowance, envSummary, fail, findLadder, intArg, needCity, numArg, optAddress, pickSeries, runner, setupEnv } from "../../lib/cmd.js";
import { describeSeries } from "../../lib/isotherm.js";
import { applyBpsDown, planBuyNo, priceUToString, roundQuoteToPricePrecision, walkBuy, walkSell } from "../../lib/plan.js";
import { explainRevert } from "../../lib/chain.js";
import { balanceOf, book, canonicalBook, gatedGuard, observedGuard, requireOpen, simulate, slippageBps, zapEvents } from "../../lib/trade.js";
import { fmtUnits, parsePrice, parseUnitsStrict, shortErr } from "../../lib/util.js";
import { isoOf } from "../../lib/weather.js";

const inputs = {
  city: F.city(0, true),
  strike: F.strike(),
  side: F.side(),
  amount: { type: InputFieldType.Text, flag: "amount", message: "AUSD to spend (YES: on the book; NO: complete sets minted in the vault, whose YES leg is then sold)", required: true },
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
    "Buy YES or NO of a city's 'Tmax >= k' strike (YES: Zap.buyYes on the canonical Kuru book; NO: CollateralVault.mintSet, then Zap.sellYes of exactly that YES with a min-out bound), with a max-price book walk and an on-chain min-out guard.";
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
    let planDetail: Record<string, unknown>;
    let yesPlan: { minOut: bigint } | undefined;
    let noPlan: ReturnType<typeof planBuyNo> | undefined;
    const pp = params.pricePrecision;
    if (side === "yes") {
      const w0 = walkBuy(l2.asks, amount, maxPU, params);
      spend = roundQuoteToPricePrecision(w0.spendQuote, params);
      const w = walkBuy(l2.asks, spend, maxPU, params);
      if (spend === 0n || w.netBase === 0n)
        fail("ISOTHERM_NO_LIQUIDITY", `No YES asks at or below ${String(i.maxPrice)} on the Tmax>=${strike}C book (best ask ${priceUToString(l2.asks[0]?.priceU ?? null, pp) ?? "none"}).`, "Raise --max-price, wait for the maker to quote, or place a resting bid: mm kuru limit <market> --side buy …");
      const minOut = applyBpsDown(w.netBase, slip);
      yesPlan = { minOut };
      planDetail = {
        route: "Zap.buyYes(minYesOut)",
        spendAusd: fmtUnits(spend, 6),
        requestedAusd: fmtUnits(amount, 6),
        expectedYes: fmtUnits(w.netBase, 6),
        minYesOut: fmtUnits(minOut, 6),
        avgPricePerYes: Number(spend) / Number(w.netBase),
        worstLevel: priceUToString(w.worstPriceU, pp),
        levelsUsed: w.levelsUsed,
        cappedByMaxPrice: w0.limitedByPrice,
      };
    } else {
      // NO = mint complete sets in the vault, then sell exactly that YES with Zap.sellYes(minAusdOut). Zap.buyNo is
      // NOT used: its only bound (minAusdBack) counts unsold YES merged back at par, so a sandwich that drains the
      // bids still passes it at a terrible NO price (security review v1, N1). sellYes' bound is a real worst case.
      const nb = planBuyNo(l2.bids, amount, maxPU, params, slip);
      if (nb.sets === 0n || nb.minAusdOut === 0n)
        fail("ISOTHERM_NO_LIQUIDITY", `No YES bids at or above ${priceUToString(nb.minBidU, pp)} on the Tmax>=${strike}C book, so NO cannot be bought at <= ${String(i.maxPrice)} (best bid ${priceUToString(l2.bids[0]?.priceU ?? null, pp) ?? "none"}).`, "Raise --max-price, or wait for the maker to quote.");
      noPlan = nb;
      spend = nb.sets;
      planDetail = {
        route: "CollateralVault.mintSet + Zap.sellYes(minAusdOut)",
        setsMinted: fmtUnits(nb.sets, 6),
        requestedAusd: fmtUnits(amount, 6),
        expectedNo: fmtUnits(nb.sets, 6),
        expectedAusdBack: fmtUnits(nb.expectedAusd, 6),
        minAusdOut: fmtUnits(nb.minAusdOut, 6),
        netAusdCost: fmtUnits(nb.sets - nb.expectedAusd, 6),
        avgPricePerNo: Number(nb.sets - nb.expectedAusd) / Number(nb.sets),
        worstCaseNoPrice: Number(nb.sets - nb.minAusdOut) / Number(nb.sets),
        minYesBid: priceUToString(nb.minBidU, pp),
        worstYesBid: priceUToString(nb.worstBidU, pp),
        levelsUsed: nb.levelsUsed,
        cappedByMaxPrice: nb.cappedByMaxPrice,
        bound:
          "On-chain: Zap.sellYes reverts unless at least minAusdOut AUSD comes back for exactly setsMinted YES. NO received is exactly setsMinted (minted to your wallet), so the NO price can never exceed worstCaseNoPrice.",
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
    const errAbis = [env.c.zapAbi!, env.c.vaultAbi];
    if (side === "yes") {
      if (i.dryRun) return { ...base, dryRun: true, steps: [`approve AUSD -> Zap (if allowance < ${fmtUnits(spend, 6)})`, "Zap.buyYes"], ...envSummary(env) };
      // ---------------------------------------------------------------- execute through the mm executor
      const run = runner(this, io, env, "weather:buy", gasMult);
      await ensureAllowance(run, env, env.dep.ausd, zap, spend, i.approve, "AUSD for the Isotherm Zap");
      const call = encodeZap(env.c.zapAbi!, "buyYes", { seriesId: s.seriesId, market, amountIn: spend, minOut: yesPlan!.minOut, to: me });
      const sim = await simulate(env, me, zap, call.data, env.c.zapAbi!, "buyYes", errAbis);
      const { result, receipt } = await run.send({ label: `Isotherm buyYes Tmax>=${strike}C ${city.name} ${isoOf(s.date)}`, to: zap, data: call.data });
      const [yesAfter, noAfter, ausdAfter] = await Promise.all([balanceOf(env, s.yes, me), balanceOf(env, s.no, me), balanceOf(env, env.dep.ausd, me)]);
      return {
        ...base,
        zapCall: call.signature,
        simulated: sim.map((x) => String(x)),
        steps: run.steps,
        events: zapEvents(env.c.zapAbi, receipt, zap),
        tx: result.hash,
        balancesAfter: { YES: fmtUnits(yesAfter, 6), NO: fmtUnits(noAfter, 6), AUSD: fmtUnits(ausdAfter, 6) },
        ...envSummary(env),
      };
    }

    // ---------------------------------------------------------------- buy NO: mintSet, then sellYes(minAusdOut)
    const nb = noPlan!;
    const vault = env.dep.vault;
    const label = `Tmax>=${strike}C ${city.name} ${isoOf(s.date)}`;
    if (i.dryRun)
      return {
        ...base,
        dryRun: true,
        steps: [
          `approve AUSD -> CollateralVault (if allowance < ${fmtUnits(nb.sets, 6)})`,
          `approve YES -> Zap (if allowance < ${fmtUnits(nb.sets, 6)})`,
          `CollateralVault.mintSet(${fmtUnits(nb.sets, 6)}): ${fmtUnits(nb.sets, 6)} YES + ${fmtUnits(nb.sets, 6)} NO to your wallet`,
          `Zap.sellYes(${fmtUnits(nb.sets, 6)} YES, minAusdOut ${fmtUnits(nb.minAusdOut, 6)}): reverts instead of filling below the bound`,
        ],
        ...envSummary(env),
      };
    const run = runner(this, io, env, "weather:buy", gasMult);
    await ensureAllowance(run, env, env.dep.ausd, vault, nb.sets, i.approve, "AUSD for the CollateralVault (mint complete sets)");
    await ensureAllowance(run, env, s.yes, zap, nb.sets, i.approve, `YES ${label} for the Isotherm Zap (sell the YES leg)`);
    // Re-read the book just before minting: if the plan no longer holds, stop with nothing minted.
    const l2b = await book(env, market);
    const re = walkSell(l2b.bids, nb.sets, nb.minBidU, params);
    if (re.soldBase < nb.sets || re.netQuote < nb.minAusdOut)
      fail(
        "ISOTHERM_PRICE_LIMIT",
        `The YES bids moved before minting: selling ${fmtUnits(nb.sets, 6)} YES at >= ${priceUToString(nb.minBidU, pp)} now returns ${fmtUnits(re.netQuote, 6)} AUSD, below minAusdOut ${fmtUnits(nb.minAusdOut, 6)}. Nothing was minted.`,
        "Re-run to re-plan. Any approval above is confirmed and harmless.",
      );
    const [ausdBefore, noBefore] = await Promise.all([balanceOf(env, env.dep.ausd, me), balanceOf(env, s.no, me)]);
    const mint = encodeFunctionData({ abi: env.c.vaultAbi, functionName: "mintSet", args: [s.seriesId, nb.sets] });
    await run.send({ label: `Isotherm buy NO 1/2: vault.mintSet ${fmtUnits(nb.sets, 6)} sets ${label}`, to: vault, data: mint, gasMult: 1.1 });
    const call = encodeZap(env.c.zapAbi!, "sellYes", { seriesId: s.seriesId, market, amountIn: nb.sets, minOut: nb.minAusdOut, to: me });
    let sim: readonly unknown[];
    let sent: Awaited<ReturnType<typeof run.send>>;
    try {
      sim = await simulate(env, me, zap, call.data, env.c.zapAbi!, "sellYes", errAbis);
      sent = await run.send({ label: `Isotherm buy NO 2/2: Zap.sellYes ${fmtUnits(nb.sets, 6)} YES ${label} (min ${fmtUnits(nb.minAusdOut, 6)} AUSD)`, to: zap, data: call.data });
    } catch (e) {
      // The sets are minted but the YES leg was not sold: the user holds complete sets worth exactly 1 AUSD each.
      const why = e instanceof CommandError ? `${e.code}: ${e.message}` : shortErr(e);
      let now: string;
      try {
        await env.reader.client.call({ account: me, to: zap, data: call.data });
        now = "a fresh simulation of the same sellYes now succeeds (the book recovered)";
      } catch (e2) {
        now = `a fresh simulation of the same sellYes reverts: ${explainRevert(e2, errAbis)}`;
      }
      const [y, n] = await Promise.all([balanceOf(env, s.yes, me), balanceOf(env, s.no, me)]);
      throw new CommandError(
        "ISOTHERM_SET_HELD",
        `Minted ${fmtUnits(nb.sets, 6)} complete sets of ${label}, but the YES leg was not sold (${why}); ${now}. No YES was sold below your limit. Wallet now holds ${fmtUnits(y, 6)} YES + ${fmtUnits(n, 6)} NO of this strike (each YES+NO pair merges back to exactly 1 AUSD).`,
        `Either merge the sets back at par: mm weather redeem ${city.key} --date ${isoOf(s.date)} --strike ${strike} --merge; or finish the NO purchase at the same limit: mm weather sell ${city.key} --date ${isoOf(s.date)} --strike ${strike} --side yes --amount ${fmtUnits(nb.sets, 6)} --min-price ${priceUToString(nb.minBidU, pp)}. Do not re-run this buy (it would mint again).`,
      );
    }
    const [yesAfter, noAfter, ausdAfter] = await Promise.all([balanceOf(env, s.yes, me), balanceOf(env, s.no, me), balanceOf(env, env.dep.ausd, me)]);
    const noGot = noAfter - noBefore;
    const paid = ausdBefore - ausdAfter;
    return {
      ...base,
      zapCall: call.signature,
      simulated: sim.map((x) => String(x)),
      steps: run.steps,
      events: zapEvents(env.c.zapAbi, sent.receipt, zap),
      tx: sent.result.hash,
      result: {
        noReceived: fmtUnits(noGot, 6),
        netAusdPaid: fmtUnits(paid, 6),
        effectiveNoPrice: noGot > 0n ? Number(paid) / Number(noGot) : null,
        withinWorstCase: noGot === nb.sets && paid <= nb.sets - nb.minAusdOut,
      },
      balancesAfter: { YES: fmtUnits(yesAfter, 6), NO: fmtUnits(noAfter, 6), AUSD: fmtUnits(ausdAfter, 6) },
      ...envSummary(env),
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return d.dryRun ? "dry run: nothing signed" : `confirmed ${String(d.tx ?? "")}`;
  }
}
