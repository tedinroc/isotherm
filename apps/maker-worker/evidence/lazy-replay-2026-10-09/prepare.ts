// Inputs for replay.ts (public, read-only data; no keys):
//   node prepare.ts
// writes, next to this script:
//   pm-history.json  Polymarket CLOB minute price history of every bucket of the Taipei Oct 8, Oct 9 and Oct 10 events
//                    (GET https://clob.polymarket.com/prices-history?market=<YES token>&startTs&endTs&fidelity=1)
//   metar.json       RCSS METAR + SPECI reports Oct 7-10 (IEM ASOS archive), parsed with packages/forecast obs-core
//   chain.json       what the live maker actually did on the 13 Kuru books of these three ladders: its OrderCreated,
//                    OrdersCanceled and Trade (fill) events, grouped by transaction, with block times. Read with
//                    eth_getLogs in 1000-block pages from a public RPC (no keys); block times interpolated from anchors.
import { writeFileSync } from "node:fs";
import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";
import { iemUrl, parseIemBulk } from "../../../../packages/forecast/src/obs-core.ts";

const HERE = new URL(".", import.meta.url).pathname;
const RPC = process.env.LOG_RPC ?? "https://10143.rpc.thirdweb.com"; // 1000-block getLogs pages
const MAKER = "0xd572638F07829D1c3636400FB73CF34Ca6c7448a".toLowerCase();
export const LADDERS = {
  oct8: { slug: "highest-temperature-in-taipei-on-october-8-2026", date: "2026-10-08", pmFrom: "2026-10-07T05:20:00Z", pmTo: "2026-10-08T09:25:00Z", fromBlock: 68892855, markets: { 28: "0x171b4cdE3724f2F17576439e6de8c36142A7DBd7", 29: "0x855eF3549eA5ACA5602EAefDD988950f16FCc6c2", 30: "0x702A7a87EDb18D733c624bF766020F3b66eb36DC", 31: "0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813" } },
  oct9: { slug: "highest-temperature-in-taipei-on-october-9-2026", date: "2026-10-09", pmFrom: "2026-10-08T13:00:00Z", pmTo: "2026-10-09T09:25:00Z", fromBlock: 69270326, markets: { 28: "0x2fDBc274A3c7525a7841957Ce26947fb73A344Dd", 29: "0x7Eeda6F3e72F7453834323Ece05c704014C46F4F", 30: "0x57Ca1C89799c94956161899f47e76bA0BD18f13A", 31: "0xDf7D12b4fbBa494bda735EF66801024b61B5dD30", 32: "0x858967f3C09C702e96385A8c1B1dF3F43A4B2629" } },
  oct10: { slug: "highest-temperature-in-taipei-on-october-10-2026", date: "2026-10-10", pmFrom: "2026-10-09T03:30:00Z", pmTo: null, fromBlock: 69439705, markets: { 28: "0xC6806c67a2faCd6e7fd72e26DA9d037eb2E2a7D3", 29: "0xA747e78cd80DF26b57c4d6E264f3bec39892B5EB", 30: "0x1d26FFF114985d7E25683F47642D552dcdEF7775", 31: "0x5033f84041827549C0BB4774426341a7128e171b" } },
} as const;

const getJson = async (url: string) => {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (i >= 4) throw new Error(`${url}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
  }
};
let rid = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (i >= 5) throw e;
      await new Promise((res) => setTimeout(res, 500 * 2 ** i));
    }
  }
}

// ---------------------------------------------------------------- Polymarket minute history
const pm: Record<string, { slug: string; buckets: { label: string; t: number[]; p: number[] }[] }> = {};
for (const [key, L] of Object.entries(LADDERS)) {
  const ev = (await getJson(`https://gamma-api.polymarket.com/events?slug=${L.slug}`))[0];
  const from = Date.parse(L.pmFrom) / 1000, to = L.pmTo ? Date.parse(L.pmTo) / 1000 : Math.floor(Date.now() / 1000);
  pm[key] = { slug: L.slug, buckets: [] };
  for (const m of ev.markets) {
    const tok = JSON.parse(m.clobTokenIds)[0];
    const h = (await getJson(`https://clob.polymarket.com/prices-history?market=${tok}&startTs=${from}&endTs=${to}&fidelity=1`)).history ?? [];
    pm[key].buckets.push({ label: m.groupItemTitle, t: h.map((x: any) => x.t), p: h.map((x: any) => x.p) });
  }
}
writeFileSync(`${HERE}/pm-history.json`, JSON.stringify(pm));

// ---------------------------------------------------------------- METARs (IEM)
const metar: { t: number; tempC: number; kind: string }[] = [];
for (const rt of [3, 4] as const) {
  const csv = await (await fetch(iemUrl("RCSS", "2026-10-07", "2026-10-11", rt))).text();
  for (const o of parseIemBulk(csv, rt === 3 ? "METAR" : "SPECI")) metar.push({ t: Math.floor(o.tUtc / 1000), tempC: o.tempC, kind: o.kind });
}
metar.sort((a, b) => a.t - b.t);
writeFileSync(`${HERE}/metar.json`, JSON.stringify(metar));

// ---------------------------------------------------------------- what the live maker did on the books
const abi = parseAbi([
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event OrdersCanceled(uint40[] orderId, address owner)",
  "event Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize, address takerAddress, address txOrigin, uint96 filledSize)",
]);
const topics = abi.map((e) => toEventSelector(e));
const marketOf = new Map<string, { ladder: string; k: number }>();
for (const [key, L] of Object.entries(LADDERS)) for (const [k, a] of Object.entries(L.markets)) marketOf.set(a.toLowerCase(), { ladder: key, k: Number(k) });
const head = Number(await rpc("eth_blockNumber", []));
const start = Math.min(...Object.values(LADDERS).map((l) => l.fromBlock));
const anchors: [number, number][] = [];
for (let b = start; b <= head; b += 5000) anchors.push([b, Number((await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), false])).timestamp)]);
anchors.push([head, Number((await rpc("eth_getBlockByNumber", ["0x" + head.toString(16), false])).timestamp)]);
const timeOf = (b: number) => {
  let i = anchors.findIndex(([x]) => x > b);
  if (i <= 0) i = i === 0 ? 1 : anchors.length - 1;
  const [b0, t0] = anchors[i - 1], [b1, t1] = anchors[i];
  return +(t0 + ((b - b0) * (t1 - t0)) / (b1 - b0)).toFixed(1);
};
const pages: [number, number][] = [];
for (let b = start; b <= head; b += 1000) pages.push([b, Math.min(head, b + 999)]);
const raw: any[] = [];
for (let i = 0; i < pages.length; i += 6) {
  const got = await Promise.all(pages.slice(i, i + 6).map(([a, z]) => rpc("eth_getLogs", [{ address: [...marketOf.keys()], fromBlock: "0x" + a.toString(16), toBlock: "0x" + z.toString(16), topics: [topics] }])));
  for (const g of got) raw.push(...g);
}
type Ev = { kind: string; orderId?: number; ids?: number[]; isBuy?: boolean; price?: number; size?: number; filled?: number; taker?: string };
const txs = new Map<string, { hash: string; block: number; t: number; ladder: string; k: number; maker: boolean; events: Ev[] }>();
for (const l of raw) {
  const m = marketOf.get(l.address.toLowerCase())!;
  const ev = decodeEventLog({ abi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }) as any;
  const a = ev.args;
  let e: Ev | null = null, mine = false;
  if (ev.eventName === "OrderCreated") (mine = a.owner.toLowerCase() === MAKER), (e = { kind: "create", orderId: Number(a.orderId), isBuy: a.isBuy, price: Number(a.price) / 1e4, size: Number(a.size) / 1e6 });
  else if (ev.eventName === "OrdersCanceled") (mine = a.owner.toLowerCase() === MAKER), (e = { kind: "cancel", ids: a.orderId.map(Number) });
  else if (ev.eventName === "Trade") (mine = a.makerAddress.toLowerCase() === MAKER), (e = { kind: "fill", orderId: Number(a.orderId), isBuy: a.isBuy, price: Number(a.price) / 1e18, filled: Number(a.filledSize) / 1e6, taker: a.takerAddress.toLowerCase() });
  if (!e || !mine) continue;
  const key = `${l.transactionHash}:${l.address.toLowerCase()}`;
  const b = Number(l.blockNumber);
  if (!txs.has(key)) txs.set(key, { hash: l.transactionHash, block: b, t: timeOf(b), ladder: m.ladder, k: m.k, maker: e.kind !== "fill", events: [] });
  txs.get(key)!.events.push(e);
}
const rows = [...txs.values()].sort((x, y) => x.block - y.block);
writeFileSync(`${HERE}/chain.json`, JSON.stringify({ rpc: RPC, head, headTime: anchors.at(-1)![1], start, rows }));
console.log(`pm buckets ${Object.values(pm).map((e) => e.buckets.length).join("+")}, metar ${metar.length}, maker events in ${rows.length} (tx, book) pairs, blocks ${start}..${head}`);
