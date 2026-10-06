#!/usr/bin/env python3
"""Independent spot-check of the Isotherm settlement rule against Polymarket outcomes.

Written from scratch by the verifier (does NOT import spikes/weather code):
  - Polymarket winner: gamma-api events?slug=highest-temperature-in-<city>-on-<month>-<d>-<yyyy>, the market whose
    outcomePrices == ["1","0"] (Yes won).  Also records which station the event description names.
  - IEM: asos.py data=metar, tz=<local tz>, local day [D 00:00, D+1 00:00), report_type 3 (routine) + 4 (SPECI).
  - Tmax = max integer temperature group over ALL reports in the local day (METAR + SPECI, incl. :30 reports).
Python 3.9 stdlib only.  Usage: python3 weather_spotcheck.py  (prints a table, writes weather_spotcheck.json)
"""
import datetime as dt
import json
import random
import re
import sys
import time
import urllib.request

UA = {"User-Agent": "isotherm-verifier/0.1 (research; contact via github)"}
CITIES = {
    "RCSS": ("taipei", "Asia/Taipei", dt.date(2026, 4, 5), dt.date(2026, 10, 5)),
    "RJTT": ("tokyo", "Asia/Tokyo", dt.date(2026, 3, 10), dt.date(2026, 10, 5)),
}
TEMP = re.compile(r"^(M?\d{2})/(M?\d{2}|//)?$")


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


def metar_temp(raw):
    body = raw.split(" RMK ")[0].replace("=", " ")
    for tok in body.split():
        m = TEMP.match(tok)
        if m:
            t = m.group(1)
            return -int(t[1:]) if t.startswith("M") else int(t)
    return None


def iem_tmax(icao, tz, d):
    n = d + dt.timedelta(days=1)
    url = ("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=%s&data=metar"
           "&year1=%d&month1=%d&day1=%d&year2=%d&month2=%d&day2=%d&tz=%s&format=onlycomma&latlon=no&elev=no"
           "&missing=M&trace=T&direct=no&report_type=3&report_type=4"
           % (icao, d.year, d.month, d.day, n.year, n.month, n.day, tz))
    rows = get(url).strip().splitlines()[1:]
    temps, hours = [], set()
    for line in rows:
        parts = line.split(",", 2)
        if len(parts) < 3:
            continue
        valid, raw = parts[1], parts[2]
        if not valid.startswith(d.isoformat()):
            continue  # defensive: keep only local day D
        t = metar_temp(raw)
        if t is not None:
            temps.append(t)
            hours.add(valid[11:13])
    return (max(temps) if temps else None), len(temps), len(hours)


def pm_winner(city, d):
    slug = "highest-temperature-in-%s-on-%s-%d-%d" % (city, d.strftime("%B").lower(), d.day, d.year)
    ev = json.loads(get("https://gamma-api.polymarket.com/events?slug=" + slug))
    if not ev:
        return None, None, slug
    e = ev[0]
    stn = re.findall(r"wunderground\.com/history/daily/[a-z]+/[a-z\-]+/([A-Z]{4})", e.get("description", ""))
    src = stn[0] if stn else ("OTHER:" + (re.findall(r"https?://\S+", e.get("description", "")) or ["?"])[0][:80])
    for m in e["markets"]:
        prices = json.loads(m["outcomePrices"]) if isinstance(m["outcomePrices"], str) else m["outcomePrices"]
        if prices and prices[0] == "1":
            return m.get("groupItemTitle"), src, slug
    return "UNRESOLVED", src, slug


def in_bucket(t, label):
    n = int(re.findall(r"-?\d+", label)[0])
    if "or below" in label:
        return t <= n
    if "or higher" in label or "or above" in label:
        return t >= n
    return t == n


def main():
    rnd = random.Random(20261006)
    picks = []
    for icao, (city, tz, a, b) in CITIES.items():
        span = (b - a).days
        k = 14 if icao == "RCSS" else 6
        ds = sorted(rnd.sample(range(span + 1), k))
        picks += [(icao, a + dt.timedelta(days=x)) for x in ds]
    # deliberately include the builder's claimed mismatch day and SPECI-decisive days
    for extra in [("RCSS", dt.date(2026, 5, 4)), ("RCSS", dt.date(2026, 4, 21)), ("RCSS", dt.date(2026, 7, 13))]:
        if extra not in picks:
            picks.append(extra)
    out = []
    for icao, d in picks:
        city, tz, _, _ = CITIES[icao]
        label, src, slug = pm_winner(city, d)
        time.sleep(0.5)
        tmax, n, nh = iem_tmax(icao, tz, d)
        time.sleep(1.0)
        ok = (label not in (None, "UNRESOLVED") and tmax is not None and in_bucket(tmax, label))
        row = dict(station=icao, date=d.isoformat(), pm_winner=label, pm_source=src, iem_tmax=tmax, iem_reports=n,
                   iem_hours=nh, match=ok)
        out.append(row)
        print("%s %s  PM=%-14s src=%-6s IEM tmax=%-4s reports=%-3d hours=%-2d %s" % (
            icao, d, label, src, tmax, n, nh, "MATCH" if ok else "MISMATCH"), flush=True)
    json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else "weather_spotcheck.json", "w"), indent=1)
    ms = [r for r in out if r["pm_source"] == r["station"]]
    print("station-sourced: %d/%d match" % (sum(r["match"] for r in ms), len(ms)))


if __name__ == "__main__":
    main()
