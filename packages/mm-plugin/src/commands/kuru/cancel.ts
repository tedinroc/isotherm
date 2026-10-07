import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, parseEventLogs, type Address } from "viem";
import { F, envSummary, fail, numArg, optAddress, runner, setupEnv } from "../../lib/cmd.js";
import { marginAccountAbi, orderBookAbi, scanOpenOrders } from "../../lib/kuru.js";
import { marginBalance, marketOrFail, NATIVE, parseIds, symbolOf } from "../../lib/kurucmd.js";
import { priceUToString } from "../../lib/plan.js";
import { fmtUnits, jsonSafe } from "../../lib/util.js";

const inputs = {
  market: { type: InputFieldType.Text, flag: "market", message: "Kuru v1 market (OrderBook) address", required: true, index: 0 },
  order: { type: InputFieldType.Text, flag: "order", message: "Order id(s) to cancel, comma-separated", required: false, prompt: false },
  all: { type: InputFieldType.Boolean, flag: "all", message: "Cancel every open order of yours on this market", required: false, prompt: false },
  withdraw: { type: InputFieldType.Boolean, flag: "withdraw", message: "Afterwards withdraw all base and quote from your Kuru MarginAccount to the wallet", required: false, prompt: false },
  gasMult: F.gasMult(),
  dryRun: F.dryRun(),
  rpc: F.rpc(),
} satisfies InputSchema;

export default class KuruCancel extends PluginCommand<Record<string, unknown>> {
  static override description = "Cancel your resting orders on any Kuru v1 market on Monad testnet (by id or --all), optionally withdrawing the freed MarginAccount funds.";
  static override examples = ["<%= config.bin %> kuru cancel 0x… --order 7 --json", "<%= config.bin %> kuru cancel 0x… --all --withdraw --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "kuru:cancel";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const market = optAddress(i.market, "market") as Address;
    if (!market) fail("KURU_BAD_INPUT", "market is required", "mm kuru cancel 0x… --all");
    const env = await setupEnv(this.ctx, i.rpc);
    if (!env.self) fail("ISOTHERM_NO_WALLET", "No wallet selected in mm.", "Run `mm init` first.");
    const me = env.self as Address;
    const p = await marketOrFail(env, market);
    const requested = parseIds(i.order);
    if (!requested.length && !i.all && !i.withdraw) fail("KURU_BAD_INPUT", "Nothing to do: pass --order <ids>, --all, or --withdraw.", "Example: mm kuru cancel 0x… --all");

    const open = await scanOpenOrders(env.reader.client, env.dep.multicall3, market, me);
    const openIds = new Set(open.map((o) => o.id));
    let ids: bigint[] = [];
    const notOpen: string[] = [];
    if (i.all) ids = open.map((o) => o.id);
    for (const id of requested) {
      if (openIds.has(id)) {
        if (!ids.includes(id)) ids.push(id);
      } else notOpen.push(id.toString());
    }
    if (notOpen.length && !ids.length && !i.withdraw)
      fail("KURU_NOT_YOUR_OPEN_ORDER", `Order(s) ${notOpen.join(", ")} are not open orders of ${me} on this market (filled, cancelled, or someone else's).`, `See: mm kuru book ${market}`);
    const plan = {
      market,
      cancel: open.filter((o) => ids.includes(o.id)).map((o) => ({ id: o.id.toString(), side: o.isBuy ? "buy" : "sell", price: priceUToString(o.priceU, p.pricePrecision) })),
      skipped: notOpen,
      withdraw: Boolean(i.withdraw),
    };
    if (i.dryRun) return { plan, dryRun: true, ...envSummary(env) };
    if (!ids.length && !i.withdraw) return { plan, cancelled: [], note: "No open orders to cancel.", ...envSummary(env) };

    const run = runner(this, io, env, "kuru:cancel", numArg(i.gasMult, "--gas-mult", 1.15, 1.0, 3.0));
    let cancelled: unknown[] = [];
    let tx: string | null = null;
    if (ids.length) {
      const { result, receipt } = await run.send({
        label: `Kuru cancel ${ids.length} order(s) on ${market.slice(0, 10)}…`,
        to: market,
        data: encodeFunctionData({ abi: orderBookAbi, functionName: "batchCancelOrdersNoRevert", args: [ids.map((x) => Number(x))] }),
      });
      tx = result.hash;
      const logs = receipt ? parseEventLogs({ abi: orderBookAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === market.toLowerCase()) }) : [];
      cancelled = logs.filter((l) => l.eventName === "OrdersCanceled").map((l) => jsonSafe(l.args));
    }
    let withdrawn: Record<string, string> | null = null;
    if (i.withdraw) {
      const tokens = [p.base, p.quote].filter((t) => t.toLowerCase() !== NATIVE);
      const before = await Promise.all(tokens.map((t) => marginBalance(env, me, t)));
      if (before.some((b) => b > 0n)) {
        await run.send({
          label: "Kuru MarginAccount withdraw all (base + quote)",
          to: env.dep.marginAccount,
          data: encodeFunctionData({ abi: marginAccountAbi, functionName: "batchWithdrawMaxTokens", args: [tokens] }),
          gasMult: 1.1,
        });
      }
      withdrawn = {};
      for (const [k, t] of tokens.entries()) withdrawn[await symbolOf(env, t)] = fmtUnits(before[k], Number(t === p.base ? p.baseDecimals : p.quoteDecimals));
    }
    const stillOpen = await scanOpenOrders(env.reader.client, env.dep.multicall3, market, me);
    return { plan, tx, cancelled, withdrawn, openOrdersAfter: stillOpen.map((o) => o.id.toString()), steps: run.steps, ...envSummary(env) };
  }

  override successHint(d: Record<string, unknown>): string {
    return d.dryRun ? "dry run: nothing signed" : `${(d.cancelled as unknown[] | undefined)?.length ?? 0} cancel event(s)`;
  }
}
