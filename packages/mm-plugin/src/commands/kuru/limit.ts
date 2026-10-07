import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, parseEventLogs, type Address } from "viem";
import { F, ensureAllowance, envSummary, fail, numArg, optAddress, runner, setupEnv } from "../../lib/cmd.js";
import { baseToSizeU, erc20Abi, marginAccountAbi, orderBookAbi, sizeUToBase } from "../../lib/kuru.js";
import { marginBalance, marketOrFail, NATIVE, symbolOf } from "../../lib/kurucmd.js";
import { priceUToString } from "../../lib/plan.js";
import { fmtUnits, jsonSafe, parsePrice, parseUnitsStrict, shortErr } from "../../lib/util.js";

const inputs = {
  market: { type: InputFieldType.Text, flag: "market", message: "Kuru v1 market (OrderBook) address", required: true, index: 0 },
  side: {
    type: InputFieldType.Select,
    flag: "side",
    message: "Order side",
    required: true,
    options: [
      { value: "buy", label: "buy (bid): locks quote in your Kuru MarginAccount" },
      { value: "sell", label: "sell (ask): locks base in your Kuru MarginAccount" },
    ],
  },
  price: { type: InputFieldType.Text, flag: "price", message: "Limit price in quote per base, on the market tick (e.g. 0.455)", required: true },
  size: { type: InputFieldType.Text, flag: "size", message: "Order size in base tokens (e.g. 50)", required: true },
  take: { type: InputFieldType.Boolean, flag: "take", message: "Allow the order to cross the spread and fill as a taker (default: post-only)", required: false, prompt: false },
  noDeposit: { type: InputFieldType.Boolean, flag: "no-deposit", message: "Do not top up the MarginAccount automatically", required: false, prompt: false },
  approve: F.approve(),
  gasMult: F.gasMult(),
  dryRun: F.dryRun(),
  rpc: F.rpc(),
} satisfies InputSchema;

export default class KuruLimit extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Place a resting limit order on any Kuru v1 market on Monad testnet (post-only by default). Tops up your Kuru MarginAccount with exactly the shortfall first.";
  static override examples = [
    "<%= config.bin %> kuru limit 0x… --side buy --price 0.42 --size 50 --json",
    "<%= config.bin %> kuru limit 0x… --side sell --price 0.58 --size 25 --dry-run --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "kuru:limit";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const market = optAddress(i.market, "market") as Address;
    if (!market) fail("KURU_BAD_INPUT", "market is required", "mm kuru limit 0x… --side buy --price 0.4 --size 10");
    const env = await setupEnv(this.ctx, i.rpc);
    if (!env.self) fail("ISOTHERM_NO_WALLET", "No wallet selected in mm.", "Run `mm init` first.");
    const me = env.self as Address;
    const p = await marketOrFail(env, market);
    if (p.base.toLowerCase() === NATIVE || p.quote.toLowerCase() === NATIVE)
      fail("KURU_NATIVE_UNSUPPORTED", "Markets with native MON as base or quote are not supported by this plugin version.", "Use an ERC-20/ERC-20 market.");
    const side = String(i.side) as "buy" | "sell";
    const isBuy = side === "buy";

    let priceU: bigint, base: bigint;
    try {
      priceU = parsePrice(String(i.price), Number(p.pricePrecision), "price");
      base = parseUnitsStrict(String(i.size), Number(p.baseDecimals), "size");
    } catch (e) {
      return fail("KURU_BAD_INPUT", shortErr(e), `Price has at most ${p.pricePrecision.toString().length - 1} decimals; size at most ${p.baseDecimals} decimals.`);
    }
    if (priceU <= 0n || priceU >= 2n ** 32n) fail("KURU_BAD_INPUT", "price out of range", "Use a positive price.");
    if (priceU % p.tickSize !== 0n) {
      const lo = (priceU / p.tickSize) * p.tickSize;
      fail("KURU_OFF_TICK", `price ${String(i.price)} is not on the ${priceUToString(p.tickSize, p.pricePrecision)} tick.`, `Nearest valid prices: ${priceUToString(lo, p.pricePrecision)} or ${priceUToString(lo + p.tickSize, p.pricePrecision)}.`);
    }
    const sizeU = baseToSizeU(base, p);
    if (sizeUToBase(sizeU, p) !== base) fail("KURU_BAD_INPUT", `size ${String(i.size)} is finer than the market's size precision.`, "Round the size.");
    if (sizeU < p.minSize || sizeU > p.maxSize)
      fail("KURU_BAD_SIZE", `size must be between ${fmtUnits(sizeUToBase(p.minSize, p), Number(p.baseDecimals))} and ${fmtUnits(sizeUToBase(p.maxSize, p), Number(p.baseDecimals))}.`, "Adjust --size.");

    const token = isBuy ? p.quote : p.base;
    const dec = Number(isBuy ? p.quoteDecimals : p.baseDecimals);
    const needed = isBuy ? (sizeU * priceU * 10n ** p.quoteDecimals + p.sizePrecision * p.pricePrecision - 1n) / (p.sizePrecision * p.pricePrecision) : base;
    const [inMargin, inWallet, sym, baseSym, quoteSym] = await Promise.all([
      marginBalance(env, me, token),
      env.reader.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [me] }) as Promise<bigint>,
      symbolOf(env, token),
      symbolOf(env, p.base),
      symbolOf(env, p.quote),
    ]);
    const shortfall = needed > inMargin ? needed - inMargin : 0n;
    if (shortfall > 0n && i.noDeposit) fail("KURU_INSUFFICIENT_MARGIN", `Order locks ${fmtUnits(needed, dec)} ${sym}; MarginAccount holds ${fmtUnits(inMargin, dec)}.`, "Drop --no-deposit to top up automatically.");
    if (shortfall > inWallet) fail("KURU_INSUFFICIENT_FUNDS", `Need ${fmtUnits(shortfall, dec)} more ${sym} in the MarginAccount but the wallet holds ${fmtUnits(inWallet, dec)}.`, "Fund the wallet first.");
    const postOnly = !i.take;
    const plan = {
      market,
      pair: `${baseSym}/${quoteSym}`,
      side,
      price: priceUToString(priceU, p.pricePrecision),
      size: fmtUnits(base, Number(p.baseDecimals)),
      postOnly,
      locks: `${fmtUnits(needed, dec)} ${sym}`,
      marginBefore: `${fmtUnits(inMargin, dec)} ${sym}`,
      depositFirst: shortfall > 0n ? `${fmtUnits(shortfall, dec)} ${sym}` : null,
      makerFeeBps: Number(p.makerFeeBps),
    };
    if (i.dryRun) return { plan, dryRun: true, ...envSummary(env) };

    const run = runner(this, io, env, "kuru:limit", numArg(i.gasMult, "--gas-mult", 1.15, 1.0, 3.0));
    if (shortfall > 0n) {
      await ensureAllowance(run, env, token, env.dep.marginAccount, shortfall, i.approve, `${sym} for the Kuru MarginAccount`);
      await run.send({
        label: `Kuru MarginAccount deposit ${fmtUnits(shortfall, dec)} ${sym}`,
        to: env.dep.marginAccount,
        data: encodeFunctionData({ abi: marginAccountAbi, functionName: "deposit", args: [me, token, shortfall] }),
      });
    }
    const data = encodeFunctionData({ abi: orderBookAbi, functionName: isBuy ? "addBuyOrder" : "addSellOrder", args: [Number(priceU), sizeU, postOnly] });
    const { result, receipt } = await run.send({ label: `Kuru ${side} ${plan.size} ${baseSym} @ ${plan.price} ${quoteSym}${postOnly ? " (post-only)" : ""}`, to: market, data });
    const logs = receipt ? parseEventLogs({ abi: orderBookAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === market.toLowerCase()) }) : [];
    const created = logs.filter((l) => l.eventName === "OrderCreated").map((l) => jsonSafe(l.args));
    const trades = logs.filter((l) => l.eventName === "Trade").map((l) => jsonSafe(l.args));
    const orderId = (created[0] as { orderId?: string } | undefined)?.orderId ?? null;
    return {
      plan,
      orderId,
      orderCreated: created,
      fills: trades,
      tx: result.hash,
      steps: run.steps,
      cancelWith: orderId ? `mm kuru cancel ${market} --order ${orderId}` : null,
      ...envSummary(env),
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return d.dryRun ? "dry run: nothing signed" : `order ${String(d.orderId ?? "?")} placed (${String(d.tx ?? "")})`;
  }
}
