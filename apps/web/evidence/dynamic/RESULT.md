# Dynamic round: RESULT (2026-10-07)

**Status: partly done. The code is ready, but the Dynamic proof has not run.**

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
