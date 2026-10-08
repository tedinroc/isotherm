# Isotherm — live operations (Monad testnet 10143)

Written 2026-10-07 14:15 Taipei (06:15 UTC), at go-live; balances and versions below are from then. Revised the same day after the v1 security review (attester gas, guardian runbook, owner key, API caps, settlement status). Balances and caps re-read at 2026-10-07 07:55 UTC (15:55 Taipei) are marked with that time. Revised again at 08:40 UTC (16:40 Taipei) for the CRE login, the re-sized API caps and the Dynamic build, and at 13:30 UTC (21:30 Taipei) for the Dynamic go-live (web app row and section 5), and at 16:30 UTC (00:30 Taipei, Oct 8) for the same-origin API at `https://isotherm.pages.dev/api/*` (sections 1, 2 and 5). Section 8 (the Cloudflare maker and its cutover runbook) was added on 2026-10-08 at 16:30 UTC and revised the same night after a tick-by-tick comparison of the shadow with the Mac maker (8.6), with a precise cutover runbook (8.3). Everything here is **testnet only**. AUSD is free
faucet test money. Nothing here touches Monad mainnet.

## 1. What is live

| Thing | Where |
|---|---|
| Phone web app (PWA) | https://isotherm.pages.dev (Cloudflare Pages project `isotherm`). Dynamic is enabled since Pages deployment `<retired-deployment>` (2026-10-07 13:21 UTC). The deployed build (Pages deployment `6b18d972`, about 16:24 UTC, main chunk `assets/index-Cd8KBz0E.js`, same app plus the same-origin API) makes "Sign in with email" through Dynamic the default, keeps the labelled dev (burner) wallet as fallback, and shows the Open-Meteo CC BY credit. The first embedded-wallet login, relayed mint and Buy Yes (a team test wallet) are in section 5. |
| API: drip, gasless-mint relayer, stats, snapshot | https://isotherm.pages.dev/api/* (Pages Function `apps/web/functions/api/[[path]].ts` → service binding `API` → Worker `isotherm-api`; the Worker has no public hostname of its own since 2026-10-07 16:05 UTC). Worker version `60f3a919` deployed 16:24 UTC; its source equals `0c112836` (13:27 UTC, stats classification), and the re-sized caps are live since `ea73ccfa` (08:02 UTC); the go-live version was `ed0ab137` |
| Contracts (v1, Sourcify exact_match) | Resolver `0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B`, Vault/factory `0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39`, Zap `0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0`. Source of truth: `deployments/testnet.json` |
| Market maker | **Live:** launchd jobs on this Mac, running from the **runtime copy** `~/isotherm-live` (see section 3). **Shadow:** the Cloudflare Worker `isotherm-maker` (`apps/maker-worker`), live since 2026-10-08 16:25 UTC in SHADOW mode: it computes every decision and sends nothing. Its decisions matched the Mac's tick by tick (section 8.6). The cutover runbook is section 8. |

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

A Taipei ladder day costs about:

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
  - Knobs are in `apps/api/wrangler.toml [vars]`: `DRIP_MON`, `DRIP_DAILY_CAP`, `DRIP_ENABLED="0"` to pause drips, `RELAY_DAILY_CAP`, `RELAY_PER_IP_PER_DAY`, `RELAY_PER_ADDRESS_PER_DAY`, `RELAY_MIN_AUSD`, `RELAY_ALLOW_PERMIT`, `RELAYER_MIN_MON`, `AUSD_FLOAT_TARGET`, `TEAM_ADDRESSES`.
  - **Size the caps to the relayer's MON** (v1 review N5): anyone can otherwise use up the day's drips and relays. `node apps/api/scripts/size-caps.mjs` computes the caps from the live balance, spread over several worst-case days (`--days N`, default 7) so one day can never spend the whole balance. The first values were sized from 0.599 MON (2 drips and 5 relayed mints per day). At 07:59 UTC on 2026-10-07 they were re-sized from 4.599 MON over 7 days (`apps/api/evidence/size-caps-2026-10-07-r2.txt`), and the Worker was redeployed at 08:02 UTC. `/api/health` `limits` at 08:40 UTC shows those values live:
    - drips: 2 per UTC day, 1 per network, 24 h per address;
    - relays: 9 per UTC day, 4 per network, 4 per address, 1–500 AUSD each;
    - reserve: 0.1 MON.

    At maximum use that covers UTC days Oct 7–13, so **top up and re-size before 2026-10-14**. Re-run it and redeploy after every top-up, with `--days` covering the time until the next top-up (judging runs Oct 14–27). Permit-mode relays stay off for the v1 vault (`RELAY_ALLOW_PERMIT = "0"`, N10).
  - After a deploy, check `/api/health`: `relayModes` should be `["authorization"]`, and `monBalance` should cover the caps.
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
- **Cost:** each report transaction bills about 0.0204 MON to the attester key (0.40 MON at 2026-10-07 07:55 UTC, about 19 reports).
- **After it lands:** confirm `LadderResolved` or `Resolver.resultOf(0x52435353, 20261008)`, never the transaction status alone. `xyz.isotherm.challenge-watch` recomputes the result and challenges a reproduced mismatch within the 900 s window; a human check is still worth it (challenge first, then pause; section 3).
- **Fallback:** if nothing settles, anyone can call `voidIfStale` after 2026-10-11 00:00 Taipei, which pays 0.5/0.5.

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

### 8.1 Who does what

| Job | Now | After the cutover |
|---|---|---|
| quoting loop, kill switch (`xyz.isotherm.maker`, `xyz.isotherm.watchdog`) | Mac (live); Worker in shadow | Worker (kill switch at stop − 90 s, plus a verify pass every 5 min like `watchdog --verify`) |
| daily roll (`xyz.isotherm.roll`) | Mac (live; the hourly job acts at the first run after 12:00, about 12:45 Taipei); Worker in shadow | Worker (from 12:00 station time; retries every 5 min until the ladder is active) |
| challenge watcher (`xyz.isotherm.challenge-watch`) | Mac (live); Worker recomputes and alerts | Worker (guardian key) |
| CRE settlement (`xyz.isotherm.cre-settle`) | Mac | **stays on the Mac** (the official CRE CLI cannot run in a Worker; the attester key is not in Cloudflare) |

**Live needs two switches, and both are off now:**
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

**Budgets** (`apps/maker-worker/config/worker.json`):
- Quoting: maker 2.2 MON/day, plus the 0.2 reserve for pulls.
- Roll, separately: maker 0.8, operator 0.5, market creator 0.8.

A spent quoting day therefore cannot block the next roll (the Oct 8 incident). The opening quotes of a new ladder
count as roll. The funding routine of section 4 is unchanged (same keys). Measured on Oct 8: the Mac's maker spent
1.94 MON on quotes and pulls (excluding the opening quotes) and 0.51 on the roll with its opening quotes, so the
quoting cap was 88 % used. Raise `dailyCapMon.maker` if quoting days get busier.

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
| Rotate a secret | `node scripts/put-secrets.mjs --only MAKER_KEY` |
| Reset the shadow's own state and summary | `node scripts/control.mjs reset-shadow` |
| Tests | `npm test` (29 unit), `npm run test:fork` (anvil fork + the bundled Worker in Miniflare, live on the fork), `MW_REHEARSAL=1 npx vitest run test/integration/cutover-rehearsal.fork.test.ts` (this runbook on a fork with the Mac's real state), `MW_LIVE_SMOKE=1 npx vitest run test/integration/live-readonly.smoke.test.ts` (read-only, no keys) |

**Known limits.**
- **Settlement still depends on the Mac.** If the Mac sleeps, ladders still resolve by `voidIfStale` after 48 h
  (0.5/0.5), but not by the CRE settlement.
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
- **MON runway.** The maker held 4.10 MON at 17:19 UTC and spent 2.45 on Oct 8 (all three keys: 3.4 MON/day);
  the testnet faucet needs a person in a browser, so fund before judging starts.
