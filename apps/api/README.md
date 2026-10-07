# apps/api — Isotherm API (Cloudflare Worker)

Live: https://isotherm.pages.dev/api/* (Worker `isotherm-api`; Durable Object `RelayerDO` (SQLite-backed) + KV
`isotherm-api-ISO_KV`; cron every minute). Status and evidence: [`../RESULT.md`](../RESULT.md).

**How requests reach the Worker.** The Worker has no public hostname of its own (`workers_dev = false`,
`preview_urls = false` in `wrangler.toml`). `https://isotherm.pages.dev/api/*` runs the Pages Function
`../web/functions/api/[[path]].ts`, which hands the incoming Request, unchanged, to this Worker over the service
binding `API` (`../web/wrangler.toml`); the cron trigger needs no route either. Cloudflare's edge sets
`CF-Connecting-IP` on the Pages request and it passes through the binding untouched, so the per-network limits below
see the real client network. Checked live on 2026-10-07: a `wrangler tail` showed the client's own address in
`cf-connecting-ip` for a request made through Pages, and a burst of 31 bad-address drips through Pages got 400 × 30
then 429, although every request carried a different spoofed `X-Real-IP` / `X-Forwarded-For`.

| Route | What |
|---|---|
| `GET /api/health` | relayer address + balances, `dripReady` / `relayReady`, relay modes (from vault bytecode), `relayMinAusd`, `limits` (caps, reserve, `dripsToday`, `relaysToday`; memoised 5 s) and `version` (see below) |
| `POST /api/drip {address}` | 0.15 MON + 1,000 AUSD (float, faucet fallback). 1 per address / 24 h, `DRIP_PER_IP_PER_DAY` per network / UTC day, `DRIP_DAILY_CAP` per UTC day; never to contracts, 7702-delegated accounts or precompiles; never below the reserve |
| `POST /api/relay/mint` | gasless complete-set mint, **authorization mode only**: `{mode:"authorization", chainId, seriesId, amount, holder, validAfter, validBefore, salt, signature}` (EIP-3009 ReceiveWithAuthorization to the vault, nonce = `keccak256(abi.encode(seriesId, amount, salt))`). 1–500 AUSD; `RELAY_PER_ADDRESS_PER_DAY`, `RELAY_PER_IP_PER_DAY`, `RELAY_DAILY_CAP`. Permit mode is refused for the v1 vault (a permit can be front-run and redirected to another series) |
| `GET /api/snapshot` | latest maker snapshot, normalised (accepts `packages/maker` "isotherm.snapshot/v1"). Per strike: `fair`, `pmImplied`, `model` (guardrail), `bid`/`ask`, `bidSize`/`askSize` (as placed), `bidRemaining`/`askRemaining` (resting now), `mode`, `action` + `reason` (this tick's decision), `lastChangeReason` + `lastQuoteAt` (why/when the quote last changed), `fairSource` (`polymarket` / `certain` / `fallback-v0` / `fallback-intraday` / `none`) and `guardSource` (`v0` / `v0-truncated` / `intraday` / `certain`), null when not reported or not a short lowercase label |
| `POST /api/snapshot` | `Authorization: Bearer <SNAPSHOT_TOKEN>` |
| `GET /api/stats` | non-maker wallets, fills, volume, settled city-days, drips, relayed mints (own log scan; maker / team / external decided at publish time, see "Who counts as traction") + `maker` (maker-reported, separate) |
| `POST /api/stats` | `Bearer <SNAPSHOT_TOKEN>`: maker-reported stats |
| `GET /api/settlements` | resolved ladders with report tx hashes |
| `POST /api/admin/tick`, `/api/admin/rescan {fromBlock,toBlock,markets?}` | `Bearer <ADMIN_TOKEN>` |

`/api/health` and `/api` report which build is serving:

```json
"version": { "app": "1.0.0", "build": "a41d37d-dirty.84a823aac98e", "commit": "a41d37d", "dirty": true,
             "builtAt": "2026-10-07T08:02:11.033Z", "workerVersionId": "ea73ccfa-8f6d-41f7-b1fd-b52f015b050b",
             "deployedAt": "2026-10-07T08:02:18.233Z" }
```

`build` = git short commit (`-dirty` when `src/`, `wrangler.toml`, the package files, `deployments/` or
`packages/abi/` differ from it) + a SHA-256 of the bundle inputs, written to `src/generated/build.json` by
`scripts/build-info.mjs` during `npm run prepare-data` (so `npm run deploy` always refreshes it).
`workerVersionId` and `deployedAt` (the upload time of this Worker version) come from Cloudflare's
`[version_metadata]` binding; both are null under `wrangler dev` (no upload time there). Deploy with `npm run deploy`;
a bare `wrangler deploy` skips `prepare-data` and would report the last build id that was prepared.

```sh
npm install
npm test            # unit tests
npm run test:fork   # spawns anvil (:19200) + wrangler dev (:8782); ISO_ANVIL_PORT / ISO_API_PORT / ISO_INSPECTOR_PORT override; throwaway keys only
npm run dev         # wrangler dev :8781 (pass --var RPC_URL:… --var RELAYER_KEY:… for a fork)
npm run deploy                                              # prepare-data (deployments, ABIs, build id) + wrangler 3 deploy
npm run size-caps -- --days 7                               # read-only: size the MON budget vars (below)
tr -d '\n' < ~/.config/isotherm/relayer.key | npx wrangler@3 secret put RELAYER_KEY
```

Secrets: `RELAYER_KEY` (~/.config/isotherm/relayer.key), `SNAPSHOT_TOKEN` (~/.config/isotherm/api-snapshot.token),
`ADMIN_TOKEN` (~/.config/isotherm/api-admin.token). Budget knobs are plain vars in `wrangler.toml`.

## Who counts as traction (`/api/stats` classification)

The log scan stores **raw** data per `tx.origin` (fills and AUSD volume for every wallet that filled on an Isotherm
book, ours included) in the Durable Object. It does not decide who is who. Each time stats are published (every cron
tick), `publicStats` classifies every origin from the **current** lists: `MAKER_ADDRESSES` (+ deployment `maker`
roles) → maker, else `TEAM_ADDRESSES` (+ deployer / operator / taker / owner / guardian / attester / relayer roles) →
team, else external. Only external origins count toward `nonMakerWallets`, `nonMakerFills` and `nonMakerVolumeAusd`.
`fills` = `nonMakerFills` + `teamFills` + `makerTakerFills`; each wallet is in exactly one class. `recentTrades[].kind`
is recomputed the same way, and `classification` says when and from how many listed addresses.

So **adding a wallet to `TEAM_ADDRESSES` and redeploying reclassifies its past fills too.** You do not need a rescan.
Removing it makes them external again.

Current team wallets that are not deployment roles:
- `0xd42A…D79c`: the go-live smoke-test dev wallet (`docs/evidence/golive`).
- `0xF4a3377D1200584D8Ab7d7e64c6B17dc6c792427`: a team test **Dynamic embedded wallet**. It was created by email login on the live site
  (Dynamic Sandbox environment) on 2026-10-07. The deployer funded it with 0.25 MON and 10,000 faucet AUSD. Its
  gasless relayed mint (`0xca08d015…`) and its Zap "Buy YES" (`0x361668d8…`, RCSS 2026-10-08 ≥28) are our own
  testing, so they are team, not traction.
  Any further wallet a team member creates through Dynamic (or any other login) must be added here as well.

Upgrade from the v1 scanner (which classified at scan time): on first load, the v1 keys are migrated once into the
raw per-origin map and are then left as they were (`scan:counters`, `scan:wallets`, `scan:teamWallets`). The
migration is **exact** when v1's trade list still held every fill and the rebuilt per-origin fills and volume
reconcile with all of v1's counters and maps. That was the case live: 2 fills, `classification.v1Migration: "exact"`.
Otherwise it is **approximate**. Per-origin fills still come from v1's maps, so wallets and fills reclassify. v1 kept
volume and maker fills only per class, so those stay in their scan-time class. Totals are unchanged either way.

## MON budget (who can spend the relayer's test MON, and how much)

Every drip and relayed mint is paid by one relayer EOA, and testnet MON is scarce. The caps spread what the relayer
holds above a reserve over a **horizon of N UTC days** (`--days N`, default 7): one worst-case day may spend at most
1/N of it, so the relayer lasts at least N days of maximum use without a top-up, and one client network can use at
most half of a day. Without the horizon, a single day of maximum use could take the whole balance. When the balance
does run down, drips and relays stop at the reserve (`dripReady` / `relayReady` turn false); they never spend it.
`node scripts/size-caps.mjs [--days N]` reads the live balance and gas price (read-only) and prints the vars; re-run
it after funding the relayer (with `--days` set to the time until the next top-up), paste the output into
`wrangler.toml`, redeploy.

```
spendable           = balance − RELAYER_MIN_MON                     reserve: drips and relays never go below it
perDay              = spendable / N                                   N = --days (default 7; whole days, 1–365)
dripCost            = DRIP_MON + (21,000 + 78,752 gas) × gasPrice     MON leg + AUSD leg (Monad bills the gas LIMIT)
relayCost           = 335,000 gas × gasPrice                          fork-measured limit, first-time holder: 334,228
DRIP_DAILY_CAP      = floor(perDay × 0.65 / dripCost)
RELAY_DAILY_CAP     = floor((perDay − DRIP_DAILY_CAP × dripCost) / relayCost)
DRIP_PER_IP_PER_DAY = max(1, floor(DRIP_DAILY_CAP / 2))
RELAY_PER_IP_PER_DAY = RELAY_PER_ADDRESS_PER_DAY = max(1, floor(RELAY_DAILY_CAP / 2))
worst-case day      = DRIP_DAILY_CAP × dripCost + RELAY_DAILY_CAP × relayCost  ≤ perDay,  so N such days ≤ spendable
```

At 2026-10-07T07:59Z the relayer held 4.599 MON at 102 gwei: spendable 4.499, perDay (7 days) 0.643, dripCost
0.160, relayCost 0.034, so 2 drips + 9 relays per UTC day (worst case 0.628 MON/day, 4.395 MON over 7 days),
1 drip and 4 relays per network, 4 relays per address. That covers UTC days Oct 7–13 at maximum use; top up and
re-size before 2026-10-14. (Run 1, before the horizon, sized 0.599 MON as a single day: 2 drips + 5 relays.)

Other guards:
- "Network" = the client IP for IPv4, its /64 for IPv6 (one subscriber holds a whole /64); stored only as a salted hash.
- Drips and relays are counted when the tx is **broadcast**, not when it succeeds: Monad bills the gas limit even
  for a revert, and a receipt wait can time out, so a self-reverted or unconfirmed request still uses up quota.
- The relay caps are checked before any RPC read and again inside the single-sender queue (exact under concurrency).
- `POST_LIMIT_PER_MIN` (30): drip + relay POSTs per network per minute, counted in the Durable Object's memory (one
  instance, so exact) before any storage or RPC work; a flood gets 429 instead of turning into public-RPC reads.
  (A Workers Rate Limiting binding was tried first: deployed with wrangler 3 on the Worker's default Cloudflare
  subdomain it never limited, even at 150 requests in a few seconds, so it was removed. There is no zone of ours in
  front of the API, so there is no dashboard WAF rule.)
- `RELAY_MIN_AUSD` (1 AUSD) stops dust mints; `RELAY_ALLOW_PERMIT=0` keeps permit relays off (they only ever apply to
  a vault without the EIP-3009 path).
