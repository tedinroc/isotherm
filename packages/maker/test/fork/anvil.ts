// Fork harness: our own anvil on a port in 19150-19199 forking live Monad testnet (anvil auto-detects Monad rules).
// Only the PID started here is ever killed.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Anvil {
  url: string;
  port: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function startAnvil(port: number, logDir: string, forkUrl = "https://testnet-rpc.monad.xyz"): Promise<Anvil> {
  mkdirSync(logDir, { recursive: true });
  const bin = join(homedir(), ".foundry/bin/anvil");
  const log = createWriteStream(join(logDir, `anvil-${port}.log`));
  const proc = spawn(bin, ["--fork-url", forkUrl, "--port", String(port), "--retries", "8", "--fork-retry-backoff", "800", "--timeout", "60000"], { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.pipe(log);
  proc.stderr!.pipe(log);
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode} (port ${port} busy?)`);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 90_000) throw new Error("anvil did not come up");
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    url,
    port,
    proc,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    },
  };
}

export async function rpc(url: string, method: string, params: unknown[] = []): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
