# apps/web + apps/api: RESULT (2026-10-07, Taipei afternoon)

> **Superseded in part by the 2026-10-07 fix round** ([web/FIXES.md](web/FIXES.md), [api/FIXES.md](api/FIXES.md)). Buy No no longer calls `Zap.buyNo`: it is `vault.mintSet` + `Zap.sellYes(minAusdOut)`. The API's relay modes, minimums and caps changed (live values in `/api/health`). Since this was written, the relayer has been funded and the RCSS 2026-10-08 ladder has gone live. The rest of this file is the original record; lines that no longer hold are marked.

**Verdict: both are built, tested, and deployed.** The phone app is live at **https://isotherm.pages.dev** and the API
at **<former API host>** (Cloudflare). Both point at the **live v1
deployment** in `deployments/testnet.json`: vault `0xae36…7B39`, resolver `0x9c78…962B`, zap `0x1ACa…CFb0`.

I tested the whole user path in the in-app browser at 375 px, against an **anvil fork** of the live testnet with the
real v1 contracts:
- sign in with the dev wallet;
- get test funds;
- buy Yes and buy No through the Zap (Superseded 2026-10-07: Buy No = vault.mintSet + Zap.sellYes(minAusdOut); see apps/web/FIXES.md);
- mint a gasless pair through the relayer;
- CRE-shaped settlement, with the attestation verified in the browser;
- challenge window, then redeem.

Nothing was broadcast to the live chain. The live site and API answer read-only requests.

Two limits on the live service today (both resolved since; see the note at the top):
- **The drip and relay cannot pay yet.** The new relayer key `0xb0b9F5E93C4D4Bb448eC96191393bf35C9E8429f` holds 0 MON, and the API answers with a clean 503.
- **There is no live ladder yet.** On-chain `ladderCount` = 0, so the live Markets screen shows "No open markets".

## What works (evidence)

### API (`apps/api`, Worker + SQLite Durable Object + KV, cron every minute)

`npm run test:all` gives **26/26 passed**. Full log: `api/evidence/vitest-unit-and-fork.txt`.
- **20 unit tests:**
  - CORS patterns;
  - bearer compare;
  - drip, IP and daily limits;
  - struct decoders that accept both the feasibility and the v1 layouts;
  - the deployments normaliser on the real v1 file;
  - snapshot normalising against `packages/maker/examples/snapshot.example.json`;
  - log aggregation that keeps maker and team wallets out of the public counts;
  - Zap market discovery;
  - the v1 `mintSetWithAuthorization` selector and nonce, checked against `packages/abi`.
- **6 fork tests.** These spawn anvil on :19200 (a fork of the live testnet) and `wrangler dev` (real Miniflare Durable Object + KV) on :8782, using throwaway keys only:
  1. Health check, and v1 relay modes detected from the vault's bytecode. CORS echoes `https://isotherm.pages.dev` and refuses `evil.example`.
  2. Admin routes return 401 without the token. The cron tick refills the AUSD float from the real faucet.
  3. The drip sends exactly 0.15 MON and 1,000 AUSD (from the float).
     - The same address again gets 429.
     - The vault address gets 400 (contract).
     - The 4th address from one IP gets 429.
  4. Snapshot auth: wrong or missing token gives 401, a bad body gives 400.
  5. **Gasless EIP-3009 mint.** The user holds **0 MON** and gets 5 YES + 5 NO; the user's MON stays 0.
     - A tampered amount gives 400 (signature).
     - A replay gives 400 ("already used").
     - The permit path also mints.
     - An amount over the cap gives 400.
  6. **Fill and settlement counting.** An outside wallet buys YES through the Zap on a book that was **never announced in a snapshot**. The scanner finds it from the Zap's `CanonicalMarketSet` event and counts the fill. A v1-attested report through the real MockKeystoneForwarder settles the ladder.
     - `/api/stats` shows `nonMakerFills ≥ 1` and `settledCityDays ≥ 1`.
     - `/api/settlements` returns the report tx and `finalAt`.
     - Maker-reported stats are stored separately and need the token.

**Live checks** (read-only, or refusals that send nothing):
- `GET /api/health` reports `relayer 0xb0b9…429f`, `relayModes ["authorization","permit"]`, `deployments "deployments/testnet.json"`, `dripReady false`. (Superseded 2026-10-07: `relayModes` is now `["authorization"]` only; see apps/api/FIXES.md.)
- The scanner caught up from the deploy block 68,884,377 to the head; `lagBlocks 0`, cron running.
- `POST /api/drip` behaves as follows:
  - a contract address is refused;
  - a precompile is refused;
  - a fresh EOA gets "The faucet relayer is out of test MON right now" (503).

  The last case was checked from the live page; screenshot `web/evidence/14-…`.

### Web (`apps/web`, Vite 5 + React 18 + viem, PWA)

- **Build and unit tests.** `npm run build` passes (`tsc -b` + vite).
  - The main entry is 540 kB, 175 kB gzip.
  - The Dynamic SDK (1.13 MB gzip) is a separate chunk, loaded only when `VITE_DYNAMIC_ENVIRONMENT_ID` is set.
  - `npm test` gives **8/8**: book maths matching the fork fills, `getL2Book` decoding, decoders, and capability detection.
- **Fork end-to-end run** in the in-app browser at 375×812 (the app labels it "Local anvil fork — not the live chain").
  - Ladder: `scripts/fork-fixture.ts` opened RCSS 2026-10-08 with ≥27…≥32 on the real v1 vault, using impersonation only. It created 6 Kuru books with canonical markets set, and the maker quoted.
  - Transactions are in `web/evidence/fork-e2e-dev-wallet-txs.json`; all succeeded.

  | Step | Result | Gas used (fork) |
  |---|---|---|
  | Drip | 0.1 MON + 1,000 AUSD in **1.7 s** (DRIP_MON was 0.1 then; it is 0.15 now) | 21,000 + 72,049 (relayer) |
  | Approve AUSD → Zap (once) | ok | 70,249 |
  | **Buy Yes ≥29 °C, 10 AUSD** | **15.61 Yes** at 0.64, as quoted (15.625 × 0.999), in 0.6 s | 466,263 |
  | **Buy No ≥29 °C, 10 AUSD net** | **24.96 No**: minted 24.96 sets and sold Yes at 0.60, so 14.96 AUSD came back, in 0.4 s. *Superseded 2026-10-07: Buy No = vault.mintSet + Zap.sellYes(minAusdOut); see apps/web/FIXES.md.* | 630,693 (`Zap.buyNo`) |
  | **Gasless pair ×10** | signed `ReceiveWithAuthorization`; the local API relayer submitted `mintSetWithAuthorization` | 224,470 (relayer pays) |
  | CRE report | `ReportProcessed.result=true`, Tmax 30, `finalAt = resolvedAt + 900 s` | — |
  | **Redeem** | **25.61 AUSD** (Yes won, 30 ≥ 29; No pays 0). AUSD went 970 → 995.61 | 182,237 |

  - The Results screen fetched the report tx and stripped the 109-byte CRE header. It recovered the EIP-712 signer (v1 type with `validUntil`): **"matches the Resolver's attester"**.
  - Portfolio showed "Result in challenge window until …" with Redeem disabled. After a warp past `finalAt`, redeem went through.
  - The stats strip read "1 trading wallet · 2 fills · 1 settled city-day" from the local API's own log scan.
  - Screenshots are in `web/evidence/01…14` (dark and light, EN and 繁中).
- **Production build against live testnet** (vite preview, then Pages). It renders with no console errors and an empty state. The stats strip reads the live API: 0 / 0 / 0.

### Screens and rules implemented
- **(a) Ladder.** Per strike:
  - **Yes price = best ask** and **No price = 1 − best bid**, read live through one Multicall3 call every 5 s;
  - Fair (the maker's quote centre), Polymarket-implied, and Model (guardrail, dimmed; ⚑ when it differs from Polymarket by more than 15 pts);
  - "already reached" from the observed max or the maker's `mode: certain`;
  - time to close.

  Tapping a strike opens a sheet with Buy Yes / Buy No / Gasless pair:
  - a quote from walking the live book, including Kuru's 0.1% fee;
  - min-out at 0.5, 1, 2 or 5% slippage, never 0 (the v1 Zap rejects 0);
  - for No, "spend X" is solved to the set size, capped at the balance (Superseded 2026-10-07: Buy No = vault.mintSet + Zap.sellYes(minAusdOut); see apps/web/FIXES.md);
  - "Pays N AUSD if the max at RCSS is ≥ k°C";
  - max loss, and top-3 book depth.

  Markets come only from `zap.canonicalMarket(seriesId)` on v1. On the feasibility deployment the app falls back to snapshot or deployments markets, verified with `Router.verifiedMarket`.
- **(b) Portfolio.**
  - Balances and the "Get test funds" button.
  - Positions per series, with mark-to-market value.
  - States: Open, Awaiting result, Challenge window, Yes won / No won / Void (0.5 each).
  - Actions: Redeem (enabled only when `now ≥ finalAt`), Sell Yes (Zap), and Merge pairs (`redeemSet`).
  - A session activity log with explorer links.
- **(c) Results.** Resolved and awaiting ladders, with per-strike ✓/✗/½, the report tx link, and attestation details:
  - which forwarder delivered it (MockKeystoneForwarder or KeystoneForwarder);
  - the workflow header, the signer, and the sources hash;
  - a stale void is recognised.
- **(d) How it works / honest risk.** Covers:
  - RCSS and the integer °C rule, including SPECI and :30 reports;
  - 183/184 RCSS and 209/209 RJTT;
  - the CRE path and why the attestation is needed;
  - the challenge window, read from the chain (900 s);
  - void rules, max loss = premium, and that the maker is the house;
  - fair value is Polymarket-implied, and the model is a guardrail only (no edge claim);
  - testnet faucet AUSD only, unaudited contracts, and contract links.
- **(e) Stats strip.** Non-maker wallets, fills, and settled city-days, with "Testnet · faucet AUSD · maker fills excluded".
- **Login.**
  - Dynamic is lazy-loaded when `VITE_DYNAMIC_ENVIRONMENT_ID` is set. Monad networks are injected; the email/Google widget comes from Dynamic.
  - Otherwise the app offers a **"Dev wallet (testnet burner, stored in this browser)"** with a warning, Show key (behind a confirm) and Forget.
- **Other behaviour.**
  - English with a 繁中 toggle; dark/light themes.
  - The header fits 375 px (tested); a CSS rule hides the wordmark under 350 px for 320 px phones (not tested).
  - Chain-clock aware, so anvil time travel works.
  - Every write estimates gas and sends limit = estimate × 1.10, because Monad bills the limit.
  - The service worker caches only the shell.
  - A fork-produced snapshot is ignored by a live build, and vice versa.

## Interfaces for the other workstreams
- **Maker → API.**
  - Request: `POST <former API host>/api/snapshot` with `Authorization: Bearer $(cat ~/.config/isotherm/api-snapshot.token)`. In maker config, set `api.url` = the Worker URL and `ISOTHERM_SNAPSHOT_TOKEN` = that file.
  - Format: the maker's `isotherm.snapshot/v1` is accepted as is. Both `strikes[{strike,pmImplied|pm,model|guard,fair,market,marketBlock,mode,flags}]` and the older `series[]` work; ladder-level `observedMaxC`/`observed.tmaxC`, `polymarket.url`, `forecast.mu`/`v0.mu` are read too.
  - Payloads up to 512 kB. Only the normalised fields are stored (`budget` and `events` are dropped).
- **Stats definitions.**
  - `nonMakerWallets` counts distinct `tx.origin` addresses that filled on an Isotherm book. It excludes `MAKER_ADDRESSES` (`0xd572…448a`), `TEAM_ADDRESSES` (deployer, taker1, taker2, relayer) and the v1 roles.
  - `settledCityDays` counts Settled results on real stations only; test stations and voids are excluded.
  - Books are discovered from `CanonicalMarketSet` on the Zap, plus snapshot markets.
- **Relay API (for the mm plugin or others).**
  - `POST /api/relay/mint` with `mode:"authorization"`: the nonce is the vault's `mintAuthorizationNonce(seriesId, amount, salt)` and the AUSD domain is "Agora Dollar" v1.
  - Caps: 500 AUSD per mint, 10 per address per day, 60 per day in total. (Superseded 2026-10-07: 1–500 AUSD per mint, authorization mode only, daily caps sized to the relayer's balance; see apps/api/FIXES.md and `/api/health` `limits`.)

## Not done / not verified (honest)
- **Dynamic login is not tested.** There is no environment ID, so the code path builds and is wired but was never run against Dynamic. The dev wallet covers judges in the meantime.
- **No live-chain trade, redeem, drip or relay has been run.** The rule is reads only; the relayer is unfunded and there is no live ladder. Every write flow has been run only on forks. (Superseded 2026-10-07: the go-live smoke test bought YES through the Zap on the live RCSS 2026-10-08 ladder, and the funded relayer had made 3 live drips; as of 08:00 UTC no live relay or redeem had run. See `docs/evidence/golive/` and `/api/health`.)
- **Monad's reserve-balance rule is untested.** The relayer waits 4 blocks after its last transaction before a MON transfer when it holds under 10 MON + the drip. Anvil does not enforce the rule, so this is unverified.
- **The relayer signs with a key held as a Worker secret.** It is not a Dynamic server wallet, because Dynamic's native addon cannot run in Workers; this is stated in the spike.
- **Some features are not built:**
  - Sell No (a Zap limitation); the UI offers hold-to-settlement or Merge instead.
  - Delegated auto-roll.
  - Calibration and fan charts.
- **Live latency on public RPC is not measured.** The fork figures (0.4–1.7 s per action) are local.
- **Hosting choice.** The API uses a SQLite-backed Durable Object; this account no longer allows KV-backed ones. KV holds the public snapshot, stats and settlements.

## Human actions
1. **Fund the relayer** `0xb0b9F5E93C4D4Bb448eC96191393bf35C9E8429f` with testnet MON.
   - Minimum: ≥ 3 MON. With ≥ 12 MON, MON drips skip the "emptying transaction" wait.
   - Within about 1 minute the cron then claims a 10k AUSD float from the faucet; this needs ≥ 0.3 MON.
   - Worst-case spend at the caps of that time (superseded 2026-10-07: the caps are now sized from the live balance by `apps/api/scripts/size-caps.mjs`; see apps/api/FIXES.md):
     - drips: about 40 × 0.15 = 6 MON/day;
     - relays: about 60 × 0.03 = 1.8 MON/day.
   - Lower `DRIP_DAILY_CAP`, `DRIP_MON` or `RELAY_DAILY_CAP` in `apps/api/wrangler.toml` and redeploy if MON is short.
2. **Point the maker at the API.** Set `ISOTHERM_SNAPSHOT_TOKEN` from `~/.config/isotherm/api-snapshot.token` and `api.url` = <former API host>.
3. **Dynamic.**
   - Put the Sandbox environment ID in `apps/web/.env.local` as `VITE_DYNAMIC_ENVIRONMENT_ID=…`, then run `npm run build` and the `wrangler@3 pages deploy` command in `apps/web/README.md`.
   - In the Dynamic dashboard, add `https://isotherm.pages.dev` (and `https://*.isotherm.pages.dev`) to the CORS origins and enable Monad Testnet 10143.
4. On a real phone, open https://isotherm.pages.dev and try "Add to Home Screen". The embedded test browser cannot install service workers.
5. **Keep these files private.** Token files in `~/.config/isotherm/` (chmod 600):
   - `relayer.key`
   - `api-snapshot.token`
   - `api-admin.token`

   The admin token drives `POST /api/admin/tick|rescan`.

## Files
- `api/src/`:
  - `index.ts` (routes, CORS, cron);
  - `relayer-do.ts` (Durable Object);
  - `relayer.ts` (drip, relay, float refill, reserve-balance wait);
  - `limits.ts`, `scan.ts` (log scan + stats), `snapshot.ts`, `abi.ts`, `deployments.ts`, `env.ts`, `chain.ts`, `util.ts`.
- `api/test/`: `unit/api-units.test.ts` and `integration/api.fork.test.ts`.
- `web/src/`:
  - `App.tsx`, `state.tsx`, `i18n.ts`, `styles.css`;
  - `components/*`;
  - `lib/` (`data.ts`, `book.ts`, `actions.ts`, `settlement.ts`, `chain.ts`, `abi.ts`, `api.ts`);
  - `wallet/` (`wallet.tsx`, `dynamic.tsx`).
- `web/scripts/`:
  - `fork-fixture.ts` and `fork-settle.ts` (anvil only; they refuse non-local RPCs);
  - `copy-deployments.mjs` (also in `api/`).
- Evidence:
  - `web/evidence/*.jpg`, `web/evidence/fork-e2e-dev-wallet-txs.json`;
  - `api/evidence/vitest-unit-and-fork.txt`.
