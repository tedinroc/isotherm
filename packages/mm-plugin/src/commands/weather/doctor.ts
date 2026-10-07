import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import type { Address } from "viem";
import { CHAIN_ID, PUBLIC_RPC } from "../../lib/config.js";
import { customChainRpc } from "../../lib/chain.js";
import { F, PLUGIN_VERSION, envSummary, setupEnv } from "../../lib/cmd.js";
import { findRegistryFn } from "../../lib/isotherm.js";
import { snapshotStatus } from "../../lib/snapshot.js";
import { erc20Abi } from "../../lib/kuru.js";
import { fmtAllowance, fmtUnits, shortErr, withTimeout } from "../../lib/util.js";

const inputs = { address: F.address(), rpc: F.rpc() } satisfies InputSchema;

export default class WeatherDoctor extends PluginCommand<Record<string, unknown>> {
  static override description =
    "Check that this mm host can trade Isotherm on Monad testnet (10143): chain config, RPC, deployment, wallet gas/AUSD, and the Guard Mode allowlist targets.";
  static override examples = ["<%= config.bin %> weather doctor --json"];
  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "weather:doctor";

  async execute(io: CommandIO) {
    const i = await io.resolveInputs(inputs);
    const checks: { check: string; ok: boolean; detail: string; fix?: string; optional?: boolean }[] = [];

    const custom = customChainRpc(this.ctx);
    checks.push({
      check: "mm customEvmChains[10143] (executor nonce/gas/fees)",
      ok: !!custom,
      detail: custom ? `rpcTarget ${custom}` : "missing: mm's hosted gateway answers HTTP 400 'Invalid chainId' for 10143, so signing fails",
      ...(custom ? {} : { fix: "curl -fsSL https://unpkg.com/mm-plugin-isotherm/scripts/setup-mm-monad.sh | SKIP_INSTALL=1 sh   (or run scripts/add-monad-testnet-chain.mjs from this package)" }),
    });

    let gw = "not tried";
    let gwOk = false;
    try {
      const id = await withTimeout(this.ctx.publicClient(CHAIN_ID).getChainId(), 8000, "gateway");
      gwOk = id === CHAIN_ID;
      gw = `answered chainId ${id}`;
    } catch (e) {
      gw = shortErr(e);
    }
    checks.push({
      check: "mm gateway ctx.publicClient(10143)",
      ok: gwOk,
      detail: gw,
      ...(gwOk ? {} : { fix: "optional: the plugin reads through its own RPC fallback. To fix the gateway for other commands too, run scripts/rpc-shim.mjs from this package and export MM_INFURA_RPC_BASE_URL=http://127.0.0.1:18790" }),
    });

    const env = await setupEnv(this.ctx, i.rpc, i.address);
    const client = env.reader.client;
    const block = await client.getBlockNumber();
    checks.push({ check: "read RPC", ok: true, detail: `${env.reader.source} ${env.reader.rpcUrl ?? ""} block ${block}`.trim() });

    const codes = await Promise.all(
      ([["CollateralVault", env.dep.vault], ["Resolver", env.dep.resolver], ["IsothermZap", env.dep.zap], ["AUSD", env.dep.ausd], ["KuruRouter", env.dep.kuruRouter], ["Multicall3", env.dep.multicall3]] as [string, Address | undefined][]).map(
        async ([n, a]) => [n, a, a ? ((await client.getCode({ address: a })) ?? "0x").length > 2 : false] as const,
      ),
    );
    for (const [n, a, ok] of codes) checks.push({ check: `contract ${n}`, ok, detail: a ? `${a}${ok ? "" : " has no code on this chain"}` : "not in deployment" });
    const reg = findRegistryFn(env.c, env.dep);
    checks.push({
      check: "canonical market registry",
      ok: true,
      detail: reg
        ? `on-chain ${reg.address}.${reg.fn}(seriesId)`
        : `none on-chain (deployment '${env.dep.abiSet}'); using the deployment file's market list (${Object.keys(env.dep.markets).length} entries) + the plugin's canonical-book parameter check`,
    });

    const snap = await snapshotStatus();
    checks.push({
      check: "maker snapshot API (optional, display only)",
      ok: snap.ok,
      optional: true,
      detail: snap.detail,
      ...(snap.ok ? {} : { fix: "optional: quote/edge fall back to the plugin's own Polymarket read and label it; set ISOTHERM_API_URL to another Isotherm API if you run one" }),
    });

    let wallet: Record<string, unknown> = { address: null, source: env.selfSource };
    if (env.self) {
      const [mon, ausd, allow] = await Promise.all([
        client.getBalance({ address: env.self }),
        client.readContract({ address: env.dep.ausd, abi: erc20Abi, functionName: "balanceOf", args: [env.self] }) as Promise<bigint>,
        env.dep.zap ? (client.readContract({ address: env.dep.ausd, abi: erc20Abi, functionName: "allowance", args: [env.self, env.dep.zap] }) as Promise<bigint>) : Promise.resolve(0n),
      ]);
      wallet = { address: env.self, source: env.selfSource, MON: fmtUnits(mon, 18), AUSD: fmtUnits(ausd, 6), ausdAllowanceToZap: fmtAllowance(allow, 6) };
      checks.push({
        check: "wallet MON for gas",
        ok: mon >= 50_000_000_000_000_000n,
        detail: `${fmtUnits(mon, 18)} MON (a Zap trade bills ~0.06-0.10 MON at 102 gwei because Monad bills the gas limit)`,
        ...(mon >= 50_000_000_000_000_000n ? {} : { fix: "claim testnet MON at https://faucet.monad.xyz (human step)" }),
      });
      checks.push({
        check: "wallet AUSD",
        ok: ausd > 0n,
        detail: `${fmtUnits(ausd, 6)} AUSD`,
        ...(ausd > 0n ? {} : { fix: `call requestFunds(<your address>) on the AUSD faucet ${env.dep.ausdFaucet} (10k testnet AUSD, global 60 s cooldown)` }),
      });
    } else {
      checks.push({ check: "wallet", ok: false, detail: env.selfSource, fix: "mm login && mm init" });
    }

    return {
      plugin: `mm-plugin-isotherm@${PLUGIN_VERSION}`,
      chainId: CHAIN_ID,
      ok: checks.every((c) => c.ok || c.optional || c.check.startsWith("mm gateway")),
      checks,
      wallet,
      guardModeAllowlist: {
        note: "If your mm wallet runs Guard Mode with an allowlist, these are the contracts the plugin sends transactions to.",
        targets: [env.dep.zap, env.dep.vault, env.dep.ausd, env.dep.marginAccount, "each strike's Kuru market (weather markets), for kuru limit/cancel", "each outcome token (YES is approved to the Zap when selling YES or buying NO)"].filter(Boolean),
      },
      publicRpc: PUBLIC_RPC,
      ...envSummary(env),
      deploymentSource: env.dep.source,
      deploymentWarnings: env.dep.warnings,
    };
  }

  override successHint(d: Record<string, unknown>): string {
    return d.ok ? "ready to trade on Monad testnet" : "some checks failed: see fix fields";
  }
}
