import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { cityByStation, resolveCity } from "../../lib/config.js";
import { F, envSummary, fail, numArg, setupEnv } from "../../lib/cmd.js";
import { listLadderRefs, readBooks, readLadder, resolveMarket, type Ladder } from "../../lib/isotherm.js";
import { humanBook } from "../../lib/kuru.js";
import { isoOf, localDate, parseDateArg } from "../../lib/weather.js";
import { isoUtc } from "../../lib/util.js";

const inputs = {
  city: F.city(0, false),
  date: F.date(),
  limit: { type: InputFieldType.Text, flag: "limit", message: "How many of the most recent ladders to scan (default 30)", required: false, prompt: false },
  all: { type: InputFieldType.Boolean, flag: "all", message: "Include ladders that are already settled or void", required: false, prompt: false },
  rpc: F.rpc(),
} satisfies InputSchema;

export default class WeatherMarkets extends PluginCommand<Record<string, unknown>> {
  static override description =
    "List Isotherm Tmax strike ladders on Monad testnet: state, close time, and each strike's canonical Kuru YES/AUSD book with best bid/ask.";
  static override examples = ["<%= config.bin %> weather markets --json", "<%= config.bin %> weather markets taipei --date tomorrow --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "weather:markets";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const city = i.city ? resolveCity(String(i.city)) : undefined;
    if (i.city && !city) fail("ISOTHERM_UNKNOWN_CITY", `Unknown city '${i.city}'.`, "Use taipei, tokyo, shenzhen or seoul.");
    const env = await setupEnv(this.ctx, i.rpc);
    const nowS = env.nowS;
    const limit = numArg(i.limit, "--limit", 30, 1, 200);

    let wanted: { station: string; date: number }[];
    if (city && i.date) {
      wanted = [{ station: city.station, date: parseDateArg(String(i.date), city) as number }];
    } else {
      const refs = await listLadderRefs(env.reader.client, env.dep, env.c, limit);
      wanted = refs.filter((r) => !city || r.station === city.station);
      if (i.date) {
        const d = String(i.date);
        wanted = wanted.filter((r) => {
          const c = cityByStation(r.station);
          try {
            return c ? parseDateArg(d, c) === r.date : false;
          } catch {
            return false;
          }
        });
      }
    }
    const seen = new Set<string>();
    const ladders: Ladder[] = [];
    for (const w of wanted.reverse()) {
      const key = `${w.station}:${w.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const l = await readLadder(env.reader.client, env.dep, env.c, w.station, w.date, nowS);
      if (l && (i.all || !["settled", "void"].includes(l.state) || (city && i.date))) ladders.push(l);
    }

    const out = [];
    for (const l of ladders) {
      const checks = await Promise.all(l.series.map((s) => resolveMarket(env.reader.client, env.dep, env.c, s)));
      const books = await readBooks(env.reader.client, env.dep, checks.map((m) => m.market).filter((m): m is `0x${string}` => !!m));
      let bi = 0;
      const c = cityByStation(l.station);
      out.push({
        city: c?.name ?? l.station,
        station: l.station,
        date: isoOf(l.date),
        state: l.state,
        closeTime: isoUtc(l.closeTime),
        dayEnd: isoUtc(l.dayEnd),
        minutesToClose: l.state === "open" ? Math.round((l.closeTime - nowS) / 60) : 0,
        result: l.result.status === "none" ? null : { status: l.result.status, tmaxC: l.result.tmaxC, ...(l.result.finalAt ? { redeemableFrom: isoUtc(l.result.finalAt) } : {}) },
        strikes: l.series.map((s, k) => {
          const m = checks[k];
          const book = m.market ? books[bi++] : null;
          const hb = book && m.params ? humanBook(book, m.params, 1) : null;
          return {
            strike: `Tmax>=${s.strikeC}C`,
            strikeC: s.strikeC,
            seriesId: s.seriesId,
            yes: s.yes,
            no: s.no,
            market: m.market,
            marketSource: m.source,
            canonical: m.canonical,
            ...(m.problems.length ? { marketProblems: m.problems } : {}),
            bestBid: hb?.bestBid ?? null,
            bestAsk: hb?.bestAsk ?? null,
          };
        }),
      });
    }
    return {
      chainId: 10143,
      network: "Monad testnet (faucet AUSD only, no real money)",
      ...envSummary(env),
      today: city ? isoOf(localDate(Date.now(), city.utcOffsetMin)) : undefined,
      ladders: out,
      count: out.length,
      notes: [
        "Each strike is a fully collateralized YES/NO pair (1 AUSD per complete set). YES pays 1 AUSD iff the official integer METAR Tmax >= k; a void pays 0.5/0.5.",
        "Only YES has a Kuru book; NO is bought by minting a set and selling the YES leg (weather buy --side no).",
        ...(out.length ? [] : [i.all ? "This deployment has no ladders matching the filter yet." : "No active ladders found. Use --all to include settled/void ladders."]),
      ],
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return `${String(d.count)} ladder(s)`;
  }
}
