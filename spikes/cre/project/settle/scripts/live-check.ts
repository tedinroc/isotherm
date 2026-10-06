// Fetch both sources live (plain fetch, outside CRE) for given dates and print Tmax per source.
// Also saves the raw responses as test fixtures.
import { awcUrl, iemUrl, localDayWindow, parseAwcRaw, parseIemCsv } from '../metar'
const IEM = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py'
const AWC = 'https://aviationweather.gov/api/data/metar'
const [station, tz, ...dates] = process.argv.slice(2)
for (const ymd of dates) {
  const w = localDayWindow(ymd, Number(tz))
  const t0 = Date.now()
  const iemTxt = await (await fetch(iemUrl(IEM, station, w))).text()
  const t1 = Date.now()
  const awcTxt = await (await fetch(awcUrl(AWC, station, w))).text()
  const t2 = Date.now()
  await Bun.write(`fixtures/iem_${station}_${ymd}.csv`, iemTxt)
  await Bun.write(`fixtures/awc_${station}_${ymd}.txt`, awcTxt)
  const a = parseIemCsv(iemTxt, station, w)
  const b = parseAwcRaw(awcTxt, station, w)
  console.log(`${station} ${ymd} IEM tmax=${a.tmax} obs=${a.obs} (${iemTxt.length}B ${t1 - t0}ms) | AWC tmax=${b.tmax} obs=${b.obs} (${awcTxt.length}B ${t2 - t1}ms)`)
}
