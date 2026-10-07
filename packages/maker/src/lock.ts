// Single-writer lock for the maker key + state file (O_EXCL lock file with pid; a dead pid's lock is stolen),
// a heartbeat file the separate watchdog job reads, and a request queue so the daily roll job can hand work to a
// running loop instead of fighting it for the lock.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LockInfo {
  pid: number;
  cmd: string;
  at: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(file: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Returns a release function, or the current holder if another live process holds the lock. */
export function acquireLock(file: string, cmd: string): { release: () => void } | { heldBy: LockInfo } {
  mkdirSync(dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, cmd, at: Math.floor(Date.now() / 1000) }), { flag: "wx" });
      const release = () => {
        const cur = readLock(file);
        if (cur?.pid === process.pid) try { unlinkSync(file); } catch {}
      };
      process.once("exit", release);
      return { release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const cur = readLock(file);
      if (cur && cur.pid !== process.pid && alive(cur.pid)) return { heldBy: cur };
      try { unlinkSync(file); } catch {} // stale lock (dead pid or unreadable)
    }
  }
  const cur = readLock(file);
  return { heldBy: cur ?? { pid: -1, cmd: "unknown", at: 0 } };
}

export function writeHeartbeat(file: string, extra: Record<string, unknown> = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify({ pid: process.pid, at: Math.floor(Date.now() / 1000), ...extra }));
  renameSync(file + ".tmp", file);
}

export function heartbeatAge(file: string): number | null {
  if (!existsSync(file)) return null;
  try {
    return Math.floor(Date.now() / 1000) - JSON.parse(readFileSync(file, "utf8")).at;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- request queue (roll job -> running loop)
export interface RollRequest {
  station: string;
  isoDate: string;
  strikes?: number[];
  noFaucet?: boolean;
  at: number;
}
export const requestDir = (stateFile: string) => join(dirname(stateFile), "requests");

export function enqueueRoll(stateFile: string, r: RollRequest): string {
  const dir = requestDir(stateFile);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `roll-${r.station}-${r.isoDate}.json`);
  writeFileSync(f, JSON.stringify(r));
  return f;
}

export function takeRollRequests(stateFile: string): { file: string; req: RollRequest }[] {
  const dir = requestDir(stateFile);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^roll-.*\.json$/.test(f))
    .map((f) => ({ file: join(dir, f), req: JSON.parse(readFileSync(join(dir, f), "utf8")) as RollRequest }));
}
