// JSON snapshot for the API/PWA: fair values, the Polymarket ladder, our quotes, the Kuru books, the observed max
// and the MON budget. Written to var/snapshot.json and POSTed to <api>/api/snapshot with a bearer token.
// Schema id: "isotherm.snapshot/v1" (documented in RESULT.md; example in examples/snapshot.example.json).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ctx } from "./chain.ts";
import type { Snapshot } from "./snapshot-core.ts";

export * from "./snapshot-core.ts";

export function writeSnapshot(file: string, snap: Snapshot) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(snap, null, 1));
  renameSync(file + ".tmp", file);
}

let warnedNoApi = false;
export async function postSnapshot(ctx: Ctx, snap: Snapshot): Promise<{ ok: boolean; status?: number; error?: string; skipped?: string }> {
  const url = ctx.cfg.api.url;
  const token = process.env[ctx.cfg.api.tokenEnv];
  if (!url || !token) {
    if (!warnedNoApi) ctx.log.info(`snapshot POST skipped: set ISOTHERM_API_URL and ${ctx.cfg.api.tokenEnv}`);
    warnedNoApi = true;
    return { ok: false, skipped: "no api url/token" };
  }
  try {
    const res = await fetch(url.replace(/\/$/, "") + ctx.cfg.api.path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(snap),
      signal: AbortSignal.timeout(ctx.cfg.api.timeoutMs),
    });
    if (!res.ok) ctx.log.warn(`snapshot POST ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    ctx.log.warn(`snapshot POST failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
    return { ok: false, error: String(e) };
  }
}
