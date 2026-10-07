// Chain access for the plugin.
//
// mm 7.0.0's hosted RPC gateway answers HTTP 400 {"error":"Invalid chainId"} for Monad testnet (10143), so
// ctx.publicClient(10143) fails for most users. Reads therefore pick the first RPC that works, in this order:
//   1. --rpc <url> flag              2. env ISOTHERM_RPC_URL
//   3. the rpcTarget of mm's customEvmChains[10143] entry (written by scripts/setup-mm-monad.sh); this is the
//      same RPC the executor uses for nonce/gas/fees, so reads and writes see the same chain
//   4. ctx.publicClient(10143) (works with the rpc-shim, or if MetaMask fixes the gateway)
//   5. the public Monad testnet RPC
import { createPublicClient, decodeErrorResult, getAddress, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { CHAIN_ID, PUBLIC_RPC } from "./config.js";
import { shortErr, withTimeout } from "./util.js";

export type Reader = {
  client: PublicClient;
  source: "flag" | "env" | "mm-customEvmChains" | "mm-gateway" | "public-rpc";
  rpcUrl?: string;
  notes: string[];
};

/** Minimal structural view of the parts of the plugin context we use (keeps unit tests host-free). */
export type HostCtx = {
  publicClient?: (chainId: number) => PublicClient;
  walletStateManager?: { read(): any };
};

const monadChain = (rpc: string) =>
  ({
    id: CHAIN_ID,
    name: "Monad Testnet",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  }) as const;

export function directClient(rpc: string): PublicClient {
  return createPublicClient({ chain: monadChain(rpc), transport: http(rpc, { timeout: 15_000, retryCount: 2, retryDelay: 400, batch: { wait: 10 } }) }) as PublicClient;
}

export function customChainRpc(ctx: HostCtx): string | undefined {
  try {
    const st = ctx.walletStateManager?.read();
    const c = (st?.customEvmChains ?? []).find((x: any) => Number(x?.chainId) === CHAIN_ID);
    return typeof c?.rpcTarget === "string" && c.rpcTarget ? c.rpcTarget : undefined;
  } catch {
    return undefined;
  }
}

export async function makeReader(ctx: HostCtx, rpcFlag?: string): Promise<Reader> {
  const notes: string[] = [];
  const tryDirect = async (rpc: string, source: Reader["source"]): Promise<Reader | undefined> => {
    const client = directClient(rpc);
    try {
      const id = await withTimeout(client.getChainId(), 8000, "eth_chainId");
      if (id !== CHAIN_ID) {
        notes.push(`${source} ${rpc} is chain ${id}, not ${CHAIN_ID}`);
        return undefined;
      }
      return { client, source, rpcUrl: rpc, notes };
    } catch (e) {
      notes.push(`${source} ${rpc}: ${shortErr(e)}`);
      return undefined;
    }
  };
  if (rpcFlag) {
    const r = await tryDirect(rpcFlag, "flag");
    if (r) return r;
    throw new Error(`--rpc ${rpcFlag} is unusable: ${notes.join("; ")}`);
  }
  if (process.env.ISOTHERM_RPC_URL) {
    const r = await tryDirect(process.env.ISOTHERM_RPC_URL, "env");
    if (r) return r;
  }
  const custom = customChainRpc(ctx);
  if (custom) {
    const r = await tryDirect(custom, "mm-customEvmChains");
    if (r) return r;
  }
  if (ctx.publicClient) {
    try {
      const client = ctx.publicClient(CHAIN_ID);
      const id = await withTimeout(client.getChainId(), 8000, "mm gateway eth_chainId");
      if (id === CHAIN_ID) return { client, source: "mm-gateway", notes };
      notes.push(`mm gateway returned chainId ${id}`);
    } catch (e) {
      notes.push(`mm gateway: ${shortErr(e)}`);
    }
  }
  const r = await tryDirect(PUBLIC_RPC, "public-rpc");
  if (r) return r;
  throw new Error(`no working Monad testnet RPC: ${notes.join("; ")}`);
}

/** The wallet mm would sign with: selectedWallet, else the first EVM BYOK wallet, else the first EVM server wallet. */
export function selectedAddress(ctx: HostCtx): { address?: Address; source: string } {
  try {
    const st = ctx.walletStateManager?.read();
    const sel = st?.selectedWallet;
    if (sel && typeof sel === "object" && typeof sel.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(sel.address)) {
      return { address: getAddress(sel.address), source: "mm-selected-wallet" };
    }
    const all = [...(st?.byokWallets ?? []), ...(st?.remoteWallets ?? [])].filter(
      (w: any) => typeof w?.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(w.address) && (w.namespace ?? "evm") === "evm",
    );
    if (all[0]) return { address: getAddress(all[0].address), source: "mm-wallet-state" };
    return { source: "none (run `mm init`, or pass --address)" };
  } catch (e) {
    return { source: `wallet state unavailable: ${shortErr(e)}` };
  }
}

// ------------------------------------------------------------------------------------------- revert decoding
function findRevertData(e: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const walk = (x: any): Hex | undefined => {
    if (!x || typeof x !== "object" || seen.has(x)) return undefined;
    seen.add(x);
    if (typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) return x.data as Hex;
    if (x.data && typeof x.data === "object" && typeof x.data.data === "string") return x.data.data as Hex;
    if (typeof x.raw === "string" && x.raw.startsWith("0x") && x.raw.length >= 10) return x.raw as Hex;
    return walk(x.cause) ?? walk(x.error) ?? walk(x.walk?.());
  };
  return walk(e);
}

export function explainRevert(e: unknown, abis: Abi[]): string {
  const data = findRevertData(e);
  if (data) {
    for (const abi of abis) {
      try {
        const d = decodeErrorResult({ abi, data });
        return `${d.errorName}(${(d.args ?? []).map((a) => String(a)).join(", ")})`;
      } catch {}
    }
    if (data.startsWith("0x08c379a0") || data.startsWith("0x4e487b71")) {
      try {
        const d = decodeErrorResult({ abi: [], data });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {}
    }
    return `revert ${data.slice(0, 10)}`;
  }
  const anyE = e as any;
  return String(anyE?.details ?? anyE?.shortMessage ?? anyE?.message ?? e).split("\n")[0].slice(0, 240);
}
