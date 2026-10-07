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

Environment (all optional, see `env.example`): `VITE_DYNAMIC_ENVIRONMENT_ID` (enables Dynamic email/Google login;
without it the app offers only the labelled dev wallet), `VITE_API_URL`, `VITE_RPC_URL`, `VITE_EXPLORER`,
`VITE_ENV_LABEL` (red banner, use it for fork builds).

Local test on an anvil fork (never the live chain):

```sh
anvil --fork-url https://testnet-rpc.monad.xyz --port 19201
# API: see ../api/README.md (wrangler dev on :8781 with RPC_URL=http://127.0.0.1:19201)
FORK_RPC=http://127.0.0.1:19201 API_URL=http://127.0.0.1:8781 SNAPSHOT_TOKEN=… OUT=/tmp/fx.json npx tsx scripts/fork-fixture.ts
VITE_RPC_URL=http://127.0.0.1:19201 VITE_API_URL=http://127.0.0.1:8781 VITE_ENV_LABEL="Local anvil fork — not the live chain" npm run dev
FORK_RPC=http://127.0.0.1:19201 TMAX=30 npx tsx scripts/fork-settle.ts /tmp/fx.json   # attested report via MockKeystoneForwarder
```

Layout: `src/lib/` (chain reads via Multicall3, Kuru book maths, Zap/vault actions, relayed mint signing, in-browser
attestation check), `src/components/` (Markets, TradeSheet, Portfolio, History, HowItWorks, WalletSheet),
`src/wallet/` (dev wallet + lazy Dynamic bridge), `src/i18n.ts` (English / 繁中).
