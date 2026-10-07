# apps/api — Isotherm API (Cloudflare Worker)

Live: <former API host> (Worker `isotherm-api`; Durable Object `RelayerDO`
(SQLite-backed) + KV `isotherm-api-ISO_KV`; cron every minute). Status and evidence: [`../RESULT.md`](../RESULT.md).

| Route | What |
|---|---|
| `GET /api/health` | relayer address + balances, `dripReady` / `relayReady`, relay modes (from vault bytecode), `relayMinAusd`, and `limits` (caps, reserve, `dripsToday`, `relaysToday`); memoised 5 s |
| `POST /api/drip {address}` | 0.15 MON + 1,000 AUSD (float, faucet fallback). 1 per address / 24 h, `DRIP_PER_IP_PER_DAY` per network / UTC day, `DRIP_DAILY_CAP` per UTC day; never to contracts, 7702-delegated accounts or precompiles; never below the reserve |
| `POST /api/relay/mint` | gasless complete-set mint, **authorization mode only**: `{mode:"authorization", chainId, seriesId, amount, holder, validAfter, validBefore, salt, signature}` (EIP-3009 ReceiveWithAuthorization to the vault, nonce = `keccak256(abi.encode(seriesId, amount, salt))`). 1–500 AUSD; `RELAY_PER_ADDRESS_PER_DAY`, `RELAY_PER_IP_PER_DAY`, `RELAY_DAILY_CAP`. Permit mode is refused for the v1 vault (a permit can be front-run and redirected to another series) |
| `GET /api/snapshot` | latest maker snapshot, normalised (accepts `packages/maker` "isotherm.snapshot/v1"). Per strike: `fair`, `pmImplied`, `model` (guardrail), `bid`/`ask`, `bidSize`/`askSize` (as placed), `bidRemaining`/`askRemaining` (resting now), `mode`, `action` + `reason` (this tick's decision), `lastChangeReason` + `lastQuoteAt` (why/when the quote last changed) |
| `POST /api/snapshot` | `Authorization: Bearer <SNAPSHOT_TOKEN>` |
| `GET /api/stats` | non-maker wallets, fills, volume, settled city-days, drips, relayed mints (own log scan) + `maker` (maker-reported, separate) |
| `POST /api/stats` | `Bearer <SNAPSHOT_TOKEN>`: maker-reported stats |
| `GET /api/settlements` | resolved ladders with report tx hashes |
| `POST /api/admin/tick`, `/api/admin/rescan {fromBlock,toBlock,markets?}` | `Bearer <ADMIN_TOKEN>` |

```sh
npm install
npm test            # unit tests
npm run test:fork   # spawns anvil (:19200) + wrangler dev (:8782); ISO_ANVIL_PORT / ISO_API_PORT / ISO_INSPECTOR_PORT override; throwaway keys only
npm run dev         # wrangler dev :8781 (pass --var RPC_URL:… --var RELAYER_KEY:… for a fork)
XDG_CONFIG_HOME=<wrangler config dir> npx wrangler@3 deploy
tr -d '\n' < ~/.config/isotherm/relayer.key | XDG_CONFIG_HOME=<wrangler config dir> npx wrangler@3 secret put RELAYER_KEY
```

Secrets: `RELAYER_KEY` (~/.config/isotherm/relayer.key), `SNAPSHOT_TOKEN` (~/.config/isotherm/api-snapshot.token),
`ADMIN_TOKEN` (~/.config/isotherm/api-admin.token). Budget knobs are plain vars in `wrangler.toml`.

## MON budget (who can spend the relayer's test MON, and how much)

Every drip and relayed mint is paid by one relayer EOA, and testnet MON is scarce. The caps are sized so that a
whole UTC day of worst-case use fits in what the relayer holds above a reserve, and so that one client network
can use at most half of a day. `node scripts/size-caps.mjs` reads the live balance and gas price (read-only) and
prints the vars; re-run it after funding the relayer, paste the output into `wrangler.toml`, redeploy.

```
spendable           = balance − RELAYER_MIN_MON                     reserve: drips and relays never go below it
dripCost            = DRIP_MON + (21,000 + 78,752 gas) × gasPrice     MON leg + AUSD leg (Monad bills the gas LIMIT)
relayCost           = 335,000 gas × gasPrice                          fork-measured limit, first-time holder: 334,228
DRIP_DAILY_CAP      = floor(spendable × 0.65 / dripCost)
RELAY_DAILY_CAP     = floor((spendable − DRIP_DAILY_CAP × dripCost) / relayCost)
DRIP_PER_IP_PER_DAY = max(1, floor(DRIP_DAILY_CAP / 2))
RELAY_PER_IP_PER_DAY = RELAY_PER_ADDRESS_PER_DAY = max(1, floor(RELAY_DAILY_CAP / 2))
```

At 2026-10-07T07:00Z the relayer held 0.599 MON at 102 gwei: spendable 0.499, dripCost 0.160, relayCost 0.034, so
2 drips + 5 relays per UTC day (worst case 0.491 MON), 1 drip and 2 relays per network, 2 relays per address.

Other guards:
- "Network" = the client IP for IPv4, its /64 for IPv6 (one subscriber holds a whole /64); stored only as a salted hash.
- Drips and relays are counted when the tx is **broadcast**, not when it succeeds: Monad bills the gas limit even
  for a revert, and a receipt wait can time out, so a self-reverted or unconfirmed request still uses up quota.
- The relay caps are checked before any RPC read and again inside the single-sender queue (exact under concurrency).
- `POST_LIMIT_PER_MIN` (30): drip + relay POSTs per network per minute, counted in the Durable Object's memory (one
  instance, so exact) before any storage or RPC work; a flood gets 429 instead of turning into public-RPC reads.
  (A Workers Rate Limiting binding was tried first: deployed with wrangler 3 on workers.dev it never limited, even
  at 150 requests in a few seconds, so it was removed. workers.dev has no zone, so there is no dashboard WAF rule.)
- `RELAY_MIN_AUSD` (1 AUSD) stops dust mints; `RELAY_ALLOW_PERMIT=0` keeps permit relays off (they only ever apply to
  a vault without the EIP-3009 path).
