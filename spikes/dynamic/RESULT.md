# Dynamic + frontend feasibility: RESULT

**Verdict: feasible, with one design constraint.** Dynamic can supply login, the embedded wallet, EIP-712 signing and a server wallet for Isotherm on Monad. Dynamic's own gas sponsorship does **not** work on Monad, so onboarding without gas needs our own relayer. That relayer is built, and it passes 22 of 22 checks on a fork of Monad testnet. Its core path also passes `eth_simulateV1` against the **live** testnet. Three things still need a person: the Dynamic account and environment ID, an API token, and testnet MON.

> 中文摘要：Dynamic 在 Monad 上能用。可用的部分是登入、嵌入式錢包、EIP-712 簽名和 server wallet。Dynamic 自家的 gas 代付不支援 Monad，這點已用三種方式確認。所以免 gas 上手改用我們自己的 relayer：relayer 先撥 AUSD 和 MON 給新用戶，再代送用戶簽好的 EIP-3009 授權。這條路徑在 fork 上 22 項檢查全過，對 live testnet 的模擬也通過。還卡在人工步驟：開 Dynamic Sandbox 帳號、取得 environment ID 和 API token、補測試網 MON。

---

## 1. What works (evidence)

### 1a. The PWA builds and boots: Vite 5 + React 18 + TypeScript + `DynamicContextProvider`
Files: `src/main.tsx`, `src/App.tsx`, `src/lib/chains.ts`, `src/lib/ausd.ts`, `public/manifest.webmanifest`, `public/sw.js`, `public/icon-*.png`

- The provider is `DynamicContextProvider` with `EthereumWalletConnectors`. Its `overrides.evmNetworks` is set to `mergeNetworks([Monad Testnet 10143, Monad 143], dashboard)`, so our two network definitions take precedence.
- The environment ID is read from `VITE_DYNAMIC_ENVIRONMENT_ID`. If it is missing, the app shows a setup screen instead of crashing.
- Email and Google login use `DynamicWidget`; which methods appear is controlled from the dashboard.
- Signing uses viem through `primaryWallet.getWalletClient('10143').signTypedData(...)`. The input is the shared `authorizationTypedData()` builder, which is the same code the relayer verifies against.
- The app has three actions: "Get test funds", "Deposit 5 AUSD — gasless (EIP-3009)" and "Direct tx from embedded wallet". The direct transaction sets an explicit gas limit of estimate × 1.15.

```
$ npm run build          # tsc -b && vite build
vite v5.4.21 building for production...
✓ 13312 modules transformed.
dist/assets/index-Cv22i562.js   5,592.28 kB │ gzip: 1,408.53 kB
✓ built in 30.34s        (16.3 s on an idle machine)   exit=0
dist: 7.1 MB, 76 files (fits Cloudflare Pages limits)
```

**Runtime check in a browser at 375 px width.** I built with a fake environment ID and served the result with `vite preview`.
- The page renders, and the Dynamic widget shows "Log in or sign up". Screenshot: `evidence/pwa-mobile-375px-fake-env.jpg`.
- There were no `process`/`Buffer` polyfill errors.
- The SDK called `https://app.dynamicauth.com/api/v0/sdk/<env>/settings?sdkVersion=ClientSDK/1.37.0`. That returns HTTP 404 for an unknown environment, which the browser reports as a CORS failure, and the login button then spins forever. Screenshot: `evidence/pwa-login-spinner-unknown-env.jpg`.
- **If you see a spinner that never stops, the environment ID is wrong or not set.**

### 1b. Gasless onboarding relayer, end to end on an anvil fork of Monad testnet: 22/22 PASS, run twice
Files: `relayer/core.ts`, `relayer/server.ts`, `relayer/signer.ts`, `contracts/src/GaslessDepositor.sol`, `scripts/e2e-fork.ts`

The test simulates the embedded wallet with a fresh local secp256k1 key. That is a fair stand-in: a Dynamic TSS-MPC embedded wallet is a plain EOA, and its signTypedData output is a standard 65-byte ECDSA signature. The relayer runs as the real HTTP server, and the test calls it with the same fetch client the PWA uses.

```
anvil --fork-url https://testnet-rpc.monad.xyz --fork-block-number 68693915 --network monad --chain-id 10143 --port 18645
(cd contracts && forge build)
FORK_RPC=http://127.0.0.1:18645 npx tsx scripts/e2e-fork.ts
PASS  user (fresh embedded wallet) starts with 0 MON
PASS  POST /drip minted AUSD to user via faucet (relayer float empty, relayer paid gas)  gasUsed 128402 / limit 149246
PASS  second drip within 60 s -> clean 429 (faucet global cooldown)
PASS  relayer refill() pulled 10,000 AUSD float from faucet
PASS  drip #2 paid 1,000 AUSD from relayer float (no faucet dependency)               gasUsed 72049 / limit 82857
PASS  relayed transferWithAuthorization moved 25 AUSD user -> vault                   gasUsed 112281 / limit 129124
PASS  user paid 0 MON for the deposit
PASS  replay rejected by relayer policy / onchain (AUSD)
PASS  tampered value rejected by relayer (sig mismatch) / onchain
PASS  non-allowlisted destination rejected
PASS  receiveWithAuthorization by non-payee reverts (front-run safe)
PASS  relayed depositWithAuthorization (receiveWithAuthorization) credited 40 AUSD     gasUsed 153346 / limit 176348
PASS  permit + depositWithPermit credited 15 AUSD                                     gasUsed 163124 / limit 187593
PASS  user still has 0 MON after 3 gasless AUSD movements
PASS  MON drip delivered 0.05 MON
PASS  direct embedded-wallet tx (AUSD self-transfer)  gasUsed 44237 / limit 51260, billedOn "gas LIMIT (Monad rule)"
22 passed, 0 failed
```
Full logs and JSON are in `evidence/e2e-fork-console-run{1,2}.log` and `evidence/e2e-fork-*.json`. Each run snapshots the fork and reverts it afterwards, so a rerun starts from the same state.

`anvil --network monad` reproduces Monad's billing rule: the MON paid equals gas **limit** × price, not gas used.

### 1c. The same path against the live Monad testnet, simulated only with `eth_simulateV1` (nothing broadcast)
```
$ npx tsx scripts/live-simulate.ts        (evidence/live-simulate.log)
simulatedOnTopOfBlock 68697571, fresh user MON = 0
faucet.requestFunds(user): success · transferWithAuthorization(user->vault, 25 AUSD): success
userAusdAfter 9975000000 · authorizationUsed true  -> LIVE SIMULATION PASS
```
On Monad, `simulateBlocks` reports `gasUsed` as 150,000,000 for every call, which is the default limit, so it says nothing about real gas. Use the fork numbers instead.

### 1d. AUSD and its faucet, verified on the live testnet with `cast`
- `eip712Domain()` returns `("Agora Dollar", "1", 10143, 0xa9012a…22dC)`.
  - The `DOMAIN_SEPARATOR` I recomputed locally from those values is `0x7ff7d6b4…3ea1`, which matches the onchain value.
  - Note that `name()` returns `"AUSD"`, which is not the EIP-712 name.
- The TransferWithAuthorization and ReceiveWithAuthorization typehashes match the standard EIP-3009 values exactly.
- The implementation `0xc1e3c7d4…12da` contains these selectors:
  - `transferWithAuthorization` and `receiveWithAuthorization`, in both the **v,r,s** and the **bytes signature** (ERC-1271 capable) variants;
  - `cancelAuthorization`;
  - `permit`, in both variants;
  - `authorizationState`, `nonces` and `isAccountFrozen`.
- **Faucet `0xd236…e6C`:**
  - Each call mints 10,000 AUSD. Its balance is about 997M AUSD.
  - **There is one global 60-second cooldown shared by everyone on the testnet.** Calling it again inside that window reverts with custom error `0x20e5bc67` = `MaxFrequencyExceeded()`. I confirmed this with new callers and new recipients, and by warping fork time: +10 s still fails, +70 s succeeds.
  - The settings live in the namespaced slot `0xd71d…14000`: `+1` holds 10,000e6 per call, `+3` holds the 60 s period and `+4` holds the timestamp of the last request.
  - `+2` holds 100,000e6. My guess is that this caps the recipient's balance, but I did not test it.
  - Because of the cooldown, the relayer pays drips from its **own AUSD float** and only falls back to the faucet when the float is empty. If the faucet is cooling down, the relayer returns a clean HTTP 429.

### 1e. Dynamic's server-wallet SDK loads on this Mac
```
$ npx tsx scripts/probe-node-sdk.ts
version 1.1.29, loadMs 3002, nativeAddon libmpc_executor_macos_arm64_nodejs.node loaded (84 exports)
exports: DynamicEvmWalletClient, createDelegatedEvmWalletClient, delegatedSignTypedData, delegatedSignTransaction,
         delegatedSignMessage, revokeDelegation  (all "function")
client methods: authenticateApiToken, createWalletAccount, getWalletClient, signTypedData, signTransaction, getAvailableEvmGaslessRelayer
```
- `getWalletClient({ walletMetadata, password, chain: monadTestnet, rpcUrl })` returns a viem WalletClient. Because of that, `relayer/signer.ts` can swap the local key for a Dynamic server wallet without any other code change.
- The native addons ship only for **Linux x64/arm64 and macOS x64/arm64**. A relayer that signs with a Dynamic server wallet therefore **cannot run on Cloudflare Workers or Pages Functions**. It has to run on the 24/7 Node host, the same machine as the maker bot.

### 1f. Comparison build on Dynamic's current headless JS SDK (`alt-jssdk/`)
Dynamic's docs now label `@dynamic-labs/sdk-react-core`, the package that provides DynamicContextProvider, as **legacy/deprecated**, and recommend `@dynamic-labs-sdk/*` instead. I built the same flow on the new SDK: email OTP, Google redirect, embedded-wallet creation, EIP-3009 signing, and `delegateWaasKeyShares`. It is about 120 lines; it typechecks, builds and boots.

| | Legacy React SDK (`src/`) | JS SDK (`alt-jssdk/`) |
|---|---|---|
| Modules | 13,312 | 2,842 |
| Main chunk, gzip | 1,408 kB | 321 kB |
| All JS, gzip | 1.89 MB | 0.37 MB |
| UI | Login, MFA and delegation prompts built in (`DynamicWidget`) | Headless; we build every screen |
| Needs Vite `define` polyfills | Yes | No |
| Docs status | "legacy / deprecated" | Recommended |

I also tested Vite 8.3.3, which the Dynamic docs say is incompatible with the legacy SDK. On this machine the legacy app **built in 1.0 s and booted** with no errors. I only checked that it boots; login was not tested.

---

## 2. What does NOT work, or is not verified

| Item | Status | Evidence |
|---|---|---|
| **Dynamic native gas sponsorship on Monad** | **Does not work.** Confirmed three ways. | (1) The docs' supported-chain table has 1, 8453, 10, 42161, 56, 4663, 5042 and Sepolia, Base Sepolia, Arc testnet. 143 and 10143 are absent. (2) The SDK's 7702 delegate (Fireblocks UGD) `0x0000Fb7702036ff9f76044a501ac1aA74cbab16b` has **no code** on Monad testnet or mainnet; for comparison, `cast code` returns a 14,631-character string on Sepolia and Base Sepolia. (3) The pricing page lists "Gasless Transactions" as an Enterprise feature. |
| Real Dynamic login and embedded-wallet signing on 10143 | **Not verified.** Needs an environment ID. | The code path is built and boots. EIP-712 signing does not depend on the chain, so the risk is low. Still untested: Dynamic's confirmation UI for typed data that uses a custom chain. |
| Dynamic server wallet as the relayer signer | **Not verified.** Needs an API token. | `relayer/signer.ts` and `scripts/server-wallet.ts` are ready; the native addon loads. |
| Delegated access (auto-roll stretch goal) | **Not built.** The SDK functions exist. | React: `useWalletDelegation().delegateKeyShares(wallets, pw, initialSignerRules)`. JS: `delegateWaasKeyShares`. Node: `delegatedSignTypedData`. It needs Sandbox plus a public **HTTPS** webhook. In Live it requires the **Enterprise** plan (stated in the docs). |
| Service-worker install | **Not verified.** | The embedded test browser refuses every service worker, including a one-line one, so the failure is the browser's, not our code's. `node --check public/sw.js` passes. Test install-to-home-screen on a real phone after deploying. |
| Broadcasting on the live testnet | **Skipped by rule.** | The deployer balance was 4.70 MON (nonce 3) and then **3.67 MON (nonce 8)**, both below the 5 MON threshold. The nonce rising while I worked shows **another agent is spending from the deployer key**, so sharing it would risk nonce collisions. |

---

## 3. Gas and latency (fork, anvil `--network monad`; costs at the live testnet price of 102 gwei)

The gas limit is set to estimate × 1.15. On the fork, the estimate equaled the gas actually used every time, so a margin of about 5–10% would be safe and cheaper, since Monad bills the limit.

| Operation | Gas used | Gas limit | MON at 102 gwei |
|---|---|---|---|
| Faucet `requestFunds` (drip when the float is empty, or refill) | 128,402 | 149,246 | 0.0152 |
| Drip AUSD from the relayer float (fresh address) | 72,049 | 82,857 | 0.0085 |
| MON drip transfer | 21,000 | 21,000 | 0.0021 |
| **Relay `transferWithAuthorization`** | 112,281 | 129,124 | **0.0132** |
| Relay `depositWithAuthorization` (→ `receiveWithAuthorization`) | 153,346 | 176,348 | 0.0180 |
| `permit` + `depositWithPermit` | 163,124 | 187,593 | 0.0191 |
| User's own direct AUSD transfer | 44,237 | 51,260 | 0.0052 |
| Deploy `GaslessDepositor` | 516,431 | — | 0.0527 |

What this means for the budget:
- **Onboarding one user** (AUSD from the float plus a MON drip) costs about 0.0106 MON in gas, plus the MON you give them.
- **Each gasless deposit** costs about 0.013–0.018 MON.
- 50 MON/day covers about 3,000 gasless deposits, or about 230 new users if each one gets 0.2 MON.

Latency measured on the fork, from POST to receipt, including verification, estimate and send:
- relay: 0.6–1.0 s
- drip: 0.3–0.4 s
- signing with a local key: about 1 ms

Expect MPC signing in the browser to add seconds.

---

## 4. Dynamic dashboard settings (exact, for the human)

Go to https://app.dynamic.xyz and open the console. Do everything below in the **Sandbox** environment.

Sandbox is free and has every feature, including delegated access and webhooks. It is capped at 1,000 users, which is enough for the hackathon.

1. **Create** an organisation and a project named "Isotherm". Use the Sandbox environment for all of the steps below.
2. **Developers → SDK & API Keys.**
   - Copy the **Environment ID**. It goes into `VITE_DYNAMIC_ENVIRONMENT_ID` and `DYNAMIC_ENVIRONMENT_ID`.
   - Create an **API token** for the server wallet and delegated access. It goes into `DYNAMIC_API_TOKEN`.
   - Hand both over in `~/.config/isotherm/dynamic.env` (`chmod 600`). Never put them in the repo or in chat.
3. **Chains & Networks** (`/dashboard/chains-and-networks`).
   - Turn on EVM and enable **Monad Testnet (10143)** and **Monad (143)**. Set the RPCs to `https://testnet-rpc.monad.xyz` and `https://rpc.monad.xyz`.
   - If Monad is not listed, tell us. The app injects both networks itself, but the docs say embedded-wallet operations can fail when a chain is not enabled in the dashboard.
4. **Log in & User Profile → sign-in methods.**
   - Turn on **Email**.
   - Turn on **Google** under Social. If Dynamic asks for a Client ID and Secret, create a Google Cloud "OAuth client ID (Web application)". Set its Authorized redirect URI to the one shown on Dynamic's Google config page, and add the Pages origin as an Authorized JavaScript origin.
5. **Wallets → Embedded Wallets (TSS-MPC).**
   - Turn it on, and turn on **create on sign-up for EVM** (`sdk.embeddedWallets.automaticEmbeddedWalletCreation=true`).
   - Leave **Smart wallets / AA (ZeroDev) OFF**, so the user's address is a plain EOA and their signatures can be checked with ecrecover. The relayer has an ERC-1271 fallback, but there is no reason to rely on it.
   - Leave **Gas sponsorship OFF**; it does nothing on Monad.
   - Turn on **"multiple embedded wallets per chain"**. The server-wallet setup requires it.
6. **Settings → Security → Allowed CORS origins.** Add:
   - `http://localhost:5173` (dev) and `http://localhost:4173` (preview)
   - `https://<project>.pages.dev`
   - `https://*.<project>.pages.dev`

   With no origins listed, every origin is allowed; adding them explicitly is still safer.
7. *(Stretch)* **Embedded Wallets → Delegated Access.**
   - Turn it ON, with "prompt on sign-in" OFF, because the app triggers it from an "Allow auto-roll" button.
   - Register a public **HTTPS** endpoint (for example a Cloudflare Tunnel to the relayer) for `wallet.delegation.created` and `wallet.delegation.revoked`.
   - Let Dynamic generate the RSA key pair, then copy the webhook secret into `DYNAMIC_WEBHOOK_SECRET`.
   - Optionally add a **Transaction Review** webhook (it returns `{proceed:true|false}`; the failure policy should be DENY).

The `dyn` CLI (`npm i -g @dynamic-labs/dynamic-console-cli`) can do steps 3–7 from a script, for example `dyn settings set sdk.embeddedWallets.automaticEmbeddedWalletCreation true`. It still needs a person to run `dyn auth login` once in a browser.

## 5. Human actions (in order)

1. Do the Dynamic Sandbox setup in §4 and put the environment ID and API token into `~/.config/isotherm/dynamic.env`.
2. Run `DYNAMIC_ENVIRONMENT_ID=… DYNAMIC_API_TOKEN=… DYNAMIC_SERVER_WALLET_PASSWORD=… npx tsx scripts/server-wallet.ts`. It creates the server wallet, signs one EIP-3009 authorization and checks the signature.
3. Send **at least 5 testnet MON** to the address that script prints, from the faucet. Do not reuse the deployer; another agent is spending from it.
4. Provide a 24/7 Node host with public HTTPS for `relayer/server.ts`. Cloudflare Tunnel from the maker-bot machine works. Pages Functions do **not**, because of the native addon.
5. On a phone, open the deployed PWA, log in by email, tap "Get test funds" and then "Deposit 5 AUSD — gasless", and capture the explorer link for the Dynamic clip.

## 6. Next steps and notes for the other builders

- **Core contracts.** Add `mintSetWithAuthorization(from, value, validAfter, validBefore, nonce, bytes sig)`. It should call `AUSD.receiveWithAuthorization(from, address(this), …)`, which `GaslessDepositor` shows is front-run-safe at about 153k gas. Optionally also add `mintSetWithPermit`. Then add the series contract to `RELAY_ALLOWED_RECEIVERS`.
- **Choose the SDK.** I recommend the JS SDK (`alt-jssdk/`) for the shipped phone app: it is 4–5× smaller, is the version Dynamic recommends, and fits a custom mobile UI. The cost is building our own OTP, Google and delegation screens, roughly half a day to a day. The legacy widget in `src/` works today and is the faster fallback.
- **Relayer HTTP API** (`src/lib/relayerClient.ts`):
  - `GET /info`
  - `POST /drip {address}`
  - `POST /relay {kind:'transfer'|'receive', chainId, from, to, value, validAfter, validBefore, nonce, signature}`

  Policy is set by env vars: `RELAY_DEPOSIT_TO`, `RELAY_ALLOWED_TO`, `RELAY_ALLOWED_RECEIVERS`, `RELAY_MAX_AUSD`, `RELAY_MAX_TTL`, `DRIP_AUSD`, `DRIP_MON`, `GAS_MARGIN_PCT`. Before submitting, the relayer checks the signature with ecrecover (falling back to ERC-1271), the nonce, the balance, the time window, the cap and the allowlist. Sends go through one queue, so a single relayer EOA never reuses a nonce.
- **Shared typed data** (`src/lib/ausd.ts`): `ausdDomain(chainId)`, `authorizationTypedData(kind, chainId, auth)`, `permitTypedData`, `newAuthorization`, `toWire`/`fromWire`, `ausdAbi`, `faucetAbi` (includes `MaxFrequencyExceeded`).
- **Before the demo,** reduce `GAS_MARGIN_PCT` to 5–10%, and add persistent drip rate-limiting (it is in memory today).

## 7. Files
`package.json` · `vite.config.ts` · `index.html` · `env.example` · `src/{main,App,SetupNeeded,config}.tsx|ts` · `src/lib/{ausd,chains,relayerClient}.ts` · `public/{manifest.webmanifest,sw.js,icon.svg,icon-192.png,icon-512.png}` · `relayer/{core,server,signer}.ts` · `contracts/{foundry.toml,src/GaslessDepositor.sol}` · `scripts/{e2e-fork,live-simulate,probe-node-sdk,server-wallet}.ts` · `alt-jssdk/` (JS SDK comparison) · `evidence/` · `docs-cache/` (Dynamic and Agora docs captured 2026-10-06)
