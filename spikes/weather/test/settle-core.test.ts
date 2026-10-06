// node --test test/   (Node >= 22.18 runs .ts directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { awcDayUrl, dayStats, decide, iemDayUrl, metarTempC, ogimetDayUrl, parseAwcJson, parseIemCsv, parseOgimetText } from "../src/settle-core.ts";
import { parseBucket, slugDate } from "../src/polymarket.ts";

const fx = (n: string) => readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8");
const TPE = 480, TYO = 540;

test("METAR temperature group parsing", () => {
  assert.equal(metarTempC("RCSS 050530Z 09013KT 040V110 9999 FEW015 SCT030 BKN100 25/18 Q1016 NOSIG RMK A3003"), 25);
  assert.equal(metarTempC("XXXX 010000Z 00000KT 9999 M05/M10 Q1030"), -5);
  assert.equal(metarTempC("XXXX 010000Z 00000KT 9999 05/// Q1030"), 5);
  assert.equal(metarTempC("XXXX 010000Z 00000KT R10/1200 9999 12/08 Q1030"), 12); // RVR group is not a temp group
  assert.equal(metarTempC("XXXX 010000Z 00000KT 9999 Q1030 RMK 23/45"), null); // remarks ignored
  assert.equal(metarTempC("RCSS 141630Z NIL"), null);
});

test("exact settlement URLs", () => {
  assert.equal(iemDayUrl("RCSS", "2026-10-05", "Asia/Taipei"),
    "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=RCSS&data=metar&year1=2026&month1=10&day1=5&year2=2026&month2=10&day2=6&tz=Asia/Taipei&format=onlycomma&latlon=no&elev=no&missing=M&trace=T&direct=no&report_type=3&report_type=4");
  assert.equal(awcDayUrl("RCSS", "2026-10-05", TPE), "https://aviationweather.gov/api/data/metar?ids=RCSS&format=json&date=2026-10-05T16:00:00Z&hours=24");
  assert.equal(ogimetDayUrl("RCSS", "2026-10-05", TPE), "https://www.ogimet.com/cgi-bin/getmetar?icao=RCSS&begin=202610041600&end=202610051559");
  assert.equal(iemDayUrl("RJTT", "2026-12-31", "Asia/Tokyo").includes("year1=2026&month1=12&day1=31&year2=2027&month2=1&day2=1"), true);
});

test("RCSS 2026-10-05: IEM and AWC agree on 29 (Polymarket winner 29°C)", () => {
  const a = dayStats(parseIemCsv(fx("iem_RCSS_2026-10-05.csv"), TPE), "2026-10-05", TPE);
  const b = dayStats(parseAwcJson(fx("awc_RCSS_2026-10-05.json")), "2026-10-05", TPE);
  assert.deepEqual([a.tmaxC, a.complete, b.tmaxC, b.complete], [29, true, 29, true]);
  assert.equal(b.nObs, 50); // the inclusive 16:00Z report (= next local day 00:00) is excluded
  assert.deepEqual(decide([a, b], [], false), { status: "SETTLED", tmaxC: 29, reason: "primary sources agree" });
});

test("RJTT 2026-10-05: 22 from both sources", () => {
  const a = dayStats(parseIemCsv(fx("iem_RJTT_2026-10-05.csv"), TYO), "2026-10-05", TYO);
  const b = dayStats(parseAwcJson(fx("awc_RJTT_2026-10-05.json")), "2026-10-05", TYO);
  assert.equal(decide([a, b], [], false).tmaxC, 22);
});

test("RCSS 2026-05-04: AWC aged out -> 2-of-3 fallback IEM+Ogimet = 25 (Polymarket resolved 24: resolver-side miss)", () => {
  const a = dayStats(parseIemCsv(fx("iem_RCSS_2026-05-04.csv"), TPE), "2026-05-04", TPE);
  const b = dayStats(parseAwcJson(fx("awc_RCSS_2026-05-04.json")), "2026-05-04", TPE);
  const c = dayStats(parseOgimetText(fx("ogimet_RCSS_2026-05-04.txt")), "2026-05-04", TPE);
  assert.equal(b.nObs, 0);
  assert.deepEqual(decide([a, b], [c], true), { status: "SETTLED", tmaxC: 25, reason: "2-of-3 fallback agree" });
});

test("RCSS 2025-11-15 (IEM outage): one partial IEM report says 20, truth 26 -> must NOT settle", () => {
  const a = dayStats(parseIemCsv(fx("iem_RCSS_2025-11-15.csv"), TPE), "2025-11-15", TPE);
  const c = dayStats(parseOgimetText(fx("ogimet_RCSS_2025-11-15.txt")), "2025-11-15", TPE);
  assert.deepEqual([a.tmaxC, a.complete, c.tmaxC, c.complete], [20, false, 26, true]);
  const empty = dayStats([], "2025-11-15", TPE);
  assert.equal(decide([a, empty], [c], false).status, "PENDING");
  assert.equal(decide([a, empty], [c], true).status, "VOID");
});

test("complete sources that disagree never settle", () => {
  const s = (t: number) => ({ tmaxC: t, nObs: 48, nHours: 24, lastLocal: "23:30", complete: true });
  assert.equal(decide([s(30), s(31)], [], true).status, "VOID");
  assert.equal(decide([s(30), s(31)], [], false).status, "PENDING");
});

test("Polymarket bucket + slug parsing", () => {
  assert.deepEqual(parseBucket("21°C or below"), { lo: -Infinity, hi: 21, unit: "C" });
  assert.deepEqual(parseBucket("25°C"), { lo: 25, hi: 25, unit: "C" });
  assert.deepEqual(parseBucket("31°C or higher"), { lo: 31, hi: Infinity, unit: "C" });
  assert.deepEqual(parseBucket("86-87°F"), { lo: 86, hi: 87, unit: "F" });
  assert.equal(slugDate("highest-temperature-in-taipei-on-october-5-2026"), "2026-10-05");
});
