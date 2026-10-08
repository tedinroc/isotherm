// Fair value per strike = the Polymarket-implied P(Tmax >= k), conditioned on the observed max so far.
// v0 (or, on the day itself, the 2-year intraday increment table) is a GUARDRAIL: a large disagreement widens the
// maker's spread, a huge one pulls the strike. Without a usable Polymarket ladder the guard becomes a FALLBACK fair
// (the maker widens further). Pure: no I/O.
// Imports only runtime-agnostic modules (the *-core.ts files, closetime.ts), so the Cloudflare Worker uses it as is.
import { pAtLeast, type LiveLadder } from "./polymarket-core.ts";
import type { ObservedMax } from "./obs-core.ts";
import { pIncrementAtLeast, type CloseTimeStats } from "./closetime.ts";
import { v0At, type V0Ladder } from "./v0-core.ts";

export interface FairCfg {
  pmMaxAgeSec: number; // older Polymarket data is not used as the quote source
  guardWarn: number; // |fair - guard| above this -> flag "guard-wide" (maker widens)
  guardPull: number; // above this -> flag "guard-pull" (maker pulls the strike)
  intradayFromMin: number; // on day D, after this local minute the guard uses the increment table instead of v0
  minCondMass: number; // only condition the PM ladder on the observed max when P_pm(>= m) is at least this
}
export const DEFAULT_FAIR_CFG: FairCfg = { pmMaxAgeSec: 20 * 60, guardWarn: 0.15, guardPull: 0.4, intradayFromMin: 11 * 60, minCondMass: 0.05 };

export type FairSource = "polymarket" | "certain" | "fallback-v0" | "fallback-intraday" | "none";

export interface StrikeFair {
  k: number;
  fair: number | null;
  source: FairSource;
  pm: number | null; // raw implied P(>=k)
  pmCond: number | null; // conditioned on the observed max
  pmDetermined: boolean;
  guard: number | null;
  guardSource: "v0" | "v0-truncated" | "intraday" | "certain" | null;
  divergence: number | null;
  certain: "yes" | null; // observed max >= k -> YES can no longer lose
  flags: string[];
}

export interface FairInput {
  strikes: number[];
  nowMs: number;
  localMinute: number | null; // minutes after the station's local midnight, if the date is today; else null
  pm: LiveLadder | null;
  pmFetchedMs: number | null;
  obs: ObservedMax | null;
  v0: Pick<V0Ladder, "ladder"> | null;
  intraday: Pick<CloseTimeStats, "incrementTable"> | null;
  cfg?: Partial<FairCfg>;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function computeFairs(inp: FairInput): StrikeFair[] {
  const cfg = { ...DEFAULT_FAIR_CFG, ...inp.cfg };
  const m = inp.obs && inp.obs.dayStarted && inp.obs.tmaxC !== null ? inp.obs.tmaxC : null;
  const pmFresh = !!inp.pm && inp.pm.ok && inp.pmFetchedMs !== null && (inp.nowMs - inp.pmFetchedMs) / 1000 <= cfg.pmMaxAgeSec;
  const pmMassAtM = inp.pm && m !== null ? pAtLeast(inp.pm, m) : null;
  return inp.strikes.map((k) => {
    const flags: string[] = [];
    // ---- certainty from observations
    if (m !== null && k <= m)
      return { k, fair: 1, source: "certain", pm: inp.pm ? pAtLeast(inp.pm, k).p : null, pmCond: 1, pmDetermined: true, guard: 1, guardSource: "certain", divergence: 0, certain: "yes", flags: ["observed-max>=k"] } as StrikeFair;
    // ---- guard
    let guard: number | null = null;
    let guardSource: StrikeFair["guardSource"] = null;
    if (m !== null && inp.intraday && inp.localMinute !== null && inp.localMinute >= cfg.intradayFromMin) {
      guard = pIncrementAtLeast(inp.intraday, inp.localMinute, m, k);
      guardSource = "intraday";
    } else if (inp.v0) {
      const g = v0At(inp.v0, k);
      if (m !== null) {
        const gm = v0At(inp.v0, m);
        guard = gm >= 0.02 ? clamp01(g / gm) : g;
        guardSource = "v0-truncated";
      } else {
        guard = g;
        guardSource = "v0";
      }
    }
    // ---- Polymarket
    let pm: number | null = null, pmCond: number | null = null, pmDetermined = false;
    if (inp.pm) {
      const r = pAtLeast(inp.pm, k);
      pm = Number.isFinite(r.p) ? r.p : null;
      pmDetermined = r.determined;
      pmCond = pm;
      if (pm !== null && m !== null && pmMassAtM && Number.isFinite(pmMassAtM.p) && pmMassAtM.p >= cfg.minCondMass) pmCond = clamp01(pm / pmMassAtM.p);
      if (!pmDetermined) flags.push("pm-extrapolated");
      if (!inp.pm.ok) flags.push("pm-degraded");
    }
    let fair: number | null = null;
    let source: FairSource = "none";
    if (pmFresh && pmCond !== null && pmDetermined) {
      fair = pmCond;
      source = "polymarket";
    } else if (guard !== null) {
      fair = guard;
      source = guardSource === "intraday" ? "fallback-intraday" : "fallback-v0";
      flags.push(inp.pm ? (pmFresh ? "pm-strike-not-on-grid" : "pm-stale-or-degraded") : "no-polymarket-market");
    }
    const divergence = fair !== null && guard !== null && source === "polymarket" ? +Math.abs(fair - guard).toFixed(4) : null;
    if (divergence !== null && divergence > cfg.guardPull) flags.push("guard-pull");
    else if (divergence !== null && divergence > cfg.guardWarn) flags.push("guard-wide");
    return {
      k,
      fair: fair === null ? null : +fair.toFixed(4),
      source,
      pm: pm === null ? null : +pm.toFixed(4),
      pmCond: pmCond === null ? null : +pmCond.toFixed(4),
      pmDetermined,
      guard: guard === null ? null : +guard.toFixed(4),
      guardSource,
      divergence,
      certain: null,
      flags,
    };
  });
}
