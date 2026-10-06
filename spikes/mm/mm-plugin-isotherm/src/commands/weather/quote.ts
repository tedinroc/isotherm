import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { isAddress, type Address } from "viem";
import {
  AUSD,
  CITIES,
  KURU_ROUTER,
  MONAD_TESTNET_ID,
  chainReader,
  forecastTmax,
  formatUnits6,
  ladder,
  readAusd,
  resolveCity,
  shortErr,
} from "../../lib/isotherm.js";

const inputs = {
  city: {
    type: InputFieldType.Text,
    flag: "city",
    message: `City (${Object.keys(CITIES).join(", ")})`,
    required: true,
    index: 0,
  },
  address: {
    type: InputFieldType.Text,
    flag: "address",
    message: "Holder address for the AUSD balance (defaults to the selected mm wallet)",
    required: false,
    prompt: false,
    index: 1,
  },
  rpc: {
    type: InputFieldType.Text,
    flag: "rpc",
    message: "Override Monad testnet RPC URL (skips the mm gateway)",
    required: false,
    prompt: false,
    index: 2,
  },
} satisfies InputSchema;

export default class WeatherQuote extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Quote an Isotherm Tmax strike ladder for a city and read Monad testnet state (AUSD collateral) for the wallet.";
  static override examples = [
    "<%= config.bin %> weather quote taipei --json",
    "<%= config.bin %> weather quote tokyo --address 0x... --json",
  ];
  // Read-only: usable before `mm login` (falls back to a direct Monad RPC).
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "weather:quote";

  async execute(io: CommandIO) {
    const { city: rawCity, address: rawAddress, rpc } = await io.resolveInputs(inputs);
    const city = resolveCity(String(rawCity ?? ""));
    if (!city) {
      throw new CommandError(
        "ISOTHERM_UNKNOWN_CITY",
        `Unknown city '${rawCity}'.`,
        `Use one of: ${Object.keys(CITIES).join(", ")}.`,
      );
    }

    // wallet-read: selected wallet from the host's local wallet state.
    let holder: Address | undefined;
    let holderSource = "none";
    if (rawAddress) {
      if (!isAddress(String(rawAddress))) {
        throw new CommandError("ISOTHERM_BAD_ADDRESS", `'${rawAddress}' is not an address.`, "Pass a 0x address.");
      }
      holder = rawAddress as Address;
      holderSource = "flag";
    } else {
      try {
        const st = this.ctx.walletStateManager.read();
        const all = [...(st.byokWallets ?? []), ...(st.remoteWallets ?? [])];
        const a = all[0]?.address;
        if (a) {
          holder = a as Address;
          holderSource = "mm-wallet-state";
        }
      } catch (e) {
        holderSource = `wallet-state-unavailable: ${shortErr(e)}`;
      }
    }

    const t0 = Date.now();
    const reader = await chainReader(() => this.ctx.publicClient(MONAD_TESTNET_ID), rpc ? String(rpc) : undefined);
    const [chainId, blockNumber, ausd, fc] = await Promise.all([
      reader.client.getChainId(),
      reader.client.getBlockNumber(),
      readAusd(reader.client, holder),
      forecastTmax(city),
    ]);
    const routerCode = await reader.client.getCode({ address: KURU_ROUTER });
    const readMs = Date.now() - t0;

    return {
      city: city.name,
      station: city.station,
      date: fc.date,
      forecastTmaxC: fc.tmaxC,
      forecastSource: fc.source,
      ladder: ladder(fc.tmaxC),
      chain: {
        chainId,
        blockNumber: blockNumber.toString(),
        rpcSource: reader.source,
        ...(reader.rpcUrl ? { rpcUrl: reader.rpcUrl } : {}),
        ...(reader.gatewayError ? { gatewayError: reader.gatewayError } : {}),
        readMs,
      },
      collateral: {
        token: AUSD,
        symbol: ausd.symbol,
        decimals: ausd.decimals,
        totalSupply: formatUnits6(ausd.totalSupply, ausd.decimals),
        holder: holder ?? null,
        holderSource,
        balance: ausd.balance === undefined ? null : formatUnits6(ausd.balance, ausd.decimals),
      },
      venue: { kuruRouter: KURU_ROUTER, routerDeployed: !!routerCode && routerCode !== "0x" },
      note: "Placeholder pricing: N(forecast, 1.6C) with METAR integer rounding; not the production model.",
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return `Isotherm ${String(d.city)} ${String(d.date)}: forecast Tmax ${String(d.forecastTmaxC)}C`;
  }
}
