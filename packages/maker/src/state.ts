// Persistent maker state (JSON, atomic write via tmp + rename). It is the bot's memory of what it created on-chain:
// the roll is resumable from it, and Kuru order ids live here (eth_getLogs is capped at 100 blocks on Monad, so
// history cannot be rescanned). Every on-chain step is ALSO re-checked against the chain before acting.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emptyState, type MakerState } from "./state-core.ts";

export * from "./state-core.ts";

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
