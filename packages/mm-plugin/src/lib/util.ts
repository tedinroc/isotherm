// Small, dependency-free helpers shared by every command.

export function shortErr(e: unknown): string {
  const anyE = e as { shortMessage?: string; message?: string } | undefined;
  const m = anyE?.shortMessage ?? anyE?.message ?? String(e);
  return String(m).split("\n")[0].slice(0, 300);
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Base units -> decimal string, e.g. (1234567n, 6) -> "1.234567". Never uses floats. */
export function fmtUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  if (decimals === 0) return (neg ? "-" : "") + a.toString();
  const s = a.toString().padStart(decimals + 1, "0");
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  return (neg ? "-" : "") + out;
}

/** Decimal string -> base units, rejecting more precision than `decimals` (no silent rounding). */
export function parseUnitsStrict(raw: string, decimals: number, what = "amount"): bigint {
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${what} '${raw}' is not a positive decimal number`);
  const [i, f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`${what} '${raw}' has more than ${decimals} decimals`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Price in (0,1) as a decimal string -> integer units of `precision` (e.g. 0.55, 1e4 -> 5500). */
export function parsePrice(raw: string, precision: number, what = "price"): bigint {
  const digits = Math.round(Math.log10(precision));
  if (10 ** digits !== precision) throw new Error(`price precision ${precision} is not a power of 10`);
  return parseUnitsStrict(raw, digits, what);
}

/** Allowances >= 2^255 are "unlimited" approvals; print them as such instead of a 78-digit number. */
export function fmtAllowance(v: bigint, decimals: number): string {
  return v >= 2n ** 255n ? "unlimited" : fmtUnits(v, decimals);
}

export const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
export const round3 = (x: number) => Math.round(x * 1e3) / 1e3;

/** JSON-safe deep copy: bigint -> decimal string. The mm host serializes command results as JSON. */
export function jsonSafe<T>(x: T): unknown {
  return JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isoUtc(sec: number | bigint): string {
  return new Date(Number(sec) * 1000).toISOString().replace(".000Z", "Z");
}

/** Abramowitz-Stegun 7.1.26 normal CDF (|err| < 1.5e-7). */
export function Phi(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
