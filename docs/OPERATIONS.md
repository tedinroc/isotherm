# Isotherm — live operations (Monad testnet 10143)

Written 2026-10-07 14:15 Taipei (06:15 UTC), at go-live; balances and versions below are from then. Revised the same day after the v1 security review (attester gas, guardian runbook, owner key, API caps, settlement status). Balances and caps re-read at 2026-10-07 07:55 UTC (15:55 Taipei) are marked with that time. Revised again at 08:40 UTC (16:40 Taipei) for the CRE login, the re-sized API caps and the Dynamic build, and at 13:30 UTC (21:30 Taipei) for the Dynamic go-live (web app row and section 5), and at 16:30 UTC (00:30 Taipei, Oct 8) for the same-origin API at `https://isotherm.pages.dev/api/*` (sections 1, 2 and 5). Section 8 (the Cloudflare maker and its cutover runbook) was added on 2026-10-08 at 16:30 UTC and revised the same night after a tick-by-tick comparison of the shadow with the Mac maker (8.6), with a precise cutover runbook (8.3). Everything here is **testnet only**. AUSD is free
faucet test money. Nothing here touches Monad mainnet.

## 1. What is live

| Thing | Where |
|---|---|
| Phone web app (PWA) | https://isotherm.pages.dev (Cloudflare Pages project `isotherm`). Dynamic is enabled since Pages deployment `<retired-deployment>` (2026-10-07 13:21 UTC). The deployed build (Pages deployment `6b18d972`, about 16:24 UTC, main chunk `assets/index-Cd8KBz0E.js`, same app plus the same-origin API) makes "Sign in with email" through Dynamic the default, keeps the labelled dev (burner) wallet as fallback, and shows the Open-Meteo CC BY credit. The first embedded-wallet login, relayed mint and Buy Yes (a team test wallet) are in section 5. |
| API: drip, gasless-mint relayer, stats, snapshot | https://isotherm.pages.dev/api/* (Pages Function `apps/web/functions/api/[[path]].ts` → service binding `API` → Worker `isotherm-api`; the Worker has no public hostname of its own since 2026-10-07 16:05 UTC). Worker version `60f3a919` deployed 16:24 UTC; its source equals `0c112836` (13:27 UTC, stats classification), and the re-sized caps are live since `ea73ccfa` (08:02 UTC); the go-live version was `ed0ab137` |
| Contracts (v1, Sourcify exact_match) | Resolver `0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B`, Vault/factory `0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39`, Zap `0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0`. Source of truth: `deployments/testnet.json` |
| Market maker | **Live: the Cloudflare Worker `isotherm-maker`** (`apps/maker-worker`), cron every minute plus a Durable Object, since the cutover at 2026-10-08 23:00 UTC (07:00 Taipei, Oct 9); first live tx 23:06 UTC. Before that it ran 6.5 h in SHADOW mode and matched the Mac's decisions tick by tick (section 8.6). The Mac launchd jobs `xyz.isotherm.maker/roll/watchdog/challenge-watch` are booted out and disabled; rollback is section 8.4. Settlement (`xyz.isotherm.cre-settle`) still runs on the Mac. |

### The first live ladder: Taipei (RCSS), Thursday 2026-10-08

- **Close.** Trading closes at **17:30 Taipei on Oct 8** (`closeTime` 1791451800). The maker stops quoting at **17:20**; its kill switch then cancels every order and withdraws the YES margin.
- **Settlement.** The day ends at 00:00 Taipei on Oct 9. Settlement comes from the CRE workflow (section 6).
- **Strikes.** They were chosen from the Polymarket median of 29 for `highest-temperature-in-taipei-on-october-8-2026`. At roll time Polymarket gave P(≥k) = 0.950 / 0.840 / 0.461 / 0.092.

| Strike | seriesId | YES token | NO token | Kuru market (canonical in the Zap) |
|---|---|---|---|---|
| ≥28 °C | `0xff739cf1…121064` | `0x67A91138014c30bF5F28A900326971bD08Cd1bc4` | `0x49B7900D282E3f5262Dd712d2e66ff0166d7516D` | `0x171b4cdE3724f2F17576439e6de8c36142A7DBd7` |
| ≥29 °C | `0xa69ae9d5…2cd3` | `0x9D4c41dcEE377A9C4bd1A8BE20A30f7598f595E8` | `0xc6D967B0e1434f8e81AFC63B9A7Ca719f80CD6f5` | `0x855eF3549eA5ACA5602EAefDD988950f16FCc6c2` |
| ≥30 °C | `0xb020bdde…0064` | `0xe1f9a759a24e41Bd8A1c7755B8b054f1E7E6D284` | `0xD2b847F236F09f7376A28c617A80e4cFBfEB8687` | `0x702A7a87EDb18D733c624bF766020F3b66eb36DC` |
| ≥31 °C | `0x28b6d44a…e658` | `0xCC10a4D4f9ec075Fa4299941a9c3F7A720E973F4` | `0x119CC5aC32500789e004B7A98919acA309C85532` | `0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813` |

Full seriesIds, every tx hash and the on-chain checks are in `docs/evidence/golive/` (`live-txs.tsv`, `books-verify-*.txt`).

## 2. Keys and wallets (all in `~/.config/isotherm/`, chmod 600, never print them)

| Role | Address | Pays for | MON after go-live | MON at 2026-10-07 07:55 UTC |
|---|---|---|---|---|
| deployer = contract owner | `0xb855f2bCA7C12Db2aA9D70740c6cF40808325c11` | owner calls; **funds the others**. Hot key: with it alone an attacker could replace the guardian and attester, so move ownership of the Resolver and Vault to a cold key (v1 review N3) | 0.85 | 23.84 |
| operator (also creates Kuru markets) | `0x602dbf3937558B1d18d76315635fD5410089bd51` | daily `createLadder` + 4 × `deployProxy` + 4 × `setCanonicalMarket` (≈0.78 MON) | 0.12 | 1.82 |
| maker | `0xd572638F07829D1c3636400FB73CF34Ca6c7448a` | mint, margin, quotes, re-quotes, kill switch | 1.73 | 2.62 |
| relayer (API Worker secret `RELAYER_KEY`) | `0xb0b9F5E93C4D4Bb448eC96191393bf35C9E8429f` | drips (0.15 MON + 1,000 AUSD each), relayed gasless mints, AUSD float refills | 0.75 | 4.60 |
| guardian | `0x30C8E371719Ff00577284dd9c10587Fa89357d50` | emergency `pause()` / `challenge()` | 0.05 | 0.05 |
| attester (CRE secret) | `0x63D2523dDC4BB055A19682Bf2d61fe94959D0Bb9` | signs settlement reports, and as the CRE workflow's default transaction sender **pays about 0.0204 MON per report tx** (200,000 gas limit at 102 gwei; `packages/cre-workflow/RESULT.md` §2), so 0.40 MON covers about 19 reports | 0.10 | 0.40 |
| treasury (maker Worker secret `TREASURY_KEY`, optional; added 2026-10-09) | `0x655dE7F5E6EdB42f26C422ED056F94BA9964BEed` | only plain MON transfers to the five role addresses above (section 4); no contract role; never the deployer key | – | – |

`~/.config/isotherm/maker.env` (chmod 600) holds `ISOTHERM_ALLOW_LIVE=1`, `ISOTHERM_API_URL` (`https://isotherm.pages.dev`; it overrides `api.url` in `config/local.json`) and `ISOTHERM_SNAPSHOT_TOKEN`.
The launchd jobs load it through `scripts/run.sh`.

## 3. The maker processes (launchd)

**Why a runtime copy?** launchd-started `bash`/`node` cannot read anything under `~/Documents`. This is macOS
privacy protection (TCC). The first attempt failed with exit 126, "Operation not permitted". So the maker runs from
`~/isotherm-live`, a copy of:
- `packages/maker` and `packages/forecast`;
- `packages/abi` and `deployments/testnet.json`.

`packages/maker/scripts/deploy-runtime.sh` makes that copy. `packages/maker/config/local.json` points **both** the
repo copy and the runtime copy at the same state, lock and heartbeat files in `~/isotherm-live/packages/maker/var/`.
That way the single-writer lock also stops a second writer started from the repo.

| launchd label | What it does | Schedule |
|---|---|---|
| `xyz.isotherm.maker` | `loop`: every 60 s it quotes all active ladders around the Polymarket-implied fair, re-quotes when needed, posts the snapshot to the API, and runs queued roll requests. The kill-switch timer runs every 15 s. | KeepAlive (restarted if it dies; throttled to once per 60 s) |
| `xyz.isotherm.roll` | `roll --station RCSS --date tomorrow --not-before 12:00`. While the loop runs, it queues the request for the loop. It is idempotent: an existing ladder costs 0 txs (verified at 06:14 UTC). | Every hour; acts from 12:00 Taipei |
| `xyz.isotherm.watchdog` | `watchdog --verify`: an independent kill switch. It acts only if the loop's heartbeat is more than 3 min old. | Every 5 min |
| `xyz.isotherm.cre-settle` (CRE workstream) | `scripts/settle-job.sh` from `~/isotherm-live/packages/cre-workflow`: settles due ladders. Official CRE path if `cre whoami` succeeds (the case since the CRE login on 2026-10-07), otherwise the labelled SDK-harness fallback; writes an evidence record per run naming the path. See section 6. | Hourly at :05 |
| `xyz.isotherm.challenge-watch` (CRE workstream) | `scripts/challenge-watch.sh`: recomputes every `LadderResolved` with the settlement rule and, on a reproduced mismatch, challenges from the guardian key (or prints the exact command) | Every 120 s |

Plist files are in `~/Library/LaunchAgents/xyz.isotherm.{maker,roll,watchdog,cre-settle,challenge-watch}.plist`. They load at user login, so
**the Mac must stay awake and logged in**. `pmset` currently shows `sleep 0`.

### Daily MON caps (config/local.json, metered per Taipei day)

| Role | Cap (MON/day) | Reserve | Notes |
|---|---|---|---|
| maker | 1.2 (raised from 0.8 on 2026-10-07) | 0.2 (pulls only) | Includes the next day's roll (≈0.48). A re-quote costs 0.055–0.058 MON. Above the cap, non-urgent re-quotes are refused. An urgent one (fair crosses a resting quote) becomes a pull paid from the reserve. The kill switch is never refused. |
| operator | 0.5 | 0.05 | `createLadder` 0.1225 + 4 × `setCanonicalMarket` 0.0138 |
| marketCreator (operator key) | 0.8 | 0.05 | 4 × `deployProxy` 0.1496 |

Every tx also needs balance ≥ gas limit × price + 0.03 MON, or it is refused **before** it is broadcast. An
underfunded operator therefore makes the roll fail cleanly; it never half-builds a ladder.

### Everyday commands (run from anywhere)

```bash
M=~/isotherm-live/packages/maker
launchctl list | grep xyz.isotherm                    # PIDs + last exit codes
bash $M/scripts/run.sh status                         # ladders, quotes, MON spent today (read-only)
tail -f $M/var/log/maker.err.log                      # loop log (human readable); JSON lines in $M/var/maker.log
cat $M/var/snapshot.json | head -50                   # what the API/web sees
curl -s https://isotherm.pages.dev/api/health   # snapshotReceivedAt, relayer MON, AUSD float
```

### Stop / restart

| Goal | Command |
|---|---|
| Restart the loop (e.g. after a config change) | `launchctl kickstart -k gui/$(id -u)/xyz.isotherm.maker` |
| Ship maker/forecast code or `deployments/testnet.json` changes to the runtime and restart | `packages/maker/scripts/deploy-runtime.sh --restart` (run from the repo) |
| **Pull all quotes now** (cancel every maker order, pause re-quoting) | `launchctl bootout gui/$(id -u)/xyz.isotherm.maker` (stopping the loop leaves resting quotes up), then `bash $M/scripts/run.sh pull --all`. Restart with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/xyz.isotherm.maker.plist`. Undo a pull with `run.sh resume --station RCSS --date 2026-10-08` while the loop is stopped. |
| Stop everything (all 3 jobs) | `bash $M/launchd/install.sh --unload`. **Pull quotes first**, otherwise orders stay on the Kuru books. |
| Start everything again | `packages/maker/scripts/deploy-runtime.sh --load` (needs `~/.config/isotherm/maker.env`) |
| Roll a date by hand | `bash $M/scripts/run.sh roll --station RCSS --date 2026-10-09` (it queues to the loop if the loop runs) |

### Emergency (contracts)

**Wrong result: challenge first, then pause.** `pause()` neither stops nor extends the 900 s challenge clock, and the vault does not follow the Resolver's pause, so a guardian who pauses instead of challenging lets a false *Settled* result pay out in full (`test/security/v1/RESULT.md`, N6). A reported *Void* is final at once and cannot be challenged (N2). `xyz.isotherm.challenge-watch` now watches the window every 120 s, but it runs on this Mac next to the attester key, so it catches a wrong report, not a compromise of this Mac. The Cloudflare maker (section 8) runs the same watcher away from the attester key, holding only the guardian key; it challenges only once it is live.

- **Key handling for these commands.** Do not pass a key as `--private-key "$(cat …)"`: the raw key then shows up in the process list (`ps`) while cast runs. Import the guardian key once into an encrypted Foundry keystore, `cast wallet import isotherm-guardian --interactive` (paste the key at the prompt and set a password), then use `--account isotherm-guardian`, which asks for that password. Without a keystore, `--interactive` prompts for the raw key instead.
- **Guardian pause** (it held 0.05 MON at 2026-10-07 07:55 UTC; pause costs ≈30k gas). Pausing the Resolver blocks reports; pausing the vault blocks mints:
  `cast send 0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B "pause()" --account isotherm-guardian --rpc-url https://testnet-rpc.monad.xyz`
  Use the same call with the vault address `0xae36…7B39`. Only the owner (deployer) can `unpause()`.
- **Guardian challenge** of a wrong settlement, within 900 s of `resolvedAt`, turns the result to Void (0.5/0.5); about 44k gas:
  `cast send 0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B "challenge(bytes4,uint32,bytes32)" 0x52435353 20261008 <reasonHash> --account isotherm-guardian --rpc-url https://testnet-rpc.monad.xyz`
- Anyone can call `voidIfStale(0x52435353, 20261008)` after `staleAt` (dayEnd + 48 h = 2026-10-11 00:00 Taipei) if nothing settled it.

## 4. Funding routine (testnet MON is the bottleneck)

**Since 2026-10-09 the money flows deployer → treasury → roles.** A person claims faucet MON to the deployer and
sends it to the treasury in one transfer; the Cloudflare maker tops up the role keys from the treasury every 10
minutes (live mode, `TREASURY_KEY` set; section 8.9). The manual per-role routine below stays the fallback, and is
the only path while `TREASURY_KEY` is not set.

| Role (address in `apps/maker-worker/config/worker.json` `treasury.roles`) | Topped up below | to | at most per Taipei day |
|---|---|---|---|
| maker | 1.5 | 4 | 4 |
| operator (also market creator) | 1.2 | 2.5 | 1.5 |
| relayer | 3 | 8 | 3 |
| attester | 0.3 | 0.8 | 0.5 |
| guardian | 0.05 | 0.15 | 0.2 |

All roles together at most 6 MON a day; the treasury keeps a floor of 2 MON. Alerts: every top-up (`TOPUP <ROLE>`),
`TREASURY LOW` below 10 MON, `<ROLE> LOW` when a role is below its minimum and cannot be topped up (also without any
`TREASURY_KEY`: the balance checks always run). Check with `node scripts/control.mjs treasury` from `apps/maker-worker`.

1. Claim testnet MON to the deployer `0xb855…5c11` (the faucet needs a person in a browser).
2. Send it on to the treasury, keeping a little on the deployer for owner calls:
   ```bash
   cd docs/evidence/golive && node fund.mjs treasury=20 --dry && node fund.mjs treasury=20
   ```
   (`fund.mjs` derives the address from the local `treasury.key`; one transfer, receipt checked.)
3. Expect a `TOPUP <ROLE>` alert within 10 minutes for every role below its minimum.

Budget at the 2026-10-09 settings (replay in section 8.9): about 2.8 MON a day for the maker and the operator
together on a busy day (quoting capped at 1.2, a 4-strike roll 1.26, the kill switch 0.1, pulls 0.25), plus the
relayer's drips and the attester's reports, about 3.3–3.6 MON a day in all. Holdings read at 2026-10-09 17:32 UTC:
124.0 MON (deployer 97.6, treasury 10.0, the five role keys 16.4), against about 83–90 MON needed from Oct 10 to
Nov 3 at that rate; the treasury floor and the caps keep a bug from draining it.

**Manual routine (fallback).** A Taipei ladder day costs about:

| Item | MON |
|---|---|
| operator roll | 0.78 |
| maker roll | 0.48 |
| re-quotes | up to the cap |
| kill switch + YES withdraw at close | ≈0.26 |
| drips | 0.16 each (0.15 sent + gas); faucet AUSD refills cost ≈0.013 per 10k |

The human faucet gives about 5 MON/day.

1. Claim testnet MON to the deployer `0xb855…5c11`. Alternatively, claim directly to the role address that is short.
2. Send from the deployer, one transfer at a time and ≥5 blocks apart. Monad's reserve-balance rule allows an account under 10 MON to send value only in an "emptying" tx, which needs no tx of its own in the previous 3 blocks. The script handles the spacing and checks every receipt:
   ```bash
   cd docs/evidence/golive && node fund.mjs operator=0.8 maker=0.8 relayer=1.0      # add --dry to preview
   ```
3. **Before each day's 12:00 Taipei roll** the operator needs about ≥0.85 MON, or the automatic roll of the next day's ladder is refused. It held 0.12 at go-live and 1.82 at 2026-10-07 07:55 UTC, enough for the Oct 9 roll. It retries every hour until funded, and nothing is broadcast while it is short.

## 5. API and web

- **API deploy** (wrangler 3.114 from `apps/api/node_modules`, on the Cloudflare account that owns the Pages project; set `XDG_CONFIG_HOME` to your wrangler config dir if you use several): `cd apps/api && npm run deploy`.
  - **How requests arrive.** The Worker has no public hostname (`workers_dev = false`, `preview_urls = false` in `apps/api/wrangler.toml`). The public API is `https://isotherm.pages.dev/api/*`: the Pages Function `apps/web/functions/api/[[path]].ts` forwards each request unchanged over the service binding `API` (`apps/web/wrangler.toml`), and `CF-Connecting-IP` passes through, so the per-network limits still see the client. The cron trigger needs no route. Deploying the Worker does not require a web redeploy, and the binding resolves only while the Worker and the Pages project are on the same account.
  - Secrets `RELAYER_KEY`, `SNAPSHOT_TOKEN` and `ADMIN_TOKEN` are already set (`npx wrangler secret list`).
  - Knobs are in `apps/api/wrangler.toml [vars]`: `DRIP_MON`, `DRIP_DAILY_CAP`, `DRIP_ENABLED="0"` to pause drips, `RELAY_DAILY_CAP`, `RELAY_PER_IP_PER_DAY`, `RELAY_PER_ADDRESS_PER_DAY`, `RELAY_MIN_AUSD`, `RELAY_ALLOW_PERMIT`, `RELAYER_MIN_MON`, `AUSD_FLOAT_TARGET`, `TEAM_ADDRESSES`, and for the chain access `RPC_URLS`, `RPC_MAX_RPS`, `STATS_SCAN_LAG_BLOCKS` (next bullet).
  - **RPC endpoints (live since 2026-10-09 18:48 UTC).** The API Worker read and wrote through the official `https://testnet-rpc.monad.xyz` alone. That endpoint limits each client IP to 15 requests/s, and Workers share egress IPs, which is what broke the maker Worker's ticks from 14:00 to 15:27 UTC on 2026-10-09. The API now uses a viem fallback pool (`apps/api/src/rpc.ts`, details in `apps/api/README.md`, "RPC endpoints").
    - **Order.** `RPC_URLS` in `wrangler.toml` lists Ankr (`https://rpc.ankr.com/monad_testnet`), then thirdweb (`https://10143.rpc.thirdweb.com`), then the official endpoint. Do not set `RPC_URL` there: it is the one-endpoint override for anvil forks and wins over the list.
    - **Chain id.** Each endpoint must answer `eth_chainId` 10143 before its first use; one that does not is never used.
    - **Throttle and cooldown.** Each endpoint gets `RPC_MAX_RPS` requests/s (8). A rate-limited endpoint cools down for 2 s or its `Retry-After`, and one that answers 5xx, times out or fails at the network level for 1 s; both double with each consecutive failure, at most 30 s, while the next endpoint serves. A request that every endpoint refused is retried, up to 4 attempts in all.
    - **Relayer nonces.** Every relayer transaction is signed once, and a retried broadcast resends the same bytes, so it is never a second transaction. The next nonce is the larger of the RPC's count and the last nonce seen mined plus 1. If a drip's MON leg or a relayed mint has an unknown fate after its broadcast, it is counted and answered 504 with its hash. A retry never sends that MON again, and a relayed mint cannot land twice because its EIP-3009 authorization is single-use. A drip's AUSD leg in that state is marked pending instead; a retry re-reads the user's AUSD balance and sends it again only if that balance has not risen.
    - **Stats scan.** Pages of at most 100 blocks, 5 blocks behind the head. `eth_getLogs` goes only to an endpoint whose head covers the page, because every endpoint tested returned a truncated result, without an error, past its own head. A page that fails stops the run with the cursor at that page. After a rate limit or an outage, the scan skips the cron for about 2, then 4, then at most 8 minutes; the cron's result is not logged, so watch `updatedAt` and `lagBlocks` in `/api/stats`.
  - **Size the caps to the relayer's MON** (v1 review N5): anyone can otherwise use up the day's drips and relays. `node apps/api/scripts/size-caps.mjs` computes the caps from the live balance, spread over several worst-case days (`--days N`, default 7) so one day can never spend the whole balance. The first values were sized from 0.599 MON (2 drips and 5 relayed mints per day). At 07:59 UTC on 2026-10-07 they were re-sized from 4.599 MON over 7 days (`apps/api/evidence/size-caps-2026-10-07-r2.txt`), and the Worker was redeployed at 08:02 UTC. `/api/health` `limits` at 08:40 UTC shows those values live:
    - drips: 2 per UTC day, 1 per network, 24 h per address;
    - relays: 9 per UTC day, 4 per network, 4 per address, 1–500 AUSD each;
    - reserve: 0.1 MON.

    At maximum use that covers UTC days Oct 7–13, so **top up and re-size before 2026-10-14**. Re-run it and redeploy after every top-up, with `--days` covering the time until the next top-up (judging runs Oct 14–27). Permit-mode relays stay off for the v1 vault (`RELAY_ALLOW_PERMIT = "0"`, N10).
  - After a deploy, check `/api/health`: `relayModes` should be `["authorization"]`, and `monBalance` should cover the caps. Since the RPC pool, also check `rpc`: `source` should be `"RPC_URLS"`, no endpoint should be `wrong-chain`, and at least the first should be `ok`. A `cooling` endpoint with a growing `rateLimited` count is the per-IP limit at work; the others keep serving. One-liner: `curl -s https://isotherm.pages.dev/api/health | python3 -c 'import json,sys; r=json.load(sys.stdin)["rpc"]; print(r["source"]); [print(e["endpoint"], e["state"], e["ok"], e["rateLimited"], e["failed"], e["lastError"]) for e in r["endpoints"]]'`.
  - Live logs: `npx wrangler tail isotherm-api` (requests that come in through the Pages Function show up here too).
- **Go-live change to the API.** The drip's second tx (the AUSD leg) re-read `eth_getTransactionCount('pending')`. Monad's RPC does not count a just-submitted tx there, so the AUSD leg reused the MON tx's nonce and was rejected ("Missing or invalid parameters"). Because nothing was recorded, a retry could also send MON again.
  - The fix: nonces are counted locally, and if MON went out but AUSD failed, the drip is recorded as AUSD-pending so a retry sends only AUSD.
  - Verified live: a two-leg drip in 1.3 s, `docs/evidence/golive/drip-two-leg-after-fix.json`.
- **Web deploy:** `cd apps/web && npm run build && npx wrangler@3 pages deploy --branch main` (same account as the Worker). `apps/web/wrangler.toml` names the project (`isotherm`), the output directory (`dist`) and the `API` service binding, and the upload includes `functions/` (the `/api/*` proxy) and `public/_routes.json`, which keeps every other static file off Functions. The build reads addresses from `deployments/testnet.json`.
  - Old deployments stay reachable at their own `https://<hash>.isotherm.pages.dev` URLs and keep serving the bundle they were built with. Delete superseded ones in the Pages dashboard (the project's deployment list) or with the Cloudflare API's delete-deployment call; wrangler 3.114 has no delete command (`npx wrangler@3 pages deployment list` shows the ids).
  - **Dynamic.** `npm run build` also reads the public Dynamic Sandbox environment ID from `apps/web/.env.production`, so the build makes "Sign in with email" through Dynamic the default. That build is live since 2026-10-07.
  - **The embedded-wallet proof passed on the live site** (2026-10-07 12:36 UTC). A team member signed in with email and got embedded wallet `0xF4a3377D1200584D8Ab7d7e64c6B17dc6c792427`, a team test wallet. The deployer funded it (0.25 MON `0x6ed02038…90be`, 10,000 AUSD `0xf4f38886…e664`). The wallet then made a relayed mint (`0xca08d0150c228c16f9841b00244654ec39f96551c52a0e063584d2adabb6bf04`) and a Zap Buy Yes (`0x361668d832a2acd47180b8875c9ce44ce0ff6f7dec9a071755e7c8d9dcb4681c`), both `success`. Details: `apps/web/evidence/dynamic/RESULT.md` §5.
  - Monad Testnet and Monad Mainnet are enabled in the Sandbox environment. Check with `curl -s https://app.dynamicauth.com/api/v0/sdk/3eaae4f7-b9bb-4a0a-a578-00ff7008a460/settings`; at 13:24 UTC it listed chains 1, 143 and 10143.
  - Emergency dev-wallet-only build: `VITE_DYNAMIC_ENVIRONMENT_ID= npm run build` (a shell variable beats the file).
- **Smoke-test wallet.** The go-live smoke test used dev wallet `0xd42A0b394F09df88BB2120D0973569b845f2D79c`, stored in the in-app browser. It is listed in `TEAM_ADDRESSES`, so the public "trading wallets" counter does not count our own test. `/api/stats` classifies its fill as `team`. The team's Dynamic test wallet `0xF4a3377D1200584D8Ab7d7e64c6B17dc6c792427` is in `TEAM_ADDRESSES` too; at 13:28 UTC `/api/stats` classified its Buy Yes as `team`, with `nonMakerWallets 0`.

## 6. Settlement (not run by the maker)

The Oct 8 ladder is settled by the CRE workflow in `packages/cre-workflow`, through the MockKeystoneForwarder plus the attester signature. The CRE workstream installed the jobs on 2026-10-07 (`packages/cre-workflow/README.md`, `RESULT.md`).
- **When:** `xyz.isotherm.cre-settle` runs hourly at :05; nothing is attempted before day end + 2 h, so the first real attempt for the Oct 8 ladder is **2026-10-08 18:05 UTC (02:05 Taipei, Oct 9)**. Disagreeing or incomplete sources stay pending and are retried hourly; a void comes only after 36 h (46 h backstop).
- **Which path:** the official path (`cre workflow simulate --broadcast`) needs `cre login`.
  - **Login.** Done on 2026-10-07; the session file `~/.cre/cre.yaml` was written at about 07:59 UTC.
  - **Since then.** `cre whoami` succeeds, and the job takes the official path with the unmodified CLI v1.37.0. The binary is byte-identical to the SHA-256-pinned release zip in `packages/cre-workflow/.tools/dl/`.
  - **First official run.** At 08:05 UTC it ran `cre workflow simulate ./settle -T testnet --non-interactive --trigger-index 2 --broadcast` against live testnet, scanned the one ladder, found nothing due and sent no report. Evidence: `~/isotherm-live/packages/cre-workflow/var/evidence/LATEST.json` (`"path": "official"`), with the history in `settle-runs.jsonl` next to it.
  - **Before the login.** The 07:08 UTC run took the harness fallback and also had nothing due.
  - **If the session lapses** (its expiry is undocumented), the job falls back to the **SDK-harness**: the same handler, rule and attestation run under Bun, not the CRE engine. The evidence record says which path ran; say "harness" wherever a harness run's evidence is used.
  - **Check before the first real attempt** (2026-10-08 18:05 UTC). Run `cre whoami` from `packages/cre-workflow` with `.tools/bin` on the PATH, or read `path` in `LATEST.json`. If it is not `official`, run `cre login` again.
- **Where it runs:** from the runtime copy `~/isotherm-live/packages/cre-workflow`, because launchd cannot read `~/Documents` (exit 126, as the maker hit). Ship changes with `packages/cre-workflow/scripts/deploy-runtime.sh`; check with `bash ~/isotherm-live/packages/cre-workflow/scripts/install-launchd.sh --status` and `launchctl list | grep xyz.isotherm`.
- **Moving it off the Mac (prepared 2026-10-09, not deployed).** A kit runs the same job on a small Linux VPS under a
  systemd timer, with a single-writer claim so the Mac and the VPS never both settle: team summary and owner steps in
  `docs/SETTLEMENT-VPS.md`, runbook in `packages/cre-workflow/vps/README.md`. Until its cutover, everything in this
  section stays as written.
- **Cost:** each report transaction bills about 0.0204 MON to the attester key (0.40 MON at 2026-10-07 07:55 UTC, about 19 reports).
- **After it lands:** confirm `LadderResolved` or `Resolver.resultOf(0x52435353, 20261008)`, never the transaction status alone. `xyz.isotherm.challenge-watch` recomputes the result and challenges a reproduced mismatch within the 900 s window; a human check is still worth it (challenge first, then pause; section 3).
- **Fallback:** if nothing settles, `voidIfStale` opens 48 h after the local day end and pays 0.5/0.5. The
  Cloudflare Worker sends it itself (next bullet), and anyone else can too.
- **Guardrails on Cloudflare (no new key).** The maker Worker's settlement watcher (section 8.8) checks every vault
  ladder that has no result yet:
  - **Overdue alert.** More than 3 h after the local day end it raises `SETTLEMENT OVERDUE RCSS:<date>`. For Taipei
    that is 19:00 UTC, about an hour after the first attempt at 18:05. The alert repeats hourly until a result
    lands, and then `OVERDUE CLEARED` is raised once. Read it with `node scripts/control.mjs alerts` from
    `apps/maker-worker`, or on a phone through the optional push channel.
  - **Automatic stale void.** Once `Resolver.staleAt` has passed (day end + 48 h) with still no result, and only
    while the Resolver is not paused, the Worker simulates `voidIfStale` and, in live mode, sends it from its
    operator key. It makes at most one attempt per ladder per hour, within 0.05 MON a day, with an alert either way.
  - **Settlement itself is unchanged.** It still runs through the official CRE CLI (`xyz.isotherm.cre-settle`)
    until the DON cutover. The Worker never signs a settlement and holds no attester key. It cannot settle a
    ladder at its real temperature; it makes a failure visible within hours and bounds it at 0.5/0.5.

## 7. Known limits

- One bid and one ask per strike; quotes follow the Polymarket-implied fair. Our v0 model is only a guardrail (it loses to Polymarket in backtest).
- No automatic redeem for the maker after settlement; use `vault.redeem` / `redeemSet` by hand.
- Tokyo (RJTT) is supported in code but not scheduled (MON budget).
- Kuru books keep matching after `closeTime` for anyone who trades the book directly; the Zap refuses. That is why the kill switch must have MON at 17:20.

## 8. The Cloudflare maker (`isotherm-maker`) and the cutover runbook

The maker loop, the daily roll, the close-time kill switch and the challenge watcher also run as a Cloudflare
Worker, `apps/maker-worker`. Details are in `apps/maker-worker/README.md`. It is meant to replace the Mac jobs for
judging (Oct 14 – Nov 3), so that judging does not depend on this Mac staying awake.

- **What it is.** A cron trigger every minute re-arms one Durable Object, `MakerDO`. The DO ticks on its own alarm,
  every 60 s from tick start to tick start, and exactly at a ladder's kill-switch time. It reuses the same
  `packages/maker` and `packages/forecast` code as the Mac.
- **No public hostname.** `workers_dev = false`, `preview_urls = false`, no routes. It reaches the API through the
  service binding `API` → `isotherm-api`. Operators use its control KV via `apps/maker-worker/scripts/control.mjs`.
- **Same Cloudflare account** as `isotherm-api` and the Pages project. The KV namespace id lives in
  `~/.config/isotherm/maker-kv-namespace-id` and is not committed.
- **Secrets** (`MAKER_KEY`, `OPERATOR_KEY`, `GUARDIAN_KEY`, `SNAPSHOT_TOKEN`) were set with
  `scripts/put-secrets.mjs`, piped on stdin from `~/.config/isotherm/`.
- **Deployed 2026-10-08, SHADOW:**
  - since 16:25 UTC (`320e757f`, then `07fd9e32`);
  - `d034e1c9` (16:52 UTC), `bdb169ea` (16:57) and `bff587c6` (17:05, current) carry the fixes from the
    shadow-vs-Mac comparison (8.6). The shadow state was reset at 16:58 UTC, so `summary` counts from there.
  - `c0301839` (18:46 UTC): guard-wide hysteresis and the 3-tick requote step (8.7), still shadow.
- **Cutover to LIVE 2026-10-08 23:00 UTC** (runbook 8.3): Mac writers stopped at 23:00:31, state imported (2 ladders,
  Oct 9 spend 2.87 MON re-booked), armed, `033804cc` deployed with `MAKER_MODE = "live"`; live from 23:06 UTC, first tx a
  >=31 requote (success); the API snapshot source is `isotherm-maker-worker`.
- **Settlement guardrails** (8.8): the `SETTLEMENT OVERDUE` alert, the automatic stale void at 48 h and an optional
  phone push. Live since 2026-10-09 15:05 UTC (`ea82e973`); the push channel's state is in `control.mjs status` (`push`).
- **RPC:** Ankr alone from 2026-10-09 15:27 UTC (the official RPC answered "requests limited to 15/sec" per client IP
  and Workers share egress IPs; ticks failed 14:00–15:27 UTC); since 18:35 UTC `RPC_URLS` = Ankr, thirdweb, official with
  fallback, throttle and retry (8.9).
- **MON saving, RPC fallback and the treasury** (8.9): live since 2026-10-09 18:35 UTC (`647da628`); `TREASURY_KEY` set
  at 18:41 UTC (treasury `0x655dE7F5E6EdB42f26C422ED056F94BA9964BEed`, 50 MON at the first pass, no top-up needed).

### 8.1 Who does what

| Job | Now | After the cutover |
|---|---|---|
| quoting loop, kill switch (`xyz.isotherm.maker`, `xyz.isotherm.watchdog`) | Mac (live); Worker in shadow | Worker (kill switch at stop − 90 s, plus a verify pass every 5 min like `watchdog --verify`) |
| daily roll (`xyz.isotherm.roll`) | Mac (live; the hourly job acts at the first run after 12:00, about 12:45 Taipei); Worker in shadow | Worker (from 12:00 station time; retries every 5 min until the ladder is active) |
| challenge watcher (`xyz.isotherm.challenge-watch`) | Mac (live); Worker recomputes and alerts | Worker (guardian key) |
| CRE settlement (`xyz.isotherm.cre-settle`) | Mac | **stays on the Mac** (the official CRE CLI cannot run in a Worker; the attester key is not in Cloudflare). The Worker alerts when a result is overdue and stale-voids at 48 h (8.8) |

**Live needs two switches. Both have been on since the cutover (2026-10-08 23:06 UTC):**
1. `MAKER_MODE = "live"` in `apps/maker-worker/wrangler.toml`. `scripts/deploy.mjs` refuses it without `--live`,
   and once it is in the file, refuses any deploy without `--live`.
2. The Durable Object flag, set by `node scripts/control.mjs arm`. It confirms with the maker address derived from
   `~/.config/isotherm/maker.key`.

**Interlock.** While live, if the API's latest snapshot is younger than 5 min and was not published by the Worker,
the Worker stays in shadow and raises the alert "live mode blocked". The Mac still running is exactly that case.
Only the kill switch still runs live during the interlock, because cancels are idempotent.

**Control documents take up to 2 minutes.** KV is eventually consistent (about 60 s) and the DO reads it once per
tick. The DO applies only the latest document, so `control.mjs` refuses a new one while the previous one is
unapplied (`--force` replaces it). Always wait for `node scripts/control.mjs result` before the next command.

**Budgets** (`apps/maker-worker/config/worker.json`; the settings of section 8.9, live since 2026-10-09 18:35 UTC):
- Quoting: maker **1.2 MON/day** with tiers: above 60 % (0.72) spreads ×2 and only urgent re-quotes; at the cap no
  new quotes and an urgent strike is pulled.
- Roll, separately: maker 0.8, operator 0.5, market creator 0.8. At most 4 strikes, none outside [0.05, 0.95].
- Reserve meter (pulls, the kill switch, the YES withdraw, orphan cancels, the stale void): **never refused**; maker
  0.5 is only the alert line (`RESERVE METER OVER maker`).

A spent quoting day therefore cannot block the next roll (the Oct 8 incident), and cannot block a pull either (it
could until 2026-10-09). The opening quotes of a new ladder count as roll. Versions `033804cc` to `7845fd00` (up to
2026-10-09 18:35 UTC) ran the earlier settings: quoting 6.9 (the cutover day's cap) with pulls on the same meter, and the
legacy re-quote rules with `requoteTicks` 3.

### 8.2 Review the shadow first

Run these from `apps/maker-worker`; set `XDG_CONFIG_HOME` to the wrangler config dir of the Cloudflare account that
holds `isotherm-api`.

```bash
node scripts/control.mjs compare    # shadow vs the Mac over the last 90 ticks: agreement %, every difference
                                    # classified (timing or UNEXPLAINED), and whether each Mac tx was predicted
node scripts/control.mjs ticks 30   # the last 30 ticks, one line per strike: shadow fair/guard/action/desired vs the
                                    # live Mac's published fair/guard/quote, plus every would-send
node scripts/control.mjs summary    # since the last reset: ticks, actions, distinct would-sends, compare stats
node scripts/control.mjs status     # mode, reasons, ladders mirrored from the books, meters, watcher verdicts
node scripts/control.mjs alerts     # loud ones (interlock, MISMATCH/UNVERIFIED settlements)
node scripts/control.mjs cron       # the every-minute cron heartbeat (shows the alarm loop is armed)
npx wrangler tail isotherm-maker    # live logs: every alarm tick, its would-sends, the cron kick
```

Look for:
- `compare`: agreement or timing at 100 %, no `UNEXPLAINED`, every Mac tx "predicted by the shadow" or "agreed after".
- `summary.ticks` growing by 1 per minute, `errors` 0.
- In `ticks`, the shadow's `want` equal to the live maker's quote, and every `would send` followed within a
  minute by the same tx from the Mac (`grep '"tx ' ~/isotherm-live/packages/maker/var/maker.log | tail`).
- Remaining differences explained by timing (section 8.6). The usual one: a `guard-wide` flag that differs for up
  to an hour because the two refresh the v0 guard at different minutes (compare the `guard` columns).
- `intentRepeats` in `summary` counts would-sends repeated while the Mac does not act (metered once).
- Around 12:00 Taipei: a shadow roll that simulates tomorrow's `createLadder` (`would send: operator createLadder`;
  the plan is not kept), then, within 2 min of the Mac's roll (about 12:45), `roll ... adopted from the existing
  on-chain ladder`.
- At 17:18:30 Taipei: `kill RCSS:... shadow cancelled N left 0`, with `KILL >=k cancel` and `withdraw YES margin`
  would-sends, after which the shadow ladder closes.
- After 02:05 Taipei: watcher verdicts `MATCH` for the CRE settlement in `status`.

### 8.3 Cutover

**Before you start (go / no-go).**
- MON. The roll needs about **0.96 MON from the operator key** (createLadder 0.147 + 5 × setCanonical 0.014 +
  5 × deployProxy 0.150, the operator is also the market creator) and the maker about 0.61 + the day's quotes
  (about 2 MON). Check with `cast balance <address> --ether --rpc-url https://testnet-rpc.monad.xyz`; fund first
  (section 4). With less, the roll stops before a market and retries every 5 min until funded.
- Time. Allow about 15 minutes. Not between 11:30 and 13:30 Taipei (Worker roll at 12:00, Mac roll job about
  12:45), not between 16:50 and 17:40 (kill switch at 17:18:30), not between 01:50 and 02:30 (settlement and its
  900 s challenge window). Good windows: 07:00–11:00 or 14:00–16:30 Taipei.
- No Mac roll in progress: `pgrep -fl 'src/cli.ts roll'` prints nothing.
- The shadow review (8.2) is clean.

Run everything from `apps/maker-worker` with `XDG_CONFIG_HOME` set as in 8.2.

1. **Stop the Mac writers and keep them off.** Leave their quotes up; the Worker adopts them. Keep `cre-settle`.
   `disable` keeps launchd from loading them again at the next login or reboot (a second writer).
   ```bash
   for j in maker roll watchdog challenge-watch; do
     launchctl bootout gui/$(id -u)/xyz.isotherm.$j
     launchctl disable gui/$(id -u)/xyz.isotherm.$j
   done
   until ! pgrep -f 'src/cli.ts (loop|roll|watchdog)' >/dev/null; do sleep 2; done   # the loop finishes its step
   launchctl list | grep xyz.isotherm           # only xyz.isotherm.cre-settle
   date -u                                      # T0: the Mac's last snapshot is at most ~60 s older
   ```
2. **Hand over the Mac's state** (Kuru order ids, lastQuote, roll steps, today's MON) to the Worker's live state.
   It works only while disarmed. Today's spend is re-booked onto the Worker's split meters from `txs.jsonl`.
   ```bash
   node scripts/control.mjs import-state ~/isotherm-live/packages/maker/var/state.json
   node scripts/control.mjs result   # repeat until: "imported live state from import:state:<n>: N ladder(s)"
   ```
3. **Arm the Durable Object.**
   ```bash
   node scripts/control.mjs arm
   node scripts/control.mjs result   # repeat until: "ARMED (DO live flag on; live also needs MAKER_MODE=live, now shadow)"
   ```
4. **Flip the env switch.** Edit `wrangler.toml`: `MAKER_MODE = "live"`. Then:
   ```bash
   npm run deploy -- --live          # the output must show MAKER_MODE: "live", schedule: * * * * *, and no workers.dev URL
   ```
   The secrets carry over. Commit the `wrangler.toml` change: from now on `npm run deploy` without `--live` is
   refused, so a routine deploy can never silently turn the maker (and its kill switch) off.
5. **Verify the first live ticks.**
   ```bash
   node scripts/control.mjs ticks 3  # until T0 + 5 min: "shadow" with ALERTS "live mode blocked" (the interlock)
   node scripts/control.mjs status   # then: "mode": "live", reasons ["env MAKER_MODE=live and the DO flag is armed"]
   node scripts/control.mjs ticks 5  # "live"; "sent: ..." lines when a re-quote is due
   node scripts/control.mjs tick     # "reconcile": the Mac's order ids kept, no "orphans"; "snapshot": {"posted": true}
   curl -s https://isotherm.pages.dev/api/snapshot | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["source"], d["receivedAt"])'
                                     # -> isotherm-maker-worker, a timestamp under a minute old
   curl -s https://isotherm.pages.dev/api/health | grep -o '"snapshotReceivedAt":"[^"]*"'
   ```
   Also check that each strike still has one bid and one ask of the maker (or is pulled), as in the web app.
6. **Watch the first roll and kill switch.** At 12:00 Taipei `ticks` shows `roll RCSS:<tomorrow> ok=true` and about
   30 `sent:` lines; at 17:18:30 `kill RCSS:<today> live cancelled N left 0` plus the YES margin withdraw. After
   02:05 the watcher verdicts in `status` are `MATCH`.

### 8.4 Rollback to the Mac

1. **Pull the Worker's quotes.** `node scripts/control.mjs pull all`, then `result` until it shows the pull, then
   `ticks 2` shows `sent: maker KILL >=k cancel x2` per quoted strike. Ladders stay paused in the Worker.
2. **Disarm.** `node scripts/control.mjs disarm`, then `result` until "disarmed". The next tick is shadow.
3. **Env switch back.** Set `MAKER_MODE = "shadow"` in `wrangler.toml`, then `npm run deploy`.
4. **Start the Mac jobs again.**
   ```bash
   for j in maker roll watchdog challenge-watch; do
     launchctl enable gui/$(id -u)/xyz.isotherm.$j
     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/xyz.isotherm.$j.plist
   done
   launchctl list | grep xyz.isotherm           # all five, the maker with a PID
   ```
5. **Hand the Worker's new ladders back.** The Mac's `state.json` predates the cutover: its tracked orders are gone
   (step 1) so it quotes afresh, but a ladder the Worker rolled after the cutover is not in it. For each one that
   `status` lists (for example `RCSS:20261011`), queue an adopting roll; the loop holds the lock, so the CLI queues it:
   ```bash
   bash ~/isotherm-live/packages/maker/scripts/run.sh roll --station RCSS --date 2026-10-11
   ```
   It adopts the on-chain strikes, markets and margin (no new markets) and quotes on the next tick.

### 8.5 Operating it

| Goal | Command (from `apps/maker-worker`) |
|---|---|
| History, one line per strike | `node scripts/control.mjs ticks 30` |
| Pull all quotes now and pause | `node scripts/control.mjs pull all`; undo with `resume RCSS:20261010` |
| Roll a date by hand (idempotent) | `node scripts/control.mjs roll RCSS 2026-10-10` |
| Change caps or settings | edit `config/worker.json` or the `[vars]` in `wrangler.toml`, then `npm run deploy` (`-- --live` once live) |
| Rotate a secret | `node scripts/put-secrets.mjs --only MAKER_KEY --live` (`--live` is required since the cutover) |
| Overdue ladders, stale voids, push channel | `node scripts/control.mjs status` (`watcher.overdue`, `watcher.staleVoids`, `push`); `alerts` for the texts |
| Check the phone push | `node scripts/control.mjs test-alert`, then `result`; one `TEST ALERT <seq>` arrives (8.8) |
| Reset the shadow's own state and summary | `node scripts/control.mjs reset-shadow` |
| Treasury and role balances | `node scripts/control.mjs treasury` (balances vs min/target, today's top-ups and caps); `status` has `treasury`, `budget.tier`, `rpc.endpoints` |
| Tests | `npm test` (73 unit), `npm run test:fork` (anvil fork + the bundled Worker in Miniflare, live on the fork), `MW_REHEARSAL=1 npx vitest run test/integration/cutover-rehearsal.fork.test.ts` (this runbook on a fork with the Mac's real state), `MW_LIVE_SMOKE=1 npx vitest run test/integration/live-readonly.smoke.test.ts` (read-only, no keys) |

**Known limits.**
- **Settlement still depends on the Mac** (until the prepared VPS cutover, `docs/SETTLEMENT-VPS.md`). If the Mac
  sleeps or loses its network, the Worker raises `SETTLEMENT OVERDUE` after 3 h and voids the ladder itself at 48 h
  (0.5/0.5, section 8.8). Only the CRE settlement pays out at the real temperature.
- **The Worker is a single region-pinned Durable Object.** One alarm per minute and 4 KV writes per minute. A warm
  tick takes 3–15 s of sequential public-RPC reads; the first tick of a fresh isolate takes about 45 s, because it
  downloads the v0 guard's Open-Meteo history and caches it in the DO.
- **Its watcher challenges only in live mode.** The Mac's `challenge-watch` covers settlements until the cutover.

### 8.6 Shadow vs Mac comparison (2026-10-08)

**Method.** A recorder polled the Worker's KV outbox every 12 s (every tick report) and the Mac's
`var/snapshot.json`. Each shadow tick is compared per strike with the Mac's published snapshot and its next tick
(from `maker.log`). A shadow would-send counts as agreement when the Mac sent the identical tx (same strike, same
prices) within 90 s; each Mac tx is checked for a shadow tick that wanted the same before it. A difference is
"timing" when the two ran on different inputs (the hourly v0 guard refreshed at another minute, or Polymarket
moved between the ticks); anything else is UNEXPLAINED. Data, the recorder and both comparison scripts:
`apps/maker-worker/evidence/shadow-compare-2026-10-08/`. The same check runs from KV: `control.mjs compare`.

| Window (UTC, Oct 8) | Worker | Shadow ticks | Strike decisions | Agree | Timing | Unexplained | Mac txs predicted by the shadow |
|---|---|---|---|---|---|---|---|
| 16:31 – 16:52 | `07fd9e32` (before the fixes) | 19 | 95 | 90 (94.7 %) | 5 (1 fair-crossed-guard-threshold, 4 v0-refresh) | 0 | 0 of 1 predicted, 1 agreed on the next tick, 0 unexplained |
| 16:53 – 17:26 | `d034e1c9` → `bff587c6` (after) | 34 | 170 | 170 (100.0 %) | 0 | 0 | 7 of 8 predicted, 1 agreed on the next tick, 0 unexplained |

**Fair values.** Paired with the Mac's next tick, |shadow fair − Mac fair| over strike decisions: 16:31 – 16:52: n=95 mean=0.0002 median=0.0000 p95=0.0008 max=0.0051; 16:53 – 17:26: n=170 mean=0.0001 median=0.0000 p95=0.0012 max=0.0034. Both read the same Polymarket CLOB a few seconds apart. (`summary.compare.fairAbsDiffMax` is larger, up to 0.04 on fast moves, because it compares with the Mac's previous published snapshot, up to a minute older.)

**Differences, all explained.**
- **v0 guard refreshed at another minute (timing).** Both refresh the v0 guard hourly, each on its own clock. On
  Oct 8 the Mac's 16:47:56 refresh moved P(Tmax ≥ 30) from 0.8364 to 0.8353; the Worker kept 0.8364 until its own
  refresh at 17:26:02 UTC, an hour after its 16:25:36 fetch (mu 30.66 → 30.65). With fair at 0.686 that is |fair − guard| 0.150 vs 0.149, either side of `guardWarn` 0.15,
  so for a few ticks the shadow wanted the wider `guard-wide` quote (0.62/0.75) and the Mac kept 0.65/0.72. Live
  there is only one writer, so this cannot happen there. The guard values are now in every tick line. From the
  Worker's 17:26:02 refresh on, its guards equal the Mac's on all five strikes (0.9813 / 0.9529 / 0.8353 / 0.5336 /
  0.1837).
- **Concurrent ticks (agreement).** When both decide within the same minute, the shadow can read the book just
  before the Mac's tx lands: it then wants exactly the tx the Mac sends seconds later.

**Fixed and redeployed (shadow).** The comparison found five things where the shadow would not behave like the
live maker, or could not be compared with it:
1. *Watchdog verify pass missing (live logic).* The Mac runs `watchdog --verify` every 5 min: it re-scans ladders
   closed in the last 2 days and cancels any maker order still open (a cancel that failed, a tx that landed late).
   The Worker ran the kill switch once and never looked again. Now every `WATCHDOG_VERIFY_SEC` (300 s), in both
   modes (unit test: a stray order on a closed book is cancelled on the next verify pass).
2. *Dry-run roll plans kept (shadow logic).* A shadow roll stored its dry-run plan in the shadow state, freezing the
   strikes of that minute's Polymarket data. Once the Mac rolled the real ladder (about 45 min later, possibly with
   other strikes), the shadow kept planning `createSeries` for its own strikes, never mirrored the new books, and
   re-planned only hourly. The plan is now only reported (`shadow:plan:<key>`), and the real ladder is adopted,
   with its strikes, within 2 min of appearing on chain (unit test).
3. *No `lastQuote` in shadow (shadow logic).* The policy re-quotes on "fair moved since the quote" and "quote older
   than 6 h". The shadow never had the Mac's `lastQuote`, so it could not predict those. It now mirrors it (time from
   the Mac's published `lastQuoteAt`; unit test: the 6-hour re-quote is predicted, then quiet once the Mac re-quotes).
4. *Repeated would-sends metered every tick (shadow logic).* While the shadow and the Mac disagreed (the v0 case),
   the shadow re-recorded the same requote every minute and metered it each time: 5 ticks had already put 0.29 MON
   on its meter, and about 40 would have put it over its 2.2 cap, after which it would refuse everything. Identical
   txs (same target and calldata) are now metered once and reported as `repeat`.
5. *Tick period drift.* Ticks ran 60 s after the previous tick *ended* (about 65 s apart); the Mac runs every 60 s.
   Now 60 s from tick start to tick start (measured: 64.7–71.6 s apart before the fix, 60.0–60.1 s after).
Also: the dry-run kill switch now records the YES-margin withdraw too, and `import-state` re-books the Mac's MON
for the day onto the split meters (imported as is, the Mac's 2.45 MON of Oct 8 would have put the Worker over its
2.2 quoting cap for the rest of that day; re-booked it is 2.18 quoting + 0.27 roll).

**Would-be MON per day.** Every would-send had exactly the gas limit and cost of the Mac's tx for the same action
(requote ≥29: 536 884 gas, 0.054762 MON on both; requote ≥30: 567 417 gas, 0.057877 MON; Oct 10 `createLadder`:
1 440 061 gas, 0.146886 MON in both the shadow and the Mac code's isolated dry run). The decisions agree, so live
the Worker spends what the Mac spends:

| Taipei day | Mac actual (maker / operator / market creator) | Worker meters for the same txs |
|---|---|---|
| 2026-10-07 (go-live day, from 13:55 Taipei) | 1.178 / 0.178 / 0.599 = 1.954 | maker 0.698 of 2.2 + roll 0.480 of 0.8; operator roll 0.178 of 0.5; market creator roll 0.599 of 0.8 |
| 2026-10-08 (full day) | 2.450 / 0.216 / 0.748 = 3.414 | maker 1.939 of 2.2 + roll 0.511 of 0.8; operator roll 0.216 of 0.5; market creator roll 0.748 of 0.8 |
| 2026-10-09 (until 17:27 UTC) | 0.659 / 0.000 / 0.000 = 0.659 | maker 0.659 of 2.2 + roll 0.000 of 0.8; operator roll 0.000 of 0.5; market creator roll 0.000 of 0.8 |

The Worker's caps fit Oct 8 (maker quoting 1.94 of 2.2, maker roll 0.51 of 0.8, operator roll 0.22 of 0.5, market
creator roll 0.75 of 0.8). The main difference is protection: on the Mac the roll shares one 3.0 meter with
quoting, so a busy quoting day can again block the next roll (Oct 8); the Worker's roll has its own meter.

**Oct 9 kill switch and Oct 10 roll.**
- *Roll decision, simulated now in the deployed shadow* (`control.mjs roll RCSS 2026-10-10` at 16:54 UTC): strikes
  [28, 29, 30, 31, 32] from Polymarket median 30 (P(≥k) 0.938 / 0.816 / 0.516 / 0.189 / 0.067), `createLadder`
  1 440 061 gas = 0.1469 MON, roll estimate operator key 0.957 MON, maker 0.611. The Mac's own Node code, dry run
  in an isolated directory 2 min earlier, planned the same strikes, gas and estimates. The plan was not kept (fix 2).
- *Full rehearsal on a fork* (`evidence/rehearsal-*`, `MW_REHEARSAL=1`): the Mac's real `state.json` imported and armed; while the "Mac" snapshot was 20 s old the interlock held (shadow, 0 txs); with it 6 min old the first live tick quoted ≥29/≥30/≥31 on the real RCSS 2026-10-09 books and posted the snapshot through the binding. Warped to 12:00:30 Taipei on Oct 9, the Worker rolled RCSS 2026-10-10 live: strikes [28–32] from the real Polymarket ladder, 35 txs (createLadder, 5 mints, 5 Kuru markets, 5 canonical, margin, 5 opening quotes); at Monad's 102 gwei that is 0.963 MON from the operator key (0.215 operator + 0.748 market creator) and 0.578 from the maker, inside the roll caps. Warped to 17:18:35, the kill switch cancelled all 6 maker orders on the Oct 9 books and withdrew the YES margin (0.115 MON at 102 gwei); the Oct 10 ladder kept quoting; the verify pass 310 s later found nothing open. Rollback (`pull all`, `disarm`) cancelled every quote, then 0 txs.
- *Timing.* The DO schedules its alarm at the kill-switch moment (stopAt − 90 s + 0.5 s = 17:18:30.5 Taipei for
  RCSS 2026-10-09), and the shadow will run it then (cancel intents for the Mac's orders, then the shadow ladder
  closes).

**Risks found (not Worker-vs-Mac differences; both runtimes share them).**
- **The operator key cannot pay for the Oct 10 roll.** It held 0.86 MON at 17:19 UTC; the roll needs about 0.96
  (it is also the market creator: 5 × deployProxy 0.15). The roll would stop before the 5th Kuru market and the
  new ladder would stay unquoted until it is funded — whoever runs it, Mac (about 12:45 Taipei) or Worker (12:00).
- **Guard-threshold flapping burns MON.** `guard-wide` has no hysteresis: when |fair − guard| sits at 0.15, every
  small Polymarket move flips the spread (0.65/0.72 ↔ 0.62/0.75) and costs a 0.058 MON requote. In the Mac's log,
  9 of 61 quotes/requotes (0.52 of 3.45 MON) returned to the quote they had replaced within 3 h; on Oct 9 the
  maker spent 0.66 MON by 17:27 UTC (the Taipei day starts at 16:00 UTC), mostly on ≥30 flipping. A small
  hysteresis (enter the wide spread at 0.15, leave it below 0.13, using the flag the resting quote was placed with)
  would remove it. Not changed here, so that the shadow stays comparable with the Mac: it is a policy change for both.
  Prepared on Oct 9 for after the cutover: section 8.7.
- **MON runway.** The maker held 4.10 MON at 17:19 UTC and spent 2.45 on Oct 8 (all three keys: 3.4 MON/day);
  the testnet faucet needs a person in a browser, so fund before judging starts.

### 8.7 Re-quote spend fix (live with the cutover, 2026-10-08 23:06 UTC; superseded by 8.9)

On Monad each re-quote bills its gas limit, about 0.056 MON. On Oct 9 (Taipei) the Mac spent about 0.65 MON/h,
mostly re-quotes that flip back and forth on ≥30 and ≥31. There are two causes:
- `guard-wide` had no hysteresis (section 8.6).
- `requoteTicks` 2 re-quotes on every 0.02 move of the fair, and the Polymarket mids jitter by cents.

**What changed.**
- *Shared core (both runtimes).* `fair.guardWarnExit` 0.13 in `packages/maker/config/default.json`.
  - A strike enters the wide spread above `guardWarn` 0.15, as before.
  - It stays wide while |fair − guard| ≥ 0.13, but only if its resting quote was placed wide. That flag is now
    stored as `lastQuote.wide`.
  - Tick lines and the snapshot show `guard-wide-held` while the wide spread is held.
  - A `lastQuote` without `wide` behaves exactly as before. That covers the Mac's `state.json` imported at the
    cutover and the shadow's mirror of the live maker. So does a config without `guardWarnExit`.
  - The Mac's runtime copy (`~/isotherm-live`) is not changed. It gets the hysteresis only at its next
    `deploy-runtime.sh`.
- *Worker only* (`apps/maker-worker/config/worker.json`):
  - `policy.requoteTicks` 3. The Mac keeps 2.
  - `budget.dailyCapMon.maker` 6.9 for the cutover day (below).

**Replay** (`apps/maker-worker/evidence/requote-replay-2026-10-09/`, `node replay.ts`, output in `results.txt`). It
runs the repo's `computeFairs`, `makeQuote` and `decide` tick by tick.

| Data | Mac actual | current (2 ticks) | hysteresis, 2 ticks | hysteresis + 3 ticks | hysteresis + 4 ticks |
|---|---|---|---|---|---|
| A. The Mac's recorded snapshots, 16:32–17:26 UTC Oct 8 (exact fair and guard) | 9 | 9 (all 9 of the Mac's txs reproduced) | 5 | **2** | 2 |
| B. Oct 9 ladder, 13:47–18:38 UTC (4.9 h; fair from the Polymarket minute history) | 38 | 44 | 25 | **17** | 8 |
| B per 24 h (MON per 24 h) | 188 (10.8) | 218 (12.5) | 124 (7.2) | **84 (5.0)** | 40 (2.5) |
| C. Oct 8 ladder, 20.4 h, no guard flapping (requoteTicks only) | 29 | 39 | – | **18** | 15 |
| Lowest edge left on the book, B / C | | 0.021 / 0.020 | 0.021 / – | 0.012 / 0.010 | 0.013 / **0.001** |

Notes on the replay:
- The urgent rule (fair at or through a resting price) still fired in every scenario. In B with 3 ticks: 18:19 UTC,
  ≥30, "resting bid 0.68 >= fair 0.6761".
- Of the 17 re-quotes left in B, 11 are ≥31. Its Polymarket bucket mid jumped 0.04–0.06 every few minutes between
  17:57 and 18:06 UTC. A larger step would only hide that by letting quotes go stale.

**Why requoteTicks 3.** It removes most of the remaining jitter re-quotes: −54 % on the calm Oct 8 ladder, −32 % on
top of the hysteresis in B. It still leaves at least 0.01 of edge on both sides. A 4-tick step (0.04) is as wide as
the normal half-spread (0.03–0.04 after rounding), so the fair reaches the resting price before the step triggers:
lowest edge 0.001 and 2 urgent re-quotes on Oct 8.

**Why 6.9 MON for the cutover day.** `import-state` re-books the Mac's quote and pull spend of that Taipei day onto
the Worker's quoting meter:
- *The Mac's part: at most 4.7.* The Mac's runtime caps that meter at 4.5 (`~/isotherm-live` `local.json`), plus the
  0.2 reserve for pulls. It stood at 1.56 at 02:21 Taipei. At that night's pace of 0.65 MON/h it reaches its cap
  around 06:50 Taipei, before the 07:00 cutover window.
  - This also argues for the morning window. A Mac at its cap cannot pay for its own 12:45 roll of Oct 10: its
    single meter blocks it, as on Oct 8. The Worker rolls at 12:00 on its separate roll meter.
- *The Worker's part: 2.2*, its usual quoting allowance.

With the old 2.2 cap, the imported meter (above 2.4) would refuse every re-quote and every pull for the rest of that
day. Only the kill switch is never refused. **Deploy this right after the cutover** (or ship it with step 4 of 8.3),
not hours later.

Lower the cap back to 2.2 from Oct 10 (Taipei): 6.9 is more than the maker key holds, so it would not protect the
wallet. With the fix, a calm day projects to about 1.6 MON of quoting; a day like the night of Oct 9 projects to
about 6, and the cap then turns re-quotes into pulls.

**MON.** The maker held 6.19 MON at 02:33 Taipei on Oct 9. If the Mac reaches its cap first, about 3 MON is left for
the Worker's rest of the day: quoting up to 2.4, roll up to 0.8 and the kill switch about 0.15. Fund the maker
(section 4).

**Deploy (after the cutover: the Worker is live).** Run from `apps/maker-worker`, with `XDG_CONFIG_HOME` set as in 8.2.
```bash
npm test && npm run typecheck                 # 32 unit tests
npm run test:fork                             # optional: anvil fork + Miniflare, throwaway keys
npm run deploy -- --live                      # wrangler.toml has MAKER_MODE = "live": the output must show it,
                                              # the cron, and no workers.dev URL; note the version id
node scripts/control.mjs status               # "version.id" = the new version, "mode": "live"
node scripts/control.mjs ticks 5              # live ticks, "sent:" only when a re-quote is due; a strike between
                                              # 0.13 and 0.15 with a wide quote shows guard-wide-held, not a re-quote
```
Then, after Taipei midnight Oct 10: set `budget.dailyCapMon.maker` back to 2.2 in `config/worker.json`, along with
its assertion in `test/unit/infra.test.ts`. Run `npm test`, then `npm run deploy -- --live`. *(Superseded by 8.9: the
6.9 cap and its assertion are removed; the quoting budget is 1.2 with tiers.)*

**Rollback.**
- Revert `config/worker.json` (and, for the hysteresis, `guardWarnExit` in `default.json`) and deploy with `--live`.
- Alternatively, set `CONFIG_OVERRIDES = '{"policy":{"requoteTicks":2},"fair":{"guardWarnExit":null}}'` in the
  `[vars]` and deploy.
- Old states keep working in both directions: `wide` is optional.

### 8.8 Settlement guardrails and the alert push (live since 2026-10-09 15:05 UTC)

Settlement still runs through the official CRE CLI on the Mac (section 6). The Worker cannot settle, but it now
makes a missed settlement visible and bounds its cost. It adds no key: `voidIfStale` is permissionless, and the
operator key already in the Worker only pays the gas. Details are in `apps/maker-worker/README.md`, "Settlement
guardrails".

| Chain time, for a vault ladder with no result | The Worker |
|---|---|
| day end + 3 h (Taipei: 19:00 UTC) | `SETTLEMENT OVERDUE <ICAO>:<date>`, repeated hourly; `OVERDUE CLEARED` once a result lands |
| `Resolver.staleAt` (day end + 48 h), Resolver not paused | simulates `voidIfStale`, then sends it from `OPERATOR_KEY` (live mode; gas = estimate × 1.10; at most once per ladder per hour; 0.05 MON/day). Alert `STALE VOIDED` / `STALE VOID FAILED` |
| Resolver paused | `STALE VOID HELD`: never voided by the Worker (owner decision) |

The settlement workflow's own VOID deadlines (36 h, 46 h backstop) come first, so the Worker's void only fires when
the workflow has not delivered at all. Settings live in `wrangler.toml` `[vars]`: `SETTLE_OVERDUE_SEC` (10800),
`SETTLE_OVERDUE_REPEAT_SEC` (3600), `AUTO_STALE_VOID` ("1"; "0" = alerts only) and `ALERT_PUSH_MIN_SEC` (3600).

**Verified.**
- 48 unit tests, run against the fake chain and stubbed push endpoints. The guardrail tests cover the gate edges,
  the hourly dedupe (also for a ladder left unresolved for weeks), the clear once settled, no void before
  `staleAt`, refusal while paused, shadow never sending, the hourly retry, a mined void logged and metered even
  when the read-back fails, the void meter, the live operator key refused on a fork, and push rate limits,
  failures and timeouts.
- The anvil fork test runs the bundled Worker in workerd (`apps/maker-worker/evidence/fork-2026-10-09T14-11-36/`):
  - day end + 3h01: `SETTLEMENT OVERDUE`, pushed to a stand-in webhook, 0 txs;
  - `staleAt`: `voidIfStale` from the operator secret, accepted (Void, `sourcesHash` 0, 76,537 gas of an 84,191
    limit);
  - the next pass: `STALE-VOID`, 0 txs.
- A read-only run of the same bundle against live testnet, in watch-only shadow with no keys
  (`apps/maker-worker/evidence/live-readonly-2026-10-09T14-08-54/`), had 0 errors and 0 txs. Its watcher pass read
  the live Resolver for the open RCSS ladders: none overdue, no stale void due, no alert.

**Deploy** (the Worker is live). Run from `apps/maker-worker` with `XDG_CONFIG_HOME` set as in 8.2:
```bash
npm test && npm run typecheck                 # 48 unit tests
npm run test:fork                             # optional: anvil fork + Miniflare, throwaway keys
npm run deploy -- --live                      # the output must show MAKER_MODE "live", AUTO_STALE_VOID "1", the cron
                                              # and no workers.dev URL; note the version id
node scripts/control.mjs status               # "version.id" = the new version; "push": {"channel": "off (...)"} until
                                              # the webhook is set; "watcher.overdue": {} while every ladder is on time
```

**Phone push (owner, optional).** Pick a channel and store its URL as the Worker secret yourself:
- ntfy: subscribe to a long random topic in the ntfy app; the URL is `https://ntfy.sh/<topic>`. The topic name is the
  only secret, so make it unguessable.
- Telegram: create a bot with @BotFather, send it a message, and read your chat id from
  `https://api.telegram.org/bot<token>/getUpdates`. The URL is
  `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>`.

```bash
umask 077; pbpaste > ~/.config/isotherm/alert-webhook.url        # or any editor; never echo it into the shell history
node scripts/put-secrets.mjs --only ALERT_WEBHOOK_URL --live    # piped on stdin to `wrangler secret put`
node scripts/control.mjs test-alert && node scripts/control.mjs result   # one "TEST ALERT <seq>" arrives on the phone
```
Every alert is then also pushed: at most once per title per hour, 5 s timeout, never blocking a tick. The URL never
appears in logs or KV. Remove it with `npx wrangler secret delete ALERT_WEBHOOK_URL --name isotherm-maker`.

**Off switch.** Set `AUTO_STALE_VOID = "0"` in `wrangler.toml` and run `npm run deploy -- --live`: the alerts stay,
and a due void becomes a `STALE VOID DUE` alert to act on by hand.

**Still on the owner** (the Worker does not cover these):
- keep the Mac that runs `xyz.isotherm.cre-settle` awake on AC power and online;
- keep the attester funded (about 0.0204 MON per report, section 2);
- keep `cre whoami` valid (section 6).

### 8.9 MON saving, RPC fallback and the treasury (live since 2026-10-09 18:35 UTC)

**Why.** Measured MON per Taipei day: Oct 8 3.41 (quotes 2.45, roll about 1.0), Oct 9 8.28 (quotes 7.03, roll 1.25;
the day's high sat at a strike and the Polymarket fair swung through the quotes for hours). The holdings (about
94 MON) must last until Nov 3. On Oct 9 the official RPC also refused the Worker ("requests limited to 15/sec" per
client IP; Workers share egress IPs; ticks failed 14:00–15:27 UTC), and ntfy.sh answered its alert pushes with HTTP 429
for the same reason.

**What changed** (details: `apps/maker-worker/README.md`, "MON budget", "RPC", "Treasury top-up").
- *Lazy re-quoting, shared core (both runtimes; `packages/maker/config/default.json` `policy`).* A strike is
  re-quoted only when the fair is at or through a resting price (urgent), a side filled or needs a refill, the fair
  moved ≥ 0.04 since the quote, or the quote is older than 2 h and the fair moved ≥ 0.02; entering the guard's wide
  spread also re-quotes, with the guard-wide hysteresis unchanged. A fill is refilled on its side only.
  `policy.lazy: false` restores the old rules.
- *Quoting budget with tiers (Worker, `config/worker.json`).* 1.2 MON per Taipei day; above 60 % spreads ×2 and urgent
  re-quotes only; at the cap no new quotes, an urgent strike is pulled. The 6.9 cutover-day cap is gone.
- *Reserve meter (shared core).* Pulls, the kill switch, the YES-margin withdraw, orphan cancels and the stale void
  are metered apart and are never refused (until now a spent quoting day refused pulls past cap + reserve).
- *Roll (Worker).* At most 4 strikes, nearest the Polymarket median, none with an implied P(≥k) outside [0.05, 0.95].
- *One-side Kuru update (measured on an anvil fork, cross-checked with read-only live gas estimates;
  `apps/maker-worker/evidence/one-side-gas-2026-10-09/`).* Kuru has no in-place modify, but `batchUpdate` with one
  side costs less than cancel 2 + place 2: full re-quote 522,424 gas (0.0576 MON billed at 102 gwei, limit × 1.08);
  cancel 1 + place 1 344,868 / 319,178 (66 % / 61 %); place 1 without cancel 287,464 (55 %); cancel 2 252,119 (48 %).
  Used for refills only: an urgent crossing moves the fair by about the half-spread, so the other side is that far
  off too and both are re-centred.
- *RPC (`RPC_URLS`, default Ankr, thirdweb, official).* Per-endpoint chain-id check (10143), a token bucket of 8
  requests/s per endpoint, retries with backoff on rate-limit / 5xx errors, an ordered fallback without ranking, and
  writes that move to the next endpoint only past a rate-limit refusal. `RPC_URL` still works as a one-URL alias
  when `RPC_URLS` is not set.
- *Treasury top-up (new, optional `TREASURY_KEY`).* Section 4.
- *ntfy access token (optional `ALERT_WEBHOOK_TOKEN`).* Below.

**Replay** (`apps/maker-worker/evidence/lazy-replay-2026-10-09/`; `node prepare.ts` fetches public data: the Polymarket
minute history of the three events, the IEM METARs and the maker's own order events on the 13 Kuru books;
`node replay.ts` runs the repo's `computeFairs`, `makeQuote`, `decide` and `quotingTier` once a minute; output in
`results.txt`). Calibration: for the Oct 9 ladder the replay of the settings live until now gives 118 full re-quotes;
the chain shows 122. Not modelled: fills (13 maker fills on these books in three days), other participants' quotes.

| Window | Policy | full re-quotes | pulls | quoting MON | pull MON | worst \|resting mid − fair\| |
|---|---|---|---|---|---|---|
| Taipei Oct 8 | on chain (the Mac; it hit its 1.2 cap at 02:20 UTC and pulled instead) | 28 | 6 | | | |
| | settings live until now (requoteTicks 3 + hysteresis) | 80 | 9 | 4.96 | 0.25 | 0.025 |
| | lazy 0.04 / 2 h / 0.02 | 59 | 9 | 3.75 | 0.25 | 0.040 |
| | **lazy + tiers, 1.2 MON** | **17** | **8** | **1.22** | **0.22** | 0.064 |
| Taipei Oct 9 | on chain (the Mac, then the Worker from 23:06 UTC) | 111 | 12 | | | |
| | settings live until now | 125 | 18 | 8.03 | 0.50 | 0.025 |
| | lazy 0.04 / 2 h / 0.02 | 88 | 18 | 5.90 | 0.50 | 0.041 |
| | **lazy + tiers, 1.2 MON** | **14** | **12** | **1.22** | **0.33** | 0.123 |
| Oct 10 ladder, 04:01–15:51 UTC Oct 9 | on chain (the maker ran out of quoting budget and MON) | 0 | 3 | | | |
| | settings live until now | 11 | 0 | 0.63 | 0 | 0.025 |
| | lazy 0.04 / 2 h / 0.02 | 9 | 0 | 0.52 | 0 | 0.031 |
| | **lazy + tiers, 1.2 MON** (the day's budget already spent by the Oct 9 ladder) | **0** | **2** | **0** | **0.06** | 0.053 |

Per 24 h over all three ladders (57.9 h): settings live until now 88 re-quotes, about 7.3 MON/day all-in; lazy rules
alone 64, about 5.9; lazy + tiers at 1.0 / 1.2 / 1.5 MON: 14 / 16 / 19 re-quotes, about 2.6 / 2.8 / 3.0 MON/day all-in
(with a 4-strike roll of 1.26 and the kill switch 0.1). Most re-quotes on these days were urgent (the fair crossed a
resting price within a minute or two), so the rules alone cannot reach 2–2.5 MON/day; the budget does, with wider and
fewer quotes once 60 % of it is spent. Tuning: `requoteFairMove` 0.04 kept (0.05 saves 6 % more but lets the mid sit
0.053 from the fair; 0.03 saves little), `staleRefreshHours` 2 kept (4 h saves 5 %), quoting cap 1.2 (the stated
1.5 projects about 3.0 MON/day; 1.0 about 2.6). The cap is one number: `budget.dailyCapMon.maker` in
`config/worker.json` or `CONFIG_OVERRIDES`. Known effect: once a day's budget is spent, the next day's freshly rolled
ladder keeps only its opening quotes (on the roll meter) until Taipei midnight, and a strike that gets crossed is
pulled, not re-quoted.

**Verified** (2026-10-09). `npm test` 73 unit tests (lazy policy, tiers, the reserve meter, one-sided refills,
treasury gates and caps, RPC fallback / throttle / retry, the ntfy token), `npm run typecheck`, `packages/maker`
`npm test` 36 (core purity included), `packages/forecast` `npm test` 28. The anvil fork test runs the bundled Worker in
workerd with throwaway keys: at the hard quoting cap an urgent strike is pulled (sent, reserve meter), the treasury
tops up a maker at 1 MON to 4 MON with a 21,000-gas transfer from a throwaway treasury key, and every tick completes
with a rate-limited stand-in RPC (HTTP 429) first in `RPC_URLS` (`apps/maker-worker/evidence/fork-2026-10-09T17-28-38/`,
the run on the final, integrated working tree).
A read-only run of the same bundle against live testnet with the production `RPC_URLS`, watch-only and without keys
(`apps/maker-worker/evidence/live-readonly-2026-10-09T17-34-24/`): all three endpoints answered chain 10143, 0 errors,
0 txs; its decisions match the live maker's quotes; the treasury pass read the five role balances.

**Deploy** (the Worker is live). From `apps/maker-worker`, with `XDG_CONFIG_HOME` set as in 8.2:
```bash
npm ci && npm test && npm run typecheck             # 73 unit tests
npm run test:fork                                   # optional: anvil fork + Miniflare, throwaway keys
node scripts/put-secrets.mjs --dry --only TREASURY_KEY   # checks treasury.key: address 0x655d…BEed, not another role's key
npm run deploy -- --live                            # the output must show MAKER_MODE "live", RPC_URLS (3 URLs), the cron,
                                                    # no workers.dev URL; note the version id
node scripts/put-secrets.mjs --only TREASURY_KEY --live  # optional: enables the top-ups (piped on stdin)
node scripts/control.mjs status                     # "version.id" new; "mode" live; budget.tier; rpc.endpoints all "ok";
                                                    # treasury.key "ok" (or "no TREASURY_KEY secret")
node scripts/control.mjs ticks 5                    # live ticks; "sent:" only for urgent or 0.04 moves; "treasury:" lines
node scripts/control.mjs treasury                   # after <= 10 min: balances vs min/target, any top-up
```
Then fund the treasury from the deployer (section 4) and watch for `TOPUP <ROLE>` alerts.

**ntfy over a shared IP (owner, optional).** A free ntfy.sh account's token does **not** lift the per-IP limit: the
ntfy server keys a publisher by its account only when the account has a tier (a paid plan), and reserving a topic is
a paid feature too. With a paid plan:
1. Sign up at ntfy.sh, pick a paid plan, and reserve the topic on the account page of the ntfy web app (others may
   then not publish to it).
2. Create an access token on the same account page (or with `ntfy token add`). Store it without echoing it:
   `umask 077; pbpaste > ~/.config/isotherm/alert-webhook.token`
3. `node scripts/put-secrets.mjs --only ALERT_WEBHOOK_TOKEN --live` (sent as `Authorization: Bearer`; the URL stays
   `https://ntfy.sh/<topic>`). Alternatively ntfy's `?auth=` query parameter (base64 of `Bearer tk_...` without the
   trailing `=`) can be put into `alert-webhook.url`; the Worker keeps the URL as is.
4. `node scripts/control.mjs test-alert && node scripts/control.mjs result`; `status.push.auth` says which form is used.
Free alternative: a Telegram bot URL (section 8.8), which is not limited by the caller's IP. The settlement VPS kit's
own push (`docs/SETTLEMENT-VPS.md`) speaks ntfy only and posts from the VPS's own IP, so a free ntfy topic works there;
do not copy a Telegram `alert-webhook.url` to the VPS.

**Rollback.**
- Quoting only: `CONFIG_OVERRIDES = '{"policy":{"lazy":false},"budget":{"softRatio":null,"dailyCapMon":{"maker":2.2}}}'`
  in `[vars]`, then `npm run deploy -- --live` (the reserve meter stays: pulls are never refused).
- RPC: set `RPC_URLS` to one URL (or remove it and set `RPC_URL` to one URL). In this Worker `RPC_URLS` wins when
  both are set; the API Worker is the other way round (`RPC_URL` wins there, section 5), and its throttle is
  `RPC_MAX_RPS`, not `RPC_RPS`.
- Treasury: `npx wrangler secret delete TREASURY_KEY --name isotherm-maker` (balance checks and LOW alerts remain).
- Everything: redeploy the previous version (`npx wrangler rollback` or `git checkout` the previous `apps/maker-worker`
  and `packages/*`, then `npm run deploy -- --live`). Old states load in both directions (new meter keys are ignored).
