// The shared maker core (pricing, policy, budget, chain/send, tick, roll, kill switch, snapshot builder) and the
// forecast cores must stay runtime-agnostic: the Cloudflare Worker (apps/maker-worker) bundles them as they are.
// This walks their VALUE-import graph (import type / export type are erased at build time) and fails on any Node
// built-in, any Node-only sibling module, top-level process/import.meta access, or the file system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../src");
const FC = resolve(HERE, "../../forecast/src");

export const CORE_ENTRIES = [
  ...["abis", "budget", "chain", "config-core", "data-core", "deployment-core", "kuru", "policy", "pricing", "roll", "snapshot-core", "state-core", "tick"].map((f) => join(SRC, `${f}.ts`)),
  ...["fair", "polymarket-core", "obs-core", "v0-core", "openmeteo-core", "closetime", "stations", "settle-core", "forecast", "fetch-types"].map((f) => join(FC, `${f}.ts`)),
];
const NODE_ONLY = new Set([
  ...["config", "state", "deployment", "data", "snapshot", "node-io", "context", "lock", "runner", "cli", "preflight"].map((f) => join(SRC, `${f}.ts`)),
  ...["http", "polymarket", "obs", "v0", "openmeteo", "close-config", "settlement", "index"].map((f) => join(FC, `${f}.ts`)),
]);

/** Value-import specifiers of a module (type-only imports/exports are erased by esbuild/tsc and are skipped). */
export function valueImports(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];?|^\s*import\s+["']([^"']+)["'];?/gm;
  for (const m of src.matchAll(re)) {
    if (m[5]) {
      out.push(m[5]);
      continue;
    }
    if (m[2]) continue; // import type / export type
    out.push(m[4]);
  }
  return out;
}

test("the shared maker + forecast core has no Node built-ins or Node-only modules in its value-import graph", () => {
  const seen = new Set<string>();
  const stack = [...CORE_ENTRIES];
  const problems: string[] = [];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    if (NODE_ONLY.has(f)) problems.push(`${f} is Node-only but reachable from the core`);
    if (/\bimport\.meta\b/.test(src)) problems.push(`${f} uses import.meta`);
    if (/(^|[^.\w])process\.(env|exit|on|once|argv|cwd|kill)/m.test(src)) problems.push(`${f} uses process.* directly`);
    for (const spec of valueImports(src)) {
      if (spec.startsWith("node:") || ["fs", "path", "os", "url", "crypto", "child_process"].includes(spec)) problems.push(`${f} imports ${spec}`);
      else if (spec.startsWith(".")) stack.push(resolve(dirname(f), spec));
      else if (!/^viem(\/|$)/.test(spec)) problems.push(`${f} imports the package ${spec} (only viem is allowed in the core)`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(seen.size >= CORE_ENTRIES.length);
});

test("valueImports skips type-only imports", () => {
  const src = `import type { A } from "./a.ts";\nimport { b, type C } from "./b.ts";\nexport type { D } from "./d.ts";\nexport * from "./e.ts";\nimport "./f.ts";`;
  assert.deepEqual(valueImports(src), ["./b.ts", "./e.ts", "./f.ts"]);
});
