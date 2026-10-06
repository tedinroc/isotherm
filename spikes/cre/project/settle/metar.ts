// Pure METAR helpers: no SDK imports, so they run unchanged under Bun tests,
// Node scripts and inside the CRE WASM (QuickJS) runtime.
//
// Settlement rule (mirrors Polymarket's city-temperature markets):
//   Tmax = max over all METAR/SPECI temperature groups "TT/DD" reported by the
//   airport station during the station's LOCAL calendar day, in integer °C.

export type DayWindow = { startMs: number; endMs: number } // [start, end) in UTC ms

/** "2026-10-05" -> 20261005 */
export const ymdToInt = (ymd: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`bad date ${ymd}`)
  return Number(ymd.replaceAll('-', ''))
}

/** Local calendar day [00:00, 24:00) for a fixed UTC offset (Asian stations have no DST). */
export const localDayWindow = (ymd: string, tzOffsetMin: number): DayWindow => {
  const [y, m, d] = ymd.split('-').map(Number)
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) - tzOffsetMin * 60_000
  return { startMs, endMs: startMs + 86_400_000 }
}

/** The local date that ended most recently before `nowMs` (i.e. "yesterday" in station time). */
export const previousLocalDate = (nowMs: number, tzOffsetMin: number): string => {
  const local = new Date(nowMs + tzOffsetMin * 60_000 - 86_400_000)
  return local.toISOString().slice(0, 10)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Parses the temperature group (e.g. "29/24", "M01/M03", "05/") from a METAR/SPECI string. */
export const parseMetarTempC = (metar: string): number | null => {
  // Whitespace-delimited group: TT/DD where TT is 2 digits optionally prefixed by M (minus).
  // RVR groups (R10/1200) and US fractional visibility (1/2SM) cannot match this pattern.
  const m = metar.match(/(?:^|\s)(M?\d{2})\/(M?\d{2})?(?=\s|$)/)
  if (!m) return null
  const t = m[1]
  return t.startsWith('M') ? -Number(t.slice(1)) : Number(t)
}

/** Extracts the "ddhhmmZ" observation time and anchors it to the month that falls inside `w`. */
export const metarObsTimeMs = (metar: string, w: DayWindow): number | null => {
  const m = metar.match(/\b(\d{2})(\d{2})(\d{2})Z\b/)
  if (!m) return null
  const [dd, hh, mi] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // Try the window's month and its neighbours; keep the candidate closest to the window.
  const ref = new Date(w.startMs)
  const distance = (t: number) => (t < w.startMs ? w.startMs - t : t >= w.endMs ? t - w.endMs + 1 : 0)
  let best: number | null = null
  for (const dm of [-1, 0, 1]) {
    const t = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + dm, dd, hh, mi)
    if (best === null || distance(t) < distance(best)) best = t
  }
  return best
}

export type SourceResult = { tmax: number; obs: number }

const summarize = (temps: number[]): SourceResult => {
  if (temps.length === 0) throw new Error('no observations in window')
  return { tmax: Math.max(...temps), obs: temps.length }
}

// ---------------------------------------------------------------- IEM ASOS

/** IEM request covering the window (UTC timestamps, raw METAR text, routine + SPECI). */
export const iemUrl = (base: string, station: string, w: DayWindow): string => {
  const a = new Date(w.startMs)
  const b = new Date(w.endMs)
  return (
    `${base}?station=${station}&data=metar&tz=Etc%2FUTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no` +
    `&report_type=3&report_type=4` +
    `&year1=${a.getUTCFullYear()}&month1=${a.getUTCMonth() + 1}&day1=${a.getUTCDate()}&hour1=${a.getUTCHours()}&minute1=${a.getUTCMinutes()}` +
    `&year2=${b.getUTCFullYear()}&month2=${b.getUTCMonth() + 1}&day2=${b.getUTCDate()}&hour2=${b.getUTCHours()}&minute2=${b.getUTCMinutes()}`
  )
}

/** CSV "station,valid,metar" with valid = "YYYY-MM-DD HH:MM" in UTC. */
export const parseIemCsv = (csv: string, station: string, w: DayWindow): SourceResult => {
  const temps: number[] = []
  const seen = new Set<string>()
  for (const line of csv.split('\n')) {
    const i1 = line.indexOf(',')
    const i2 = line.indexOf(',', i1 + 1)
    if (i1 < 0 || i2 < 0) continue
    if (line.slice(0, i1) !== station) continue // skips header + other stations
    const valid = line.slice(i1 + 1, i2)
    const metar = line.slice(i2 + 1).trim()
    const t = Date.parse(valid.replace(' ', 'T') + ':00Z')
    if (!(t >= w.startMs && t < w.endMs)) continue
    if (seen.has(metar)) continue
    seen.add(metar)
    const tc = parseMetarTempC(metar)
    if (tc !== null) temps.push(tc)
  }
  return summarize(temps)
}

// ------------------------------------------------------- aviationweather.gov

/** AWC data API: `date` pins the END of the window, `hours` its length (no relative-to-now drift). */
export const awcUrl = (base: string, station: string, w: DayWindow): string => {
  const end = new Date(w.endMs - 60_000) // last minute of the local day
  const iso = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}T${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:00Z`
  return `${base}?ids=${station}&format=raw&hours=24&date=${iso}`
}

/** Raw format: one "METAR RCSS 051530Z ..." / "SPECI ..." per line, newest first. */
export const parseAwcRaw = (raw: string, station: string, w: DayWindow): SourceResult => {
  const temps: number[] = []
  const seen = new Set<string>()
  for (const l of raw.split('\n')) {
    const line = l.trim()
    if (!line.includes(` ${station} `) && !line.startsWith(`${station} `)) continue
    const t = metarObsTimeMs(line, w)
    if (t === null || !(t >= w.startMs && t < w.endMs)) continue
    const body = line.replace(/^(METAR|SPECI)\s+/, '')
    if (seen.has(body)) continue
    seen.add(body)
    const tc = parseMetarTempC(line)
    if (tc !== null) temps.push(tc)
  }
  return summarize(temps)
}

// ------------------------------------------------------------ settlement

export type Decision =
  | { kind: 'settle'; isVoid: boolean; tmaxC: number }
  | { kind: 'retry'; reason: string }

/** Agree-or-void across the two independent sources. Thin coverage => retry later, never settle. */
export const decide = (a: SourceResult, b: SourceResult, minObs: number): Decision => {
  if (a.obs < minObs || b.obs < minObs) {
    return { kind: 'retry', reason: `coverage below ${minObs} obs (iem=${a.obs}, awc=${b.obs})` }
  }
  if (a.tmax !== b.tmax) return { kind: 'settle', isVoid: true, tmaxC: 0 }
  return { kind: 'settle', isVoid: false, tmaxC: a.tmax }
}
