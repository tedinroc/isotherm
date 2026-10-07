import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address, Hex } from "viem";
import { cityByStation, resolveCity } from "../../lib/config.js";
import { F, envSummary, fail, numArg, setupEnv } from "../../lib/cmd.js";
import { listLadderRefs, readBooks, readLadder, resolveMarket, tokenBalances, type Ladder } from "../../lib/isotherm.js";
import { erc20Abi, humanBook } from "../../lib/kuru.js";
import { isoOf } from "../../lib/weather.js";
import { fmtAllowance, fmtUnits, isoUtc } from "../../lib/util.js";

const inputs = {
  city: F.city(0, false),
  address: F.address(),
  limit: { type: InputFieldType.Text, flag: "limit", message: "How many of the most recent ladders to scan (default 40)", required: false, prompt: false },
  rpc: F.rpc(),
} satisfies InputSchema;

export default class WeatherPositions extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Your Isotherm YES/NO positions on Monad testnet: balances per strike, book value or redeemable payout, plus AUSD/MON balances and Zap allowance.";
  static override examples = ["<%= config.bin %> weather positions --json", "<%= config.bin %> weather positions --address 0x... --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "weather:positions";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const city = i.city ? resolveCity(String(i.city)) : undefined;
    if (i.city && !city) fail("ISOTHERM_UNKNOWN_CITY", `Unknown city '${i.city}'.`, "Use taipei, tokyo, shenzhen or seoul.");
    const env = await setupEnv(this.ctx, i.rpc, i.address);
    if (!env.self) fail("ISOTHERM_NO_WALLET", `No wallet to read (${env.selfSource}).`, "Pass --address 0x…, or run `mm init`.");
    const me = env.self as Address;
    const client = env.reader.client;
    const nowS = env.nowS;
    const limit = numArg(i.limit, "--limit", 40, 1, 300);

    const refs = (await listLadderRefs(client, env.dep, env.c, limit)).filter((r) => !city || r.station === city.station);
    const seen = new Set<string>();
    const ladders: Ladder[] = [];
    for (const r of refs) {
      const k = `${r.station}:${r.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const l = await readLadder(client, env.dep, env.c, r.station, r.date, nowS);
      if (l) ladders.push(l);
    }
    const all = ladders.flatMap((l) => l.series.map((s) => ({ l, s })));
    const bals = await tokenBalances(client, env.dep, me, all.flatMap(({ s }) => [s.yes, s.no]));
    const held = all.map((x, j) => ({ ...x, yes: bals[2 * j], no: bals[2 * j + 1] })).filter((x) => x.yes > 0n || x.no > 0n);

    const positions = [];
    let redeemableTotal = 0n;
    for (const h of held) {
      const { l, s } = h;
      const redeemOpen = (l.result.status === "settled" || l.result.status === "void") && (l.result.finalAt === null || l.result.finalAt <= nowS);
      let payout: bigint | null = null;
      if (redeemOpen) {
        payout = (await client.readContract({ address: env.dep.vault, abi: env.c.vaultAbi, functionName: "previewRedeem", args: [s.seriesId, h.yes, h.no] })) as bigint;
        redeemableTotal += payout;
      }
      let mark: { bestBid: number | null; bestAsk: number | null; markAusd: string | null } | null = null;
      if (!redeemOpen) {
        const m = await resolveMarket(client, env.dep, env.c, s);
        if (m.market && m.params) {
          const [b] = await readBooks(client, env.dep, [m.market]);
          const hb = b ? humanBook(b, m.params, 1) : null;
          const bid = hb?.bestBid ?? null;
          const ask = hb?.bestAsk ?? null;
          // conservative mark: YES at the bid, NO at 1 - ask (what you could get right now, before fees)
          const v = (bid !== null ? (Number(h.yes) / 1e6) * bid : 0) + (ask !== null ? (Number(h.no) / 1e6) * (1 - ask) : 0);
          mark = { bestBid: bid, bestAsk: ask, markAusd: bid === null && ask === null ? null : v.toFixed(6) };
        }
      }
      const pairs = h.yes < h.no ? h.yes : h.no;
      positions.push({
        city: cityByStation(s.station)?.name ?? s.station,
        station: s.station,
        date: isoOf(s.date),
        strike: `Tmax>=${s.strikeC}C`,
        strikeC: s.strikeC,
        seriesId: s.seriesId,
        yes: fmtUnits(h.yes, 6),
        no: fmtUnits(h.no, 6),
        ladderState: l.state,
        result: l.result.status === "none" ? null : { status: l.result.status, tmaxC: l.result.tmaxC, ...(l.result.finalAt ? { redeemableFrom: isoUtc(l.result.finalAt) } : {}) },
        redeemableAusd: payout === null ? null : fmtUnits(payout, 6),
        mark,
        nextAction: redeemOpen
          ? payout && payout > 0n
            ? `mm weather redeem ${cityByStation(s.station)?.key ?? s.station} --date ${isoOf(s.date)}`
            : "losing side: nothing to redeem"
          : pairs > 0n
            ? `hold, or merge ${fmtUnits(pairs, 6)} YES+NO pairs back to AUSD: mm weather redeem ${cityByStation(s.station)?.key ?? s.station} --date ${isoOf(s.date)} --merge`
            : l.state === "open"
              ? "hold, or sell: mm weather sell …"
              : "wait for settlement",
      });
    }

    const [ausd, mon, zapAllowance] = await Promise.all([
      client.readContract({ address: env.dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as Promise<bigint>,
      client.getBalance({ address: me }),
      env.dep.zap ? (client.readContract({ address: env.dep.ausd, abi: erc20Abi, functionName: "allowance", args: [me, env.dep.zap] }) as Promise<bigint>) : Promise.resolve(0n),
    ]);
    return {
      address: me,
      addressSource: env.selfSource,
      balances: { AUSD: fmtUnits(ausd, 6), MON: fmtUnits(mon, 18), ausdAllowanceToZap: fmtAllowance(zapAllowance, 6) },
      positions,
      redeemableAusdTotal: fmtUnits(redeemableTotal, 6),
      scannedLadders: ladders.length,
      ...envSummary(env),
      notes: [
        "Testnet faucet AUSD only. Marks use the current top of our Kuru book before fees and are not a promise of execution.",
        ...(ausd === 0n ? [`No AUSD: claim testnet AUSD from the faucet contract ${env.dep.ausdFaucet} (requestFunds(address), 10k AUSD, global 60 s cooldown).`] : []),
        ...(mon === 0n ? ["No MON for gas: get testnet MON at https://faucet.monad.xyz (human step)."] : []),
      ],
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return `${(d.positions as unknown[]).length} position(s); redeemable ${String(d.redeemableAusdTotal)} AUSD`;
  }
}

export type _Hex = Hex;
