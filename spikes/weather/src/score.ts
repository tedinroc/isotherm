// Probability scoring for P(Tmax >= k) ladders.
export interface Eval {
  date: string;
  k: number;
  p: number;
  y: 0 | 1;
}

export const CLIP = 0.01; // same clip for every forecaster in log loss (Polymarket prints 0.0005)

export const brier = (es: Eval[]) => es.reduce((s, e) => s + (e.p - e.y) ** 2, 0) / es.length;
export const logLoss = (es: Eval[], clip = CLIP) =>
  es.reduce((s, e) => {
    const p = Math.min(1 - clip, Math.max(clip, e.p));
    return s - (e.y ? Math.log(p) : Math.log(1 - p));
  }, 0) / es.length;

/** Reliability table: 10 equal-width bins of forecast probability. */
export function reliability(es: Eval[], bins = 10) {
  const b = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, meanP: 0, freq: 0 }));
  for (const e of es) {
    const i = Math.min(bins - 1, Math.floor(e.p * bins));
    b[i].n++;
    b[i].meanP += e.p;
    b[i].freq += e.y;
  }
  return b.filter((x) => x.n).map((x) => ({ bin: `${x.lo.toFixed(1)}-${x.hi.toFixed(1)}`, n: x.n, meanP: +(x.meanP / x.n).toFixed(3), obsFreq: +(x.freq / x.n).toFixed(3) }));
}

/** Deterministic PRNG so bootstrap CIs are reproducible. */
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired day-block bootstrap of mean(score A) - mean(score B). Strikes within a day are strongly correlated,
 * so the resampling unit is the day. Returns [diff, lo95, hi95, P(diff<0)].
 */
export function pairedBootstrap(a: Eval[], b: Eval[], score: (es: Eval[]) => number, iters = 4000) {
  const days = [...new Set(a.map((e) => e.date))];
  const A = new Map<string, Eval[]>(), B = new Map<string, Eval[]>();
  for (const e of a) (A.get(e.date) ?? A.set(e.date, []).get(e.date)!).push(e);
  for (const e of b) (B.get(e.date) ?? B.set(e.date, []).get(e.date)!).push(e);
  const point = score(a) - score(b);
  const rnd = mulberry32(42);
  const diffs: number[] = [];
  for (let it = 0; it < iters; it++) {
    const ra: Eval[] = [], rb: Eval[] = [];
    for (let i = 0; i < days.length; i++) {
      const d = days[Math.floor(rnd() * days.length)];
      ra.push(...A.get(d)!);
      rb.push(...B.get(d)!);
    }
    diffs.push(score(ra) - score(rb));
  }
  diffs.sort((x, y) => x - y);
  return {
    diff: +point.toFixed(5),
    ci95: [+diffs[Math.floor(0.025 * iters)].toFixed(5), +diffs[Math.floor(0.975 * iters)].toFixed(5)],
    pAbetter: +(diffs.filter((d) => d < 0).length / iters).toFixed(3),
    days: days.length,
  };
}

// ---------------------------------------------------------------- causal logistic stacking
const logit = (p: number) => {
  const q = Math.min(0.99, Math.max(0.01, p));
  return Math.log(q / (1 - q));
};
/** Fit y ~ sigmoid(w . [1, logit(x1), logit(x2)...]) by IRLS with a small ridge penalty. */
export function fitLogistic(X: number[][], y: number[], ridge = 1.0, iters = 25): number[] {
  const d = X[0].length + 1;
  let w = new Array(d).fill(0);
  w[1] = 1; // start at "trust the first input"
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    const g = new Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const z = [1, ...X[i].map(logit)];
      const p = 1 / (1 + Math.exp(-z.reduce((s, v, j) => s + v * w[j], 0)));
      const r = p * (1 - p);
      for (let a = 0; a < d; a++) {
        g[a] += (p - y[i]) * z[a];
        for (let b = 0; b < d; b++) H[a][b] += r * z[a] * z[b];
      }
    }
    for (let a = 1; a < d; a++) {
      g[a] += ridge * (w[a] - (a === 1 ? 1 : 0)); // shrink toward identity on the first input
      H[a][a] += ridge;
    }
    // solve H dw = g (Gaussian elimination)
    const M = H.map((row, i) => [...row, g[i]]);
    for (let c = 0; c < d; c++) {
      let piv = c;
      for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < d; r++) {
        if (r === c || M[c][c] === 0) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= d; k++) M[r][k] -= f * M[c][k];
      }
    }
    const dw = M.map((row, i) => row[d] / row[i]);
    w = w.map((v, i) => v - dw[i]);
    if (dw.every((x) => Math.abs(x) < 1e-6)) break;
  }
  return w;
}
export function predictLogistic(w: number[], x: number[]): number {
  const z = [1, ...x.map(logit)];
  return 1 / (1 + Math.exp(-z.reduce((s, v, j) => s + v * w[j], 0)));
}
