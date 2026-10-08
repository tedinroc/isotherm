// Inputs for replay.ts (read-only everywhere):
//   node prepare.ts <maker.log> <txs.jsonl>      (the Mac maker's var/ files)
// writes, next to this script:
//   mac-ticks.json   the Mac maker's tick start times (unix s), from "tick N done in X ms" lines
//   mac-quotes.json  the Mac maker's quote / requote / pull txs: { t, k, kind, bid, ask, mon }
//   pm-history.json  Polymarket CLOB minute price history of every bucket of the Taipei Oct 8 and Oct 9 events
//                    (GET https://clob.polymarket.com/prices-history?market=<YES token>&startTs&endTs&fidelity=1)
import { readFileSync, writeFileSync } from "node:fs";

const HERE = new URL(".", import.meta.url).pathname;
const [, , makerLog, txsJsonl] = process.argv;
if (!makerLog || !txsJsonl) throw new Error("usage: node prepare.ts <maker.log> <txs.jsonl>");

const ticks: number[] = [];
for (const l of readFileSync(makerLog, "utf8").split("\n").filter(Boolean)) {
  const j = JSON.parse(l);
  const m = String(j.msg).match(/^tick \d+ done in (\d+) ms/);
  if (m) ticks.push(+(Date.parse(j.t) / 1000 - Number(m[1]) / 1000).toFixed(3));
}
writeFileSync(`${HERE}/mac-ticks.json`, JSON.stringify(ticks));

const quotes: { t: number; k: number; kind: string; bid: number | null; ask: number | null; mon: number }[] = [];
for (const l of readFileSync(txsJsonl, "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(l);
  if (r.role !== "maker") continue;
  let m = String(r.label).match(/^(re)?quote >=(\d+) \d+@([\d.-]+) \/ \d+@([\d.-]+)/);
  if (m) quotes.push({ t: Date.parse(r.t) / 1000, k: +m[2], kind: m[1] ? "requote" : "quote", bid: m[3] === "-" ? null : +m[3], ask: m[4] === "-" ? null : +m[4], mon: r.mon });
  else if ((m = String(r.label).match(/^pull >=(\d+)/))) quotes.push({ t: Date.parse(r.t) / 1000, k: +m[1], kind: "pull", bid: null, ask: null, mon: r.mon });
}
writeFileSync(`${HERE}/mac-quotes.json`, JSON.stringify(quotes));

const EVENTS: [string, string, number, number][] = [
  ["oct8", "highest-temperature-in-taipei-on-october-8-2026", Date.parse("2026-10-07T05:20:00Z") / 1000, Date.parse("2026-10-08T09:25:00Z") / 1000],
  ["oct9", "highest-temperature-in-taipei-on-october-9-2026", Date.parse("2026-10-08T13:00:00Z") / 1000, Math.floor(Date.now() / 1000)],
];
const out: Record<string, { slug: string; buckets: { label: string; t: number[]; p: number[] }[] }> = {};
for (const [key, slug, from, to] of EVENTS) {
  const ev = (await (await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`)).json())[0];
  out[key] = { slug, buckets: [] };
  for (const m of ev.markets) {
    const tok = JSON.parse(m.clobTokenIds)[0];
    const h = (await (await fetch(`https://clob.polymarket.com/prices-history?market=${tok}&startTs=${from}&endTs=${to}&fidelity=1`)).json()).history ?? [];
    out[key].buckets.push({ label: m.groupItemTitle, t: h.map((x: any) => x.t), p: h.map((x: any) => x.p) });
  }
}
writeFileSync(`${HERE}/pm-history.json`, JSON.stringify(out));
console.log(`mac-ticks ${ticks.length}, mac-quotes ${quotes.length}, pm buckets ${Object.values(out).map((e) => e.buckets.length).join("+")}`);
