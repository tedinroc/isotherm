// Settlement stations. Fixed UTC offsets on purpose: neither Taiwan nor Japan observes DST,
// and a fixed offset is what a CRE workflow (no tz database) can reproduce exactly.
export interface Station {
  icao: string;
  city: string;
  name: string;
  lat: number; // from aviationweather.gov station record
  lon: number;
  utcOffsetMin: number;
  tzName: string; // for IEM's tz= parameter and Open-Meteo timezone=
  polymarketSeriesId: string;
  polymarketSlugCity: string;
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

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
