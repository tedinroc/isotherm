# apps/web — Isotherm phone app (PWA)

Vite 5 + React 18 + TypeScript + viem. Live: https://isotherm.pages.dev (Cloudflare Pages project `isotherm`).
Status, evidence and human actions: [`../RESULT.md`](../RESULT.md).

```sh
npm install
npm run dev        # http://127.0.0.1:5173 (copies ../../deployments/testnet.json → src/generated first)
npm test           # book maths, decoders (vitest)
npm run build      # tsc -b && vite build → dist/
XDG_CONFIG_HOME=<wrangler config dir> npx wrangler@3 pages deploy dist --project-name isotherm --branch main
```

Environment (all optional, see `env.example`): `VITE_DYNAMIC_ENVIRONMENT_ID`, `VITE_API_URL`, `VITE_RPC_URL`,
`VITE_EXPLORER`, `VITE_ENV_LABEL` (red banner, use it for fork builds).

**Login:** builds read the public Dynamic Sandbox environment ID from `.env.production` (committed; `npm run dev` reads
`.env.local` instead, generated from `~/.config/isotherm/dynamic.env`). With it, "Sign in with email" (Dynamic, embedded
wallet) is the default and the labelled dev wallet (a testnet burner key in browser storage) is the fallback;
`VITE_DYNAMIC_ENVIRONMENT_ID= npm run build` makes a dev-wallet-only build. Status: Dynamic is enabled on the live site
(redeployed 2026-10-07 13:21 UTC with the Open-Meteo credit, main chunk `index-Dl6lo4gH.js`). The first embedded-wallet
login, relayed mint (`0xca08d015…bf04`) and Zap Buy Yes (`0x361668d8…681c`) ran on Monad testnet from the team's own
wallet `0xF4a3…2427`, a team wallet, not traction: see [`evidence/dynamic/RESULT.md`](evidence/dynamic/RESULT.md) §5.

**Buy No** is two transactions behind one tap: `vault.mintSet(seriesId, n)`, then `zap.sellYes(seriesId, market, n,
minAusdOut)`, with a progress list in the trade sheet (`src/lib/buyNo.ts`, `src/lib/buyNoPlan.ts`). The app never calls
`Zap.buyNo`: its `minAusdBack` bound fails under partial fills (verifier finding N1). If step 2 reverts because the
price moved past the slippage limit, the user keeps complete pairs and the sheet offers "Merge back" (1:1, no price
risk) or a re-quoted sale. Fix notes and fork evidence: [`FIXES.md`](FIXES.md), `evidence/fix-round/`.

Local test on an anvil fork (never the live chain):

```sh
anvil --fork-url https://testnet-rpc.monad.xyz --port 19201
# API: see ../api/README.md (wrangler dev on :8781 with RPC_URL=http://127.0.0.1:19201)
FORK_RPC=http://127.0.0.1:19201 API_URL=http://127.0.0.1:8781 SNAPSHOT_TOKEN=… OUT=/tmp/fx.json npx tsx scripts/fork-fixture.ts
VITE_RPC_URL=http://127.0.0.1:19201 VITE_API_URL=http://127.0.0.1:8781 VITE_ENV_LABEL="Local anvil fork — not the live chain" npm run dev
FORK_RPC=http://127.0.0.1:19201 TMAX=30 npx tsx scripts/fork-settle.ts /tmp/fx.json   # attested report via MockKeystoneForwarder
# Buy No on the deployed v1 contracts + the live ladder's real Kuru book, copied into the fork: normal fill,
# a sandwich between the quote and step 2 (reverts), and the same sandwich against the old Zap.buyNo (fills at ~1/NO)
FORK_RPC=http://127.0.0.1:19201 STRIKE=30 BUDGET=10 npx tsx scripts/fork-buyno-sandwich.ts
# in-browser sandwich: switches the fork to manual mining and front-runs the dev wallet's sellYes in the same block
FORK_RPC=http://127.0.0.1:19201 VICTIM=0x… STRIKE=30 npx tsx scripts/fork-sandwich-watcher.ts
```

Layout: `src/lib/` (chain reads via Multicall3, Kuru book maths, Zap/vault actions, the two-step Buy No, relayed mint
signing, in-browser attestation check), `src/components/` (Markets, TradeSheet, Portfolio, History, HowItWorks, WalletSheet),
`src/wallet/` (dev wallet + lazy Dynamic bridge), `src/i18n.ts` (English / 繁中).
