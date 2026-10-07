// Persistent maker state (JSON, atomic write via tmp + rename). It is the bot's memory of what it created on-chain:
// the roll is resumable from it, and Kuru order ids live here (eth_getLogs is capped at 100 blocks on Monad, so
// history cannot be rescanned). Every on-chain step is ALSO re-checked against the chain before acting.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import type { BudgetState } from "./budget.ts";

export type OrderRef = { id: number; price: number; size: number; placedAt: number };
export type SeriesMode = "pending" | "quoting" | "pulled" | "certain" | "closed";

export interface SeriesState {
  strike: number;
  seriesId: Hex;
  yes: Address;
  no: Address;
  market: Address | null;
  marketBlock?: number; // block of the deployProxy tx (log scanners start here: eth_getLogs is capped at 100 blocks)
  canonical: boolean | null; // registered in the v1 Zap (null = registry not supported)
  mode: SeriesMode;
  reason?: string;
  orders: { bid?: OrderRef; ask?: OrderRef };
  lastQuote?: { fair: number; bid: number | null; ask: number | null; bidSize: number; askSize: number; at: number; tx: Hex };
  lastPullAt?: number;
  marginDone?: boolean;
}

export interface PendingTx {
  hash: Hex;
  from: Address;
  nonce: number;
  at: number;
  what: string;
}

export interface LadderState {
  key: string; // "RCSS:20261008"
  station: string;
  date: number; // yyyymmdd (on-chain)
  isoDate: string;
  strikes: number[];
  strikeSource: string;
  closeTime: number; // unix s (vault closeTime; minting stops)
  stopAt: number; // unix s (maker kill switch)
  dayEnd: number;
  status: "planned" | "rolling" | "active" | "closed";
  paused?: boolean; // manual "pull" command: quotes cancelled, no re-quoting until "resume"
  steps: Record<string, { done: boolean; at: number; tx?: Hex; note?: string }>;
  pending: Record<string, PendingTx>;
  series: Record<string, SeriesState>;
  createdAt: number;
  closedAt?: number;
  polymarket?: { slug: string; url: string };
}

export interface MakerState {
  version: 1;
  deployment: { vault: Address; resolver: Address; zap: Address | null; source: string; variant: string };
  ladders: Record<string, LadderState>;
  budget: BudgetState;
  events: { at: number; kind: string; msg: string }[]; // last ~200 notable events (shown in the snapshot)
}

export function emptyState(dep: MakerState["deployment"]): MakerState {
  return { version: 1, deployment: dep, ladders: {}, budget: { day: "", spent: {}, txs: {} }, events: [] };
}

export function loadState(file: string, dep: MakerState["deployment"]): MakerState {
  if (!existsSync(file)) return emptyState(dep);
  const s = JSON.parse(readFileSync(file, "utf8")) as MakerState;
  if (s.deployment.vault.toLowerCase() !== dep.vault.toLowerCase())
    throw new Error(`state file ${file} belongs to vault ${s.deployment.vault}, but the deployment is ${dep.vault}. Move it aside (it is the record of what exists on the old deployment) or set MAKER_STATE.`);
  s.events ??= [];
  return s;
}

export function saveState(file: string, s: MakerState) {
  mkdirSync(dirname(file), { recursive: true });
  s.events = s.events.slice(-200);
  writeFileSync(file + ".tmp", JSON.stringify(s, null, 1));
  renameSync(file + ".tmp", file);
}

export const ladderKey = (station: string, date: number) => `${station}:${date}`;

export function note(s: MakerState, kind: string, msg: string, now = Math.floor(Date.now() / 1000)) {
  s.events.push({ at: now, kind, msg });
}
