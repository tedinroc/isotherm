#!/usr/bin/env python3
"""Shadow (Cloudflare Worker) vs live (Mac maker) tick-by-tick comparison.

Pairs every Worker shadow tick T with the Mac maker's NEXT tick T' (T < T' <= T + 75 s), i.e. the Mac decision made
from the same book state the shadow saw, with market data at most ~1 min newer. Per strike:
  fair diff, guard-flag equality, action equality, and for quote/requote the Mac's new quote vs the shadow's desired.
Disagreements are classified: 'timing' when the inputs moved between T and T' (fair delta / flags differ and the
policy outcome flips on that input), 'logic' otherwise.
"""
import json, sys, datetime, collections, re

REC = sys.argv[1]
MAC_LOG = sys.argv[2]
SINCE = sys.argv[3] if len(sys.argv) > 3 else None
UNTIL = sys.argv[4] if len(sys.argv) > 4 else None

def ts(s):
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

W = [json.loads(l) for l in open(f'{REC}/worker-ticks.jsonl')]
W_ALL = W
M = [json.loads(l) for l in open(f'{REC}/mac-snaps.jsonl')]
if SINCE:
    W = [w for w in W if ts(w['at']) >= ts(SINCE)]
    M = [m for m in M if ts(m['generatedAt']) >= ts(SINCE) - 120]
if UNTIL:
    W = [w for w in W if ts(w['at']) < ts(UNTIL)]
M.sort(key=lambda m: m['generatedAt'])

# Mac txs from maker.log in the window
mac_tx = []
for line in open(MAC_LOG):
    try:
        j = json.loads(line)
    except Exception:
        continue
    if j['msg'].startswith('tx '):
        t = ts(j['t'])
        if W and ts(W[0]['at']) - 120 <= t <= ts(W[-1]['at']) + 120:
            mac_tx.append((j['t'], j['msg']))

def mac_strikes(m):
    out = {}
    for l in m['ladders']:
        if l['status'] != 'active':
            continue
        for s in l['strikes']:
            out[(l['key'], s['strike'])] = s
    return out

# the Mac's snapshot is generated at the END of its tick; its decisions were made during the tick. maker.log has
# "tick N done in X ms" right after the snapshot is written/posted: start = done - X.
done = []
for line in open(MAC_LOG):
    try:
        j = json.loads(line)
    except Exception:
        continue
    mm = re.match(r'tick (\d+) done in (\d+) ms', j['msg'])
    if mm:
        done.append((ts(j['t']), int(mm.group(2))))
done.sort()
import bisect
_dt = [d[0] for d in done]
def mac_tick_start(m):
    g = ts(m['generatedAt'])
    i = bisect.bisect_left(_dt, g - 0.5)
    if i < len(done) and done[i][0] - g < 15:
        return done[i][0] - done[i][1] / 1000
    return g - 20

# the old Worker versions (before d034e1c9) did not report the guard; its v0 snapshot is the same one the first
# reporting tick shows, as long as that tick's v0FetchedAt is earlier than the old tick (one v0 refresh per hour)
inferred = {}
for w in W_ALL:
    for l in w['ladders']:
        d = l.get('data') or {}
        if d.get('v0FetchedAt'):
            for s in l['strikes']:
                if s.get('guard') is not None and (l['key'], s['k']) not in inferred:
                    inferred[(l['key'], s['k'])] = (ts(d['v0FetchedAt']), s['guard'])
for w in W:
    for l in w['ladders']:
        for s in l['strikes']:
            g = inferred.get((l['key'], s['k']))
            if s.get('guard') is None and g and g[0] < ts(w['at']):
                s['guard'] = g[1]
                s['guardInferred'] = True

rows = []
stats = collections.Counter()
fair_diffs = []
for w in W:
    if w['mode'] != 'shadow':
        continue
    T = ts(w['at'])
    # the Mac tick whose snapshot is generated after T + w.ms (the shadow finished reading) and within 75 s
    nxt = [m for m in M if T < mac_tick_start(m) <= T + 75]
    prv = [m for m in M if mac_tick_start(m) <= T]
    mn = nxt[0] if nxt else None
    mp = prv[-1] if prv else None
    stats['worker_ticks'] += 1
    if not mn:
        stats['no_mac_pair'] += 1
        continue
    ms_ = mac_strikes(mn)
    mp_ = mac_strikes(mp) if mp else {}
    for l in w['ladders']:
        for s in l['strikes']:
            key = (l['key'], s['k'])
            ma = ms_.get(key)
            if not ma:
                stats['strike_missing_on_mac'] += 1
                continue
            stats['pairs'] += 1
            wa = s['action']
            mact = (ma.get('lastAction') or {}).get('kind') or 'none'
            fd = None if s['fair'] is None or ma['fair'] is None else abs(s['fair'] - ma['fair'])
            if fd is not None:
                fair_diffs.append(fd)
            wflags = sorted(s.get('flags') or [])
            mflags = sorted(ma.get('flags') or [])
            wd = s['desired']
            wdes = 'pull' if (wd and 'pull' in wd) else (f"{wd['bid']}/{wd['ask']}" if wd else '-')
            mq = f"{ma['bid']}/{ma['ask']}" if (ma['bid'] is not None or ma['ask'] is not None) else 'none'
            wrest = f"{s['resting']['bid']}/{s['resting']['ask']}"
            # Mac's quote BEFORE its action = its previous snapshot's tracked orders
            mprev = mp_.get(key)
            mrest_before = (f"{mprev['bid']}/{mprev['ask']}" if mprev and (mprev['bid'] is not None or mprev['ask'] is not None) else 'none') if mprev else '?'
            same_book = (wrest.replace('None', 'None') == mrest_before.replace('none', 'None/None'))
            verdict = None
            # the same action sent by the Mac concurrently (its tick started before T, its tx landed after the shadow
            # read the book): same strike, same prices, within [T-10 s, T+20 s]
            conc = None
            for (tt, msg) in mac_tx:
                mm = re.match(r'tx maker\s+(quote|requote|pull|KILL) >=(\d+)(?: (\d+)@([\d.-]+) / (\d+)@([\d.-]+))?', msg)
                if not mm or int(mm.group(2)) != s['k'] or not (T - 10 <= ts(tt) <= T + 20):
                    continue
                kind = mm.group(1)
                if kind in ('quote', 'requote') and wa in ('quote', 'requote') and f"{mm.group(4)}/{mm.group(6)}".replace('-', 'None') == wdes:
                    conc = tt
                if kind == 'pull' and wa == 'pull':
                    conc = tt
            if conc and wa != mact:
                verdict = 'agree:concurrent'
            elif wa == mact:
                if wa in ('quote', 'requote'):
                    verdict = 'agree' if wdes == mq else ('agree:same-action,price-from-newer-fair' if fd is not None and fd >= 0.002 else 'agree-action/DIFF-PRICE')
                else:
                    verdict = 'agree'
            if verdict is None:
                # timing explanation: inputs moved between the shadow tick and the Mac tick
                wg, mg = s.get('guard'), ma.get('guard')
                band = lambda f, g: None if f is None or g is None else (2 if abs(f - g) >= 0.40 else 1 if abs(f - g) >= 0.15 else 0)
                if wflags != mflags and wg is not None and mg is not None and abs(wg - mg) > 0.0005 and band(s['fair'], mg) != band(s['fair'], wg):
                    verdict = 'timing:v0-refresh'   # same code; the guard alone flips the band (different hourly v0 snapshot)
                elif wflags != mflags:
                    verdict = 'timing:fair-crossed-guard-threshold'   # Polymarket moved across guardWarn between the ticks
                elif fd is not None and fd >= 0.004:
                    verdict = 'timing:fair-moved'
                elif not same_book:
                    verdict = 'timing:book-changed'
                else:
                    verdict = 'UNEXPLAINED'
            stats[verdict] += 1
            rows.append(dict(at=w['at'], mac=mn['generatedAt'], key=l['key'], k=s['k'], wfair=s['fair'], mfair=ma['fair'], wguard=s.get('guard'), mguard=ma.get('guard'),
                             wflags=wflags, mflags=mflags, waction=wa, maction=mact, wdesired=wdes, wresting=wrest, mquote=mq, mrest_before=mrest_before,
                             wreasons='; '.join(s.get('reasons') or [])[:80], mreasons='; '.join((ma.get('lastAction') or {}).get('reasons') or [])[:80], verdict=verdict))

print(json.dumps({k: v for k, v in stats.items()}, indent=1))
if fair_diffs:
    fair_diffs.sort()
    print('fair |diff| n=%d mean=%.4f median=%.4f p95=%.4f max=%.4f' % (len(fair_diffs), sum(fair_diffs) / len(fair_diffs), fair_diffs[len(fair_diffs) // 2], fair_diffs[int(len(fair_diffs) * 0.95)], fair_diffs[-1]))
# distinct would-sends (the same tx repeated while the book is unchanged counts once)
seen=set(); ws=[]
for w in W:
    for i in w.get('intents', []):
        sig=(i['role'], i['to'], i['data'], i['label'])
        if sig in seen: continue
        seen.add(sig); ws.append((w['at'], i['role'], i['label'], i['costMon'], i['gasLimit']))
print('\nShadow would-sends (distinct):')
for x in ws: print(' ', x)
print('\nMac txs in window:')
for t, m in mac_tx:
    print(' ', t, m[:110])
print('\nNon-trivial rows (any action != none or verdict != agree):')
for r in rows:
    if r['verdict'] != 'agree' or r['waction'] != 'none' or r['maction'] != 'none':
        print(f"  W {r['at'][11:19]} M {r['mac'][11:19]} {r['key']} >={r['k']} fair W {r['wfair']} M {r['mfair']} guard W {r['wguard']} M {r['mguard']} flags W {r['wflags']} M {r['mflags']} | W {r['waction']} want {r['wdesired']} rest {r['wresting']} | M {r['maction']} -> {r['mquote']} (before {r['mrest_before']}) | {r['verdict']} | W: {r['wreasons']} | M: {r['mreasons']}")
json.dump(rows, open(f'{REC}/compare-rows.json', 'w'), indent=0)
