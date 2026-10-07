# Dynamic round: RESULT (2026-10-07)

> **Update, 2026-10-07 13:30 UTC: the proof has now run, on the live site.** A team member signed in with Dynamic email login on https://isotherm.pages.dev, and the resulting embedded wallet made a relayed (gasless) mint and a Zap Buy Yes on Monad testnet. It is a team test wallet, so this is a team test, not traction. See [§5](#5-live-proof-on-2026-10-07). Sections 1–4 and the runbook are the original record from before the login.

**Status (original, 08:40 UTC): partly done. The code is ready, but the Dynamic proof has not run.**

- **Done.** The two code fixes; Dynamic is wired into every build and is the default sign-in; Dynamic loads and its login renders on localhost (dev build and production build).
- **Not done.**
  - The embedded-wallet proof: Dynamic email login, the relayed mint, Buy Yes, and Portfolio.
  - The Pages deploy, which was conditional on that proof.
- **Live state.** https://isotherm.pages.dev still serves the previous deployment. No testnet MON or AUSD was spent. The one live relay was not used.

**Why the proof stopped at the login.** Logging in to the embedded wallet means signing in to Dynamic's identity provider (app.dynamicauth.com) and creating a user in the Sandbox environment. The agent's operating rules do not let it create accounts or sign in to an external identity provider, and Sandbox test accounts on localhost are no exception. So a person has to do that one step. Everything after the login is ready: see "Runbook" below.

## 1. Code fixes (tests + tsc green)

**(a) Portfolio "Sell Yes"** used to sell at today's quote with no floor. Now:
- The button shows the price, e.g. "Sell Yes · ≈ 4.60 AUSD at 0.82".
- Tapping it opens a confirmation with the average price, the expected proceeds and the exact minimum that will be sent. The plan is frozen when the confirmation opens, and nothing is sent until "Sell for ≥ M AUSD" is tapped.
- When the Yes is the unsold leg of a Buy No whose step 2 failed, the sale is the same retry the trade sheet offers. It keeps the original plan's per-unit minimum (`planRetrySell`), and it is blocked, with the trade sheet's warning, when today's bids cannot pay that floor.
- The trade sheet records that plan per wallet and strike in `src/lib/stranded.ts`, so the floor survives closing the sheet:
  - The record lives in browser storage, or in memory if storage is blocked.
  - A second stranding keeps the stricter plan.
  - A merge or a completed sale clears the record.
- Code: `src/lib/buyNoPlan.ts` (`planPortfolioSell`), `src/lib/stranded.ts`, `src/components/Portfolio.tsx`, `src/components/TradeSheet.tsx`.

**(b) Fair-value source.**
- `SnapshotStrike` now has `fairSource` and `guardSource`, typed after `packages/forecast/src/fair.ts`.
- `StrikeView` carries both fields.
- Every strike whose fair value is not Polymarket-sourced gets a small label next to "Fair" (`src/lib/fairSource.ts`):

  | Source | Label |
  |---|---|
  | `certain` | observed max |
  | `fallback-v0` | our model |
  | `fallback-intraday` | intraday model |
  | missing or unknown | source not stated |

- The legend says so too, in en and 繁中.

**Evidence**
- `npm test`: **35/35**. 15 are new in `test/portfolio-sell-and-fair.test.ts`:
  - the source labels;
  - plain-quote sizing and its minimum;
  - no bids → blocked;
  - the N1 sandwich: the plain quote would have sold at >0.99 per No, and the retry floor blocks it;
  - an unchanged book;
  - the retry cap at the stranded pairs;
  - the stranded store, with and without storage, with a throwing storage, and its stricter-plan merge.
- `tsc -b`: exit 0.
- **Fork run in the in-app browser at 375 px.** It used anvil `127.0.0.1:19701`, forked from Monad testnet block 68923694, with the red "Local anvil fork" banner and a dev burner wallet funded on the fork only:
  - Buy Yes 5 AUSD on ≥29 °C: tx `0xc41ba102…afad`.
  - Portfolio showed "Sell Yes · ≈ 4.60 AUSD at 0.82" (`04`).
  - The confirmation said "minimum of 4.51 AUSD (2% below this quote)" (`05`).
  - After confirming, the `sellYes` calldata decodes to `yesIn 5612359, minAusdOut 4505581`, which is the confirmed minimum. Sold 5.61 Yes for 4.60 AUSD (`06`, `fork-portfolio-sell.json`).
- **Fair label at 375 px** (`03`). The live snapshot is Polymarket-sourced on every strike right now, so no label shows on the real page; that is correct. For this screenshot only, the page's `fetch` was patched in the browser to mark ≥30 as `fallback-v0` and to drop the field on ≥31. The labels "our model" and "source not stated" rendered.

## 2. Environment ID in the build

- **`apps/web/.env.production`** (committable): `VITE_DYNAMIC_ENVIRONMENT_ID=3eaae4f7-b9bb-4a0a-a578-00ff7008a460`.
  - The ID is public: it is served by Dynamic's public settings endpoint and shipped in every page that uses Dynamic.
  - The repo root ignores `.env.*`, so `apps/web/.gitignore` re-includes this one file: `git check-ignore` reports it as negated.
  - `.env.local` stays ignored.
- **`apps/web/.env.local`** (gitignored) was generated from `~/.config/isotherm/dynamic.env`. It is for `npm run dev`, which does not read `.env.production`. Note that dynamic.env names the key `DYNAMIC_ENVIRONMENT_ID`, without the `VITE_` prefix.
- **A dev-wallet-only build:** `VITE_DYNAMIC_ENVIRONMENT_ID= npm run build`, because a shell variable beats the file.
- **Sign-in sheet.**
  - With the ID, **"Sign in with email"** is the primary button, with "Dynamic creates a wallet for your email (Dynamic Sandbox, Monad testnet). Test funds only."
  - "No account: use a dev wallet" plus the labelled burner note are the fallback.
  - The old "email or Google" wording is gone: the dashboard enables email only.
  - Without the ID, the sheet still offers only the dev wallet and says Dynamic is not configured in this build.

**Production build:**
- Main chunk `assets/index-CIjHIjYB.js` (sha256 prefix `424b1bae4507ef52`), 557.95 kB, 181.79 kB gzip.
- The Dynamic SDK is code-split: `assets/dynamic-E9UWATBD.js`, 1,127 kB gzip.
- The main chunk contains the environment ID once, the live API and RPC, no `127.0.0.1`/`localhost`, and no `function buyNo`.
- This bundle was **not deployed**.

## 3. Localhost check, without logging in

**Dev build on `127.0.0.1:5201`:**
- The SDK loaded with the real ID. It fetched `…/sdk/3eaae4f7…/settings`, `sdkSettings` and `nonce`, with no console errors.
- `01`: the sign-in sheet, with Dynamic as the default.
- `02`: Dynamic's modal, showing "Sandbox · Log in or sign up · Enter your email · Continue". It also lists MetaMask, Coinbase and WalletConnect.
- Nothing was typed into the modal.

**Production build (`vite preview` on `127.0.0.1:5202`):**
- The same sheet and modal (`07`).
- The `dynamic-*.js` chunk loaded and called the settings endpoint.

## 4. Dynamic dashboard: what the public settings say

At 08:20Z, and again at **08:37Z**, `https://app.dynamicauth.com/api/v0/sdk/3eaae4f7-b9bb-4a0a-a578-00ff7008a460/settings` (copy: `public-sdk-settings.json`) shows:

| Setting | Value |
|---|---|
| `environmentName` | `sandbox` |
| EVM networks | **only `1 Ethereum Mainnet`** |
| Login providers | `emailOnly` |
| Embedded wallets | automatic creation on, EVM primary, `defaultWalletVersion V3` |
| Smart wallets | off |

The SDK running in the browser received the same network list; it is stored in localStorage as `projectSettings`. **So Monad is not enabled in this Sandbox environment.** The likely cause is that it was enabled in the Live environment, or the change was not saved.

The app adds 10143 and 143 itself through `overrides.evmNetworks` with `mergeNetworks`. Per Dynamic's React docs, that override can enable "any EVM network that we do not currently support out of the box". Dynamic's server-wallet docs say MPC signing "does not require the network to be enabled in your Dynamic developer console". Neither statement has been verified for a React embedded wallet on 10143; that is exactly what the login proof would show.

**What to change.** In app.dynamic.xyz:
1. Switch to the **Sandbox** environment whose ID is `3eaae4f7-b9bb-4a0a-a578-00ff7008a460` (Developers → SDK & API Keys shows it).
2. Open **Chains & Networks → EVM**, enable **Monad Testnet (10143)**, and **Save**.
3. Check that it took effect:

   ```sh
   curl -s https://app.dynamicauth.com/api/v0/sdk/3eaae4f7-b9bb-4a0a-a578-00ff7008a460/settings | python3 -c 'import json,sys;d=json.load(sys.stdin);print([(n["chainId"],n["name"]) for g in d["networks"] for n in g["networks"]])'
   ```

   The output must include `('10143', 'Monad Testnet')`.

## Runbook for the remaining proof (a person does step 2; the rest can be done by a team member or by an agent)

1. Start the dev server:

   ```sh
   cd apps/web && npm run prepare-data && npx vite --port 5201
   ```

   Open `http://127.0.0.1:5201` at 375 px.
2. **(person)** Sign in → **Sign in with email** → `isotherm-qa+dynamic_test@example.com` → enter the static Sandbox code that Dynamic shows or documents. The embedded wallet is created. Copy its address from Portfolio.
3. Fund it:

   ```sh
   scripts/fund-embedded.sh 0xEMBEDDED --yes
   ```

   This sends 0.25 testnet MON (gas limit 21000) and calls faucet `requestFunds` (10,000 AUSD; it waits 65 s once if the global 60 s cooldown hits), all from the deployer. It prints both tx hashes. The deployer held 23.84 MON at nonce 42 at 08:3xZ.
4. Relayed mint:
   - Markets → ≥29 °C → **Gasless pair** → 5 → **Mint 5 pairs (no fee)**.
   - Dynamic shows the EIP-712 `ReceiveWithAuthorization` (domain "Agora Dollar" v1, chain 10143, to the vault). Approve it, and the live `/api/relay/mint` submits it.
   - Use one relay only. `/api/health` at 08:21Z showed `relaysToday 0` of a cap of 9.
5. Buy Yes: pick a strike → **Buy Yes** → 5 → confirm in Dynamic. The app checks for ≥ 0.061 MON first; 0.25 is enough.
6. Portfolio should show the pairs and the Yes. The "This session" list has every tx hash.
7. **If the Dynamic prompt refuses chain 10143,** capture the exact text and do the dashboard change in §4. Do not work around Dynamic's check.
8. Only after steps 2–6 pass, deploy, then check the live site **read-only** (the widget renders; do not log in there):

   ```sh
   npm run build && XDG_CONFIG_HOME=<wrangler config dir> npx wrangler@3 pages deploy dist --project-name isotherm --branch main
   ```

## Housekeeping

- Servers this round started have all been stopped: vite :5201, :5203, preview :5202, anvil :19701.
- Key scan of `apps/web`, excluding `node_modules`, against every value of 20+ characters in `~/.config/isotherm/*` except `dynamic.env`: **0 secrets found**. The only matches are the public API URL from `maker.env`, which also appears in `env.example`, `src/config.ts` and the bundle.
- No git commits.

## 5. Live proof on 2026-10-07

**Status: done on the live site, with a team test wallet. This is a team test, not traction.**

**Who and where.**
- A team member signed in with Dynamic email login on **https://isotherm.pages.dev** (Sandbox environment `3eaae4f7-b9bb-4a0a-a578-00ff7008a460`), then traded from a phone.
- This was not the localhost `+dynamic_test` login in the runbook above. The Dynamic build was already live: before this round's redeploy, the live main chunk was `index-CIjHIjYB.js`, the production build from §2, which carries the environment ID.
- Dynamic created embedded wallet **`0xF4a3377D1200584D8Ab7d7e64c6B17dc6c792427`**. It is a team test wallet, so it counts as a **team wallet**. The API counts it as one: it is in `TEAM_ADDRESSES` (`apps/api/wrangler.toml`), and live `/api/stats` at 13:28 UTC shows its fill as `team`, with `nonMakerWallets 0`.

**Dashboard.** Monad Testnet and Monad Mainnet are now enabled in the Sandbox environment. The public settings, re-read at 13:24 UTC, show:

| Setting | Value |
|---|---|
| `environmentName` | `sandbox` |
| EVM networks | `1 Ethereum Mainnet`, `143 Monad Mainnet`, `10143 Monad Testnet` |
| Embedded wallets | automatic creation on, EVM primary, `defaultWalletVersion V3` |
| Smart wallets | off |

The copy is in [`public-sdk-settings-2026-10-07T1324Z.json`](public-sdk-settings-2026-10-07T1324Z.json).

**Transactions.** All are on Monad testnet and all have status `success`. They were re-read with `cast receipt` / `cast tx` on `https://testnet-rpc.monad.xyz` at 13:26 UTC (block 68,981,655). The machine-readable copy is [`live-proof-2026-10-07.json`](live-proof-2026-10-07.json).

| # | Time (UTC) | Tx | Block | From → to | What happened |
|---|---|---|---|---|---|
| 1 | 12:30:46 | [`0x6ed02038b3473da721713530783e8e31957bdb92f412c26fc349345d885b90be`](https://testnet.monadvision.com/tx/0x6ed02038b3473da721713530783e8e31957bdb92f412c26fc349345d885b90be) | 68,970,676 | deployer `0xb855…5c11` (nonce 42) → embedded wallet | Funding: 0.25 testnet MON, for the wallet's own trades |
| 2 | 12:30:49 | [`0xf4f388864bf2e3d6d386c024a76d6c2b6ffbd4f481ef05376d0c44c1ccf1e664`](https://testnet.monadvision.com/tx/0xf4f388864bf2e3d6d386c024a76d6c2b6ffbd4f481ef05376d0c44c1ccf1e664) | 68,970,687 | deployer (nonce 43) → AUSD faucet `requestFunds` | Funding: 10,000 test AUSD to the embedded wallet |
| 3 | 12:36:22 | [`0xca08d0150c228c16f9841b00244654ec39f96551c52a0e063584d2adabb6bf04`](https://testnet.monadvision.com/tx/0xca08d0150c228c16f9841b00244654ec39f96551c52a0e063584d2adabb6bf04) | 68,971,790 | relayer `0xb0b9…429f` (nonce 12) → vault `mintSetWithAuthorization` | **Gasless mint.** The embedded wallet signed an EIP-3009 `ReceiveWithAuthorization` for 5 AUSD (domain "Agora Dollar" v1, chain 10143). AUSD emitted `AuthorizationUsed(authorizer = embedded wallet)` and moved 5 AUSD from the wallet to the vault. The vault minted 5 `RCSS-20261008-GE28-Y` and 5 `RCSS-20261008-GE28-N` to the wallet. The relayer paid the gas (282,612 × 102 gwei = 0.0288 MON); the wallet paid none. `/api/health` afterwards reported `relayedTotal 1`, so this was the live API's first relayed mint. |
| 4 | 12:36:43 | [`0x99b2ad622d55ff700a60bc6f403983051a9d73220123bd6ffda13d3617556e52`](https://testnet.monadvision.com/tx/0x99b2ad622d55ff700a60bc6f403983051a9d73220123bd6ffda13d3617556e52) | 68,971,859 | **embedded wallet** (nonce 0) → AUSD `approve` | The wallet approved the Zap for 100,000 AUSD; 99,995 is left |
| 5 | 12:36:52 | [`0x361668d832a2acd47180b8875c9ce44ce0ff6f7dec9a071755e7c8d9dcb4681c`](https://testnet.monadvision.com/tx/0x361668d832a2acd47180b8875c9ce44ce0ff6f7dec9a071755e7c8d9dcb4681c) | 68,971,890 | **embedded wallet** (nonce 1) → Zap `buyYes` | **Buy YES**, sent and paid for by the wallet itself. Calldata: `ausdIn 5,000,000`, `minYesOut 4,944,544` (2% below the quote). On the ≥ 28 °C Kuru book `0x171b…DBd7`, Kuru's `Trade` event shows `price 0.99` and `filledSize 5.050505`. The Zap's event shows `yesOut 5,045,454` and `refund 0`. The difference between the two sizes is Kuru's 0.1% taker fee. |

**Wallet after the proof** (re-read at 13:26 UTC):

| Field | Value |
|---|---|
| Nonce | 2 |
| MON | 0.1911154. That is 0.0588846 spent on its two own transactions: (78,223 + 499,077) gas × 102 gwei, because Monad bills the gas limit. |
| AUSD | 9,990 |
| YES ≥ 28 °C | 10.045454 |
| NO ≥ 28 °C | 5 |

**What this proves.**
- The Dynamic embedded wallet works on chain 10143. It signs EIP-712 typed data, and AUSD's `receiveWithAuthorization` accepts that signature, which means it is a plain EOA as expected with smart wallets off.
- The same wallet also sends ordinary transactions to our contracts.
- The relay path that had been proven only with a burner wallet on a fork is now proven on live testnet.

**What it does not prove.**
- The proof does not say whether the wallet relied on the dashboard's 10143 entry or on the app's `overrides.evmNetworks` injection, because both are now present.
- There is no screenshot or recording of the phone session in the repo.
- The Portfolio view was not checked independently. The on-chain balances above are the check.
- Delegated access and server wallets are still not built or used.
- No non-team user has signed in yet, as far as we know.

**Redeploy (this round, 13:21 UTC).** `npm run build` read the environment ID from `.env.production`, then `wrangler@3 pages deploy dist --project-name isotherm --branch main` ran. Deployment `https://<retired-deployment>.isotherm.pages.dev`.
- New main chunk: `index-Dl6lo4gH.js`. It contains the environment ID once, "Sign in with email" with the `dynamic-login` button, and the Open-Meteo CC BY credit (`open-meteo-credit`, added in `dfd0c41` and not in the previous live build). The Dynamic SDK chunk is `dynamic-DKA4llTK.js`.
- `vitest`: 35/35.

**Read-only smoke check of the live site (13:21–13:25 UTC, in-app browser; no login).**
- The page served `index-Dl6lo4gH.js`.
- The credit rendered: "“Model” is built from Open-Meteo forecasts, bias-corrected by Isotherm (modified). Weather data by Open-Meteo.com (CC BY 4.0)."
- The page lazy-loaded `dynamic-DKA4llTK.js`, which happens only when an environment ID is configured. There were no console errors.
- The sign-in sheet itself was not opened. That browser profile already holds a dev wallet, so the header shows an address rather than "Sign in". The Dynamic button's presence was therefore checked in the served main chunk instead (`curl`): "Sign in with email" and `data-testid="dynamic-login"` are both there.
