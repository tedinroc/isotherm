# Isotherm — live operations (Monad testnet 10143)

Written 2026-10-07 14:15 Taipei (06:15 UTC), at go-live; balances and versions below are from then. Revised the same day after the v1 security review (attester gas, guardian runbook, owner key, API caps, settlement status). Balances and caps re-read at 2026-10-07 07:55 UTC (15:55 Taipei) are marked with that time. Revised again at 08:40 UTC (16:40 Taipei) for the CRE login, the re-sized API caps and the Dynamic build, and at 13:30 UTC (21:30 Taipei) for the Dynamic go-live (web app row and section 5), and at 16:30 UTC (00:30 Taipei, Oct 8) for the same-origin API at `https://isotherm.pages.dev/api/*` (sections 1, 2 and 5). Everything here is **testnet only**. AUSD is free
faucet test money. Nothing here touches Monad mainnet.

## 1. What is live

| Thing | Where |
|---|---|
| Phone web app (PWA) | https://isotherm.pages.dev (Cloudflare Pages project `isotherm`). Dynamic is enabled since Pages deployment `<retired-deployment>` (2026-10-07 13:21 UTC). The deployed build (Pages deployment `6b18d972`, about 16:24 UTC, main chunk `assets/index-Cd8KBz0E.js`, same app plus the same-origin API) makes "Sign in with email" through Dynamic the default, keeps the labelled dev (burner) wallet as fallback, and shows the Open-Meteo CC BY credit. The first embedded-wallet login, relayed mint and Buy Yes (a team test wallet) are in section 5. |
| API: drip, gasless-mint relayer, stats, snapshot | https://isotherm.pages.dev/api/* (Pages Function `apps/web/functions/api/[[path]].ts` → service binding `API` → Worker `isotherm-api`; the Worker has no public hostname of its own since 2026-10-07 16:05 UTC). Worker version `60f3a919` deployed 16:24 UTC; its source equals `0c112836` (13:27 UTC, stats classification), and the re-sized caps are live since `ea73ccfa` (08:02 UTC); the go-live version was `ed0ab137` |
| Contracts (v1, Sourcify exact_match) | Resolver `0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B`, Vault/factory `0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39`, Zap `0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0`. Source of truth: `deployments/testnet.json` |
| Market maker | launchd jobs on this Mac, running from the **runtime copy** `~/isotherm-live` (see section 3) |

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
| `xyz.isotherm.cre-settle` (CRE workstream) | `scripts/settle-job.sh` from `~/isotherm-live/packages/cre-workflow`: settles due ladders. Official CRE path if `cre whoami` succeeds (the case since the team's `cre login` on 2026-10-07), otherwise the labelled SDK-harness fallback; writes an evidence record per run naming the path. See section 6. | Hourly at :05 |
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

**Wrong result: challenge first, then pause.** `pause()` neither stops nor extends the 900 s challenge clock, and the vault does not follow the Resolver's pause, so a guardian who pauses instead of challenging lets a false *Settled* result pay out in full (`test/security/v1/RESULT.md`, N6). A reported *Void* is final at once and cannot be challenged (N2). `xyz.isotherm.challenge-watch` now watches the window every 120 s, but it runs on this Mac next to the attester key, so it catches a wrong report, not a compromise of this Mac; a watcher on a separate machine holding only the guardian key is still to do.

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
- **Smoke-test wallet.** The go-live smoke test used dev wallet `0xd42A0b394F09df88BB2120D0973569b845f2D79c`, stored in the in-app browser. It is listed in `TEAM_ADDRESSES`, so the public "trading wallets" counter does not count our own test. `/api/stats` classifies its fill as `team`. The team's Dynamic embedded wallet `0xF4a3377D1200584D8Ab7d7e64c6B17dc6c792427` is in `TEAM_ADDRESSES` too; at 13:28 UTC `/api/stats` classified its Buy Yes as `team`, with `nonMakerWallets 0`.

## 6. Settlement (not run by the maker)

The Oct 8 ladder is settled by the CRE workflow in `packages/cre-workflow`, through the MockKeystoneForwarder plus the attester signature. The CRE workstream installed the jobs on 2026-10-07 (`packages/cre-workflow/README.md`, `RESULT.md`).
- **When:** `xyz.isotherm.cre-settle` runs hourly at :05; nothing is attempted before day end + 2 h, so the first real attempt for the Oct 8 ladder is **2026-10-08 18:05 UTC (02:05 Taipei, Oct 9)**. Disagreeing or incomplete sources stay pending and are retried hourly; a void comes only after 36 h (46 h backstop).
- **Which path:** the official path (`cre workflow simulate --broadcast`) needs `cre login`.
  - **Login.** It was run on 2026-10-07; the session file `~/.cre/cre.yaml` was written at about 07:59 UTC.
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
