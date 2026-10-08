// Maker configuration: config/default.json, deep-merged with config/local.json (if present) or $MAKER_CONFIG, then
// a few env overrides. Paths are relative to the package root unless absolute.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge, validateConfig, type MakerConfig } from "./config-core.ts";

export * from "./config-core.ts";

export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(PKG_ROOT, "../..");

export function resolvePath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : join(PKG_ROOT, p);
}

export function loadConfig(overrides: any = {}): MakerConfig {
  let cfg = JSON.parse(readFileSync(join(PKG_ROOT, "config/default.json"), "utf8"));
  const extra = process.env.MAKER_CONFIG ?? join(PKG_ROOT, "config/local.json");
  if (existsSync(extra)) cfg = deepMerge(cfg, JSON.parse(readFileSync(extra, "utf8")));
  if (process.env.MAKER_RPC ?? process.env.RPC_URL) cfg.rpc = process.env.MAKER_RPC ?? process.env.RPC_URL;
  if (process.env.ISOTHERM_API_URL) cfg.api.url = process.env.ISOTHERM_API_URL;
  if (process.env.MAKER_STATE) cfg.paths.state = process.env.MAKER_STATE;
  if (process.env.MAKER_VAR) for (const k of Object.keys(cfg.paths)) cfg.paths[k] = join(process.env.MAKER_VAR, cfg.paths[k].replace(/^var\//, ""));
  if (process.env.MAKER_STATIONS) cfg.stations = process.env.MAKER_STATIONS.split(",").map((s) => s.trim().toUpperCase());
  cfg = deepMerge(cfg, overrides);
  cfg.allowLive = process.env.ISOTHERM_ALLOW_LIVE === "1";
  cfg.dryRun = Boolean(cfg.dryRun);
  for (const k of Object.keys(cfg.paths)) cfg.paths[k] = resolvePath(cfg.paths[k]);
  cfg.keysDir = resolvePath(cfg.keysDir);
  validateConfig(cfg);
  return cfg as MakerConfig;
}

