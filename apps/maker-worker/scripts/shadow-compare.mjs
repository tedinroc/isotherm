// Shadow vs live maker, tick by tick (pure: no I/O; `control.mjs compare` feeds it). Used for the cutover review.
//
// Inputs: the Worker's tick lines (KV `ticks:recent`, one entry per tick with per-strike decisions and the live
// maker's published snapshot at that tick) and the live maker's tx lines (the Mac's maker.log JSON lines).
// Per shadow tick and strike:
//   - action "none": the shadow is happy with the book as the live maker left it -> agree;
//   - a would-send (quote / requote / pull): agree if the live maker sent the same (same strike, same prices, or a
//     pull) within [-10 s, +90 s] of the tick; otherwise it is classified as timing when its inputs differ from the
//     live maker's (the hourly v0 guard refreshed at another minute, or Polymarket moved), else UNEXPLAINED.
// Per live-maker tx: agree if a shadow tick within [-90 s, +10 s] wanted the same, or the next shadow tick saw the
// new book and wanted no change; otherwise UNEXPLAINED (a decision the shadow never made).

const parseQuote = (q) => {
  const m = /^(-|[\d.]+)\/(-|[\d.]+)$/.exec(q ?? "");
  return m ? { bid: m[1] === "-" ? null : Number(m[1]), ask: m[2] === "-" ? null : Number(m[2]) } : null;
};

/** Mac maker.log lines -> [{ t (ms), kind, k, bid, ask }] for quote/requote/pull/KILL txs. */
export function macTxs(makerLogText) {
  const out = [];
  for (const line of makerLogText.split("\n")) {
    if (!line.includes('"tx ')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const m = /^tx maker\s+(quote|requote|pull|KILL) >=(\d+)(?: \d+@([\d.]+|-) \/ \d+@([\d.]+|-))?/.exec(j.msg ?? "");
    if (!m) continue;
    out.push({ t: Date.parse(j.t), kind: m[1], k: Number(m[2]), bid: m[3] && m[3] !== "-" ? Number(m[3]) : null, ask: m[4] && m[4] !== "-" ? Number(m[4]) : null, msg: j.msg.slice(0, 120) });
  }
  return out;
}

export function compare(ticks, txs, o = {}) {
  const tol = o.fairTol ?? 0.004;
  const shadow = ticks.filter((t) => t.mode === "shadow");
  const res = { ticks: shadow.length, from: shadow[0]?.at ?? null, to: shadow.at(-1)?.at ?? null, pairs: 0, verdicts: {}, items: [], macTxs: 0, macVerdicts: {} };
  const bump = (m, k) => (m[k] = (m[k] ?? 0) + 1);
  // the guard flags come from |fair - guard| against fair.guardWarn / guardPull (config/default.json: 0.15 / 0.40)
  const band = (f, g) => (f === null || g === null ? null : Math.abs(f - g) >= (o.guardPull ?? 0.4) ? 2 : Math.abs(f - g) >= (o.guardWarn ?? 0.15) ? 1 : 0);
  const same = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1e-9;
  for (const t of shadow) {
    const T = Date.parse(t.at);
    for (const s of t.strikes ?? []) {
      if (!s.mac || typeof s.mac === "string") continue; // "missing", or a line from before the structured format
      res.pairs++;
      let v;
      if (s.action === "none" || s.action === null) v = "agree";
      else {
        const want = parseQuote(s.desired);
        const hit = txs.find((x) => x.k === s.k && x.t >= T - 10_000 && x.t <= T + 90_000 && (s.action === "pull" ? x.kind === "pull" : x.kind !== "pull" && want && same(x.bid, want.bid) && same(x.ask, want.ask)));
        if (hit) v = "agree (the live maker sent the same tx)";
        else {
          const bw = band(s.fair, s.guard), bm = band(s.mac.fair, s.mac.guard);
          // the guard alone flips the spread band: with the live maker's guard, the shadow's own fair would be quoted
          // like the live maker's -> the two v0 snapshots differ (each refreshes hourly on its own clock)
          if (bw !== bm && s.guard !== null && s.mac.guard !== null && Math.abs(s.guard - s.mac.guard) > 0.0005 && band(s.fair, s.mac.guard) !== bw) v = "timing: v0 guard refreshed at another minute";
          else if (bw !== bm || (s.fair !== null && s.mac.fair !== null && Math.abs(s.fair - s.mac.fair) >= tol)) v = "timing: Polymarket moved between the two ticks";
          else v = "UNEXPLAINED";
        }
      }
      bump(res.verdicts, v);
      if (v !== "agree") res.items.push({ at: t.at, key: s.key, k: s.k, shadow: `${s.action} want ${s.desired} rest ${s.resting} fair ${s.fair} guard ${s.guard} [${(s.flags ?? []).join(",")}]`, live: `fair ${s.mac.fair} guard ${s.mac.guard} quote ${s.mac.quote}`, verdict: v });
    }
  }
  if (shadow.length) {
    const t0 = Date.parse(shadow[0].at), t1 = Date.parse(shadow.at(-1).at);
    for (const x of txs.filter((x) => x.t >= t0 && x.t <= t1 && x.kind !== "KILL")) {
      res.macTxs++;
      const predicted = shadow.some((t) => {
        const T = Date.parse(t.at);
        if (T < x.t - 90_000 || T > x.t + 10_000) return false;
        const s = (t.strikes ?? []).find((y) => y.k === x.k);
        if (!s || !s.action || s.action === "none") return false;
        const w = parseQuote(s.desired);
        return x.kind === "pull" ? s.action === "pull" : w && same(w.bid, x.bid) && same(w.ask, x.ask);
      });
      const next = shadow.find((t) => Date.parse(t.at) > x.t + 2_000);
      const ns = next?.strikes?.find((y) => y.k === x.k);
      const r = parseQuote(ns?.resting);
      const after = !!ns && (ns.action === "none" || ns.action === null) && (x.kind === "pull" ? r?.bid === null && r?.ask === null : r && same(r.bid, x.bid) && same(r.ask, x.ask));
      const v = predicted ? "predicted by the shadow" : after ? "agreed after (the next shadow tick wanted no change)" : "UNEXPLAINED";
      bump(res.macVerdicts, v);
      if (v === "UNEXPLAINED") res.items.push({ at: new Date(x.t).toISOString(), k: x.k, live: x.msg, verdict: "live maker tx the shadow never wanted" });
    }
  }
  const agree = Object.entries(res.verdicts).filter(([k]) => k.startsWith("agree")).reduce((a, [, n]) => a + n, 0);
  const timing = Object.entries(res.verdicts).filter(([k]) => k.startsWith("timing")).reduce((a, [, n]) => a + n, 0);
  res.agreementPct = res.pairs ? +((100 * agree) / res.pairs).toFixed(1) : null;
  res.explainedPct = res.pairs ? +((100 * (agree + timing)) / res.pairs).toFixed(1) : null;
  return res;
}
