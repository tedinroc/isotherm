// Isotherm on-chain reads: ladders, series, results, canonical Kuru markets, positions.
import { hexToString, stringToHex, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { CANONICAL_BOOK, cityByStation, loadAbi, type AbiFn, type Deployment } from "./config.js";
import { decodeL2, erc20Abi, orderBookAbi, readMarketParams, type L2, type MarketParams } from "./kuru.js";
import { isoUtc, shortErr } from "./util.js";

export const station4 = (code: string) => stringToHex(code, { size: 4 });
export const stationStr = (b4: Hex) => hexToString(b4, { size: 4 }).replace(/\0/g, "");

export type Contracts = { vaultAbi: Abi; resolverAbi: Abi; zapAbi?: Abi; tokenAbi: Abi };
export function contracts(dep: Deployment): Contracts {
  return {
    vaultAbi: loadAbi("CollateralVault", dep),
    resolverAbi: loadAbi("Resolver", dep),
    zapAbi: dep.zap ? loadAbi("IsothermZap", dep) : undefined,
    tokenAbi: loadAbi("OutcomeToken", dep),
  };
}

export type Series = {
  seriesId: Hex;
  station: string;
  date: number;
  strikeC: number;
  closeTime: number;
  yes: Address;
  no: Address;
  collateral: bigint;
  gated: boolean; // v1 compliance flag: only allowlisted recipients may mint (false on the feasibility vault)
};

export type LadderResult = {
  status: "none" | "settled" | "void";
  tmaxC: number | null;
  resolvedAt: number | null;
  finalAt: number | null; // v1 challenge window end (redemption opens); null on the feasibility resolver
  sourcesHash: Hex | null;
};

export type Ladder = {
  station: string;
  date: number;
  dayEnd: number;
  closeTime: number;
  result: LadderResult;
  state: "open" | "closed" | "awaiting-settlement" | "settled" | "settled-in-challenge-window" | "void";
  series: Series[];
};

// ------------------------------------------------------------------------------------------- reads
export async function readSeries(client: PublicClient, dep: Deployment, c: Contracts, ids: Hex[]): Promise<Series[]> {
  if (!ids.length) return [];
  const rs = await client.multicall({
    multicallAddress: dep.multicall3,
    allowFailure: false,
    contracts: ids.map((id) => ({ address: dep.vault, abi: c.vaultAbi, functionName: "getSeries", args: [id] }) as const),
  });
  return rs.map((r: any, i) => ({
    seriesId: ids[i],
    station: stationStr(r.station as Hex),
    date: Number(r.date),
    strikeC: Number(r.strikeC),
    closeTime: Number(r.closeTime),
    yes: r.yes as Address,
    no: r.no as Address,
    collateral: BigInt(r.collateral),
    gated: Boolean(r.gated ?? false),
  }));
}

export function decodeResult(r: any): LadderResult {
  const st = Number(r?.status ?? 0);
  return {
    status: st === 1 ? "settled" : st === 2 ? "void" : "none",
    tmaxC: st === 1 ? Number(r.tmaxC) : null,
    resolvedAt: r?.resolvedAt ? Number(r.resolvedAt) : null,
    finalAt: r?.finalAt !== undefined ? Number(r.finalAt) : null,
    sourcesHash: (r?.sourcesHash as Hex) ?? null,
  };
}

export function ladderState(nowS: number, closeTime: number, dayEnd: number, res: LadderResult): Ladder["state"] {
  if (res.status === "void") return "void";
  if (res.status === "settled") return res.finalAt !== null && res.finalAt > nowS ? "settled-in-challenge-window" : "settled";
  if (nowS < closeTime) return "open";
  if (nowS < dayEnd) return "closed";
  return "awaiting-settlement";
}

export async function readLadder(client: PublicClient, dep: Deployment, c: Contracts, station: string, date: number, nowS: number): Promise<Ladder | null> {
  const s4 = station4(station);
  const ids = (await client.readContract({ address: dep.vault, abi: c.vaultAbi, functionName: "ladderSeries", args: [s4, date] })) as Hex[];
  if (!ids.length) return null;
  const [series, dayEnd, res] = await Promise.all([
    readSeries(client, dep, c, ids),
    client.readContract({ address: dep.resolver, abi: c.resolverAbi, functionName: "dayEnd", args: [s4, date] }) as Promise<bigint>,
    client.readContract({ address: dep.resolver, abi: c.resolverAbi, functionName: "resultOf", args: [s4, date] }),
  ]);
  series.sort((a, b) => a.strikeC - b.strikeC);
  const result = decodeResult(res);
  const closeTime = Math.min(...series.map((s) => s.closeTime));
  return { station, date, dayEnd: Number(dayEnd), closeTime, result, state: ladderState(nowS, closeTime, Number(dayEnd), result), series };
}

/** The most recent `limit` ladders (vault.ladderAt), optionally filtered by station / date. */
export async function listLadderRefs(client: PublicClient, dep: Deployment, c: Contracts, limit = 40): Promise<{ station: string; date: number; index: number }[]> {
  const n = Number(await client.readContract({ address: dep.vault, abi: c.vaultAbi, functionName: "ladderCount" }));
  const from = Math.max(0, n - limit);
  if (n === 0) return [];
  const idx = Array.from({ length: n - from }, (_, i) => from + i);
  const refs = await client.multicall({
    multicallAddress: dep.multicall3,
    allowFailure: false,
    contracts: idx.map((i) => ({ address: dep.vault, abi: c.vaultAbi, functionName: "ladderAt", args: [BigInt(i)] }) as const),
  });
  return refs.map((r: any, i) => ({ station: stationStr(r.station as Hex), date: Number(r.date), index: idx[i] }));
}

// ------------------------------------------------------------------------------------------- canonical market
/** A v1 on-chain registry: any view fn(bytes32) -> address whose name mentions "market", on the Zap or the Vault. */
export function findRegistryFn(c: Contracts, dep: Deployment): { address: Address; abi: Abi; fn: string } | undefined {
  const cands: { address: Address | undefined; abi: Abi | undefined }[] = [
    { address: dep.zap, abi: c.zapAbi },
    { address: dep.vault, abi: c.vaultAbi },
  ];
  for (const { address, abi } of cands) {
    if (!address || !abi) continue;
    const fn = abi.find(
      (x) =>
        x.type === "function" &&
        /market/i.test(x.name) &&
        (x.stateMutability === "view" || x.stateMutability === "pure") &&
        x.inputs.length === 1 &&
        x.inputs[0].type === "bytes32" &&
        x.outputs.length === 1 &&
        x.outputs[0].type === "address",
    ) as AbiFn | undefined;
    if (fn) return { address, abi, fn: fn.name };
  }
  return undefined;
}

export type MarketCheck = {
  market: Address | null;
  source: "registry" | "deployments" | "flag" | "none";
  registry?: string;
  canonical: boolean;
  params?: MarketParams;
  problems: string[];
};

const ZERO = "0x0000000000000000000000000000000000000000";

export function checkBookParams(params: MarketParams | undefined, s: Pick<Series, "yes">, ausd: Address): string[] {
  if (!params) return ["Kuru router does not list this market (verifiedMarket returned zeros)"];
  const p: string[] = [];
  if (params.base.toLowerCase() !== s.yes.toLowerCase()) p.push(`book base ${params.base} is not this series' YES token ${s.yes}`);
  if (params.quote.toLowerCase() !== ausd.toLowerCase()) p.push(`book quote ${params.quote} is not AUSD`);
  if (params.pricePrecision !== CANONICAL_BOOK.pricePrecision) p.push(`pricePrecision ${params.pricePrecision} != ${CANONICAL_BOOK.pricePrecision}`);
  if (params.sizePrecision !== CANONICAL_BOOK.sizePrecision) p.push(`sizePrecision ${params.sizePrecision} != ${CANONICAL_BOOK.sizePrecision}`);
  if (params.baseDecimals !== CANONICAL_BOOK.baseDecimals || params.quoteDecimals !== CANONICAL_BOOK.quoteDecimals) p.push(`decimals ${params.baseDecimals}/${params.quoteDecimals} != 6/6`);
  if (params.takerFeeBps > CANONICAL_BOOK.maxTakerFeeBps) p.push(`takerFeeBps ${params.takerFeeBps} > ${CANONICAL_BOOK.maxTakerFeeBps} (hostile-book pattern, security finding #4)`);
  if (params.makerFeeBps > params.takerFeeBps) p.push(`makerFeeBps ${params.makerFeeBps} > takerFeeBps ${params.takerFeeBps}`);
  return p;
}

/**
 * Which Kuru book is THE book for a series. Order: on-chain registry (v1) > deployments file > --market flag.
 * A --market that disagrees with a registry/deployment entry is refused. Every candidate is checked against
 * Kuru's router and the canonical book parameters, so a look-alike book with a 90% taker fee is rejected.
 */
export async function resolveMarket(client: PublicClient, dep: Deployment, c: Contracts, s: Series, flagMarket?: Address): Promise<MarketCheck> {
  let market: Address | null = null;
  let source: MarketCheck["source"] = "none";
  let registry: string | undefined;
  const problems: string[] = [];
  const reg = findRegistryFn(c, dep);
  if (reg) {
    registry = `${reg.address}.${reg.fn}`;
    try {
      const m = (await client.readContract({ address: reg.address, abi: reg.abi, functionName: reg.fn, args: [s.seriesId] })) as Address;
      if (m && m !== ZERO) {
        market = m;
        source = "registry";
      }
    } catch (e) {
      problems.push(`registry ${registry} read failed: ${shortErr(e)}`);
    }
  }
  if (!market && dep.markets[s.seriesId.toLowerCase()]) {
    market = dep.markets[s.seriesId.toLowerCase()];
    source = "deployments";
  }
  if (flagMarket) {
    if (market && market.toLowerCase() !== flagMarket.toLowerCase()) {
      problems.push(`--market ${flagMarket} is not the canonical book ${market} (${source}); refusing`);
      return { market, source, registry, canonical: false, problems };
    }
    if (!market) {
      market = flagMarket;
      source = "flag";
    }
  }
  if (!market) return { market: null, source: "none", registry, canonical: false, problems: [...problems, "no Kuru book is registered for this series yet"] };
  const params = await readMarketParams(client, dep.kuruRouter, market);
  problems.push(...checkBookParams(params, s, dep.ausd));
  return { market, source, registry, canonical: problems.length === 0, params, problems };
}

/** getL2Book for several markets in one multicall (bestBidAsk's empty-book encoding is ambiguous, L2 is not). */
export async function readBooks(client: PublicClient, dep: Deployment, markets: Address[]): Promise<(L2 | null)[]> {
  if (!markets.length) return [];
  const rs = await client.multicall({
    multicallAddress: dep.multicall3,
    allowFailure: true,
    contracts: markets.map((m) => ({ address: m, abi: orderBookAbi, functionName: "getL2Book" }) as const),
  });
  return rs.map((r) => (r.status === "success" ? decodeL2(r.result as Hex) : null));
}

export async function tokenBalances(client: PublicClient, dep: Deployment, owner: Address, tokens: Address[]): Promise<bigint[]> {
  if (!tokens.length) return [];
  const rs = await client.multicall({
    multicallAddress: dep.multicall3,
    allowFailure: true,
    contracts: tokens.map((t) => ({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) as const),
  });
  return rs.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));
}

export function describeSeries(s: Series) {
  const city = cityByStation(s.station);
  return {
    seriesId: s.seriesId,
    city: city?.name ?? s.station,
    station: s.station,
    date: s.date,
    strike: `Tmax>=${s.strikeC}C`,
    strikeC: s.strikeC,
    closeTime: isoUtc(s.closeTime),
    yes: s.yes,
    no: s.no,
  };
}
