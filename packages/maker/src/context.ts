// Builds the runtime context: config, deployment, clients, role keys, state, logger. Refuses any chain but 10143.
import { join, dirname } from "node:path";
import type { Address } from "viem";
import { loadConfig, type MakerConfig, type Role } from "./config.ts";
import { loadDeployment, probeZapRegistry } from "./deployment.ts";
import { loadCloseTime } from "../../forecast/src/close-config.ts";
import { makeClients, type Ctx, type Logger } from "./chain.ts";
import { appendTxLog, loadKey, makeLogger } from "./node-io.ts";
import { loadState, saveState } from "./state.ts";

export async function buildContext(opts: { cfg?: MakerConfig; overrides?: any; quiet?: boolean; logger?: Logger } = {}): Promise<Ctx> {
  const cfg = opts.cfg ?? loadConfig(opts.overrides ?? {});
  const dep = loadDeployment();
  const { chain, pub } = makeClients(cfg.rpc);
  const cid = await pub.getChainId();
  if (cid !== 10143) throw new Error(`refusing: RPC ${cfg.rpc} is chain ${cid}, not Monad testnet 10143 (mainnet is never touched)`);
  let clientVersion = "unknown";
  try {
    clientVersion = String(await pub.request({ method: "web3_clientVersion" as any }));
  } catch {}
  const isAnvil = /anvil/i.test(clientVersion);
  const log = opts.logger ?? makeLogger(cfg.paths.log, opts.quiet);
  const maker = loadKey(cfg.keysDir, cfg.roles.maker);
  if (!maker) throw new Error(`maker key ${cfg.keysDir}/${cfg.roles.maker}.key not found`);
  let opName = cfg.roles.operator;
  let operator = loadKey(cfg.keysDir, opName);
  if (!operator) {
    opName = cfg.roles.operatorFallback;
    operator = loadKey(cfg.keysDir, opName);
    if (operator) log.warn(`operator key "${cfg.roles.operator}" not found: using "${opName}" for series creation / canonical markets`);
  }
  const creatorName = cfg.roles.marketCreator === "operator" ? opName : cfg.roles.marketCreator === "maker" ? cfg.roles.maker : cfg.roles.marketCreator;
  const creator = cfg.roles.marketCreator === "operator" ? operator : cfg.roles.marketCreator === "maker" ? maker : loadKey(cfg.keysDir, creatorName);
  const accounts = { maker, operator: operator ?? maker, marketCreator: creator ?? operator ?? maker } as Ctx["accounts"];
  const addr = Object.fromEntries(Object.entries(accounts).map(([r, a]) => [r, a.address])) as Record<Role, Address>;
  const depRef = { vault: dep.vault, resolver: dep.resolver, zap: dep.zap, source: dep.source, variant: dep.variant };
  const state = loadState(cfg.paths.state, depRef);
  const txLogFile = join(dirname(cfg.paths.state), "txs.jsonl");
  const ctx: Ctx = {
    cfg,
    dep,
    pub,
    chain,
    rpc: cfg.rpc,
    isAnvil,
    clientVersion,
    accounts,
    addr,
    keyNames: { maker: cfg.roles.maker, operator: operator ? opName : cfg.roles.maker, marketCreator: creator ? creatorName : opName },
    state,
    save: () => saveState(cfg.paths.state, state),
    log,
    closeTimes: loadCloseTime()?.stations ?? null,
    txLogFile,
    recordTx: (line) => appendTxLog(txLogFile, line),
  };
  await probeZapRegistry(pub, dep);
  return ctx;
}
