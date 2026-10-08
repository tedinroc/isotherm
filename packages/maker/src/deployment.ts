// Contract addresses: deployments/testnet.json (single source of truth, written by the contracts workstream) with a
// tolerant reader, else the feasibility deployment (live since the 56/56 e2e run). ABIs: our own minimal fragments
// (abis.ts) for everything we call; packages/abi/*.json (else root out/) is only consulted to cross-check.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config.ts";
import { feasibilityDeployment, parseDeployment, type Deployment } from "./deployment-core.ts";

export * from "./deployment-core.ts";

export function deploymentFile(): string {
  return process.env.ISOTHERM_DEPLOYMENT ?? join(REPO_ROOT, "deployments", "testnet.json");
}

export function loadDeployment(file = deploymentFile()): Deployment {
  if (existsSync(file)) return parseDeployment(JSON.parse(readFileSync(file, "utf8")), file);
  return feasibilityDeployment();
}

/** packages/abi/<name>.json (array or {abi}) else root out/<name>.sol/<name>.json; null if neither exists. */
export function loadAbiFile(name: string): { abi: any[]; source: string } | null {
  for (const f of [join(REPO_ROOT, "packages", "abi", `${name}.json`), join(REPO_ROOT, "out", `${name}.sol`, `${name}.json`)]) {
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8"));
    return { abi: Array.isArray(j) ? j : j.abi, source: f };
  }
  return null;
}
