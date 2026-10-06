// Isotherm end-to-end harness: shared constants, ABIs, clients, a gas-recording tx sender, CRE report builder,
// forecast fair values. Real transactions only (anvil fork of Monad testnet, or the live testnet).
// Keys are read from ~/.config/isotherm/<role>.key and never printed or written anywhere.
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  http,

  parseAbi,
  stringToHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "../../.."); // isotherm repo root

// ------------------------------------------------------------------ live Monad testnet (10143) addresses
export const A = {
  ausd: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC" as Address, // 6 dp, EIP-712 "Agora Dollar" v1
  faucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as Address, // requestFunds(addr): 10k AUSD, GLOBAL 60 s cooldown
  mockForwarder: "0xB9F79d863261869B234c481D1f9A7af84AeAd192" as Address, // CRE MockKeystoneForwarder (permissionless)
  kuruRouter: "0x7EFbE105Ca7415dE98F96622173458ac1c054630" as Address, // Kuru v1 testnet Router (permissionless deployProxy)
  marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02" as Address,
} as const;
export const CHAIN_ID = 10143;
export const BILL_GWEI = 102n; // Monad testnet: base 100 + tip 2 gwei, charged on the GAS LIMIT

// Kuru market params proven by the Kuru spike (price 1e-4 AUSD units on a 0.001 tick; size = YES base units).
export const KURU = { type: 0, sizePrecision: 1_000_000n, pricePrecision: 10_000, tick: 10, minSize: 1_000_000n, maxSize: 1_000_000_000_000n, takerFeeBps: 10n, makerFeeBps: 0n, ammSpread: 100n } as const;

// ------------------------------------------------------------------ ABIs
export const kuruRouterAbi = parseAbi([
  "function deployProxy(uint8 _type, address _baseAssetAddress, address _quoteAssetAddress, uint96 _sizePrecision, uint32 _pricePrecision, uint32 _tickSize, uint96 _minSize, uint96 _maxSize, uint256 _takerFeeBps, uint256 _makerFeeBps, uint96 _kuruAmmSpread) returns (address proxy)",
  "function verifiedMarket(address) view returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)",
  "event MarketRegistered(address baseAsset, address quoteAsset, address market, address vaultAddress, uint32 pricePrecision, uint96 sizePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread)",
  "error Unauthorized()",
]);
export const bookAbi = parseAbi([
  "function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)",
  "function batchCancelOrdersNoRevert(uint40[] _orderIds)",
  "function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill) payable returns (uint256)",
  "function bestBidAsk() view returns (uint256, uint256)",
  "function getL2Book() view returns (bytes)",
  "function s_orderIdCounter() view returns (uint40)",
  "function s_orders(uint40) view returns (address ownerAddress, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function s_buyPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "function s_sellPricePoints(uint256) view returns (uint40 head, uint40 tail)",
  "error InsufficientBalance()",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
]);
export const marginAbi = parseAbi([
  "function deposit(address _user, address _token, uint256 _amount) payable",
  "function batchWithdrawMaxTokens(address[] _tokens)",
  "function getBalance(address _user, address _token) view returns (uint256)",
]);
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function symbol() view returns (string)",
]);
export const faucetAbi = parseAbi(["function requestFunds(address)", "error MaxFrequencyExceeded()"]);
export const forwarderAbi = parseAbi([
  "function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)",
  "function typeAndVersion() view returns (string)",
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
]);

export function artifact(file: string, name = file) {
  const j = JSON.parse(readFileSync(join(ROOT, "out", `${file}.sol`, `${name}.json`), "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}
export const ART = {
  Resolver: artifact("Resolver"),
  CollateralVault: artifact("CollateralVault"),
  IsothermZap: artifact("IsothermZap"),
  OutcomeToken: artifact("OutcomeToken"),
};
const ERROR_ABIS: Abi[] = [ART.Resolver.abi, ART.CollateralVault.abi, ART.IsothermZap.abi, ART.OutcomeToken.abi, kuruRouterAbi, faucetAbi, bookAbi];

// ------------------------------------------------------------------ keys / clients
export type Role = "deployer" | "maker" | "taker1" | "taker2";
export const ROLES: Role[] = ["deployer", "maker", "taker1", "taker2"];

export function loadAccount(role: Role): PrivateKeyAccount {
  const raw = readFileSync(join(homedir(), ".config/isotherm", `${role}.key`), "utf8").trim();
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

export function makeClients(rpc: string) {
  const chain = { ...monadTestnet, rpcUrls: { default: { http: [rpc] } } };
  const transport = http(rpc, { retryCount: 4, retryDelay: 500, timeout: 60_000 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const test = createTestClient({ chain, transport, mode: "anvil" });
  const wallet = (acct: PrivateKeyAccount) => createWalletClient({ chain, transport, account: acct });
  return { pub, test, wallet, chain };
}

// ------------------------------------------------------------------ tx recorder (Monad bills the gas LIMIT)
export type Rec = {
  n: number;
  phase: string;
  step: string;
  op: string; // budget key
  who: string;
  gasUsed: string; // execution gas (on live Monad, receipts report gasUsed == gasLimit)
  gasEstimate: string;
  gasLimit: string; // what is billed
  monBilled: number; // gasLimit × 102 gwei
  latencyMs: number; // send -> receipt (client-side, includes polling)
  block: string;
  hash: Hex;
  status: string;
  forkOnly?: boolean; // anvil-only step (time travel): excluded from the live MON requirement
  note?: string;
};

export class Recorder {
  recs: Rec[] = [];
  constructor(public outDir: string) {}
  add(r: Omit<Rec, "n">) {
    const rec = { n: this.recs.length + 1, ...r };
    this.recs.push(rec);
    appendFileSync(join(this.outDir, "steps.jsonl"), JSON.stringify(rec) + "\n");
    return rec;
  }
}

export function explainRevert(e: unknown): string {
  const seen = new Set<unknown>();
  const find = (x: any): Hex | undefined => {
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) return x.data as Hex;
    if (typeof x.data === "object" && typeof x.data?.data === "string") return x.data.data as Hex;
    return find(x.cause) ?? find(x.error);
  };
  const data = find(e);
  if (data) {
    for (const abi of ERROR_ABIS) {
      try {
        const d = decodeErrorResult({ abi, data });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {}
    }
    return `revert data ${data.slice(0, 74)}`;
  }
  const m = (e as any)?.shortMessage ?? (e as any)?.message ?? String(e);
  return String(m).split("\n")[0];
}

// ------------------------------------------------------------------ CRE report exactly as `cre workflow simulate --broadcast` sends it
// rawReport = version(1)=0x01 | executionId(32) | timestamp(4)=100 | donId(4)=1 | donConfigVersion(4)=1 |
//             workflowId(32)=0x11..11 | workflowName(10)="7721568293" | workflowOwner(20)=0xaa..aa | reportId(2)=0x0001 | payload
// (header constants observed from the official simulator by the CRE spike); reportContext 96 B; 4 × 65 B signatures.
export function creRawReport(executionId: Hex, payload: Hex): Hex {
  return concat([
    "0x01",
    executionId,
    toHex(100, { size: 4 }),
    toHex(1, { size: 4 }),
    toHex(1, { size: 4 }),
    `0x${"11".repeat(32)}` as Hex, // workflowId 0x1111…11
    stringToHex("7721568293", { size: 10 }),
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "0x0001",
    payload,
  ]);
}
export const CRE_CONTEXT = toHex(new Uint8Array(96));
export const CRE_SIGS = Array.from({ length: 4 }, () => toHex(new Uint8Array(65)));

export function settlementPayload(station: Hex, date: number, tmaxC: number, isVoid: boolean, sourcesHash: Hex, sig: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "bytes4" }, { type: "uint32" }, { type: "int16" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes" }],
    [station, date, tmaxC, isVoid, sourcesHash, sig],
  );
}

export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: "station", type: "bytes4" },
    { name: "date", type: "uint32" },
    { name: "tmaxC", type: "int16" },
    { name: "isVoid", type: "bool" },
    { name: "sourcesHash", type: "bytes32" },
  ],
} as const;

// ------------------------------------------------------------------ station-local dates
export const station4 = (code: string) => stringToHex(code, { size: 4 });
export function localDate(tsSec: number, offsetSec: number): number {
  const d = new Date((tsSec + offsetSec) * 1000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
export function dayEndOf(date: number, offsetSec: number): number {
  const y = Math.floor(date / 10_000), m = Math.floor(date / 100) % 100, d = date % 100;
  return Date.UTC(y, m - 1, d) / 1000 - offsetSec + 86_400;
}
export const isoDate = (date: number) => `${Math.floor(date / 10_000)}-${String(Math.floor(date / 100) % 100).padStart(2, "0")}-${String(date % 100).padStart(2, "0")}`;

// ------------------------------------------------------------------ forecast fair value (maker bot v0)
// P(METAR integer Tmax >= k) = 1 - Phi((k - 0.5 - mu) / sigma), mu = Open-Meteo deterministic daily max for the
// station's coordinates. (The weather spike's calibrated engine replaces this in the real bot.)
export function Phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
export async function forecastTaipei(date: number): Promise<{ mu: number; source: string }> {
  const iso = isoDate(date);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=25.0697&longitude=121.5525&daily=temperature_2m_max&timezone=Asia%2FTaipei&start_date=${iso}&end_date=${iso}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const j: any = await r.json();
    const mu = Number(j?.daily?.temperature_2m_max?.[0]);
    if (Number.isFinite(mu)) return { mu, source: url };
  } catch {}
  return { mu: 29.4, source: "fallback (Open-Meteo unreachable)" };
}
export const fairValue = (mu: number, sigma: number, k: number) => 1 - Phi((k - 0.5 - mu) / sigma);

/** Two-sided quote around fair value on the 0.001 tick, inside (0, 1). Prices in Kuru units (1e-4 AUSD). */
export function quoteAround(fv: number, half = 0.02): { bid: number; ask: number } {
  let bid = Math.floor((fv - half) * 1000) * 10;
  let ask = Math.ceil((fv + half) * 1000) * 10;
  bid = Math.min(Math.max(bid, 10), 9970);
  ask = Math.min(Math.max(ask, bid + 20), 9990);
  return { bid, ask };
}

// ------------------------------------------------------------------ misc
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const fmt6 = (x: bigint) => (Number(x) / 1e6).toFixed(6);
export const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`;
export function jsonSafe(x: unknown) {
  return JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
export function writeJson(path: string, x: unknown) {
  writeFileSync(path, jsonSafe(x));
}
export function readJsonIf<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}
export { encodeDeployData, encodeFunctionData, type TransactionReceipt };
