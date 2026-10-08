// Node-only I/O for the maker: the file logger, role keys from ~/.config/isotherm/<name>.key (never printed) and the
// var/txs.jsonl writer. Moved out of chain.ts so the shared core (chain/tick/roll) stays runtime-agnostic; the
// Cloudflare Worker (apps/maker-worker) supplies its own equivalents.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Logger, TxRecord } from "./chain.ts";

export function makeLogger(file: string | null, quiet = false): Logger {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const w = (level: string) => (msg: string, extra?: Record<string, unknown>) => {
    const line = { t: new Date().toISOString(), level, msg, ...(extra ?? {}) };
    if (file) appendFileSync(file, JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
    // logs go to stderr so command output on stdout stays machine-readable JSON
    if (!quiet || level !== "info") console.error(`${line.t.slice(11, 19)} ${level === "info" ? "" : level.toUpperCase() + " "}${msg}`);
  };
  return { info: w("info"), warn: w("warn"), error: w("error") };
}

export function loadKey(keysDir: string, name: string): PrivateKeyAccount | null {
  const f = join(keysDir, `${name}.key`);
  if (!existsSync(f)) return null;
  const raw = readFileSync(f, "utf8").trim();
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

/** Append one broadcast tx to var/txs.jsonl (what Ctx.recordTx does on the Node side). */
export function appendTxLog(file: string, line: TxRecord) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
}
