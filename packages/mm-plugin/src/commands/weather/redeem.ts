import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, parseEventLogs, type Address } from "viem";
import { F, envSummary, fail, intArg, needCity, numArg, runner, setupEnv } from "../../lib/cmd.js";
import { listLadderRefs, readLadder, tokenBalances, type Ladder } from "../../lib/isotherm.js";
import { isoOf, parseDateArg } from "../../lib/weather.js";
import { fmtUnits, isoUtc, jsonSafe } from "../../lib/util.js";

const inputs = {
  city: F.city(0, true),
  date: F.date(),
  strike: { type: InputFieldType.Text, flag: "strike", message: "Only this strike (default: every strike you hold)", required: false, prompt: false },
  merge: { type: InputFieldType.Boolean, flag: "merge", message: "Before settlement: merge matching YES+NO pairs back into AUSD (vault.redeemSet)", required: false, prompt: false },
  burnLosers: { type: InputFieldType.Boolean, flag: "burn-losers", message: "Also send zero-payout redemptions (burns losing tokens; costs gas)", required: false, prompt: false },
  gasMult: F.gasMult(),
  dryRun: F.dryRun(),
  rpc: F.rpc(),
} satisfies InputSchema;

export default class WeatherRedeem extends PluginCommand<Record<string, unknown>> {
  static override description =
    "After settlement, redeem YES/NO for AUSD (YES pays 1 iff Tmax >= k, void pays 0.5/0.5). Before settlement, --merge turns YES+NO pairs back into AUSD.";
  static override examples = ["<%= config.bin %> weather redeem taipei --date 2026-10-08 --json", "<%= config.bin %> weather redeem taipei --merge --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "weather:redeem";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const city = needCity(i.city);
    const env = await setupEnv(this.ctx, i.rpc);
    if (!env.self) fail("ISOTHERM_NO_WALLET", "No wallet selected in mm.", "Run `mm init` first.");
    const me = env.self as Address;
    const client = env.reader.client;
    const nowS = env.nowS;
    const strike = i.strike ? intArg(i.strike, "strike") : undefined;
    const gasMult = numArg(i.gasMult, "--gas-mult", 1.1, 1.0, 3.0);

    const ladders: Ladder[] = [];
    if (i.date) {
      const l = await readLadder(client, env.dep, env.c, city.station, parseDateArg(String(i.date), city) as number, nowS);
      if (!l) fail("ISOTHERM_NO_LADDER", `No ${city.station} ladder on ${String(i.date)}.`, "List ladders with `mm weather markets --all`.");
      ladders.push(l as Ladder);
    } else {
      const refs = (await listLadderRefs(client, env.dep, env.c, 60)).filter((r) => r.station === city.station);
      for (const d of [...new Set(refs.map((r) => r.date))]) {
        const l = await readLadder(client, env.dep, env.c, city.station, d, nowS);
        if (l) ladders.push(l);
      }
    }

    type Action = { kind: "redeem" | "merge"; label: string; seriesId: `0x${string}`; strikeC: number; date: number; yes: bigint; no: bigint; payout: bigint };
    const actions: Action[] = [];
    const skipped: Record<string, unknown>[] = [];
    for (const l of ladders) {
      const series = l.series.filter((s) => strike === undefined || s.strikeC === strike);
      const bals = await tokenBalances(client, env.dep, me, series.flatMap((s) => [s.yes, s.no]));
      const redeemOpen = (l.result.status === "settled" || l.result.status === "void") && (l.result.finalAt === null || l.result.finalAt <= nowS);
      for (const [j, s] of series.entries()) {
        const yes = bals[2 * j];
        const no = bals[2 * j + 1];
        if (yes === 0n && no === 0n) continue;
        if (redeemOpen) {
          const payout = (await client.readContract({ address: env.dep.vault, abi: env.c.vaultAbi, functionName: "previewRedeem", args: [s.seriesId, yes, no] })) as bigint;
          if (payout === 0n && !i.burnLosers) {
            skipped.push({ strike: `Tmax>=${s.strikeC}C`, date: isoOf(s.date), yes: fmtUnits(yes, 6), no: fmtUnits(no, 6), reason: "losing side pays 0 (use --burn-losers to burn anyway)" });
            continue;
          }
          actions.push({ kind: "redeem", label: `Isotherm redeem Tmax>=${s.strikeC}C ${city.name} ${isoOf(s.date)}`, seriesId: s.seriesId, strikeC: s.strikeC, date: s.date, yes, no, payout });
        } else if (i.merge) {
          const pairs = yes < no ? yes : no;
          if (pairs === 0n) {
            skipped.push({ strike: `Tmax>=${s.strikeC}C`, date: isoOf(s.date), reason: "no YES+NO pairs to merge" });
            continue;
          }
          actions.push({ kind: "merge", label: `Isotherm merge ${fmtUnits(pairs, 6)} YES+NO Tmax>=${s.strikeC}C ${city.name} ${isoOf(s.date)}`, seriesId: s.seriesId, strikeC: s.strikeC, date: s.date, yes: pairs, no: pairs, payout: pairs });
        } else {
          skipped.push({
            strike: `Tmax>=${s.strikeC}C`,
            date: isoOf(s.date),
            yes: fmtUnits(yes, 6),
            no: fmtUnits(no, 6),
            reason:
              l.result.status === "none"
                ? `not settled yet (${l.state}; day ends ${isoUtc(l.dayEnd)})`
                : `settled; redemption opens ${l.result.finalAt ? isoUtc(l.result.finalAt) : "soon"}`,
          });
        }
      }
    }
    const plan = actions.map((a) => ({ kind: a.kind, strike: `Tmax>=${a.strikeC}C`, date: isoOf(a.date), yes: fmtUnits(a.yes, 6), no: fmtUnits(a.no, 6), expectedAusd: fmtUnits(a.payout, 6) }));
    if (!actions.length) return { wallet: me, plan, skipped, redeemedAusd: "0.000000", note: "Nothing to redeem or merge.", ...envSummary(env) };
    if (i.dryRun) return { wallet: me, plan, skipped, dryRun: true, ...envSummary(env) };

    const run = runner(this, io, env, "weather:redeem", gasMult);
    const results = [];
    let total = 0n;
    for (const a of actions) {
      const data =
        a.kind === "redeem"
          ? encodeFunctionData({ abi: env.c.vaultAbi, functionName: "redeem", args: [a.seriesId, a.yes, a.no] })
          : encodeFunctionData({ abi: env.c.vaultAbi, functionName: "redeemSet", args: [a.seriesId, a.yes] });
      const { result, receipt } = await run.send({ label: a.label, to: env.dep.vault, data });
      let paid = a.payout;
      if (receipt && a.kind === "redeem") {
        const ev = parseEventLogs({ abi: env.c.vaultAbi, logs: receipt.logs, eventName: "Redeemed" }) as unknown as { args: { payout?: bigint } }[];
        if (ev[0]?.args?.payout !== undefined) paid = ev[0].args.payout;
      }
      total += paid;
      results.push({ ...plan[results.length], tx: result.hash, paidAusd: fmtUnits(paid, 6) });
    }
    return { wallet: me, results: jsonSafe(results), skipped, redeemedAusd: fmtUnits(total, 6), steps: run.steps, ...envSummary(env) };
  }

  override successHint(d: Record<string, unknown>): string {
    return d.dryRun ? "dry run: nothing signed" : `received ${String(d.redeemedAusd)} AUSD`;
  }
}
