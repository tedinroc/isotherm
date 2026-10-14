#!/usr/bin/env bash
# shellcheck disable=SC2016  # single-quoted stub bodies and JavaScript are meant literally
# TEST ONLY, on the Mac or any Linux host: no network, no key, no systemd, 0 MON. The REAL vps/stack-watch.sh,
# vps/stack-watch.mjs and vps/lib.sh run from a scratch package, always with --fixtures (generated per case by
# a small node script below: realistic /api/health, /api/snapshot, /api/settlements, /api/stats, balances and
# Resolver.resultOf outputs, the web RPCs' eth_blockNumber and CORS preflight answers, the deployed build's fallback
# list; ladders "active"/"closed" with their seriesIds and markets, or "planned"/"rolling" via UNROLL) and --now; the
# settlement job's evidence records by mkruns.mjs. Shims in the scratch package's .tools/bin (first on lib.sh's PATH):
# `curl` records each push (title, priority, the -K URL's host, body) and answers 200, or the HTTP status in
# <shim>/fail while that file exists (a failed delivery), and records any other call (a GET, an RPC read) and fails it,
# except the site's index.html and main script while <shim>/site-index and site-js exist; `cast` records and fails any
# call. The alert URL file holds https://ntfy.invalid/<random topic>; the proxies point at 127.0.0.1:9. Every check
# positive and negative:
#   Z  first run / dry run / minute guard / lock / var isolation / fixture mode reads nothing live / --help; the live
#      code path against the shims (the 4 GETs, the one eth_blockNumber POST and its OPTIONS preflight with the site's
#      Origin, the site's index.html, 5 cast balance reads; the deployed script read once per build, its fallbacks)
#   A  MAKER STALLED (14 vs 16 min, the 2nd stale run or 25 min, dedupe, CLEARED only after 30 min clean, a one-off
#      gap never pushed, a maker that fails on and off: one push, no CLEARED in between; empty snapshot)
#   B  BOOKS EMPTY (60 min first-seen, fair 0.10..0.90 edges, a filled side, the close window, before the roll, CLEARED,
#      a refill followed by a new gap keeps the alert open)
#   L  LADDER NOT OPENED (tomorrow's ladder "rolling" or missing at 13:00 local), NO ACTIVE LADDER (20 min after the
#      close), both CLEARED once it rolls
#   C  DRIP DOWN / RELAY DOWN / API UNHEALTHY (20 min, 3 runs), not for the cap or a deliberate pause, an outage with a
#      good reading every 20 min; RELAYER LOW; AUSD FLOAT
#   D  DRIP / RELAY CAP USED EARLY (before 08:00 UTC, once a day, again the next day) vs CAP REACHED after 08:00 (low)
#   O  a failed delivery (HTTP 429) of a one-off push (CAP USED EARLY, the digest): re-sent on the next run
#   E  TREASURY LOW, MAKER LOW and OPERATOR LOW (20 min), the roll dip, boundaries, a failed read keeps the state;
#      GUARDIAN LOW and ATTESTER LOW (20 min, 3 runs), the lines, a dip, failed reads, CLEARED
#   R  WEB RPC DOWN from the 3rd failed run in a row: no answer, HTTP 503, a JSON-RPC error, not JSON, a CORS header
#      for another origin or none, a preflight refused / for another origin / without content-type, a stuck block;
#      not for "*" or a 204 preflight, a one-off chain reset, or a run a minute after another; the check from the Mac
#      fits the failure; with the deployed build's fallbacks: default while one answers, high at once when none does;
#      --snooze-web
#   F  SETTLEMENT OVERDUE (day end + 5 h; the API list, then the chain; a remembered ladder; a failed chain read; a
#      ladder that never reached the chain is not checked, one with its series is)
#   N  WATCH CANNOT REACH THE API only from the 3rd failed run in a row; a success resets the count; on and off: once
#   P  --snooze: the maker checks held (the others not), shown in the digest, ended by --snooze 0 or by time
#   G  the daily digest: once per UTC day from 01:00, yesterday's counters, deltas, ladders, open alerts
#   K  the digest's CRE line: last official run, last report, the span the login showed over (not an age); single
#      misses vs a lapse; a failed official run; stale records, a gap, a stand-down; the records only read, and only
#      on a run that may send the digest; none without records
#   X  past 2026-10-31: no checks, one reminder a day to uninstall
#   S  no push ever went to a real URL; no GET, no cast call; the topic in no output or state file; the one POST and
#      the one OPTIONS
# Usage: vps/test/stack-watch-unit.sh   Env: ISOTHERM_TEST_BASH (default /bin/bash), KEEP=1 keeps the scratch.
# The report always goes to a kept scratch file (its path is printed). ISOTHERM_WRITE_EVIDENCE=1 also writes the
# tracked evidence file, vps/evidence/stack-watch-unit.txt (or ISOTHERM_TEST_EVIDENCE=<path>), and only from a run
# where every check passed. Exit 0 = all pass.
set -uo pipefail
REAL="$(cd "$(dirname "$0")/../.." && pwd)"; REPO=$(cd "$REAL/../.." && pwd)
TBASH=${ISOTHERM_TEST_BASH:-/bin/bash}
EVOUT=${ISOTHERM_TEST_EVIDENCE:-$REAL/vps/evidence/stack-watch-unit.txt}
SEARCH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
NODE=$(PATH=$SEARCH; command -v node) || { echo "node not found" >&2; exit 2; }
TMPBASE=${TMPDIR:-/tmp}; SC=$(mktemp -d "${TMPBASE%/}/isotherm-stack-watch.XXXXXX"); SCP=$(cd "$SC" && pwd -P)
# shellcheck disable=SC2317  # called by the EXIT trap
cleanup() { [ "${KEEP:-0}" = 1 ] || rm -rf "$SC"; }
trap cleanup EXIT

main() {
P="$SC/root/packages/cre-workflow"; BIN="$P/.tools/bin"; SD="$SC/shim"; FX="$SC/fx"
mkdir -p "$P/vps" "$BIN" "$SD" "$SC/home" "$SC/tmp" "$FX"
for f in stack-watch.sh stack-watch.mjs lib.sh; do ln -s "$REAL/vps/$f" "$P/vps/$f"; done   # the code under test
ln -s "$NODE" "$BIN/node"; ln -s "$TBASH" "$BIN/bash"
cat >"$BIN/curl" <<'EOF'
#!/bin/bash
# TEST shim of curl: a push_alert call (-K config) is recorded and answered 200; anything else (a GET, an RPC read) is
# recorded with its arguments and fails (no answer), except the site's index.html and main script while
# $SHIM_DIR/site-index and site-js exist (served as is)
title=""; prio=""; host=none; args="$*"; out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -H) case "$2" in "Title: "*) title=${2#Title: } ;; "Priority: "*) prio=${2#Priority: } ;; esac; shift ;;
    -K) u=$(sed -n 's/^url = "\(.*\)"$/\1/p' "$2"); case "$u" in https://ntfy.invalid/*) host=ntfy.invalid ;; *) host=OTHER ;; esac; shift ;;
    -o) out=$2; shift ;;
    -A|-D|-w|-X|--data|--max-time) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
if [ "$host" = none ]; then
  echo "CURL $args" >>"${SHIM_DIR:?}/gets"
  case "$url" in
    https://isotherm.pages.dev/) [ -f "$SHIM_DIR/site-index" ] && { cat "$SHIM_DIR/site-index"; exit 0; } ;;
    https://isotherm.pages.dev/assets/*) [ -f "$SHIM_DIR/site-js" ] && [ -n "$out" ] && { cp "$SHIM_DIR/site-js" "$out"; printf 200; exit 0; } ;;
  esac
  exit 7
fi
body=$(cat | tr '\n' '\037')
if [ -f "$SHIM_DIR/fail" ]; then printf '%s\t%s\n' "$title" "$prio" >>"$SHIM_DIR/failed"; cat "$SHIM_DIR/fail"; exit 0; fi   # e.g. 429
printf '%s\t%s\t%s\t%s\n' "$title" "$prio" "$host" "$body" >>"${SHIM_DIR:?}/pushes"
printf 200
EOF
printf '#!/bin/bash\necho "cast $*" >>"${SHIM_DIR:?}/cast-calls"; exit 1\n' >"$BIN/cast"
chmod +x "$BIN/curl" "$BIN/cast"
TOPIC="isotherm-test-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 24)"
printf 'https://ntfy.invalid/%s\n' "$TOPIC" >"$SC/alert.url"; chmod 600 "$SC/alert.url"
: >"$SD/pushes"

# ---- fixtures: node mkfx.mjs <dir> <ISO now> [JavaScript mutation]. Realistic base (the live shapes of 2026-10-13):
# Taipei ladders D rolled D-1 04:00Z, close D 09:30Z, day end D 16:00Z, listed until close + 36 h, settled at 18:05Z.
cat >"$SC/mkfx.mjs" <<'EOF'
import fs from "node:fs"; import path from "node:path";
const [dir, nowIso, mut = ""] = process.argv.slice(2);
const ep = (s) => Date.parse(s) / 1000, iso = (t) => new Date(t * 1000).toISOString(), now = ep(nowIso);
const ymd = (t) => Number(new Date(t * 1000).toISOString().slice(0, 10).replace(/-/g, ""));
const day = (d) => `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6)}`;
const sid = (d, k) => "0x" + `${d}${k}`.padStart(64, "0"), mkt = (d, k) => "0x" + `${d}${k}`.padStart(40, "0");
const strike = (d, k, fair) => ({ k, seriesId: sid(d, k), market: mkt(d, k), fair, fairSource: "polymarket", bid: +(fair - 0.04).toFixed(2), ask: +(fair + 0.04).toFixed(2), bidSize: 100, askSize: 100, bidRemaining: 100, askRemaining: 100, mode: "quoting" });
const ladders = [];
for (let t = ep("2026-10-08T00:00:00Z"); t <= ep("2026-11-03T00:00:00Z"); t += 86400) {
  const d = ymd(t), close = ep(`${day(d)}T09:30:00Z`), end = ep(`${day(d)}T16:00:00Z`), roll = ep(`${day(d)}T04:00:00Z`) - 86400;
  if (now < roll || now >= close + 36 * 3600) continue;
  const closed = now >= close;
  ladders.push({ station: "RCSS", city: "taipei", date: d, closeTime: close, dayEnd: end, status: closed ? "closed" : "active",
    strikes: closed ? [29, 30, 31].map((k) => ({ k, seriesId: sid(d, k), market: mkt(d, k), fair: null, bid: null, ask: null, bidSize: 0, askSize: 0, bidRemaining: null, askRemaining: null, mode: "closed" }))
      : [strike(d, 29, 0.85), strike(d, 30, 0.5), strike(d, 31, 0.2)] });
}
const h = { ok: true, relayer: "0xb0b9F5E93C4D4Bb448eC96191393bf35C9E8429f", chainId: 10143, monBalance: "102.423603328", ausdFloat: "51000",
  dripEnabled: true, dripReady: true, dripMon: "0.25", dripAusd: "1000", relayEnabled: true, relayReady: true,
  limits: { reserveMon: "0.1", dripDailyCap: 17, dripPerIpPerDay: 5, relayDailyCap: 28, relayPerIpPerDay: 14, dripsToday: 0, relaysToday: 0 },
  dripsTotal: 9, relayedTotal: 8, snapshotReceivedAt: iso(now - 30) };
const s = { version: 1, generatedAt: iso(now - 30), receivedAt: iso(now - 30), chainId: 10143, source: "isotherm-maker-worker", ladders,
  maker: { address: "0xd572638F07829D1c3636400FB73CF34Ca6c7448a", mon: 4.99 } };
const settlements = [];
for (let t = ep("2026-10-08T00:00:00Z"); t <= now; t += 86400) {
  const d = ymd(t), end = ep(`${day(d)}T16:00:00Z`);
  if (now >= end + 7500) settlements.unshift({ station: "RCSS", date: d, status: 1, tmaxC: 30, finalAt: end + 7500 + 900 });
}
const t = { updatedAt: iso(now - 60), resolver: "0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B", settlements };
const st = { nonMakerWallets: 4, nonMakerFills: 10, updatedAt: iso(now - 60) };
const b = { treasury: 158.62, maker: 4.99, operator: 2.24, guardian: 0.05, attester: 0.7776 };
// the web app's RPC answering eth_blockNumber (~2.5 blocks a second) and its CORS preflight (the live headers of
// 2026-10-14). wr.code / wr.pre 0 = no answer; wr.json a string or object replaces the answer (null: none); wr.acao,
// wr.pacao, wr.pah null drop that header. wr.build: the deployed script (null: unknown, no webbuild file), wr.fb its
// fallbacks, added by FB(url, {...the same fields}); the default is the live build of 2026-10-13, without fallbacks.
const SITE = "https://isotherm.pages.dev";
const wr = { code: 200, block: Math.floor((now - ep("2026-10-01T00:00:00Z")) * 2.5), json: undefined, acao: SITE,
  pre: 200, pacao: SITE, pah: "Content-Type,Authorization,User-Agent", build: "/assets/index-Cd8KBz0E.js", fb: [] };
const FB = (url, o = {}) => wr.fb.push({ url, code: 200, block: wr.block, json: undefined, acao: "*", pre: 204, pacao: "*", pah: "content-type", ...o });
const r = {}, del = [], code = {};
const L = (d) => s.ladders.find((x) => x.date === d), K = (d, k) => L(d).strikes.find((x) => x.k === k);
// UNROLL(d, "planned" | "rolling"): the ladder of day d stuck in its roll (planned: no seriesId, no market; rolling:
// series created, no market); no quotes. DROP(d): not in the maker's state at all (refused before planning).
const UNROLL = (d, status) => { const l = L(d); l.status = status; for (const x of l.strikes) Object.assign(x, { bid: null, ask: null, bidSize: 0, askSize: 0, bidRemaining: null, askRemaining: null, mode: "pending", market: null }, status === "planned" ? { seriesId: null } : {}); };
const DROP = (d) => { s.ladders = s.ladders.filter((x) => x.date !== d); };
new Function("h", "s", "t", "st", "b", "wr", "FB", "r", "del", "code", "now", "ep", "iso", "L", "K", "UNROLL", "DROP", mut)(h, s, t, st, b, wr, FB, r, del, code, now, ep, iso, L, K, UNROLL, DROP);
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
for (const [n, v] of Object.entries({ health: h, snapshot: s, settlements: t, stats: st })) {
  if (code[n]) fs.writeFileSync(path.join(dir, `${n}.code`), String(code[n]));
  if (!del.includes(n)) fs.writeFileSync(path.join(dir, `${n}.json`), typeof v === "string" ? v : JSON.stringify(v));
}
// as stack-watch.sh rpcprobe leaves them: <name>.code always, .json only for HTTP 200, .headers when anything answered;
// <name>-pre.code always, -pre.headers when anything answered. webbuild: the script, then its fallbacks (webfb1, ...)
const rpcFiles = (name, o) => {
  const j = o.json !== undefined ? o.json : { jsonrpc: "2.0", id: 1, result: "0x" + o.block.toString(16) };
  fs.writeFileSync(path.join(dir, `${name}.code`), String(o.code).padStart(3, "0"));
  if (o.code === 200 && j !== null) fs.writeFileSync(path.join(dir, `${name}.json`), typeof j === "string" ? j : JSON.stringify(j));
  if (o.code !== 0) fs.writeFileSync(path.join(dir, `${name}.headers`), `HTTP/2 ${o.code} \r\naccess-control-allow-credentials: true\r\n${o.acao !== null ? `access-control-allow-origin: ${o.acao}\r\n` : ""}content-type: application/json\r\n\r\n`);
  fs.writeFileSync(path.join(dir, `${name}-pre.code`), String(o.pre).padStart(3, "0"));
  if (o.pre !== 0) fs.writeFileSync(path.join(dir, `${name}-pre.headers`), `HTTP/2 ${o.pre} \r\n${o.pah !== null ? `access-control-allow-headers: ${o.pah}\r\n` : ""}access-control-allow-methods: GET, POST, OPTIONS\r\n${o.pacao !== null ? `access-control-allow-origin: ${o.pacao}\r\n` : ""}\r\n`);
};
rpcFiles("webrpc", wr);
if (wr.build !== null) fs.writeFileSync(path.join(dir, "webbuild"), [wr.build, ...wr.fb.map((f) => f.url)].join("\n") + "\n");
wr.fb.forEach((f, i) => rpcFiles(`webfb${i + 1}`, f));
for (const [role, v] of Object.entries(b)) if (v !== null) fs.writeFileSync(path.join(dir, `balance-${role}.txt`), `${Number(v).toFixed(18)}\n`);
for (const [k, v] of Object.entries(r)) fs.writeFileSync(path.join(dir, `result-${k}.txt`), v + "\n");
EOF

PASS=0; FAIL=0
ok() { if [ "$1" = 1 ]; then PASS=$((PASS + 1)); echo "  PASS  $2"; else FAIL=$((FAIL + 1)); echo "  FAIL  $2"; fi; }
t() { if "$@"; then echo 1; else echo 0; fi; }   # t <test command>: 1/0 for ok()
W="ISOTHERM WATCH: "
ep() { "$NODE" -e 'console.log(Date.parse(process.argv[1]) / 1000)' "$1"; }
envrun() {
  env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin" HOME="$SC/home" TMPDIR="$SC/tmp" SHIM_DIR="$SD" \
    HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 \
    http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 ISOTHERM_ALERT_URL_FILE="$SC/alert.url" "$@"
}
# w <case> <group> <ISO now> [mutation] [-- extra stack-watch.sh flags]: one run of the real stack-watch.sh with fresh
# fixtures and the group's own state dir ($SC/st-<group>); its pushes in $SC/new-<case>.tsv. The settlement job's var/
# (read for the digest's CRE line) is $SVAR when set (SVAR=dir w ...), else one without records.
w() {
  local c=$1 g=$2 at=$3 mut=${4:-}; shift 3; [ $# -gt 0 ] && shift
  [ "${1:-}" = -- ] && shift
  "$NODE" "$SC/mkfx.mjs" "$FX/$c" "$at" "$mut" || { echo "    fixture error"; return 1; }
  local n0; n0=$(wc -l <"$SD/pushes" | tr -d ' ')
  envrun ISOTHERM_WATCH_DIR="$SC/st-$g" ISOTHERM_STATE_DIR="${SVAR:-$SC/settle-none}" "$TBASH" "$P/vps/stack-watch.sh" --fixtures "$FX/$c" --now "$(ep "$at")" "$@" >"$SC/out-$c.log" 2>&1; RC=$?
  tail -n +$((n0 + 1)) "$SD/pushes" >"$SC/new-$c.tsv"
  grep -E '\[watch\] (pending|clearing|over:|re-sending|delivered:|not delivered|snoozed|snooze ended|MAKER STALLED, BOOKS|API |BOOKS EMPTY held|skipped|another run|DRY|dry run|evaluator)|\[vps\] (ALERT|push: )|WOULD PUSH' "$SC/out-$c.log" \
    | sed -E 's/^\[[^]]+\] //; s/(.{240}).*/\1 .../; s/^/    | /'
  echo "    $at exit $RC: $(wc -l <"$SC/new-$c.tsv" | tr -d ' ') push(es) $(cut -f1,2 "$SC/new-$c.tsv" | sed "s/^$W//" | tr '\t\n' '/,' | sed 's/,$//')"
}
np() { grep -c "^$W$2	" "$SC/new-$1.tsv" 2>/dev/null || true; }          # np <case> <title without the prefix>
nall() { wc -l <"$SC/new-$1.tsv" | tr -d ' '; }
prio() { grep "^$W$2	" "$SC/new-$1.tsv" | head -n1 | cut -f2; }
body() { grep "^$W$2	" "$SC/new-$1.tsv" | head -n1 | cut -f4 | tr '\037' '\n'; }
has() { body "$1" "$2" | grep -qF -- "$3"; }                              # has <case> <title> <text>
npg() { # npg <case prefix> <title> [last case]: pushes of that title over the runs whose case starts with the prefix
  local n=0 f c
  for f in "$SC"/new-"$1"*.tsv; do [ -f "$f" ] || continue; c=$(grep -c "^$W$2	" "$f" || true); n=$((n + c)); [ "$f" = "$SC/new-${3:-}.tsv" ] && break; done
  echo "$n"
}
# snz <group> <ISO now> <hours> [--snooze-web]: stack-watch.sh --snooze (or --snooze-web) HOURS; prints its exit code
snz() { envrun ISOTHERM_WATCH_DIR="$SC/st-$1" "$TBASH" "$P/vps/stack-watch.sh" --now "$(ep "$2")" "${4:---snooze}" "$3" >"$SC/out-snz.log" 2>&1; echo $?; }

echo "# $(date -u +%FT%TZ) stack-watch-unit: $("$TBASH" -c 'echo "bash $BASH_VERSION"') on $(uname -s) $(uname -m), node $("$NODE" --version); fixtures, stubs, no network, no key, 0 MON"
echo "# scratch package <scratch>/root/packages/cre-workflow (vps/stack-watch.sh, stack-watch.mjs and lib.sh symlinked to the code under test)"

echo; echo "## Z. first run, dry run, minute guard, lock, var/ isolation"
w Z1 z 2026-10-14T06:00:00Z
ok "$([ "$(nall Z1)" = 1 ] && [ "$(np Z1 'daily digest 2026-10-14')" = 1 ] && [ "$(prio Z1 'daily digest 2026-10-14')" = default ] && has Z1 'daily digest 2026-10-14' 'First digest' && echo 1 || echo 0)" "a healthy stack: the first run pushes only the first digest (default priority), the heartbeat"
w Z2 z 2026-10-14T06:10:00Z
ok "$(t [ "$(nall Z2)" = 0 ])" "the next run: nothing"
stamps() { find "$SC/st-z/alerts" -type f -exec cksum {} + | sort; }   # every dedupe stamp and ALERTS.log, with its checksum
cp "$SC/st-z/state.json" "$SC/state-before"; stamps >"$SC/stamps-before"
w Z3 z 2026-10-14T06:20:00Z 'b.treasury = 19.5' -- --dry-run
ok "$(grep -q "WOULD PUSH \[priority high, repeat after 360 min\] ${W}TREASURY LOW" "$SC/out-Z3.log" && [ "$(nall Z3)" = 0 ] && echo 1 || echo 0)" "--dry-run prints WOULD PUSH (TREASURY LOW, high, 6 h) and pushes nothing"
ok "$(cmp -s "$SC/state-before" "$SC/st-z/state.json" && stamps | cmp -s - "$SC/stamps-before" && echo 1 || echo 0)" "--dry-run saves no state and no dedupe stamp"
w Z4 z 2026-10-14T06:05:00Z 'b.treasury = 19.5'
ok "$(grep -q 'skipped: minute :05 is next to the :05 settlement run' "$SC/out-Z4.log" && [ "$(nall Z4)" = 0 ] && cmp -s "$SC/state-before" "$SC/st-z/state.json" && echo 1 || echo 0)" "at :05 the run is skipped (no read, no push, no state)"
w Z5 z 2026-10-14T06:09:00Z 'b.treasury = 19.5' -- --force
ok "$(t [ "$(np Z5 'TREASURY LOW')" = 1 ])" "--force runs at :09"
mkdir "$SC/st-z/run.lock"; w Z6 z 2026-10-14T06:30:00Z
ok "$(grep -q 'another run holds' "$SC/out-Z6.log" && [ -d "$SC/st-z/run.lock" ] && echo 1 || echo 0)" "a fresh lock (another run): skipped, the lock left to its owner"
touch -t 202601010000 "$SC/st-z/run.lock"; w Z7 z 2026-10-14T06:40:00Z
ok "$(! grep -q 'another run holds' "$SC/out-Z7.log" && [ ! -d "$SC/st-z/run.lock" ] && echo 1 || echo 0)" "a stale lock (> 10 min): taken over; removed at exit"
# the settlement unit's environment (ISOTHERM_STATE_DIR=var) inherited, no ISOTHERM_WATCH_DIR: only var/watch is used
"$NODE" "$SC/mkfx.mjs" "$FX/Z8" 2026-10-14T06:50:00Z ''
envrun ISOTHERM_STATE_DIR="$P/var" "$TBASH" "$P/vps/stack-watch.sh" --fixtures "$FX/Z8" --now "$(ep 2026-10-14T06:50:00Z)" >"$SC/out-Z8.log" 2>&1
VARLS=$(find "$P/var" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort | tr '\n' ' ')
ok "$([ "$VARLS" = "watch " ] && [ -f "$P/var/watch/state.json" ] && [ -f "$P/var/watch/alerts/ALERTS.log" ] && echo 1 || echo 0)" "default state dir: var/watch only, even with the settlement unit's ISOTHERM_STATE_DIR inherited (var/ holds: $VARLS)"

w Z9 z 2026-10-14T07:00:00Z 's.ladders.push(null, { station: "RCSS", date: 20261016, status: "active", closeTime: now + 3600, strikes: { k: 1 } }); t.settlements.push(null, 7); h.limits = null'
ok "$([ "$RC" = 0 ] && ! grep -q 'evaluator failed' "$SC/out-Z9.log" && echo 1 || echo 0)" "malformed API data (null ladders, strikes not a list, null settlements, no limits): no crash, exit 0"
printf 'not json' >"$SC/st-z/state.json"; w Z10 z 2026-10-14T07:10:00Z
ok "$([ "$RC" = 0 ] && "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$SC/st-z/state.json" && echo 1 || echo 0)" "a corrupt state.json: treated as a fresh start, rewritten as valid JSON"
mv "$BIN/node" "$BIN/node.real"; printf '#!/bin/bash
echo "boom (test)" >&2; exit 3
' >"$BIN/node"; chmod +x "$BIN/node"
w Z11 z 2026-10-14T07:20:00Z
rm -f "$BIN/node"; mv "$BIN/node.real" "$BIN/node"
ok "$([ "$RC" = 1 ] && grep -q 'evaluator failed (exit 3): boom (test)' "$SC/out-Z11.log" && [ "$(np Z11 'WATCH ERROR')" = 1 ] && [ "$(prio Z11 'WATCH ERROR')" = default ] && echo 1 || echo 0)" "the evaluator itself fails: exit 1 and one WATCH ERROR push (6 h repeat), so a broken watch is not silent"
# the live code path (no --fixtures) against the shims, with its own shim directory (S below still holds): the curl
# and cast calls exactly as sent, all failing (no answer)
LSD="$SC/shim-live"; mkdir -p "$LSD"; : >"$LSD/pushes"
envrun SHIM_DIR="$LSD" ISOTHERM_WATCH_DIR="$SC/st-zl" ISOTHERM_STATE_DIR="$SC/settle-none" "$TBASH" "$P/vps/stack-watch.sh" --now "$(ep 2026-10-14T07:30:00Z)" >"$SC/out-Z12.log" 2>&1; RC=$?
sed -E "s#$SC#<scratch>#g; s/^/    | /" "$LSD/gets" | sort   # the probe runs alongside the GETs: any order
WEBCALL=$(grep -F 'eth_blockNumber' "$LSD/gets"); PRECALL=$(grep -F -- '-X OPTIONS' "$LSD/gets")
ok "$([ "$RC" = 0 ] && [ "$(grep -c . "$LSD/gets")" = 7 ] && [ "$(grep -cE ' https://isotherm\.pages\.dev/api/(health|snapshot|settlements|stats)$' "$LSD/gets")" = 4 ] && [ "$(grep -c -- '--data' "$LSD/gets")" = 1 ] \
  && printf '%s' "$WEBCALL" | grep -qF -- '-H Origin: https://isotherm.pages.dev --data {"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' && printf '%s' "$WEBCALL" | grep -qE ' https://testnet-rpc\.monad\.xyz$' && echo 1 || echo 0)" "live path: 4 GETs of the API, and ONE POST, eth_blockNumber to https://testnet-rpc.monad.xyz with the site's Origin"
ok "$([ "$(grep -c -- ' -X ' "$LSD/gets")" = 1 ] && printf '%s' "$PRECALL" | grep -qF -- '-X OPTIONS -H Origin: https://isotherm.pages.dev -H Access-Control-Request-Method: POST -H Access-Control-Request-Headers: content-type' && printf '%s' "$PRECALL" | grep -qE ' https://testnet-rpc\.monad\.xyz$' && [ "$(grep -cE ' https://isotherm\.pages\.dev/$' "$LSD/gets")" = 1 ] && echo 1 || echo 0)" "live path: its CORS preflight, ONE OPTIONS with the site's Origin, POST and content-type; one GET of the site's index.html (unreadable here: no fallback read)"
ok "$(grep -q 'pending: WEB RPC DOWN: https://testnet-rpc.monad.xyz failed 1/3 runs in a row (no answer)' "$SC/out-Z12.log" && grep -q 'pending: API unreadable, 1/3' "$SC/out-Z12.log" && grep -q "the site's fallbacks unknown" "$SC/out-Z12.log" && echo 1 || echo 0)" "live path, nothing answers: WEB RPC DOWN and the API both pending (1/3), the site's fallbacks unknown"
ok "$([ "$(grep -c '^cast balance ' "$LSD/cast-calls")" = 10 ] && ! grep -qv '^cast balance ' "$LSD/cast-calls" && grep -q '^cast balance 0x30C8E371719Ff00577284dd9c10587Fa89357d50 --ether' "$LSD/cast-calls" && grep -q '^cast balance 0x63D2523dDC4BB055A19682Bf2d61fe94959D0Bb9 --ether' "$LSD/cast-calls" && echo 1 || echo 0)" "live path: only cast balance reads, 5 roles (treasury, maker, operator, guardian, attester) x 2 RPCs"
# the deployed build: the site's index.html names its main script; the shim serves both, the script listing the two
# fallbacks. The script is read once and cached (var/watch/web-build); each fallback is read as the primary is.
printf '<script type="module" crossorigin src="/assets/index-Test1234.js"></script>\n' >"$LSD/site-index"
printf 'const a="https://testnet-rpc.monad.xyz",b=["https://rpc.ankr.com/monad_testnet","https://10143.rpc.thirdweb.com"];\n' >"$LSD/site-js"
lrun() { : >"$LSD/gets"; envrun SHIM_DIR="$LSD" ISOTHERM_WATCH_DIR="$SC/st-zl" ISOTHERM_STATE_DIR="$SC/settle-none" "$TBASH" "$P/vps/stack-watch.sh" --now "$(ep "$2")" "${@:3}" >"$SC/out-$1.log" 2>&1; }
lrun Z13 2026-10-14T07:40:00Z
sed -E "s#$SC#<scratch>#g; s/^/    | /" "$LSD/gets" | grep -vE '/api/' | sort
ok "$([ "$(grep -cE ' https://isotherm\.pages\.dev/assets/index-Test1234\.js$' "$LSD/gets")" = 1 ] && [ "$(printf '/assets/index-Test1234.js\nhttps://rpc.ankr.com/monad_testnet\nhttps://10143.rpc.thirdweb.com')" = "$(cat "$SC/st-zl/web-build")" ] \
  && [ "$(grep -cE -- '--data .* https://(rpc\.ankr\.com/monad_testnet|10143\.rpc\.thirdweb\.com)$' "$LSD/gets")" = 2 ] && [ "$(grep -cE -- '-X OPTIONS .* https://(rpc\.ankr\.com/monad_testnet|10143\.rpc\.thirdweb\.com)$' "$LSD/gets")" = 2 ] && grep -q 'fallbacks rpc.ankr.com/monad_testnet (no answer), 10143.rpc.thirdweb.com (no answer)' "$SC/out-Z13.log" && echo 1 || echo 0)" "a new build: its script read once, its 2 fallbacks cached in var/watch/web-build and each read (eth_blockNumber + preflight)"
lrun Z14 2026-10-14T07:50:00Z
ok "$([ "$(grep -c '/assets/' "$LSD/gets")" = 0 ] && [ "$(grep -cE ' https://isotherm\.pages\.dev/$' "$LSD/gets")" = 1 ] && [ "$(grep -cE -- '--data .* https://(rpc\.ankr\.com/monad_testnet|10143\.rpc\.thirdweb\.com)$' "$LSD/gets")" = 2 ] && echo 1 || echo 0)" "the same build on the next run: index.html only (the script not read again), the cached fallbacks read"
rm -f "$SC/st-zl/web-build"; lrun Z15 2026-10-14T08:00:00Z --dry-run
ok "$([ "$(grep -c '/assets/' "$LSD/gets")" = 1 ] && [ ! -e "$SC/st-zl/web-build" ] && echo 1 || echo 0)" "--dry-run reads the script but caches nothing (no state)"
printf 'console.log(1)\n' >"$LSD/site-js"; lrun Z16 2026-10-14T08:10:00Z
ok "$([ ! -e "$SC/st-zl/web-build" ] && ! grep -qE -- 'thirdweb|ankr' "$LSD/gets" && grep -q "the site's fallbacks unknown" "$SC/out-Z16.log" && echo 1 || echo 0)" "a script that does not even list the web RPC (not the app's config): nothing cached, no fallback assumed"
rm -f "$LSD/site-index" "$LSD/site-js"
HELP=$(envrun "$TBASH" "$P/vps/stack-watch.sh" --help)
ok "$([ "$(printf '%s\n' "$HELP" | head -n 1 | cut -c1-21)" = "# Stack watchdog for " ] && ! printf '%s\n' "$HELP" | grep -qv '^#' && printf '%s\n' "$HELP" | tail -n 1 | grep -q 'ISOTHERM_STATE_DIR' && echo 1 || echo 0)" "--help prints the header comment and stops at the first line of code ($(printf '%s\n' "$HELP" | wc -l | tr -d ' ') lines)"

echo; echo "## A. MAKER STALLED"
STALE() { echo "s.receivedAt = s.generatedAt = iso(now - $1 * 60)"; }
w A00 a 2026-10-14T06:00:00Z
w A01 a 2026-10-14T06:10:00Z "$(STALE 14)"
ok "$(t [ "$(np A01 'MAKER STALLED')" = 0 ])" "snapshot 14 min old: no push"
w A02 a 2026-10-14T06:20:00Z "$(STALE 16)"
ok "$([ "$(np A02 'MAKER STALLED')" = 0 ] && grep -q 'pending: MAKER STALLED (snapshot 16 min old, stale run 1' "$SC/out-A02.log" && echo 1 || echo 0)" "16 min old, the first stale run: pending (a single gap that heals by itself is no push)"
w A03 a 2026-10-14T06:30:00Z "$(STALE 26)"
ok "$([ "$(np A03 'MAKER STALLED')" = 1 ] && [ "$(prio A03 'MAKER STALLED')" = high ] && has A03 'MAKER STALLED' '26 min old' && has A03 'MAKER STALLED' 'control.mjs status' && has A03 'MAKER STALLED' '--snooze HOURS' && echo 1 || echo 0)" "the 2nd stale run (26 min): MAKER STALLED, high, with what to run (and the snooze for a deliberate pause)"
echo "    body: $(body A03 'MAKER STALLED')"
w A04 a 2026-10-14T06:40:00Z "$(STALE 36)"
ok "$([ "$(np A04 'MAKER STALLED')" = 0 ] && grep -q "already pushed 0 min ago; not repeated" "$SC/out-A04.log" && echo 1 || echo 0)" "still stale 10 min later: not repeated (3 h window)"
w A05 a 2026-10-14T06:50:00Z
w A06 a 2026-10-14T07:00:00Z "$(STALE 16)"
ok "$([ "$(nall A05)" = 0 ] && grep -q 'clearing: MAKER STALLED' "$SC/out-A05.log" && [ "$(nall A06)" = 0 ] && echo 1 || echo 0)" "fresh once, then stale again: no CLEARED and no new push (the same problem, inside its 3 h window)"
for c in 07:10 07:20 07:30; do w "A07-$c" a "2026-10-14T$c:00Z" >/dev/null; done
w A08 a 2026-10-14T07:40:00Z
ok "$([ "$(npg A07 'CLEARED MAKER STALLED')" = 0 ] && [ "$(np A08 'CLEARED MAKER STALLED')" = 1 ] && [ "$(prio A08 'CLEARED MAKER STALLED')" = low ] && [ ! -f "$SC/st-a/alerts/ISOTHERM_WATCH__MAKER_STALLED.last" ] && echo 1 || echo 0)" "fresh from 07:10Z: CLEARED (low) only at 07:40Z, after 30 min without it; the title's stamp reset"
w A09 a 2026-10-14T07:50:00Z "$(STALE 30)"
ok "$(t [ "$(np A09 'MAKER STALLED')" = 1 ])" "stale again, already 30 min old: pushed at once (a new problem; from 25 min no second run is needed)"
w A10 a 2026-10-14T08:00:00Z 'for (const k of Object.keys(s)) delete s[k]; Object.assign(s, { version: 1, empty: true, ladders: [] })'
ok "$(grep -q 'MAKER STALLED | /api/snapshot holds no maker snapshot' "$SC/out-A10.log" && echo 1 || echo 0)" "an empty /api/snapshot is a stall too (deduplicated here)"
w AO0 ao 2026-10-14T06:00:00Z >/dev/null; w AO1 ao 2026-10-14T06:10:00Z "$(STALE 17)"
for c in 06:20 06:30 06:40; do w "AO2-$c" ao "2026-10-14T$c:00Z" >/dev/null; done
w AO3 ao 2026-10-14T06:50:00Z
ok "$([ "$(npg AO 'MAKER STALLED')" = 0 ] && [ "$(npg AO 'CLEARED MAKER STALLED')" = 0 ] && grep -q 'over: MAKER STALLED' "$SC/out-AO3.log" && echo 1 || echo 0)" "one stale run (17 min), then fresh snapshots: no push and no CLEARED at all; forgotten 30 min later"
# the review's probe: ticks failing on and off at night (00:00-01:00 Taipei), the snapshot 16 min / 1 min old in turn
i=0; for c in 16:00 16:10 16:20 16:30 16:40 16:50 17:00; do
  if [ $((i % 2)) = 0 ]; then a=16; else a=1; fi
  w "AF$i" af "2026-10-14T$c:00Z" "$(STALE $a)" >/dev/null; i=$((i + 1))
done
ok "$([ "$(npg AF 'MAKER STALLED')" = 1 ] && [ "$(np AF2 'MAKER STALLED')" = 1 ] && [ "$(npg AF 'CLEARED MAKER STALLED')" = 0 ] && echo 1 || echo 0)" "16 / 1 / 16 / 1 ... min old, 16:00-17:00Z (7 runs, 4 stale): ONE high push (16:20Z, the 2nd stale run) and no CLEARED in between (before: 4 high + 3 CLEARED)"
for c in 17:10 17:20 17:30 17:40; do w "AG-$c" af "2026-10-14T$c:00Z" >/dev/null; done
ok "$([ "$(npg AG 'CLEARED MAKER STALLED')" = 1 ] && [ "$(np AG-17:40 'CLEARED MAKER STALLED')" = 1 ] && echo 1 || echo 0)" "fresh from 17:10Z: one CLEARED, at 17:40Z"

echo; echo "## B. BOOKS EMPTY"
NOBID='K(20261015, 30).bid = null'
w B1 b 2026-10-14T06:00:00Z "$NOBID"
ok "$(grep -q 'pending: BOOKS EMPTY RCSS 2026-10-15 >=30C (fair 0.50) no bid since 06:00Z' "$SC/out-B1.log" && [ "$(np B1 'BOOKS EMPTY')" = 0 ] && echo 1 || echo 0)" "fair 0.50 without a bid: first seen, pending"
w B2 b 2026-10-14T06:50:00Z "$NOBID"
ok "$(t [ "$(np B2 'BOOKS EMPTY')" = 0 ])" "50 min: no push"
w B3 b 2026-10-14T07:00:00Z "$NOBID"
ok "$([ "$(np B3 'BOOKS EMPTY')" = 1 ] && [ "$(prio B3 'BOOKS EMPTY')" = default ] && has B3 'BOOKS EMPTY' 'RCSS 2026-10-15 >=30C (fair 0.50) no bid since 06:00Z' && has B3 'BOOKS EMPTY' 'quoting cap' && echo 1 || echo 0)" "60 min: BOOKS EMPTY (default), the strike and the likely cause named"
echo "    body: $(body B3 'BOOKS EMPTY')"
w B4 b 2026-10-14T07:10:00Z
w B4b b 2026-10-14T07:40:00Z
ok "$([ "$(np B4 'CLEARED BOOKS EMPTY')" = 0 ] && [ "$(np B4b 'CLEARED BOOKS EMPTY')" = 1 ] && echo 1 || echo 0)" "quoted again at 07:10Z: CLEARED at 07:40Z (30 min later)"
EDGES='K(20261015, 29).fair = 0.95; K(20261015, 29).bid = K(20261015, 29).ask = null; K(20261015, 31).fair = 0.09; K(20261015, 31).ask = null; K(20261014, 30).fair = 0.10; K(20261014, 30).askRemaining = 0'
for tm in 06:00 06:30 07:00 07:30 08:00; do w "B5-$tm" b5 "2026-10-14T$tm:00Z" "$EDGES" >/dev/null; done
w B5 b5 2026-10-14T08:10:00Z "$EDGES"
ok "$([ "$(np B5 'BOOKS EMPTY')" = 0 ] && grep -q 'BOOKS EMPTY | 1 at-the-money strike' "$SC/out-B5.log" && echo 1 || echo 0)" "after 2 h: fair 0.95 and 0.09 never count; fair 0.10 with its ask filled (askRemaining 0) does (pushed at 07:00, held since)"
ok "$(grep -q 'RCSS 2026-10-14 >=30C (fair 0.10) no ask since 06:00Z' "$SC/out-B5.log" && ! grep -qE '>=29C|>=31C' "$SC/out-B5.log" && echo 1 || echo 0)" "the alert names only that strike"
# the close window: the closing ladder (10-14, close 09:30Z) and the next one (10-15), both empty since 08:20Z
CW='K(20261014, 30).ask = null; K(20261015, 29).bid = null'
for tm in 08:20 09:00; do w "B6-$tm" b6 "2026-10-14T$tm:00Z" "$CW" >/dev/null; done
w B6a b6 2026-10-14T09:20:00Z "$CW"
w B6b b6 2026-10-14T09:30:00Z "$CW"
ok "$([ "$(np B6a 'BOOKS EMPTY')" = 0 ] && [ "$(np B6b 'BOOKS EMPTY')" = 0 ] && grep -q 'BOOKS EMPTY held: inside a close window' "$SC/out-B6a.log" && echo 1 || echo 0)" "09:20 and 09:30Z (60 and 70 min): held, inside 09:15-09:35"
w B6c b6 2026-10-14T09:40:00Z "$CW"
ok "$([ "$(np B6c 'BOOKS EMPTY')" = 1 ] && has B6c 'BOOKS EMPTY' 'RCSS 2026-10-15 >=29C (fair 0.85) no bid since 08:20Z' && ! has B6c 'BOOKS EMPTY' '2026-10-14' && echo 1 || echo 0)" "09:40Z: pushed for the 10-15 ladder only (the 10-14 one closed; its kill switch pulled it by design)"
# the roll: before 04:00Z the next ladder does not exist; a ladder that is not "active" yet (here "rolling", its opening
# quotes not placed) never counts; once active, the 60 min count from then
EMPTY15='for (const k of [29, 30, 31]) { K(20261015, k).bid = K(20261015, k).ask = null }'
w B7a b7 2026-10-14T03:50:00Z
w B7b b7 2026-10-14T04:00:00Z "$EMPTY15; L(20261015).status = \"rolling\""
w B7c b7 2026-10-14T04:20:00Z "$EMPTY15; L(20261015).status = \"rolling\""
w B7d b7 2026-10-14T04:30:00Z "$EMPTY15"
w B7e b7 2026-10-14T05:20:00Z "$EMPTY15"
w B7f b7 2026-10-14T05:30:00Z "$EMPTY15"
ok "$(! grep -q 'pending: BOOKS' "$SC/out-B7b.log" "$SC/out-B7c.log" && [ "$(npg B7 'BOOKS EMPTY' B7e)" = 0 ] && [ "$(np B7f 'BOOKS EMPTY')" = 1 ] && has B7f 'BOOKS EMPTY' 'since 04:30Z' && echo 1 || echo 0)" "a ladder not active yet (rolling) never counts; once active at 04:30Z, pushed 60 min later (05:30Z), not 60 min after it appeared"
# a refill followed by a new gap: the alert stays open (no CLEARED, no second alert an hour later)
for tm in 06:00 07:00; do w "B8-$tm" b8 "2026-10-14T$tm:00Z" "$NOBID" >/dev/null; done
w B8-07:10 b8 2026-10-14T07:10:00Z >/dev/null
for tm in 07:20 07:50 08:20; do w "B8-$tm" b8 "2026-10-14T$tm:00Z" "$NOBID" >/dev/null; done
for tm in 08:30 08:40 08:50; do w "B8-$tm" b8 "2026-10-14T$tm:00Z" >/dev/null; done
w B9 b8 2026-10-14T09:00:00Z
ok "$([ "$(npg B8 'BOOKS EMPTY')" = 1 ] && [ "$(np B8-07:00 'BOOKS EMPTY')" = 1 ] && [ "$(npg B8 'CLEARED BOOKS EMPTY')" = 0 ] && grep -q 'ALERT: ISOTHERM WATCH: BOOKS EMPTY | 1 at-the-money strike(s) without a maker quote on one side: RCSS 2026-10-15 >=30C (fair 0.50) no bid since 07:20Z' "$SC/out-B8-07:20.log" && [ "$(np B9 'CLEARED BOOKS EMPTY')" = 1 ] && echo 1 || echo 0)" "empty 06:00Z, pushed 07:00Z, refilled 07:10Z, empty again 07:20-08:20Z: one BOOKS EMPTY, kept open (not CLEARED); quoted from 08:30Z: CLEARED at 09:00Z"

echo; echo "## L. ladders: LADDER NOT OPENED, NO ACTIVE LADDER (the review's probe: 10-15 stuck \"rolling\" from 04:00Z on 10-14)"
ROLLING='UNROLL(20261015, "rolling")'
w L00 l 2026-10-14T04:50:00Z "$ROLLING"
ok "$(t [ "$(nall L00)" = 1 ])" "04:50Z (12:50 Taipei), 10-15 still rolling: only the first digest (today's 10-14 trades; the grace runs to 13:00 local)"
w L01 l 2026-10-14T05:00:00Z "$ROLLING"
ok "$([ "$(np L01 'LADDER NOT OPENED RCSS')" = 1 ] && [ "$(prio L01 'LADDER NOT OPENED RCSS')" = high ] && has L01 'LADDER NOT OPENED RCSS' 'RCSS 2026-10-15 is not open for trading' && has L01 'LADDER NOT OPENED RCSS' '"rolling"' && has L01 'LADDER NOT OPENED RCSS' 'Trading now: RCSS 2026-10-14 to 09:30Z' && has L01 'LADDER NOT OPENED RCSS' 'control.mjs roll RCSS 2026-10-15' && grep -q 'RCSS 2026-10-15 NOT OPEN' "$SC/out-L01.log" && echo 1 || echo 0)" "05:00Z (13:00 Taipei), 10-15 still \"rolling\": LADDER NOT OPENED RCSS, high, naming the ladder, what still trades and the fix"
echo "    body: $(body L01 'LADDER NOT OPENED RCSS')"
w L02 l 2026-10-14T06:00:00Z "$ROLLING"
ok "$(t [ "$(np L02 'LADDER NOT OPENED RCSS')" = 0 ])" "06:00Z: not repeated (3 h window)"
for c in 09:20 09:30 09:40 09:50; do w "L03-$c" l "2026-10-14T$c:00Z" "$ROLLING" >/dev/null; done
w L04 l 2026-10-14T10:00:00Z "$ROLLING"
ok "$([ "$(npg L03 'NO ACTIVE LADDER')" = 0 ] && [ "$(np L04 'NO ACTIVE LADDER')" = 1 ] && [ "$(prio L04 'NO ACTIVE LADDER')" = high ] && has L04 'NO ACTIVE LADDER' 'RCSS 2026-10-15 rolling' && echo 1 || echo 0)" "10-14 closed at 09:30Z with 10-15 still rolling: NO ACTIVE LADDER at 10:00Z (20 min after the close window, 3 runs), high"
echo "    body: $(body L04 'NO ACTIVE LADDER')"
w L05 l 2026-10-14T11:00:00Z
w L06 l 2026-10-14T11:30:00Z
ok "$([ "$(nall L05)" = 0 ] && grep -q 'clearing: LADDER NOT OPENED RCSS' "$SC/out-L05.log" && [ "$(np L06 'CLEARED LADDER NOT OPENED RCSS')" = 1 ] && [ "$(np L06 'CLEARED NO ACTIVE LADDER')" = 1 ] && echo 1 || echo 0)" "rolled at 11:00Z: both CLEARED (low) at 11:30Z"
w LM lm 2026-10-14T05:00:00Z 'DROP(20261015)'
ok "$([ "$(np LM 'LADDER NOT OPENED RCSS')" = 1 ] && has LM 'LADDER NOT OPENED RCSS' "not in the maker's state" && echo 1 || echo 0)" "10-15 not in the snapshot at all at 05:00Z (its roll refused before planning): LADDER NOT OPENED RCSS"
w LP lp 2026-10-14T05:00:00Z 'UNROLL(20261015, "planned")'
ok "$([ "$(np LP 'LADDER NOT OPENED RCSS')" = 1 ] && has LP 'LADDER NOT OPENED RCSS' '"planned"' && echo 1 || echo 0)" "10-15 \"planned\" (no transaction yet) at 05:00Z: LADDER NOT OPENED RCSS"

echo; echo "## C. /api/health: DRIP DOWN, RELAY DOWN, API UNHEALTHY, RELAYER LOW, AUSD FLOAT"
RPCBAD='h.monBalance = null; h.dripReady = false; h.relayReady = false'
w C1 c 2026-10-14T06:00:00Z "$RPCBAD"; w C2 c 2026-10-14T06:10:00Z "$RPCBAD"
ok "$([ "$(np C1 'DRIP DOWN')" = 0 ] && [ "$(np C2 'DRIP DOWN')" = 0 ] && [ "$(np C2 'RELAYER LOW')" = 0 ] && echo 1 || echo 0)" "dripReady/relayReady false (the API cannot read the chain): pending for 20 min; no RELAYER LOW from an unknown balance"
w C3 c 2026-10-14T06:20:00Z "$RPCBAD"
ok "$([ "$(np C3 'DRIP DOWN')" = 1 ] && [ "$(np C3 'RELAY DOWN')" = 1 ] && [ "$(prio C3 'DRIP DOWN')" = high ] && has C3 'DRIP DOWN' 'could not read the relayer' && echo 1 || echo 0)" "20 min (3 runs): DRIP DOWN and RELAY DOWN (high), the reason given"
w C4 c 2026-10-14T06:30:00Z
w C4b c 2026-10-14T07:00:00Z
ok "$([ "$(nall C4)" = 0 ] && [ "$(np C4b 'CLEARED DRIP DOWN')" = 1 ] && [ "$(np C4b 'CLEARED RELAY DOWN')" = 1 ] && echo 1 || echo 0)" "ready again at 06:30Z: both CLEARED at 07:00Z"
CAPFULL='h.limits.dripsToday = 17; h.dripReady = false'
for tm in 09:00 09:10 09:20; do w "C5-$tm" c5 "2026-10-14T$tm:00Z" "$CAPFULL" >/dev/null; done
w C5 c5 2026-10-14T09:30:00Z "$CAPFULL"
ok "$([ "$(npg C5 'DRIP DOWN')" = 0 ] && [ "$(npg C5 'DRIP CAP REACHED')" = 1 ] && echo 1 || echo 0)" "dripReady false because the day's cap is used (first seen 09:00Z): never DRIP DOWN; one DRIP CAP REACHED"
PAUSED='h.dripEnabled = false; h.dripReady = false'
for tm in 06:00 06:20 06:40; do w "C6-$tm" c6 "2026-10-14T$tm:00Z" "$PAUSED" >/dev/null; done
ok "$(t [ "$(npg C6 'DRIP DOWN')" = 0 ])" "drips paused on purpose (DRIP_ENABLED=0) for 40 min: never DRIP DOWN"
w C7a c7 2026-10-14T06:00:00Z 'h.ok = false'; w C7b c7 2026-10-14T06:10:00Z 'h.ok = false'; w C7c c7 2026-10-14T06:20:00Z 'h.ok = false'
ok "$([ "$(np C7b 'API UNHEALTHY')" = 0 ] && [ "$(np C7c 'API UNHEALTHY')" = 1 ] && echo 1 || echo 0)" "health.ok false: API UNHEALTHY after 20 min (3 runs)"
w C8a c8 2026-10-14T06:00:00Z 'h.monBalance = "15.0"'
w C8b c8 2026-10-14T06:10:00Z 'h.monBalance = "14.9"'
ok "$([ "$(np C8a 'RELAYER LOW')" = 0 ] && [ "$(np C8b 'RELAYER LOW')" = 1 ] && [ "$(prio C8b 'RELAYER LOW')" = high ] && has C8b 'RELAYER LOW' '2.8 worst-case days at the current caps' && echo 1 || echo 0)" "relayer 15.0 MON: nothing; 14.9: RELAYER LOW at once (high), with the runway"
echo "    body: $(body C8b 'RELAYER LOW')"
w C9a c9 2026-10-14T06:00:00Z 'h.ausdFloat = "5000"'; w C9b c9 2026-10-14T06:20:00Z 'h.ausdFloat = "5000"'
w C9c c9 2026-10-14T06:30:00Z 'h.ausdFloat = "4000"'; w C9d c9 2026-10-14T06:40:00Z 'h.ausdFloat = "4000"'; w C9e c9 2026-10-14T06:50:00Z 'h.ausdFloat = "4000"'
ok "$([ "$(np C9b 'AUSD FLOAT LOW')" = 0 ] && [ "$(np C9d 'AUSD FLOAT LOW')" = 0 ] && [ "$(np C9e 'AUSD FLOAT LOW')" = 1 ] && [ "$(prio C9e 'AUSD FLOAT LOW')" = default ] && echo 1 || echo 0)" "AUSD float 5,000: nothing; 4,000 for 20 min: AUSD FLOAT LOW (default)"
# the review's case: a drip outage with one good reading every 20 min (before: never reported, each good reading reset the clock)
w CF0 cf 2026-10-14T06:00:00Z 'h.dripReady = false'; w CF1 cf 2026-10-14T06:10:00Z 'h.dripReady = false'
w CF2 cf 2026-10-14T06:20:00Z; w CF3 cf 2026-10-14T06:30:00Z 'h.dripReady = false'
ok "$([ "$(npg CF 'DRIP DOWN')" = 1 ] && [ "$(np CF3 'DRIP DOWN')" = 1 ] && has CF3 'DRIP DOWN' 'since 2026-10-14T06:00Z' && echo 1 || echo 0)" "dripReady false, false, true, false (06:00-06:30Z): DRIP DOWN at 06:30Z, open since 06:00Z"

echo; echo "## D. caps used early (a bot?)"
w D0 d 2026-10-14T05:00:00Z 'h.limits.dripsToday = 16; h.limits.relaysToday = 27'
ok "$([ "$(np D0 'DRIP CAP USED EARLY')" = 0 ] && [ "$(np D0 'RELAY CAP USED EARLY')" = 0 ] && echo 1 || echo 0)" "16/17 drips, 27/28 relays at 05:00Z: nothing"
w D1 d 2026-10-14T07:50:00Z 'h.limits.dripsToday = 17; h.dripReady = false'
ok "$([ "$(np D1 'DRIP CAP USED EARLY')" = 1 ] && [ "$(prio D1 'DRIP CAP USED EARLY')" = high ] && has D1 'DRIP CAP USED EARLY' 'used by 07:50 UTC' && has D1 'DRIP CAP USED EARLY' 'set DRIP_MON back to 0.15 or pause drips' && has D1 'DRIP CAP USED EARLY' 'docs/OPERATIONS.md section 0' && echo 1 || echo 0)" "17/17 drips by 07:50Z: DRIP CAP USED EARLY, high, the action and OPERATIONS section 0"
echo "    body: $(body D1 'DRIP CAP USED EARLY')"
w D2 d 2026-10-14T08:00:00Z 'h.limits.dripsToday = 17; h.dripReady = false'
ok "$(t [ "$(nall D2)" = 0 ])" "08:00Z, still full: no second push that day (and no CAP REACHED)"
w D3 d 2026-10-14T08:10:00Z 'h.limits.dripsToday = 17; h.limits.relaysToday = 28; h.dripReady = h.relayReady = false'
ok "$([ "$(np D3 'RELAY CAP REACHED')" = 1 ] && [ "$(prio D3 'RELAY CAP REACHED')" = low ] && [ "$(np D3 'RELAY CAP USED EARLY')" = 0 ] && has D3 'RELAY CAP REACHED' 'Heavy judge use is fine' && echo 1 || echo 0)" "28/28 relays first seen at 08:10Z: RELAY CAP REACHED at LOW priority (no sound at night), not EARLY"
w D4 d 2026-10-15T02:00:00Z 'h.limits.dripsToday = 17; h.limits.relaysToday = 28; h.dripReady = h.relayReady = false'
ok "$([ "$(np D4 'DRIP CAP USED EARLY')" = 1 ] && [ "$(np D4 'RELAY CAP USED EARLY')" = 1 ] && has D4 'RELAY CAP USED EARLY' 'RELAY_ENABLED' && echo 1 || echo 0)" "the next UTC day, full by 02:00Z: both CAP USED EARLY again (relays: lower the caps or RELAY_ENABLED=0)"

echo; echo "## O. a one-off push whose delivery failed is re-sent (the review's probe: ntfy answers 429 once)"
echo 429 >"$SD/fail"
w O1 o 2026-10-14T03:00:00Z 'h.limits.dripsToday = 17; h.dripReady = false'
rm -f "$SD/fail"
ok "$([ "$(nall O1)" = 0 ] && grep -q 'push: FAILED (HTTP 429)' "$SC/out-O1.log" && grep -q 'DRIP CAP USED EARLY' "$SD/failed" && grep -q 'daily digest 2026-10-14' "$SD/failed" && echo 1 || echo 0)" "03:00Z, 17/17 drips: DRIP CAP USED EARLY and the first digest both answered 429: nothing delivered"
w O2 o 2026-10-14T03:10:00Z 'h.limits.dripsToday = 17; h.dripReady = false'
ok "$([ "$(np O2 'DRIP CAP USED EARLY')" = 1 ] && [ "$(prio O2 'DRIP CAP USED EARLY')" = high ] && [ "$(np O2 'daily digest 2026-10-14')" = 1 ] && grep -q 're-sending (try 2' "$SC/out-O2.log" && echo 1 || echo 0)" "03:10Z: both re-sent and delivered (before: lost for the day)"
w O3 o 2026-10-14T03:20:00Z 'h.limits.dripsToday = 17; h.dripReady = false'
ok "$([ "$(nall O3)" = 0 ] && grep -q 'delivered: DRIP CAP USED EARLY (try 2)' "$SC/out-O3.log" && echo 1 || echo 0)" "03:20Z: seen as delivered (its stamp changed), nothing more"

echo; echo "## E. treasury, maker, operator"
w E1 e 2026-10-14T06:00:00Z 'b.treasury = 20.0; b.maker = 1.0; b.operator = 0.9'
ok "$(t [ "$(nall E1)" = 1 ])" "treasury 20.0, maker 1.0, operator 0.9 (the lines): nothing but the first digest"
w E2 e 2026-10-14T06:10:00Z 'b.treasury = 19.9'
ok "$([ "$(np E2 'TREASURY LOW')" = 1 ] && [ "$(prio E2 'TREASURY LOW')" = high ] && has E2 'TREASURY LOW' 'node fund.mjs treasury=20' && echo 1 || echo 0)" "treasury 19.9: TREASURY LOW at once (high), with the funding command"
w E3 e 2026-10-14T06:20:00Z 'b.treasury = null'
ok "$([ "$(nall E3)" = 0 ] && grep -q '"treasury-low"' "$SC/st-e/state.json" && echo 1 || echo 0)" "a failed treasury read: no CLEARED, the alert stays open in the state"
w E4 e 2026-10-14T06:30:00Z 'b.treasury = 25'
w E4b e 2026-10-14T07:00:00Z 'b.treasury = 25'
ok "$([ "$(nall E4)" = 0 ] && [ "$(np E4b 'CLEARED TREASURY LOW')" = 1 ] && echo 1 || echo 0)" "funded at 06:30Z: CLEARED at 07:00Z"
w E5a e2 2026-10-14T06:00:00Z 'b.maker = 0.95; s.maker.mon = 0.95'
w E5b e2 2026-10-14T06:10:00Z 'b.maker = 0.95; s.maker.mon = 0.95'
w E5c e2 2026-10-14T06:20:00Z 'b.maker = 0.95; s.maker.mon = 0.95'
ok "$([ "$(np E5b 'MAKER LOW')" = 0 ] && [ "$(np E5c 'MAKER LOW')" = 1 ] && [ "$(prio E5c 'MAKER LOW')" = high ] && echo 1 || echo 0)" "maker 0.95 MON: MAKER LOW after 20 min (two treasury passes), high"
w E6a e3 2026-10-14T04:10:00Z 'b.operator = 0.47'
w E6b e3 2026-10-14T04:20:00Z 'b.operator = 2.5'
ok "$([ "$(np E6a 'OPERATOR LOW')" = 0 ] && [ "$(np E6b 'OPERATOR LOW')" = 0 ] && echo 1 || echo 0)" "the roll's dip (0.47 at 04:10Z, refilled by 04:20Z): no push"
w E7a e4 2026-10-14T05:00:00Z 'b.operator = 0.85'; w E7b e4 2026-10-14T05:10:00Z 'b.operator = 0.85'; w E7c e4 2026-10-14T05:20:00Z 'b.operator = 0.85'
ok "$([ "$(np E7b 'OPERATOR LOW')" = 0 ] && [ "$(np E7c 'OPERATOR LOW')" = 1 ] && has E7c 'OPERATOR LOW' 'needs ~0.85 MON' && echo 1 || echo 0)" "operator 0.85 for 20 min: OPERATOR LOW (the roll needs ~0.85)"
# the guardian (challenge / pause gas) and the attester (the settlement report sender), topped up by the treasury below
# 0.05 and 0.3: nothing else watched them (audit 2026-10-14)
w E8 e5 2026-10-14T06:00:00Z 'b.guardian = 0.03; b.attester = 0.08'
ok "$(t [ "$(nall E8)" = 1 ])" "guardian 0.03 and attester 0.08 (the lines; the settlement job's own push warns below 0.1): nothing but the first digest"
GA='b.guardian = 0.029; b.attester = 0.079'
w E9a e5 2026-10-14T06:10:00Z "$GA"; w E9b e5 2026-10-14T06:20:00Z "$GA"; w E9c e5 2026-10-14T06:30:00Z "$GA"
ok "$([ "$(np E9b 'GUARDIAN LOW')" = 0 ] && [ "$(np E9b 'ATTESTER LOW')" = 0 ] && [ "$(np E9c 'GUARDIAN LOW')" = 1 ] && [ "$(prio E9c 'GUARDIAN LOW')" = high ] && [ "$(np E9c 'ATTESTER LOW')" = 1 ] && [ "$(prio E9c 'ATTESTER LOW')" = high ] && grep -q 'pending: GUARDIAN LOW' "$SC/out-E9b.log" && echo 1 || echo 0)" "guardian 0.029, attester 0.079 MON from 06:10Z: pending, then both LOW at 06:30Z (20 min, 3 runs), high"
ok "$(has E9c 'GUARDIAN LOW' 'challenge()' && has E9c 'GUARDIAN LOW' 'node fund.mjs guardian=0.15' && has E9c 'ATTESTER LOW' 'about 3 reports at 0.0204' && has E9c 'ATTESTER LOW' 'node fund.mjs attester=0.5' && echo 1 || echo 0)" "the bodies say what each pays for (a challenge; the reports left) and how to fund it"
echo "    body: $(body E9c 'GUARDIAN LOW')"
echo "    body: $(body E9c 'ATTESTER LOW')"
w E10 e5 2026-10-14T06:40:00Z 'b.guardian = null; b.attester = null'
ok "$([ "$(nall E10)" = 0 ] && grep -q '"guardian-low"' "$SC/st-e5/state.json" && grep -q '"attester-low"' "$SC/st-e5/state.json" && echo 1 || echo 0)" "both reads fail: no CLEARED, both stay open in the state"
w E11 e5 2026-10-14T06:50:00Z; w E11b e5 2026-10-14T07:20:00Z
ok "$([ "$(nall E11)" = 0 ] && [ "$(np E11b 'CLEARED GUARDIAN LOW')" = 1 ] && [ "$(np E11b 'CLEARED ATTESTER LOW')" = 1 ] && echo 1 || echo 0)" "topped up at 06:50Z: both CLEARED at 07:20Z"
w E12a e6 2026-10-14T18:10:00Z 'b.guardian = 0.028'; w E12b e6 2026-10-14T18:20:00Z 'b.guardian = 0.15'
ok "$([ "$(npg E12 'GUARDIAN LOW')" = 0 ] && grep -q 'pending: GUARDIAN LOW' "$SC/out-E12a.log" && echo 1 || echo 0)" "a dip (two challenges: 0.028), topped up by the next run: no push"

echo; echo "## R. WEB RPC DOWN (the web app's RPC read as a browser on the site reads it; the deployed build's fallbacks)"
DOWN='wr.code = 0'
w R0 r 2026-10-14T06:00:00Z
ok "$([ "$(nall R0)" = 1 ] && grep -q '; web RPC block [0-9]' "$SC/out-R0.log" && has R0 'daily digest 2026-10-14' 'Web RPC (testnet-rpc.monad.xyz): ok, block ' && echo 1 || echo 0)" "answering: nothing pushed but the first digest, which shows the block"
w R1 r 2026-10-14T06:10:00Z "$DOWN"; w R2 r 2026-10-14T06:20:00Z "$DOWN"
ok "$([ "$(nall R1)" = 0 ] && [ "$(nall R2)" = 0 ] && grep -q 'pending: WEB RPC DOWN: https://testnet-rpc.monad.xyz failed 2/3 runs in a row (no answer)' "$SC/out-R2.log" && echo 1 || echo 0)" "no answer on the 1st and 2nd run: pending, no push"
w R3 r 2026-10-14T06:30:00Z 'wr.code = 503'
ok "$([ "$(np R3 'WEB RPC DOWN')" = 1 ] && [ "$(prio R3 'WEB RPC DOWN')" = high ] && has R3 'WEB RPC DOWN' ': HTTP 503' && has R3 'WEB RPC DOWN' 'since 2026-10-14T06:10Z' && has R3 'WEB RPC DOWN' 'apps/web/src/config.ts' && has R3 'WEB RPC DOWN' "curl -s -D - -H 'content-type: application/json' -H 'Origin: https://isotherm.pages.dev'" && has R3 'WEB RPC DOWN' "suspect this VPS's network" && has R3 'WEB RPC DOWN' 'has no fallback RPC: judges see no prices' && echo 1 || echo 0)" "the 3rd failed run in a row (HTTP 503): WEB RPC DOWN, high (the deployed build has no fallback), since the first failure, with the check to run from the Mac (headers shown) and, for a network failure, this VPS's network as a suspect"
echo "    body: $(body R3 'WEB RPC DOWN')"
w R4 r 2026-10-14T06:40:00Z "$DOWN"
ok "$(t [ "$(np R4 'WEB RPC DOWN')" = 0 ])" "the 4th: not repeated (3 h window)"
w R5 r 2026-10-14T06:50:00Z; w R5b r 2026-10-14T07:20:00Z
ok "$([ "$(nall R5)" = 0 ] && [ "$(np R5b 'CLEARED WEB RPC DOWN')" = 1 ] && [ "$(prio R5b 'CLEARED WEB RPC DOWN')" = low ] && echo 1 || echo 0)" "answering again from 06:50Z: CLEARED (low) at 07:20Z"
w RA0 ra 2026-10-14T06:00:00Z "$DOWN"; w RA1 ra 2026-10-14T06:10:00Z "$DOWN"; w RA2 ra 2026-10-14T06:20:00Z
w RA3 ra 2026-10-14T06:30:00Z "$DOWN"; w RA4 ra 2026-10-14T06:40:00Z "$DOWN"
ok "$(t [ "$(npg RA 'WEB RPC DOWN')" = 0 ])" "fail, fail, ok, fail, fail: no push (a good run resets the count)"
# each way it can fail, 3 runs each: the reason in the push
rk() { # rk <case> <mutation> <text in the body> <label>
  local c=$1; for tm in 06:00 06:10; do w "$c-$tm" "$c" "2026-10-14T$tm:00Z" "$2" >/dev/null; done
  w "$c" "$c" 2026-10-14T06:20:00Z "$2"
  ok "$([ "$(np "$c" 'WEB RPC DOWN')" = 1 ] && has "$c" 'WEB RPC DOWN' "$3" && echo 1 || echo 0)" "$4: WEB RPC DOWN on the 3rd run, saying \"$3\""
}
rk RE 'wr.json = { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "request limit reached" } }' 'no block number (error -32005: request limit reached)' "HTTP 200 with a JSON-RPC error"
rk RJ 'wr.json = "<html>502 Bad Gateway</html>"' ': not JSON' "HTTP 200 with an HTML page"
rk RC 'wr.acao = "https://example.org"' 'access-control-allow-origin "https://example.org") does not allow https://isotherm.pages.dev' "a CORS header for another origin (browsers drop the answer)"
rk RN 'wr.acao = null' 'access-control-allow-origin missing' "no CORS header at all"
rk RP 'wr.pre = 403' 'its CORS preflight (OPTIONS): HTTP 403, so browsers never send the read' "the preflight refused (HTTP 403), the POST itself fine"
rk RPN 'wr.pre = 0' 'its CORS preflight (OPTIONS): no answer' "the preflight unanswered"
rk RPO 'wr.pacao = "https://example.org"' 'its CORS preflight (OPTIONS): access-control-allow-origin "https://example.org"' "the preflight allows another origin"
rk RPH 'wr.pah = "Authorization,User-Agent"' 'access-control-allow-headers "Authorization,User-Agent", without content-type' "the preflight does not allow the content-type header"
ok "$(! has RC 'WEB RPC DOWN' "suspect this VPS's network" && has RC 'WEB RPC DOWN' "curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: https://isotherm.pages.dev' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type' https://testnet-rpc.monad.xyz" && has RC 'WEB RPC DOWN' 'a block number alone does not mean a browser can use it' \
  && ! has RPH 'WEB RPC DOWN' "suspect this VPS's network" && has RP 'WEB RPC DOWN' "suspect this VPS's network" && ! has RE 'WEB RPC DOWN' "suspect this VPS's network" && echo 1 || echo 0)" "the check from the Mac fits the failure: a CORS one prints the headers of both requests and never blames this VPS's network; an HTTP error or no answer does; a JSON-RPC error does not"
echo "    body: $(body RC 'WEB RPC DOWN')"
for tm in 06:00 06:10 06:20; do w "RV-$tm" rv "2026-10-14T$tm:00Z" 'wr.pre = 204; wr.pacao = "*"; wr.pah = "content-type"' >/dev/null; done
ok "$([ "$(npg RV 'WEB RPC DOWN')" = 0 ] && ! grep -q 'pending: WEB RPC' "$SC"/out-RV-*.log && echo 1 || echo 0)" "a 204 preflight allowing \"*\" and content-type (Ankr's and thirdweb's answer): fine"
HOLD='wr.block -= Math.round((now - ep("2026-10-14T06:00:00Z")) * 2.5)'   # the block of 06:00Z, every run
for tm in 06:00 06:10 06:20; do w "RS-$tm" rs "2026-10-14T$tm:00Z" "$HOLD" >/dev/null; done
w RS rs 2026-10-14T06:30:00Z "$HOLD"
ok "$([ "$(npg RS- 'WEB RPC DOWN')" = 0 ] && [ "$(np RS 'WEB RPC DOWN')" = 1 ] && has RS 'WEB RPC DOWN' 'stuck: block ' && grep -q 'pending: WEB RPC DOWN: .* 1/3 .*stuck' "$SC/out-RS-06:10.log" && echo 1 || echo 0)" "the same block from 06:00Z on (stuck): failed from the 2nd run (06:10Z), WEB RPC DOWN on the 3rd failed one (06:30Z)"
for tm in 06:00 06:10 06:20; do w "RW-$tm" rw "2026-10-14T$tm:00Z" 'wr.acao = "*"' >/dev/null; done
ok "$([ "$(npg RW 'WEB RPC DOWN')" = 0 ] && ! grep -q 'pending: WEB RPC' "$SC"/out-RW-*.log && echo 1 || echo 0)" "access-control-allow-origin \"*\": fine (no pending, no push)"
w RB0 rb 2026-10-14T06:00:00Z; w RB1 rb 2026-10-14T06:10:00Z 'wr.block = 1000'; w RB2 rb 2026-10-14T06:20:00Z 'wr.block = 2500'
w RB3 rb 2026-10-14T06:30:00Z 'wr.block = 4000'
ok "$([ "$(npg RB 'WEB RPC DOWN')" = 0 ] && grep -q 'pending: WEB RPC DOWN: .* 1/3 .*stuck: block 1000' "$SC/out-RB1.log" && ! grep -q 'pending: WEB RPC' "$SC/out-RB2.log" "$SC/out-RB3.log" && echo 1 || echo 0)" "a chain reset (block 1000 after millions): one failed run, then it counts from there (no push)"
w RQ0 rq 2026-10-14T06:00:00Z; w RQ1 rq 2026-10-14T06:01:00Z "$HOLD" -- --force
ok "$(! grep -q 'pending: WEB RPC' "$SC/out-RQ1.log" && echo 1 || echo 0)" "a run 1 min after the last with the same block: not judged stuck"
# a deployed build with fallbacks (apps/web FALLBACK_RPC_URLS): the primary down while one answers is default, not high
FB2='FB("https://rpc.ankr.com/monad_testnet"); FB("https://10143.rpc.thirdweb.com")'
for tm in 06:00 06:10; do w "RF-$tm" rf "2026-10-14T$tm:00Z" "$DOWN; $FB2" >/dev/null; done
w RF1 rf 2026-10-14T06:20:00Z "$DOWN; $FB2"
ok "$([ "$(npg RF- 'WEB RPC DOWN')" = 0 ] && [ "$(np RF1 'WEB RPC DOWN')" = 1 ] && [ "$(prio RF1 'WEB RPC DOWN')" = default ] && has RF1 'WEB RPC DOWN' 'falls back to rpc.ankr.com/monad_testnet (ok), 10143.rpc.thirdweb.com (ok): judges can still read and trade through the fallback' && grep -q 'pending: WEB RPC DOWN: .* 2/3 .*default (a fallback answers)' "$SC/out-RF-06:10.log" && echo 1 || echo 0)" "the deployed build falls back to Ankr and thirdweb, both answer: WEB RPC DOWN on the 3rd run at DEFAULT priority, saying judges still trade"
echo "    body: $(body RF1 'WEB RPC DOWN')"
w RF2 rf 2026-10-14T06:30:00Z "$DOWN; FB(\"https://rpc.ankr.com/monad_testnet\", { code: 0, pre: 0 }); FB(\"https://10143.rpc.thirdweb.com\", { acao: null })"
ok "$([ "$(np RF2 'WEB RPC DOWN')" = 1 ] && [ "$(prio RF2 'WEB RPC DOWN')" = high ] && has RF2 'WEB RPC DOWN' 'rpc.ankr.com/monad_testnet (no answer), 10143.rpc.thirdweb.com (its CORS header (access-control-allow-origin missing)' && has RF2 'WEB RPC DOWN' 'judges see no prices' && echo 1 || echo 0)" "10 min later the fallbacks fail too: HIGH at once (the default push's 3 h repeat stamp reset), no fallback answers"
w RF3 rf 2026-10-14T06:40:00Z "$DOWN; $FB2"; w RF4 rf 2026-10-14T06:50:00Z "$DOWN"
ok "$([ "$(nall RF3)" = 0 ] && [ "$(nall RF4)" = 0 ] && echo 1 || echo 0)" "after the high push, a fallback back and then none again: no more pushes inside the 3 h window"
for tm in 06:00 06:10 06:20; do w "RG-$tm" rg "2026-10-14T$tm:00Z" "$DOWN; FB(\"https://rpc.ankr.com/monad_testnet\", { code: 503 })" >/dev/null; done
ok "$([ "$(np RG-06:20 'WEB RPC DOWN')" = 1 ] && [ "$(prio RG-06:20 'WEB RPC DOWN')" = high ] && echo 1 || echo 0)" "a build whose only fallback fails too: high from the start"
for tm in 06:00 06:10 06:20; do w "RU-$tm" ru "2026-10-14T$tm:00Z" "$DOWN; wr.build = null" >/dev/null; done
ok "$([ "$(prio RU-06:20 'WEB RPC DOWN')" = high ] && has RU-06:20 'WEB RPC DOWN' "the deployed site's script could not be read for its fallback RPCs (none assumed)" && echo 1 || echo 0)" "the deployed build unknown (the site unreadable): no fallback assumed, high"
w R6 rf 2026-10-14T07:00:00Z "$FB2"
ok "$(grep -q 'web RPC block [0-9]*, fallbacks rpc.ankr.com/monad_testnet (ok), 10143.rpc.thirdweb.com (ok)' "$SC/out-R6.log" && echo 1 || echo 0)" "the run's summary line lists the deployed build's fallbacks and how each answered"
# --snooze-web: WEB RPC DOWN held (an outage nobody can fix, or one only this VPS sees); the other checks run
ok "$([ "$(snz rz 2026-10-14T05:55:00Z 73 --snooze-web)" = 2 ] && [ ! -e "$SC/st-rz/snooze-web-until" ] && echo 1 || echo 0)" "--snooze-web 73: refused (exit 2), nothing written"
RCS=$(snz rz 2026-10-14T05:55:00Z 2 --snooze-web)
sed -E 's/^\[[^]]+\] //; s/^/    | /' "$SC/out-snz.log"
for tm in 06:00 06:10 06:20; do w "RZ-$tm" rz "2026-10-14T$tm:00Z" "$DOWN; b.treasury = 19" >/dev/null; done
ok "$([ "$RCS" = 0 ] && [ "$(cat "$SC/st-rz/snooze-web-until")" = "$(( $(ep 2026-10-14T05:55:00Z) + 7200 ))" ] && [ "$(npg RZ- 'WEB RPC DOWN')" = 0 ] && [ "$(np RZ-06:00 'TREASURY LOW')" = 1 ] && grep -q 'snoozed until 2026-10-14T07:55Z: WEB RPC DOWN is held' "$SC/out-RZ-06:20.log" && has RZ-06:00 'daily digest 2026-10-14' 'Snoozed: WEB RPC DOWN until 2026-10-14T07:55Z' && echo 1 || echo 0)" "--snooze-web 2 at 05:55Z: 3 failed runs, no WEB RPC DOWN; TREASURY LOW still pushed; the digest shows the snooze"
RCS=$(snz rz 2026-10-14T06:25:00Z 0 --snooze-web)
w RZ1 rz 2026-10-14T06:30:00Z "$DOWN"
ok "$([ "$RCS" = 0 ] && [ ! -e "$SC/st-rz/snooze-web-until" ] && [ "$(np RZ1 'WEB RPC DOWN')" = 1 ] && has RZ1 'WEB RPC DOWN' '4 run(s) in a row since 2026-10-14T06:00Z' && echo 1 || echo 0)" "--snooze-web 0 ends it: the next failed run pushes at once (it kept counting: 4 runs since 06:00Z)"

echo; echo "## F. SETTLEMENT OVERDUE (RCSS 2026-10-14: day end 16:00Z, due by 21:00Z)"
ZERO='"(0, 0, 0, 0, 0x0000000000000000000000000000000000000000000000000000000000000000)"'
UNSET="t.settlements = t.settlements.filter((x) => x.date !== 20261014); r[\"RCSS-20261014\"] = $ZERO"
w F1 f 2026-10-14T20:50:00Z "$UNSET"
ok "$([ "$(np F1 'SETTLEMENT OVERDUE RCSS 2026-10-14')" = 0 ] && ! grep -q 'result-RCSS-20261014' "$SC/out-F1.log" && echo 1 || echo 0)" "20:50Z (4 h 50): no push, and no chain read yet"
w F2 f 2026-10-14T21:00:00Z "$UNSET"
ok "$([ "$(np F2 'SETTLEMENT OVERDUE RCSS 2026-10-14')" = 1 ] && [ "$(prio F2 'SETTLEMENT OVERDUE RCSS 2026-10-14')" = high ] && grep -q 'fixture reads: .*result-RCSS-20261014.txt' "$SC/out-F2.log" && has F2 'SETTLEMENT OVERDUE RCSS 2026-10-14' 'isotherm-vps.sh status' && echo 1 || echo 0)" "21:00Z: not in /api/settlements, Resolver.resultOf status 0 -> SETTLEMENT OVERDUE (high), what to check"
echo "    body: $(body F2 'SETTLEMENT OVERDUE RCSS 2026-10-14')"
w F3 f 2026-10-14T21:10:00Z "$UNSET"
ok "$(t [ "$(np F3 'SETTLEMENT OVERDUE RCSS 2026-10-14')" = 0 ])" "21:10Z: not repeated (3 h window)"
w F4 f 2026-10-14T22:00:00Z 't.settlements = t.settlements.filter((x) => x.date !== 20261014); r["RCSS-20261014"] = "(1, 30, 1792004700 [1.792e9], 1792005600 [1.792e9], 0x00)"'
ok "$(t [ "$(np F4 'CLEARED SETTLEMENT OVERDUE RCSS 2026-10-14')" = 1 ])" "the chain has the result (the API list lags): CLEARED at once (a result is final)"
w F5 f 2026-10-14T22:10:00Z 't.settlements = t.settlements.filter((x) => x.date !== 20261014)'
ok "$([ "$(nall F5)" = 0 ] && ! grep -q 'result-RCSS-20261014' "$SC/out-F5.log" && echo 1 || echo 0)" "afterwards: remembered as resolved, no more chain reads"
w F6 f6 2026-10-14T21:00:00Z
ok "$([ "$(np F6 'SETTLEMENT OVERDUE RCSS 2026-10-14')" = 0 ] && ! grep -q 'result-RCSS' "$SC/out-F6.log" && echo 1 || echo 0)" "settled and listed in /api/settlements: no push, no chain read"
w F7a f7 2026-10-14T15:00:00Z
w F7b f7 2026-10-14T21:00:00Z "$UNSET"'; s.ladders = s.ladders.filter((x) => x.date !== 20261014)'
ok "$(t [ "$(np F7b 'SETTLEMENT OVERDUE RCSS 2026-10-14')" = 1 ])" "a ladder no longer in the snapshot but remembered from an earlier run: still checked"
w F8 f8 2026-10-14T21:00:00Z 't.settlements = t.settlements.filter((x) => x.date !== 20261014)'
ok "$([ "$(np F8 'SETTLEMENT OVERDUE RCSS 2026-10-14')" = 1 ] && has F8 'SETTLEMENT OVERDUE RCSS 2026-10-14' 'chain read failed; per /api/settlements' && echo 1 || echo 0)" "the chain read fails, /api/settlements fresh (1 min) without it: pushed, labelled"
w F9 f9 2026-10-14T21:00:00Z 't.settlements = t.settlements.filter((x) => x.date !== 20261014); t.updatedAt = iso(now - 7200)'
ok "$(t [ "$(np F9 'SETTLEMENT OVERDUE RCSS 2026-10-14')" = 0 ])" "the chain read fails and /api/settlements is 2 h old: unknown, no push"
# the review's probe: 10-15 left "planned" (no seriesId, no market: never on chain), its Resolver result all zeros
NOCHAIN15="UNROLL(20261015, \"planned\"); t.settlements = t.settlements.filter((x) => x.date !== 20261015); r[\"RCSS-20261015\"] = $ZERO"
w F10 f10 2026-10-15T21:00:00Z "$NOCHAIN15"
ok "$([ "$(np F10 'SETTLEMENT OVERDUE RCSS 2026-10-15')" = 0 ] && ! grep -q 'result-RCSS-20261015' "$SC/out-F10.log" && echo 1 || echo 0)" "10-15 still \"planned\" at 21:00Z (never reached the chain): no SETTLEMENT OVERDUE, no chain read (before: high every 3 h for 4 days)"
w F11 f11 2026-10-15T21:00:00Z "${NOCHAIN15/planned/rolling}"
ok "$(t [ "$(np F11 'SETTLEMENT OVERDUE RCSS 2026-10-15')" = 1 ])" "stuck \"rolling\" with its series created (on chain): checked, SETTLEMENT OVERDUE"

echo; echo "## N. the watchdog cannot reach the API"
w N0 n 2026-10-14T06:00:00Z
w N1 n 2026-10-14T06:10:00Z 'del.push("health")'
w N2 n 2026-10-14T06:20:00Z 'del.push("snapshot")'
ok "$([ "$(nall N1)" = 0 ] && [ "$(nall N2)" = 0 ] && grep -q 'API unreadable, 2/3 runs in a row' "$SC/out-N2.log" && echo 1 || echo 0)" "1st and 2nd failed run: no push"
w N3 n 2026-10-14T06:30:00Z 'del.push("health"); code.health = 503'
ok "$([ "$(np N3 'WATCH CANNOT REACH THE API')" = 1 ] && [ "$(prio N3 'WATCH CANNOT REACH THE API')" = high ] && has N3 'WATCH CANNOT REACH THE API' '/api/health: HTTP 503' && [ "$(nall N3)" = 1 ] && echo 1 || echo 0)" "3rd in a row: WATCH CANNOT REACH THE API (high, the HTTP status); nothing else (blind checks stay quiet)"
w N4 n 2026-10-14T06:40:00Z 'del.push("health")'
ok "$(t [ "$(np N4 'WATCH CANNOT REACH THE API')" = 0 ])" "4th: not repeated (3 h window)"
w N5 n 2026-10-14T06:50:00Z
w N5b n 2026-10-14T07:20:00Z
ok "$([ "$(nall N5)" = 0 ] && [ "$(np N5b 'CLEARED WATCH CANNOT REACH THE API')" = 1 ] && echo 1 || echo 0)" "reachable again from 06:50Z: CLEARED at 07:20Z"
w N6a n6 2026-10-14T06:00:00Z 'del.push("health")'; w N6b n6 2026-10-14T06:10:00Z 'del.push("health")'
w N6c n6 2026-10-14T06:20:00Z; w N6d n6 2026-10-14T06:30:00Z 'del.push("health")'; w N6e n6 2026-10-14T06:40:00Z 'del.push("health")'
ok "$(t [ "$(npg N6 'WATCH CANNOT REACH THE API')" = 0 ])" "fail, fail, success, fail, fail: no push (a success resets the count)"
# the review's probe: 3 failed runs, 1 good one, over and over (06:00-08:00Z)
i=0; for c in 06:00 06:10 06:20 06:30 06:40 06:50 07:00 07:10 07:20 07:30 07:40 07:50 08:00; do
  n=$(printf 'NF%02d' "$i")
  if [ $((i % 4)) = 3 ]; then w "$n" nf "2026-10-14T$c:00Z" >/dev/null; else w "$n" nf "2026-10-14T$c:00Z" 'del.push("health")' >/dev/null; fi
  i=$((i + 1))
done
ok "$([ "$(npg NF 'WATCH CANNOT REACH THE API')" = 1 ] && [ "$(np NF02 'WATCH CANNOT REACH THE API')" = 1 ] && [ "$(npg NF 'CLEARED WATCH CANNOT REACH THE API')" = 0 ] && echo 1 || echo 0)" "3 failed runs, 1 good, repeated for 2 h: ONE high push (06:20Z), no CLEARED in between (before: one every 40 min)"

echo; echo "## P. --snooze HOURS (a deliberate pause of the maker: control.mjs pull / disarm)"
N0=$(wc -l <"$SD/pushes" | tr -d ' ')
ok "$([ "$(snz p 2026-10-14T05:05:00Z 73)" = 2 ] && [ "$(snz p 2026-10-14T05:05:00Z 2h)" = 2 ] && [ ! -e "$SC/st-p/snooze-until" ] && echo 1 || echo 0)" "--snooze 73 and --snooze 2h: refused (exit 2), nothing written"
RCS=$(snz p 2026-10-14T05:05:00Z 6)
sed -E 's/^\[[^]]+\] //; s/^/    | /' "$SC/out-snz.log"
ok "$([ "$RCS" = 0 ] && [ "$(cat "$SC/st-p/snooze-until")" = "$(( $(ep 2026-10-14T05:05:00Z) + 21600 ))" ] && grep -q 'snoozed until 2026-10-14T11:05Z (6 h)' "$SC/out-snz.log" && [ ! -e "$SC/st-p/state.json" ] && [ "$(wc -l <"$SD/pushes" | tr -d ' ')" = "$N0" ] && echo 1 || echo 0)" "--snooze 6 at 05:05Z (inside :03-:09: it runs no check): snooze-until written, no state, no push"
PAUSE='s.receivedAt = s.generatedAt = iso(now - 40 * 60); b.treasury = 19'
w P1 p 2026-10-14T06:00:00Z "$PAUSE"; w P2 p 2026-10-14T06:10:00Z "$PAUSE"
ok "$([ "$(npg P 'MAKER STALLED')" = 0 ] && [ "$(np P1 'TREASURY LOW')" = 1 ] && grep -q 'snoozed until 2026-10-14T11:05Z' "$SC/out-P1.log" && has P1 'daily digest 2026-10-14' 'Snoozed: the maker checks until 2026-10-14T11:05Z' && echo 1 || echo 0)" "snoozed, the snapshot 40 min old for 2 runs: no MAKER STALLED; TREASURY LOW still pushed; the digest shows the snooze"
RCS=$(snz p 2026-10-14T06:15:00Z 0)
w P3 p 2026-10-14T06:20:00Z "$PAUSE"
ok "$([ "$RCS" = 0 ] && [ ! -e "$SC/st-p/snooze-until" ] && [ "$(np P3 'MAKER STALLED')" = 1 ] && echo 1 || echo 0)" "--snooze 0 ends it: the next run pushes MAKER STALLED at once (40 min old)"
RCS=$(snz q 2026-10-14T06:00:00Z 1)
w Q1 q 2026-10-14T06:50:00Z "$PAUSE"; w Q2 q 2026-10-14T07:10:00Z "$PAUSE"
ok "$([ "$RCS" = 0 ] && [ "$(np Q1 'MAKER STALLED')" = 0 ] && [ "$(np Q2 'MAKER STALLED')" = 1 ] && echo 1 || echo 0)" "a 1 h snooze from 06:00Z: held at 06:50Z, over by itself at 07:10Z (MAKER STALLED)"

echo; echo "## G. the daily digest (01:00 UTC)"
w G1 g 2026-10-13T23:50:00Z 'h.limits.dripsToday = 3; h.limits.relaysToday = 5'
w G2 g 2026-10-14T00:00:00Z
w G3 g 2026-10-14T00:50:00Z 'h.limits.dripsToday = 1; h.dripsTotal = 10'
ok "$([ "$(np G1 'daily digest 2026-10-13')" = 1 ] && [ "$(nall G2)" = 0 ] && [ "$(nall G3)" = 0 ] && echo 1 || echo 0)" "first run 23:50Z: the first digest; 00:00 and 00:50Z: none"
w G4 g 2026-10-14T01:00:00Z 'h.limits.dripsToday = 2; h.limits.relaysToday = 0; h.dripsTotal = 12; h.relayedTotal = 13'
ok "$([ "$(np G4 'daily digest 2026-10-14')" = 1 ] && [ "$(prio G4 'daily digest 2026-10-14')" = default ] && has G4 'daily digest 2026-10-14' 'Yesterday (UTC 10-13): 3/17 drips, 5/28 relayed mints (last seen 23:50Z). Since the last digest: +3 drips, +5 mints.' && has G4 'daily digest 2026-10-14' 'Relayer 102.42 MON = 19.0 worst-case days' && has G4 'daily digest 2026-10-14' 'Ladders: 1 active (RCSS 2026-10-14 to 09:30Z); next RCSS 2026-10-15 opens 2026-10-14T04:00Z (not planned yet).' && has G4 'daily digest 2026-10-14' 'Open alerts: none.' && has G4 'daily digest 2026-10-14' 'Watch: 3 run(s) since the last digest, 0 could not read the API.' && echo 1 || echo 0)" "01:00Z: the digest: yesterday's counters (peak), deltas, relayer runway, ladders (active, next), open alerts, run count"
body G4 'daily digest 2026-10-14' | sed 's/^/    | /'
ok "$(has G4 'daily digest 2026-10-14' 'Treasury 158.62, maker 4.99, operator 2.24, guardian 0.0500, attester 0.7776 MON.' && has G4 'daily digest 2026-10-14' 'Web RPC (testnet-rpc.monad.xyz): ok, block ' && echo 1 || echo 0)" "the digest also shows the guardian and the attester, and the web RPC's block"
w G5 g 2026-10-14T01:10:00Z
ok "$(t [ "$(nall G5)" = 0 ])" "01:10Z: no second digest"
w G6 g 2026-10-14T12:00:00Z 'b.treasury = 19'
w G7 g 2026-10-15T01:00:00Z 'b.treasury = 19; del.push("stats")'
ok "$([ "$(np G7 'daily digest 2026-10-15')" = 1 ] && has G7 'daily digest 2026-10-15' 'Open alerts: TREASURY LOW (since 2026-10-14T12:00Z).' && has G7 'daily digest 2026-10-15' 'Treasury 19.00' && ! has G7 'daily digest 2026-10-15' 'Trading:' && echo 1 || echo 0)" "the next day's digest lists the open alert; a missing /api/stats only drops its line"
ok "$(t [ "$(( $(npg G 'daily digest 2026-10-13') + $(npg G 'daily digest 2026-10-14') + $(npg G 'daily digest 2026-10-15') ))" = 3 ])" "one digest per UTC day: 3 digests over 10-13, 10-14, 10-15 in 7 runs"

echo; echo "## K. the digest's CRE line (from the settlement job's evidence records; read only, never ~/.cre)"
# node mkruns.mjs <file> <first run> <last run> [JavaScript mutation]: the settlement job's hourly :05 runs, shaped like
# the VPS's var/evidence/settle-runs.jsonl of 2026-10-14 (official, cre whoami ok, exit 0; the 18:05Z run reports the day)
cat >"$SC/mkruns.mjs" <<'EOF'
import fs from "node:fs";
const [file, from, to, mut = ""] = process.argv.slice(2);
const ep = (s) => Date.parse(s) / 1000, iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const R = [];
for (let t = ep(from); t <= ep(to); t += 3600) {
  const day = Number(iso(t).slice(0, 10).replace(/-/g, "")), report = iso(t).slice(11, 16) === "18:05";
  R.push({ job: "isotherm-settle.service", host: "vps", startedAt: iso(t), finishedAt: iso(t + 40), path: "official", pathLabel: "OFFICIAL: cre workflow simulate", pathReason: "cre whoami succeeded",
    stoodDownForDon: false, stoodDownForWriter: false, creLogin: true, network: "LIVE Monad testnet 10143", testDataRelabel: null, dryRun: false, exitCode: 0, exitMeaning: "ok / nothing to do / skipped",
    runner: [], workflow: null, reportsSent: report ? [{ station: "RCSS", date: day, action: "settled", tmaxC: 30, txHash: "0x" + "ab".repeat(32), confirmed: "resolved", sourcesHash: "0x" + "cd".repeat(32) }] : [],
    receiptChecks: [], log: "/home/isotherm/isotherm/packages/cre-workflow/var/logs/settle.log" });
}
const at = (s) => { const r = R.find((x) => x.startedAt === s); if (!r) throw new Error(`no run at ${s}`); return r; };
// MISS: cre whoami failed, the harness ran; EXIT3: whoami ok, run-official.sh found no login (both a miss in lib.sh);
// FAILOFF: the official run failed with rc; AFTERFAIL: the harness run after a failed official run (the login was there)
const MISS = (s) => Object.assign(at(s), { path: "harness-fallback", creLogin: false, pathReason: "cre whoami failed (not logged in to CRE)" });
const EXIT3 = (s) => Object.assign(at(s), { path: "harness-fallback", pathReason: "cre whoami succeeded; then run-official.sh reported no login (exit 3) before signing" });
const FAILOFF = (s, rc) => { const r = Object.assign(at(s), { exitCode: rc, exitMeaning: rc === 4 ? "a report was sent but NOT accepted on chain" : "run failed" }); for (const o of r.reportsSent) o.confirmed = "not-accepted"; };
const AFTERFAIL = (s) => Object.assign(at(s), { path: "harness-fallback", pathReason: `cre whoami succeeded, but the previous OFFICIAL run failed (rc=1 at ${s}); this run uses the harness, the next one retries OFFICIAL` });
new Function("R", "MISS", "EXIT3", "FAILOFF", "AFTERFAIL", mut)(R, MISS, EXIT3, FAILOFF, AFTERFAIL);
fs.writeFileSync(file, R.map((r) => JSON.stringify(r)).join("\n") + "\n");
EOF
kr() { # kr <case> <first run> <last run> [mutation]: a settlement var/ with those records, then the 10-14 digest (01:00Z)
  mkdir -p "$SC/settle-$1/evidence"
  "$NODE" "$SC/mkruns.mjs" "$SC/settle-$1/evidence/settle-runs.jsonl" "$2" "$3" "${4:-}" || echo "    runs fixture error"
  cksum <"$SC/settle-$1/evidence/settle-runs.jsonl" >"$SC/settle-$1.sum"
  SVAR="$SC/settle-$1" w "$1" "$1" 2026-10-14T01:00:00Z >/dev/null
  body "$1" 'daily digest 2026-10-14' | grep '^CRE: ' | sed 's/^/    | /'
}
cre() { body "$1" 'daily digest 2026-10-14' | grep '^CRE: ' | grep -qF -- "$2"; }   # cre <case> <text in the CRE line>
kr K1 2026-10-10T09:05:00Z 2026-10-14T00:05:00Z 'FAILOFF("2026-10-10T09:05:00Z", 1); AFTERFAIL("2026-10-10T10:05:00Z"); EXIT3("2026-10-11T01:05:00Z"); MISS("2026-10-13T05:05:00Z"); MISS("2026-10-13T23:05:00Z"); R.push({ ...R[R.length - 1], startedAt: "2026-10-14T00:30:00Z", dryRun: true, path: "harness-fallback", creLogin: false })'
ok "$(cre K1 'CRE: last official run 2026-10-14T00:05Z ok; last report RCSS 2026-10-13 settled 30C (resolved) at 2026-10-13T18:05Z on the official path. Login shown from 2026-10-10T09:05Z to 2026-10-14T00:05Z on every recorded run but 3 single miss(es) (the last at 2026-10-13T23:05Z; each followed by a run with it: CRE API errors, no action); a span of 3 d 15 h, not the session'"'"'s age (a relogin with no miss before it leaves no record).' && echo 1 || echo 0)" "the VPS's own pattern (a failed first official run, 3 single misses, a dry run): last official run ok, last report, the login shown from 10-10 09:05Z to the last run (a span, not an age: a relogin leaves no record); single misses are not a new session"
ok "$(cksum <"$SC/settle-K1/evidence/settle-runs.jsonl" | cmp -s - "$SC/settle-K1.sum" && [ "$(find "$SC/settle-K1" -mindepth 1 | sed "s#$SC/settle-K1/##" | sort | tr '\n' ' ')" = "evidence evidence/settle-runs.jsonl " ] && echo 1 || echo 0)" "the settlement records are only read: byte-identical, nothing added to that var/"
kr K2 2026-10-10T09:05:00Z 2026-10-14T00:05:00Z 'MISS("2026-10-13T23:05:00Z"); MISS("2026-10-14T00:05:00Z")'
ok "$(cre K2 'LOGIN LAPSED: 2 runs in a row without it since 2026-10-13T23:05Z (last shown 2026-10-13T22:05Z); CRE LOGIN NEEDED has the fix' && cre K2 'last official run 2026-10-13T22:05Z ok' && echo 1 || echo 0)" "2 misses in a row (23:05, 00:05Z): LOGIN LAPSED, since when, the last run that had it"
kr K3 2026-10-10T09:05:00Z 2026-10-14T00:05:00Z 'MISS("2026-10-14T00:05:00Z")'
ok "$(cre K3 'the LAST run (2026-10-14T00:05Z) missed it: CRE LOGIN NEEDED follows if the next one does too' && ! cre K3 'LAPSED' && echo 1 || echo 0)" "the last run alone missed it: said so, not LAPSED"
kr K4 2026-10-10T09:05:00Z 2026-10-13T19:05:00Z 'FAILOFF("2026-10-13T18:05:00Z", 4); AFTERFAIL("2026-10-13T19:05:00Z")'
ok "$(cre K4 'last official run 2026-10-13T18:05Z FAILED (exit 4: a report was sent but NOT accepted on chain); the last run (2026-10-13T19:05Z) took the HARNESS fallback (cre whoami succeeded, but the previous OFFICIAL run failed' && cre K4 'last report RCSS 2026-10-13 settled 30C (not-accepted)' && echo 1 || echo 0)" "the official run failed (exit 4), the harness ran after it: both said"
kr K5 2026-10-10T09:05:00Z 2026-10-14T00:05:00Z 'for (let h = 10; h <= 14; h++) MISS(`2026-10-12T${h}:05:00Z`)'
ok "$(cre K5 'Login shown from 2026-10-12T15:05Z to 2026-10-14T00:05Z on every recorded run; a span of 1 d 9 h, not the session' && echo 1 || echo 0)" "a real lapse (5 misses, 10-12 10:05-14:05Z) and a new login: the span starts at the first run after it"
mkdir -p "$SC/settle-K6/evidence"; printf 'not json\n{"oops"\n' >"$SC/settle-K6/evidence/settle-runs.jsonl"
SVAR="$SC/settle-K6" w K6 K6 2026-10-14T01:00:00Z >/dev/null
ok "$(cre K6 'CRE: no settlement run recorded yet.' && echo 1 || echo 0)" "records that do not parse: \"no settlement run recorded yet\", no crash"
ok "$(! has G4 'daily digest 2026-10-14' 'CRE:' && echo 1 || echo 0)" "no records at all (no settlement job on the host, as in the other groups): no CRE line"
# the review's probe: the records stop 10-12 05:05Z (the settlement job stopped writing), the digest on 10-14 01:00Z
kr K7 2026-10-10T09:05:00Z 2026-10-12T05:05:00Z
ok "$(cre K7 'CRE: NO SETTLEMENT RUN RECORDED SINCE 2026-10-12T05:05Z (1 d 19 h ago; it runs hourly at :05): is isotherm-settle.timer running?' && cre K7 'Login shown from 2026-10-10T09:05Z to 2026-10-12T05:05Z on every recorded run; a span of 1 d 20 h' && echo 1 || echo 0)" "records ending 44 h before the digest: NO SETTLEMENT RUN RECORDED SINCE, first; the login's span ends at the last record, not now"
kr K7b 2026-10-10T09:05:00Z 2026-10-13T23:05:00Z
ok "$(! cre K7b 'NO SETTLEMENT RUN' && echo 1 || echo 0)" "the last record 1 h 55 min old (one hourly run missing): no warning"
# the gap of the VPS's real records: none from 10-11 18:05Z to 10-12 14:05Z
kr K8 2026-10-10T09:05:00Z 2026-10-14T00:05:00Z 'R.splice(0, R.length, ...R.filter((r) => r.startedAt <= "2026-10-11T18:05:00Z" || r.startedAt >= "2026-10-12T14:05:00Z" && r.startedAt !== "2026-10-13T03:05:00Z" && r.startedAt !== "2026-10-13T04:05:00Z"))'
ok "$(cre K8 'Login shown from 2026-10-10T09:05Z to 2026-10-14T00:05Z on every recorded run; no run recorded 2026-10-11T18:05Z to 2026-10-12T14:05Z (and 1 shorter gap(s)); a span of 3 d 15 h' && echo 1 || echo 0)" "a 20 h gap in the records (and a 3 h one): the largest named, the other counted, inside the span"
kr K9 2026-10-10T09:05:00Z 2026-10-14T00:05:00Z 'Object.assign(R[R.length - 1], { stoodDownForWriter: true, path: "harness-fallback", exitMeaning: "stood down: this host released the settlement writer role to another host; nothing signed or sent" })'
ok "$(cre K9 'the last run (2026-10-14T00:05Z) STOOD DOWN (this host released the settlement writer role to another host; nothing signed here)' && ! cre K9 'HARNESS fallback (' && echo 1 || echo 0)" "the last run stood down (writer role released): said so, not called a harness fallback run"
# the records are parsed only on a run that may send the digest: a node that counts its -e scripts (lib.sh iso_of
# is the only other one, used by --snooze only)
mkdir -p "$SC/settle-KG/evidence"; "$NODE" "$SC/mkruns.mjs" "$SC/settle-KG/evidence/settle-runs.jsonl" 2026-10-13T01:05:00Z 2026-10-14T00:05:00Z ''
mv "$BIN/node" "$BIN/node.real"; printf '#!/bin/bash
[ "$1" = -e ] && echo e >>"$SHIM_DIR/node-e"
exec "%s" "$@"
' "$NODE" >"$BIN/node"; chmod +x "$BIN/node"
: >"$SD/node-e"; SVAR="$SC/settle-KG" w KG0 kg 2026-10-14T00:50:00Z >/dev/null; KG0=$(wc -l <"$SD/node-e" | tr -d ' ')
: >"$SD/node-e"; SVAR="$SC/settle-KG" w KG1 kg 2026-10-14T01:00:00Z >/dev/null; KG1=$(wc -l <"$SD/node-e" | tr -d ' ')
: >"$SD/node-e"; SVAR="$SC/settle-KG" w KG2 kg 2026-10-14T01:10:00Z >/dev/null; KG2=$(wc -l <"$SD/node-e" | tr -d ' ')
: >"$SD/node-e"; SVAR="$SC/settle-KG" w KG3 kg 2026-10-15T01:00:00Z >/dev/null; KG3=$(wc -l <"$SD/node-e" | tr -d ' ')
rm -f "$BIN/node"; mv "$BIN/node.real" "$BIN/node"
ok "$([ "$KG0" = 0 ] && [ "$KG1" = 1 ] && [ "$KG2" = 0 ] && [ "$KG3" = 1 ] && [ "$(np KG1 'daily digest 2026-10-14')" = 1 ] && cre KG1 'CRE: last official run 2026-10-14T00:05Z ok' && [ "$(np KG3 'daily digest 2026-10-15')" = 1 ] && body KG3 'daily digest 2026-10-15' | grep -q '^CRE: NO SETTLEMENT RUN RECORDED SINCE 2026-10-14T00:05Z' && echo 1 || echo 0)" "the records parsed only for a digest: 00:50Z no ($KG0), 01:00Z yes ($KG1, with the CRE line), 01:10Z no ($KG2: today's sent), the next day's 01:00Z yes ($KG3)"

echo; echo "## X. past the end date (2026-10-31)"
w X0 x 2026-10-31T23:50:00Z
w X1 x 2026-11-01T02:00:00Z 'b.treasury = 1; h.limits.dripsToday = 17'
ok "$([ "$(nall X1)" = 1 ] && [ "$(np X1 'past its end date')" = 1 ] && [ "$(prio X1 'past its end date')" = low ] && has X1 'past its end date' 'install-watch.sh --uninstall' && echo 1 || echo 0)" "11-01: one low push asking to uninstall; no check runs (treasury 1 MON, cap full: silent)"
w X2 x 2026-11-01T02:10:00Z 'b.treasury = 1'
ok "$(t [ "$(nall X2)" = 0 ])" "the same day again: nothing"

echo; echo "## S. safety of the test itself and of the code"
ok "$([ -s "$SD/pushes" ] && [ "$(cut -f3 "$SD/pushes" | sort -u)" = ntfy.invalid ] && echo 1 || echo 0)" "all $(wc -l <"$SD/pushes" | tr -d ' ') pushes went to the test URL https://ntfy.invalid/... (read by push_alert from the file, curl -K)"
ok "$([ ! -e "$SD/gets" ] && [ ! -e "$SD/cast-calls" ] && echo 1 || echo 0)" "fixture mode: no curl call but the pushes, and no cast call"
N=$(grep -rlF "$TOPIC" "$SC"/out-*.log "$SC"/st-* "$P/var" 2>/dev/null | wc -l | tr -d ' ')
ok "$(t [ "$N" = 0 ])" "the alert URL's topic is in no output, state or ALERTS.log file"
ok "$(! grep -qE 'cast (send|publish|mktx|wallet)|"(send|publish|mktx)"|private-key|-X *POST|--request|fetch\(|https?\.request' "$REAL/vps/stack-watch.sh" "$REAL/vps/stack-watch.mjs" && [ "$(grep -c -- '--data' "$REAL/vps/stack-watch.sh")" = 1 ] && grep -- '--data' "$REAL/vps/stack-watch.sh" | grep -qF -- "--data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}'" && [ "$(grep -o 'execFileSync(' "$REAL/vps/stack-watch.mjs" | wc -l | tr -d ' ')" = 1 ] && grep -q 'execFileSync(CAST, ' "$REAL/vps/stack-watch.mjs" \
  && [ "$(grep -c -- ' -X ' "$REAL/vps/stack-watch.sh")" = 1 ] && grep -q -- ' -X OPTIONS -H "Origin: $SITE"' "$REAL/vps/stack-watch.sh" && echo 1 || echo 0)" "the watchdog's code has no tx-sending cast command, no key flag, no -X POST / --request, no fetch; its one --data is the eth_blockNumber read (lib.sh push_alert's is the ntfy push) and its one -X the OPTIONS preflight; the evaluator runs nothing but cast (the curls in WEB RPC DOWN's body are for a person)"
ok "$(t [ "$(LC_ALL=C grep -c $'[^ -~\t]' "$REAL/vps/stack-watch.mjs")" = 0 ])" "ASCII only in stack-watch.mjs (push titles go out as HTTP headers)"

echo; echo "# $(date -u +%FT%TZ) done: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
}

main 2>&1 | tee "$SC/report.txt"; RC=${PIPESTATUS[0]}
# the report: always a kept scratch file; the tracked evidence only on request (ISOTHERM_WRITE_EVIDENCE=1) and only
# from a run where every check passed
REPORT=$(mktemp "${TMPBASE%/}/isotherm-stack-watch-unit-report.XXXXXX") || { echo "mktemp failed" >&2; exit 2; }
# $HOME only where a path starts, never right after <scratch> or <repo> (in a container HOME=/root, and the scratch
# package is <scratch>/root/packages/...)
sed -E -e "s#$SCP#<scratch>#g" -e "s#$SC#<scratch>#g" -e "s#$REPO#<repo>#g" -e "s#(^|[^>])$HOME#\\1~#g" "$SC/report.txt" >"$REPORT"
echo "-> report: $REPORT"
if [ "${ISOTHERM_WRITE_EVIDENCE:-0}" = 1 ]; then
  if [ "$RC" = 0 ]; then mkdir -p "$(dirname "$EVOUT")"; cp "$REPORT" "$EVOUT"; echo "-> evidence: ${EVOUT#"$REPO"/}"
  else echo "-> evidence NOT written (a check failed): ${EVOUT#"$REPO"/} unchanged"; fi
fi
exit "$RC"
