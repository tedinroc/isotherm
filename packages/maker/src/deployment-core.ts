// Contract addresses and the deployment reader (runtime-agnostic: no Node APIs). deployment.ts (Node) reads
// deployments/testnet.json from disk; the Cloudflare Worker bundles the same file. Both parse it with parseDeployment.
// ABIs: our own minimal fragments (abis.ts) for everything we call.
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import { resultAbiFeasibility, resultAbiV1, seriesAbiFeasibility, seriesAbiV1, zapRegistryAbi } from "./abis.ts";

export const TESTNET_CONSTANTS = {
  ausd: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" as Address, // 6 dp, EIP-712 "Agora Dollar" v1
  ausdFaucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as Address, // requestFunds(addr): 10k AUSD, GLOBAL 60 s cooldown
  kuruRouter: "0x7EFbE105Ca7415dE98F96622173458ac1c054630" as Address,
  marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as Address,
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
};

/** Feasibility deployment (spikes/e2e/logs/live-2026-10-06T15-04-29, git 1ae0d48). Owner = deployer. RCSS is NOT
 *  registered on its Resolver (that run used throwaway test stations), so a real Taipei roll needs v1. */
export const FEASIBILITY = {
  resolver: "0x1c7a8a5df93f7f33c778c2163d8887e9249475f1" as Address,
  vault: "0xc83fe722eb5bd29a0355c090f14ccb0605153713" as Address,
  zap: "0x1b1d91ebd1590c7814aedcae66ac6ded492c792e" as Address,
};

export interface Deployment {
  source: string;
  variant: "v1" | "feasibility";
  chainId: number;
  vault: Address;
  resolver: Address;
  zap: Address | null;
  ausd: Address;
  ausdFaucet: Address;
  kuruRouter: Address;
  marginAccount: Address;
  multicall3: Address;
  roles: Partial<Record<"operator" | "maker" | "owner" | "guardian" | "attester", Address>>;
  seriesAbi: typeof seriesAbiV1 | typeof seriesAbiFeasibility;
  resultAbi: typeof resultAbiV1 | typeof resultAbiFeasibility;
  zapRegistry: boolean | null; // null = not probed yet
}

/** Depth-first search for an address under a key matching `re` (case-insensitive); values may be strings or {address}. */
export function findAddr(obj: any, re: RegExp, depth = 0): Address | null {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (!re.test(k)) continue;
    const a = typeof v === "string" ? v : v && typeof v === "object" ? ((v as any).address ?? (v as any).addr) : null;
    if (typeof a === "string" && isAddress(a, { strict: false })) return getAddress(a);
  }
  for (const v of Object.values(obj)) {
    const r = findAddr(v, re, depth + 1);
    if (r) return r;
  }
  return null;
}

/** A parsed deployments/testnet.json (tolerant reader); `source` names it in errors and in the snapshot. */
export function parseDeployment(j: any, source: string): Deployment {
  const req = (re: RegExp, name: string) => {
    const a = findAddr(j, re);
    if (!a) throw new Error(`${source}: no ${name} address found`);
    return a;
  };
  const chainId = Number(j.chainId ?? j.chain?.id ?? 10143);
  if (chainId !== 10143) throw new Error(`${source}: chainId ${chainId} is not Monad testnet 10143`);
  const variantField = String(j.variant ?? j.version ?? "v1").toLowerCase();
  const variant: Deployment["variant"] = variantField.includes("feas") ? "feasibility" : "v1";
  return {
    source,
    variant,
    chainId,
    vault: req(/^(collateral_?vault|vault)$/i, "vault"),
    resolver: req(/^resolver$/i, "resolver"),
    zap: findAddr(j, /^(isotherm_?zap|zap)$/i),
    ausd: findAddr(j, /^(ausd|collateral)$/i) ?? TESTNET_CONSTANTS.ausd,
    ausdFaucet: findAddr(j, /^(ausd_?faucet|faucet)$/i) ?? TESTNET_CONSTANTS.ausdFaucet,
    kuruRouter: findAddr(j, /^(kuru_?router|router)$/i) ?? TESTNET_CONSTANTS.kuruRouter,
    marginAccount: findAddr(j, /^(kuru_?margin_?account|margin_?account)$/i) ?? TESTNET_CONSTANTS.marginAccount,
    multicall3: findAddr(j, /^multicall3?$/i) ?? TESTNET_CONSTANTS.multicall3,
    roles: {
      operator: findAddr(j, /^operator$/i) ?? undefined,
      maker: findAddr(j, /^maker$/i) ?? undefined,
      owner: findAddr(j, /^(owner|new_?owner)$/i) ?? undefined,
      guardian: findAddr(j, /^guardian$/i) ?? undefined,
      attester: findAddr(j, /^attester$/i) ?? undefined,
    },
    seriesAbi: variant === "v1" ? seriesAbiV1 : seriesAbiFeasibility,
    resultAbi: variant === "v1" ? resultAbiV1 : resultAbiFeasibility,
    zapRegistry: null,
  };
}

/** The feasibility deployment (used when deployments/testnet.json is absent). */
export function feasibilityDeployment(): Deployment {
  return {
    source: "feasibility-fallback (deployments/testnet.json absent)",
    variant: "feasibility",
    chainId: 10143,
    ...FEASIBILITY,
    ...TESTNET_CONSTANTS,
    roles: {},
    seriesAbi: seriesAbiFeasibility,
    resultAbi: resultAbiFeasibility,
    zapRegistry: null,
  };
}

/** Does the Zap expose the v1 canonical-market registry? (eth_call canonicalMarket(0)). */
export async function probeZapRegistry(pub: PublicClient, d: Deployment): Promise<boolean> {
  if (!d.zap) return (d.zapRegistry = false);
  try {
    await pub.readContract({ address: d.zap, abi: zapRegistryAbi, functionName: "canonicalMarket", args: [`0x${"00".repeat(32)}`] });
    d.zapRegistry = true;
  } catch {
    d.zapRegistry = false;
  }
  return d.zapRegistry;
}
