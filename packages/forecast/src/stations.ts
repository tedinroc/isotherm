// Settlement stations. Fixed UTC offsets on purpose: none of these observe DST, and a fixed offset is what a CRE
// workflow (no tz database) and the on-chain Resolver (registerStation offset) reproduce exactly.
//
// `validated` = our METAR rule was checked against Polymarket's resolved winners for this station
// (RCSS 183/184 station-sourced days, RJTT 209/209; spikes/weather/RESULT.md). ZGSZ and RKSI are registered on-chain
// by the deploy script but were NOT validated: the maker refuses to roll them unless forced.
export interface Station {
  icao: string;
  city: string;
  name: string;
  lat: number; // aviationweather.gov station record
  lon: number;
  utcOffsetMin: number;
  tzName: string; // IEM tz= parameter and Open-Meteo timezone=
  polymarketSeriesId: string | null;
  polymarketSlugCity: string;
  validated: boolean;
}

export const STATIONS: Record<string, Station> = {
  RCSS: {
    icao: "RCSS",
    city: "taipei",
    name: "Taipei Songshan Airport",
    lat: 25.069,
    lon: 121.552,
    utcOffsetMin: 8 * 60,
    tzName: "Asia/Taipei",
    polymarketSeriesId: "11346", // taipei-daily-weather
    polymarketSlugCity: "taipei",
    validated: true,
  },
  RJTT: {
    icao: "RJTT",
    city: "tokyo",
    name: "Tokyo Haneda Airport",
    lat: 35.553,
    lon: 139.781,
    utcOffsetMin: 9 * 60,
    tzName: "Asia/Tokyo",
    polymarketSeriesId: "10740", // tokyo-daily-weather
    polymarketSlugCity: "tokyo",
    validated: true,
  },
  ZGSZ: {
    icao: "ZGSZ",
    city: "shenzhen",
    name: "Shenzhen Bao'an Airport",
    lat: 22.639,
    lon: 113.811,
    utcOffsetMin: 8 * 60,
    tzName: "Asia/Shanghai",
    polymarketSeriesId: null,
    polymarketSlugCity: "shenzhen",
    validated: false,
  },
  RKSI: {
    icao: "RKSI",
    city: "seoul",
    name: "Seoul Incheon Airport",
    lat: 37.469,
    lon: 126.451,
    utcOffsetMin: 9 * 60,
    tzName: "Asia/Seoul",
    polymarketSeriesId: null,
    polymarketSlugCity: "seoul",
    validated: false,
  },
};

export function station(icao: string): Station {
  const s = STATIONS[icao.toUpperCase()];
  if (!s) throw new Error(`unknown station ${icao}`);
  return s;
}

/** Local calendar date (YYYY-MM-DD) of a UTC epoch-ms instant at a fixed offset. */
export function localDateOf(epochMs: number, utcOffsetMin: number): string {
  return new Date(epochMs + utcOffsetMin * 60_000).toISOString().slice(0, 10);
}

/** [startUtcMs, endUtcMs) of a local calendar day. */
export function localDayUtcRange(localDate: string, utcOffsetMin: number): [number, number] {
  const midnightUtc = Date.parse(localDate + "T00:00:00Z") - utcOffsetMin * 60_000;
  return [midnightUtc, midnightUtc + 86_400_000];
}

/** UTC epoch ms of local clock time `hhmm` ("16:30") on local date `localDate`. */
export function localTimeToUtcMs(localDate: string, hhmm: string, utcOffsetMin: number): number {
  const [h, m] = hhmm.split(":").map(Number);
  return localDayUtcRange(localDate, utcOffsetMin)[0] + (h * 60 + m) * 60_000;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 2026-10-08 <-> 20261008 (the on-chain uint32 date). */
export const isoToYmd = (iso: string): number => Number(iso.replace(/-/g, ""));
export const ymdToIso = (ymd: number): string => {
  const s = String(ymd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};
