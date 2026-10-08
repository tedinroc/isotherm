// Runs apps/maker-worker/scripts/shadow-compare.mjs (the tool behind control.mjs compare) over the recorder's full tick
// reports: node compare-mjs.mjs <rec-dir> <maker.log> <since|''> <until|''> <abs path of scripts/shadow-compare.mjs>
import { readFileSync } from 'node:fs';
const [, , recDir, makerLog, since, until, toolPath] = process.argv;
const { compare, macTxs } = await import(toolPath);
const fmt = (b, a) => `${b ?? '-'}/${a ?? '-'}`;
const lines = readFileSync(`${recDir}/worker-ticks.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((t) => (!since || t.at >= since) && (!until || t.at < until))
  .map((t) => ({ at: t.at, ms: t.ms, mode: t.mode, block: t.block, intents: t.intents.map((i) => i.label), txs: [], errors: t.errors, alerts: t.alerts, kill: [], rolls: [],
    strikes: t.ladders.flatMap((l) => l.strikes.map((s) => ({ key: l.key, k: s.k, fair: s.fair, guard: s.guard ?? null, flags: s.flags, action: s.action,
      desired: s.desired === null ? '-' : 'pull' in s.desired ? 'pull' : fmt(s.desired.bid, s.desired.ask), resting: fmt(s.resting.bid, s.resting.ask), reasons: (s.reasons || []).join('; '),
      mac: s.mac === undefined ? null : s.mac === null ? 'missing' : { fair: s.mac.fair, guard: s.mac.guard ?? null, quote: fmt(s.mac.bid, s.mac.ask), mode: s.mac.mode } }))) }));
const r = compare(lines, macTxs(readFileSync(makerLog, 'utf8')));
console.log(JSON.stringify({ window: [r.from, r.to], ticks: r.ticks, pairs: r.pairs, agreementPct: r.agreementPct, explainedPct: r.explainedPct, verdicts: r.verdicts, macTxs: r.macTxs, macVerdicts: r.macVerdicts }, null, 1));
for (const i of r.items) console.log(`  ${i.at} ${i.key ?? ''} >=${i.k} ${i.verdict} | shadow: ${i.shadow ?? '-'} | live: ${i.live}`);
