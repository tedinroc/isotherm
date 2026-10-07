// Settlement stations (fixed UTC offsets; neither Taiwan, Japan, China nor Korea observes DST).
export interface StationMeta {
  icao: string;
  city: { en: string; zh: string };
  airport: string;
  utcOffsetMin: number;
  test?: boolean;
}

export const STATIONS: Record<string, StationMeta> = {
  RCSS: { icao: 'RCSS', city: { en: 'Taipei', zh: '台北' }, airport: 'Taipei Songshan Airport', utcOffsetMin: 480 },
  RJTT: { icao: 'RJTT', city: { en: 'Tokyo', zh: '東京' }, airport: 'Tokyo Haneda Airport', utcOffsetMin: 540 },
  ZGSZ: { icao: 'ZGSZ', city: { en: 'Shenzhen', zh: '深圳' }, airport: "Shenzhen Bao'an Airport", utcOffsetMin: 480 },
  RKSI: { icao: 'RKSI', city: { en: 'Seoul', zh: '首爾' }, airport: 'Seoul Incheon Airport', utcOffsetMin: 540 },
  VHHH: { icao: 'VHHH', city: { en: 'Hong Kong', zh: '香港' }, airport: 'Hong Kong International Airport', utcOffsetMin: 480 },
};

export function stationMeta(icao: string): StationMeta {
  return (
    STATIONS[icao] ?? {
      icao,
      city: { en: `Test station ${icao}`, zh: `測試站 ${icao}` },
      airport: 'Test station (not a real city; used to rehearse settlement)',
      utcOffsetMin: 0,
      test: true,
    }
  );
}

/** yyyymmdd -> "Oct 8" / "10月8日" */
export function formatDate(date: number, lang: 'en' | 'zh'): string {
  const y = Math.floor(date / 10_000);
  const m = Math.floor(date / 100) % 100;
  const d = date % 100;
  if (lang === 'zh') return `${m}月${d}日`;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function weekday(date: number, lang: 'en' | 'zh'): string {
  const y = Math.floor(date / 10_000);
  const m = Math.floor(date / 100) % 100;
  const d = date % 100;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(lang === 'zh' ? 'zh-TW' : 'en-US', { weekday: 'short', timeZone: 'UTC' });
}

/** The station-local yyyymmdd for a UTC instant. */
export function localDateOf(epochMs: number, utcOffsetMin: number): number {
  const d = new Date(epochMs + utcOffsetMin * 60_000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
