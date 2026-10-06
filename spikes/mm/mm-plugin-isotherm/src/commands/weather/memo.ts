import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { isAddress, stringToHex, type Address, type Hex } from "viem";
import { CITIES, MONAD_TESTNET_ID, forecastTmax, resolveCity, shortErr } from "../../lib/isotherm.js";

// Shape accepted by the host executor (see mm 7.0.0 wallet:send-transaction):
// { kind: "transaction", chainId, transaction: { to, data?, value?, gas?, ... }, intent? }
type ExecRequest = {
  kind: "transaction";
  chainId: number;
  transaction: { to: Address; data?: Hex; value?: bigint; gas?: bigint };
  intent?: { action: string; summary: string };
};
type ExecResult = {
  kind: string;
  hash?: string;
  status: string;
  failureCode?: string;
  failureDescription?: string;
  pendingJob?: { pollingId?: string };
};
type Executor = (req: ExecRequest, opts?: { signal?: AbortSignal; noAwait?: boolean; waitForReceipt?: boolean }) => Promise<ExecResult>;

const inputs = {
  city: {
    type: InputFieldType.Text,
    flag: "city",
    message: `City (${Object.keys(CITIES).join(", ")})`,
    required: true,
    index: 0,
  },
  to: {
    type: InputFieldType.Text,
    flag: "to",
    message: "Recipient of the 0-value memo tx (defaults to your own wallet)",
    required: false,
    prompt: false,
    index: 1,
  },
  gas: {
    type: InputFieldType.Text,
    flag: "gas",
    message: "Gas limit (Monad bills the limit; default 30000)",
    required: false,
    prompt: false,
    index: 2,
  },
  wait: {
    type: InputFieldType.Boolean,
    flag: "wait",
    message: "Wait for the on-chain receipt",
    required: false,
    prompt: false,
    index: 3,
  },
} satisfies InputSchema;

export default class WeatherMemo extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Submit a harmless 0-value Monad testnet tx carrying today's Isotherm forecast memo, via the Agent Wallet executor (policy-gated).";
  static override examples = ["<%= config.bin %> weather memo taipei --wait --json"];
  // Defaults kept: requiresAuth = true, requiresInit = true (the executor needs a session + wallet).
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "weather:memo";

  async execute(io: CommandIO) {
    const { city: rawCity, to: rawTo, gas: rawGas, wait } = await io.resolveInputs(inputs);
    const city = resolveCity(String(rawCity ?? ""));
    if (!city) {
      throw new CommandError("ISOTHERM_UNKNOWN_CITY", `Unknown city '${rawCity}'.`, `Use one of: ${Object.keys(CITIES).join(", ")}.`);
    }

    const st = this.ctx.walletStateManager.read();
    const self = [...(st.byokWallets ?? []), ...(st.remoteWallets ?? [])][0]?.address as Address | undefined;
    if (!self) {
      throw new CommandError("ISOTHERM_NO_WALLET", "No wallet in mm state.", "Run `mm init` first.");
    }
    const to = (rawTo ? String(rawTo) : self) as Address;
    if (!isAddress(to)) throw new CommandError("ISOTHERM_BAD_ADDRESS", `'${to}' is not an address.`, "Pass a 0x address.");

    let tmax: number | null = null;
    let fcDate = "";
    try {
      const fc = await forecastTmax(city);
      tmax = fc.tmaxC;
      fcDate = fc.date;
    } catch (e) {
      io.log("warn", `forecast unavailable: ${shortErr(e)}`);
    }
    const memo = `isotherm:v0:${city.station}:${fcDate}:tmax=${tmax ?? "na"}`;
    const gas = BigInt(rawGas ? String(rawGas) : "30000");

    const exec = (await this.ctx.walletExecutor(io, this.pluginCommandId)) as unknown as Executor;
    const t0 = Date.now();
    const res = await exec(
      {
        kind: "transaction",
        chainId: MONAD_TESTNET_ID,
        transaction: { to, data: stringToHex(memo), value: 0n, gas },
        intent: { action: "custom", summary: `Isotherm forecast memo for ${city.name} (0 MON)` },
      },
      { signal: io.signal, ...(wait ? { waitForReceipt: true } : {}) },
    );
    return {
      chainId: MONAD_TESTNET_ID,
      from: self,
      to,
      memo,
      gasLimit: gas.toString(),
      status: res.status,
      hash: res.hash || null,
      ...(res.failureCode ? { failureCode: res.failureCode } : {}),
      ...(res.failureDescription ? { failureDescription: res.failureDescription } : {}),
      ...(res.pendingJob?.pollingId ? { pollingId: res.pendingJob.pollingId } : {}),
      submitMs: Date.now() - t0,
    };
  }
}
