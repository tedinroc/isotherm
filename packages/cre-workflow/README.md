# packages/cre-workflow — Isotherm settlement on Chainlink CRE

The workflow settles every due Isotherm ladder (`Tmax ≥ k °C`, one result per station and local day) on
Monad testnet 10143. Here is the pipeline:

1. It reads the airport METARs from IEM and aviationweather.gov, with Ogimet as a fallback.
2. It applies the validated settlement rule (`settle/settle-core.ts`, byte-identical to `packages/forecast`).
3. The attester signs the v1 report with EIP-712.
4. The report goes through the (Mock)KeystoneForwarder to `Resolver.onReport`.

Testnet only. The collateral is faucet AUSD.

```
cron (02:00 Taipei, 02:00 Tokyo, hourly at :30)
 -> Resolver.paused()?   Vault.ladderCount() + duePendingLadders(start,count)   [EVM reads, finalized block]
 -> plan: oldest first, not before dayEnd + 2 h; within the CRE quotas (15 HTTP, 15 EVM reads per run)
 -> per station-date, node-mode HTTP + DON median consensus: IEM + AWC (+ 1 Ogimet call per run if needed)
 -> decide(): A,B complete & equal -> SETTLED | >=2 complete & equal -> SETTLED (2-of-3)
              otherwise PENDING; VOID only after dayEnd + 36 h with every consulted source healthy (46 h backstop)
 -> report = abi.encode(bytes4,uint32,int16,bool,bytes32,uint64 validUntil,bytes sig); validUntil = anchor + 25 min
 -> runtime.report -> evm.writeReport (gas limit 200k) -> forwarder -> Resolver.onReport
 -> Resolver.resultOf at latest (the forwarders swallow a failed onReport; tx success != settled)
```

## Quick start

```bash
./setup.sh                                   # CRE CLI v1.37.0 (sha256-pinned) + bun 1.4.2 into .tools/, npm deps
export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
cd settle && bun test && bun run typecheck && bun run build && cd ..   # 84 tests (+3 fork e2e), WASM build, no login
scripts/fork-e2e.sh        # live v1 bytecode on an anvil fork: accepted/tampered reports, catch-up, VOID, payouts
scripts/dry-run.sh         # what a run would do on LIVE testnet right now (0 MON, nothing signed by the real key)
scripts/run-official.sh    # OFFICIAL: `cre workflow simulate -T testnet --broadcast` (needs `cre login`)
scripts/install-launchd.sh # renders the hourly LaunchAgent (add --install to load it; a human action)
```

| Script | What it does | MON | Login |
|---|---|---|---|
| `scripts/fork-e2e.sh` | Runs `settle/e2e/fork.e2e.test.ts` on its own anvil fork (port 19310) | 0 | no |
| `scripts/sim-fork.sh` | Runs the CRE simulator (compiled WASM) on a fork with live METAR data | 0 | official binary: yes. `ISOTHERM_ALLOW_PATCHED_SIM=1` uses the spike's dev build |
| `scripts/harness-fork-check.sh` | Runs `run-official.sh --harness` end to end on a fork | 0 | no |
| `scripts/dry-run.sh` | Runs the real handler against live reads and live HTTP, stopping before any send | 0 | no |
| `scripts/run-official.sh` | Live settlement. Preflight, 30-min spacing guard, lock, then simulate `--broadcast` and confirm the receipts | about 0.02 per report | yes (`--harness` fallback: no) |
| `scripts/install-launchd.sh` | Hourly LaunchAgent at :35 that calls `run-official.sh` | | |

Keys are never printed:
- **Attester (CRE secret `ISOTHERM_ATTESTER_KEY`).** Read from `~/.config/isotherm/attester.key`.
- **Tx sender (`CRE_ETH_PRIVATE_KEY`).** Read from `ISOTHERM_TX_KEY_FILE`, which defaults to the attester key file. That account holds 0.1 MON.

**Never point the live attester key at a fork.** A fork shares the live Resolver's EIP-712 domain, so anything signed there is valid on live testnet. The scripts enforce this.

## Files

- `settle/workflow.ts`: the handler.
- `settle/plan.ts`: the pure planning helpers (ordering, gates, cursor, budgets, time anchor).
- `settle/sources.ts`: the node-mode fetchers and the source-health rule.
- `settle/report.ts`: the v1 encoding, EIP-712 signing and `sourcesHash`.
- `settle/settle-core.ts`: the validated rule, unchanged (sha256 `119832de…3d62`).
- `settle/config.ts` and `config.{testnet,anvil}.json`: the configuration.
- `settle/test/`: unit, golden-fixture and SDK-harness handler tests.
- `settle/e2e/`: the fork e2e, dry run, harness runner, receipt confirmation and the forwarder `send-report`.
- `settle/fixtures/`: real METAR captures, listed in `MANIFEST.json`.
- `evidence/`: the outputs referenced in `RESULT.md`.
