// The maker config inside the Worker: packages/maker/config/default.json (the same defaults the Mac uses), the
// Worker overlay config/worker.json, then CONFIG_OVERRIDES; validated with the shared validateConfig. There are no
// files, paths or key directories here: state lives in the Durable Object and keys are Worker secrets.
import defaults from "../../../packages/maker/config/default.json";
import { deepMerge, validateConfig, type MakerConfig } from "../../../packages/maker/src/config-core.ts";
import overlay from "../config/worker.json";
import type { Settings } from "./env.ts";

/** Monad bills the GAS LIMIT, so the limit multiplier over eth_estimateGas is kept tight. */
export const GAS_MULT_RANGE: [number, number] = [1.05, 1.1];

export function workerConfig(s: Settings, mode: "shadow" | "live"): MakerConfig {
  let cfg = deepMerge<any>(structuredClone(defaults), overlay);
  cfg = deepMerge<any>(cfg, s.configOverrides ?? {});
  delete cfg._comment;
  cfg.rpc = s.rpc;
  cfg.stations = s.stations;
  cfg.api = { ...cfg.api, url: null }; // the Worker posts through its service binding, never to a URL
  cfg.allowLive = mode === "live";
  cfg.dryRun = mode === "shadow";
  validateConfig(cfg as MakerConfig);
  for (const k of ["makerMult", "opMult"] as const) {
    const m = cfg.gas[k];
    if (!(m >= GAS_MULT_RANGE[0] && m <= GAS_MULT_RANGE[1])) throw new Error(`gas.${k} ${m} outside ${GAS_MULT_RANGE.join("..")} (Monad bills the gas limit)`);
  }
  return cfg as MakerConfig;
}
