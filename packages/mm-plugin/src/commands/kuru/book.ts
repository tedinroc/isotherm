import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { F, envSummary, numArg, optAddress, setupEnv, fail } from "../../lib/cmd.js";
import { humanBook, readL2, scanOpenOrders, erc20Abi } from "../../lib/kuru.js";
import { marginBalance, marketOrFail, NATIVE, symbolOf } from "../../lib/kurucmd.js";
import { fmtUnits } from "../../lib/util.js";
import { priceUToString } from "../../lib/plan.js";

const inputs = {
  market: { type: InputFieldType.Text, flag: "market", message: "Kuru v1 market (OrderBook) address", required: true, index: 0 },
  depth: { type: InputFieldType.Text, flag: "depth", message: "Price levels per side (default 10)", required: false, prompt: false },
  address: F.address(),
  rpc: F.rpc(),
} satisfies InputSchema;

export default class KuruBook extends PluginCommand<Record<string, unknown>> {
  static override description = "Read any Kuru v1 order book on Monad testnet: market params, L2 depth, and your open orders and MarginAccount balances.";
  static override examples = ["<%= config.bin %> kuru book 0x… --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "kuru:book";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const market = optAddress(i.market, "market");
    if (!market) fail("KURU_BAD_INPUT", "market is required", "mm kuru book 0x…");
    const env = await setupEnv(this.ctx, i.rpc, i.address);
    const p = await marketOrFail(env, market as Address);
    const depth = numArg(i.depth, "--depth", 10, 1, 100);
    const [l2, baseSym, quoteSym] = await Promise.all([readL2(env.reader.client, market as Address), symbolOf(env, p.base), symbolOf(env, p.quote)]);
    let mine: Record<string, unknown> | null = null;
    if (env.self) {
      const me = env.self;
      const [orders, mBase, mQuote, wBase, wQuote] = await Promise.all([
        scanOpenOrders(env.reader.client, env.dep.multicall3, market as Address, me),
        marginBalance(env, me, p.base),
        marginBalance(env, me, p.quote),
        p.base.toLowerCase() === NATIVE ? env.reader.client.getBalance({ address: me }) : (env.reader.client.readContract({ address: p.base, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as Promise<bigint>),
        p.quote.toLowerCase() === NATIVE ? env.reader.client.getBalance({ address: me }) : (env.reader.client.readContract({ address: p.quote, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as Promise<bigint>),
      ]);
      mine = {
        address: me,
        openOrders: orders.map((o) => ({
          id: o.id.toString(),
          side: o.isBuy ? "buy" : "sell",
          price: priceUToString(o.priceU, p.pricePrecision),
          size: fmtUnits((o.sizeU * 10n ** p.baseDecimals) / p.sizePrecision, Number(p.baseDecimals)),
        })),
        marginAccount: { [baseSym]: fmtUnits(mBase, Number(p.baseDecimals)), [quoteSym]: fmtUnits(mQuote, Number(p.quoteDecimals)) },
        wallet: { [baseSym]: fmtUnits(wBase, Number(p.baseDecimals)), [quoteSym]: fmtUnits(wQuote, Number(p.quoteDecimals)) },
        note: "Open orders are scanned over the last 300 order ids.",
      };
    }
    return {
      market,
      pair: `${baseSym}/${quoteSym}`,
      params: {
        base: p.base,
        quote: p.quote,
        baseDecimals: Number(p.baseDecimals),
        quoteDecimals: Number(p.quoteDecimals),
        pricePrecision: p.pricePrecision.toString(),
        sizePrecision: p.sizePrecision.toString(),
        tick: priceUToString(p.tickSize, p.pricePrecision),
        minSize: fmtUnits((p.minSize * 10n ** p.baseDecimals) / p.sizePrecision, Number(p.baseDecimals)),
        maxSize: fmtUnits((p.maxSize * 10n ** p.baseDecimals) / p.sizePrecision, Number(p.baseDecimals)),
        takerFeeBps: Number(p.takerFeeBps),
        makerFeeBps: Number(p.makerFeeBps),
      },
      book: humanBook(l2, p, depth),
      mine,
      ...envSummary(env),
    };
  }
}
