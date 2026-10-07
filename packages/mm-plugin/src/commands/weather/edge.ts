import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { F, envSummary, needCity, numArg, setupEnv } from "../../lib/cmd.js";
import { buildQuoteView, DISCLAIMER } from "../../lib/view.js";
import { round3 } from "../../lib/util.js";

const inputs = {
  city: F.city(0, true),
  date: F.date(),
  minGap: { type: InputFieldType.Text, flag: "min-gap", message: "Only suggest trades when the price gap vs Polymarket-implied exceeds this (default 0.03)", required: false, prompt: false },
  rpc: F.rpc(),
} satisfies InputSchema;

export default class WeatherEdge extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Compare our Kuru book with the Polymarket-implied fair value for each strike (from the maker snapshot when fresh, else the plugin's own Polymarket read), after Kuru's taker fee. A cross-venue price gap, not a forecast.";
  static override examples = ["<%= config.bin %> weather edge taipei --json", "<%= config.bin %> weather edge tokyo --min-gap 0.05 --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "weather:edge";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const city = needCity(i.city);
    const minGap = numArg(i.minGap, "--min-gap", 0.03, 0, 1);
    const env = await setupEnv(this.ctx, i.rpc);
    const v = await buildQuoteView(env, city, i.date);
    const open = v.ladder?.state === "open";

    const rows = v.rows.map((r) => {
      const fee = (r.takerFeeBps ?? 10) / 10_000;
      // Polymarket-based reference only (the maker snapshot's fair when it is Polymarket-based, else the live read).
      // A model fallback never drives a suggestion: no forecasting-edge claims.
      const pm = r.marketRef;
      const ask = r.book?.bestAsk ?? null;
      const bid = r.book?.bestBid ?? null;
      // Effective prices after Kuru's taker fee (taken from the output token).
      const yesCost = ask === null ? null : ask / (1 - fee); // AUSD per YES received
      const yesProceeds = bid === null ? null : bid * (1 - fee); // AUSD received per YES sold
      const yesCheap = pm === null || yesCost === null ? null : round3(pm - yesCost); // buy YES / sell NO
      const yesRich = pm === null || yesProceeds === null ? null : round3(yesProceeds - pm); // sell YES / buy NO
      let suggestion: string | null = null;
      if (open && r.canonical && !r.observedLocked) {
        if (yesCheap !== null && yesCheap >= minGap && (yesRich === null || yesCheap >= yesRich)) {
          suggestion = `mm weather buy ${city.key} --date ${v.date} --strike ${r.strikeC} --side yes --amount 10 --max-price ${ask}`;
        } else if (yesRich !== null && yesRich >= minGap) {
          suggestion = `mm weather buy ${city.key} --date ${v.date} --strike ${r.strikeC} --side no --amount 10 --max-price ${round3(1 - (bid as number) * (1 - fee))}`;
        }
      }
      return {
        strike: r.strike,
        strikeC: r.strikeC,
        bestBid: bid,
        bestAsk: ask,
        fairValue: r.fairValue,
        fairValueSource: r.fairValueSource,
        reference: pm,
        referenceSource: r.marketRefSource,
        polymarketImplied: r.polymarketImplied,
        yesCheapVsPolymarket: yesCheap,
        yesRichVsPolymarket: yesRich,
        observedLocked: r.observedLocked,
        guardrail: r.guardrail,
        canonical: r.canonical,
        suggestion,
      };
    });
    const ranked = [...rows].sort((a, b) => Math.max(b.yesCheapVsPolymarket ?? -9, b.yesRichVsPolymarket ?? -9) - Math.max(a.yesCheapVsPolymarket ?? -9, a.yesRichVsPolymarket ?? -9));

    return {
      city: v.city,
      station: v.station,
      date: v.date,
      ladder: v.ladder,
      polymarket: v.polymarket,
      makerSnapshot: v.makerSnapshot,
      guardrailModel: v.guardrailModel,
      observed: v.observed,
      minGap,
      rows: ranked,
      definitions: {
        reference: "The Polymarket-implied P(Tmax >= k) the gap is measured against: the maker snapshot's fair value when it is fresh and Polymarket-based (referenceSource maker-snapshot), else the plugin's own live Polymarket read (polymarket-live). Never a model.",
        yesCheapVsPolymarket: "reference minus our best ask grossed up for the taker fee. Positive: YES on our book costs less than the Polymarket-implied probability (also how cheaply NO can be sold).",
        yesRichVsPolymarket: "Our best bid net of the taker fee minus reference. Positive: YES sells (or NO buys) on our book above the Polymarket-implied probability.",
        guardrail: "GUARDRAIL ONLY (maker v0, else the plugin's cruder v0-lite). flag = it differs from the reference by more than 0.15. It never drives a suggestion.",
        observedLocked: "The observed METAR max so far already reached k, so YES is very likely to win (official settlement still pending). No suggestion is made for locked strikes.",
      },
      disclaimer: [
        "A gap between two venues is not a forecasting edge and not a promise of profit: Polymarket can be wrong, both books can move, and thin books mean small size.",
        ...DISCLAIMER,
      ],
      notes: [...v.notes, ...(open ? [] : ["The ladder is not open, so no trade is suggested."])],
      ...envSummary(env),
    };
  }

  override successHint(d: Record<string, unknown>): string {
    const n = (d.rows as { suggestion: string | null }[]).filter((r) => r.suggestion).length;
    return `${n} strike(s) with a gap >= ${String(d.minGap)} vs Polymarket-implied (testnet; not a forecast)`;
  }
}
