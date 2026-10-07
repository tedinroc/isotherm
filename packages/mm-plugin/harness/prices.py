#!/usr/bin/env python3
"""TEST HARNESS ONLY. Prices for run-all.sh's trade steps, read from the quote-today / quote-tomorrow outputs (the
fork's real books and today's observed max), so the run works whatever the market does. Prints shell assignments.
Usage: eval "$(python3 harness/prices.py <evidence dir>)" """
import glob
import json
import math
import sys

out = sys.argv[1]


def doc(name):
    t = open(sorted(glob.glob(f"{out}/*-{name}.txt"))[0]).read()
    return json.loads(t[t.index("\n{\n") + 1:])["data"]


D, T = doc("quote-today"), doc("quote-tomorrow")


def side(v, k, s):
    r = next((r for r in v["rows"] if r["strikeC"] == k), None)
    return (r or {}).get("book") and r["book"].get(s)


def up4(x):
    return math.ceil(round(x * 1e4, 6)) / 1e4


def dn4(x):
    return math.floor(round(x * 1e4, 6)) / 1e4


def nomax(b):  # buy NO at <= 1 - bid x (1 - fee)
    return "" if not b else f"{up4(1 - b * 0.999):.4f}"


p = {
    "T30_ASK": side(T, 30, "bestAsk"),
    "T30_BID": side(T, 30, "bestBid"),
    "T30_NOMAX": nomax(side(T, 30, "bestBid")),
    "T29_NOMAX": nomax(side(T, 29, "bestBid")),
    # closing NO = buy YES at the ask: proceeds per NO ~ 1 - ask / (1 - fee); leave 0.005 for per-level rounding
    "T29_NOMIN": f"{max(0.0001, dn4(1 - side(T, 29, 'bestAsk') / 0.999 - 0.005)):.4f}",
    "T31_ASK": side(T, 31, "bestAsk"),
    "T31_NOMAX": nomax(side(T, 31, "bestBid")),
    "T28_NOMAX": nomax(side(T, 28, "bestBid")),
    # a post-only bid strictly inside the 31 spread, on the 0.001 tick
    "K31_LIMIT": f"{math.floor((side(T, 31, 'bestBid') + side(T, 31, 'bestAsk')) / 2 * 1000) / 1000:.3f}",
}
obs = (D.get("observed") or {}).get("maxC")
ks = sorted(r["strikeC"] for r in D["rows"])
locked = [k for k in ks if obs is not None and k <= obs]
free = [k for k in ks if obs is None or k > obs]
p["D_OBS"] = "" if obs is None else obs
p["D_LOCK_K"] = locked[-1] if locked else ""
p["D_LOCK_ASK"] = side(D, locked[-1], "bestAsk") if locked else ""
p["D_FREE_K"] = free[-1] if free else ""
p["D_FREE_ASK"] = side(D, free[-1], "bestAsk") if free else ""
p["D_FREE_NOMAX"] = nomax(side(D, free[-1], "bestBid")) if free else ""
for k, v in p.items():
    print(f"{k}='{'' if v is None else v}'")
