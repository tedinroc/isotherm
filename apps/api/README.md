# apps/api — Isotherm API (Cloudflare Worker)

Live: <former API host> (Worker `isotherm-api`; Durable Object `RelayerDO`
(SQLite-backed) + KV `isotherm-api-ISO_KV`; cron every minute). Status and evidence: [`../RESULT.md`](../RESULT.md).

| Route | What |
|---|---|
| `GET /api/health` | relayer address + balances, drip/relay config, deployment source, relay modes detected from vault bytecode |
| `POST /api/drip {address}` | 0.15 MON + 1,000 AUSD (float, faucet fallback). 1 per address / 24 h, 3 per IP / day, 40 per day; never to contracts, 7702-delegated accounts or precompiles |
| `POST /api/relay/mint` | gasless complete-set mint: `{mode:"authorization", chainId, seriesId, amount, holder, validAfter, validBefore, salt, signature}` (EIP-3009 ReceiveWithAuthorization to the vault, nonce = `keccak256(abi.encode(seriesId, amount, salt))`) or `{mode:"permit", …, deadline, signature}` |
| `GET /api/snapshot` | latest maker snapshot, normalised (accepts `packages/maker` "isotherm.snapshot/v1") |
| `POST /api/snapshot` | `Authorization: Bearer <SNAPSHOT_TOKEN>` |
| `GET /api/stats` | non-maker wallets, fills, volume, settled city-days, drips, relayed mints (own log scan) + `maker` (maker-reported, separate) |
| `POST /api/stats` | `Bearer <SNAPSHOT_TOKEN>`: maker-reported stats |
| `GET /api/settlements` | resolved ladders with report tx hashes |
| `POST /api/admin/tick`, `/api/admin/rescan {fromBlock,toBlock,markets?}` | `Bearer <ADMIN_TOKEN>` |

```sh
npm install
npm test            # unit tests
npm run test:fork   # spawns anvil (:19200, fork of live testnet) + wrangler dev (:8782); throwaway keys only
npm run dev         # wrangler dev :8781 (pass --var RPC_URL:… --var RELAYER_KEY:… for a fork)
XDG_CONFIG_HOME=<wrangler config dir> npx wrangler@3 deploy
tr -d '\n' < ~/.config/isotherm/relayer.key | XDG_CONFIG_HOME=<wrangler config dir> npx wrangler@3 secret put RELAYER_KEY
```

Secrets: `RELAYER_KEY` (~/.config/isotherm/relayer.key), `SNAPSHOT_TOKEN` (~/.config/isotherm/api-snapshot.token),
`ADMIN_TOKEN` (~/.config/isotherm/api-admin.token). Budget knobs are plain vars in `wrangler.toml`.
