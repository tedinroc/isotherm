import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { F, envSummary, needCity, setupEnv } from "../../lib/cmd.js";
import { buildQuoteView, DISCLAIMER } from "../../lib/view.js";

const inputs = { city: F.city(0, true), date: F.date(), rpc: F.rpc() } satisfies InputSchema;

export default class WeatherQuote extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Per strike of a city's Tmax ladder: our Kuru book bid/ask, the fair value (the maker snapshot's Polymarket-implied P(Tmax >= k), else the plugin's own Polymarket read), a clearly labelled guardrail model (not a forecast), and the observed max so far.";
  static override examples = ["<%= config.bin %> weather quote taipei --json", "<%= config.bin %> weather quote tokyo --date 2026-10-09 --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "weather:quote";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const city = needCity(i.city);
    const env = await setupEnv(this.ctx, i.rpc);
    const v = await buildQuoteView(env, city, i.date);
    return {
      ...v,
      fidelity: city.fidelity,
      ...envSummary(env),
      disclaimer: DISCLAIMER,
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return `Isotherm ${String(d.city)} ${String(d.date)}: ${(d.rows as unknown[]).length} strikes`;
  }
}
