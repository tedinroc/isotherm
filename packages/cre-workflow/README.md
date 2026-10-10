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
cd settle && bun test && bun run typecheck && bun run build && cd ..   # 93 tests (+11 fork e2e, skipped without a fork), WASM build, no login
scripts/fork-e2e.sh        # live v1 bytecode on an anvil fork: accepted/tampered reports, catch-up, VOID, payouts
scripts/dry-run.sh         # what a run would do on LIVE testnet right now (0 MON, nothing signed by the real key)
scripts/run-official.sh    # OFFICIAL: `cre workflow simulate -T testnet --broadcast` (needs `cre login`)
scripts/deploy-runtime.sh --load   # copy to ~/isotherm-live (outside ~/Documents) + load both LaunchAgents from there
scripts/jobs-fork-e2e.sh   # both LaunchAgents, started by launchd from the runtime copy, against a warped anvil fork
```

**Installed on this Mac (2026-10-07):** `xyz.isotherm.cre-settle` (hourly at :05, official path if `cre whoami`
succeeds, otherwise the labelled harness fallback; evidence record per run) and `xyz.isotherm.challenge-watch` (every
120 s). Both run from `~/isotherm-live/packages/cre-workflow`, because launchd cannot read `~/Documents` (macOS TCC,
exit 126). Operations: `docs/OPERATIONS.md` §6. Changes in this round: `FIXES.md`.

**Prepared, not deployed (2026-10-09): the same job on a small Linux VPS** (`vps/`, runbook `vps/README.md`). It is the
same `settle-job.sh` under a systemd timer at :05, with the official path, the harness fallback, the lock and the
spacing guard unchanged. Around the job it adds a single-writer guard, so the Mac and the VPS never both settle, and an
optional ntfy push. `vps/cutover.sh` moves the job from the Mac; `vps/rollback.sh` moves it back.

| Script | What it does | MON | Login |
|---|---|---|---|
| `scripts/fork-e2e.sh` | Runs `settle/e2e/fork.e2e.test.ts` on its own anvil fork (port 19310) | 0 | no |
| `scripts/sim-fork.sh` | Runs the CRE simulator (compiled WASM) on a fork with live METAR data | 0 | official binary: yes. `ISOTHERM_ALLOW_PATCHED_SIM=1` uses the spike's dev build |
| `scripts/harness-fork-check.sh` | Runs `run-official.sh --harness` end to end on a fork | 0 | no |
| `scripts/dry-run.sh` | Runs the real handler against live reads and live HTTP, stopping before any send | 0 | no |
| `scripts/run-official.sh` | Live settlement. Preflight, 30-min spacing guard, lock (shared with the runtime copy), then simulate `--broadcast` and confirm the receipts. A simulate run that stops at the CLI's CRE credential check, before anything is compiled or sent, runs once more 45 s later (`scripts/official-retry-check.sh`) | about 0.02 per report | yes (`--harness` fallback: no) |
| `scripts/settle-job.sh` | launchd entry: picks the path (`cre whoami` OK → official, else harness; after a failed official run, harness once), runs `run-official.sh`, appends an evidence record naming the path (`var/evidence/`) | about 0.02 per report | optional |
| `scripts/challenge-watch.sh` | launchd entry: `settle/ops/challenge-watch.ts`, recomputes every `LadderResolved` with `decide()`, challenges a reproduced mismatch from the guardian key or prints the exact command | about 0.0064 per challenge | no |
| `scripts/deploy-runtime.sh` | Copies the package (+ `packages/abi`, `deployments/testnet.json`) to `~/isotherm-live`; `--load` / `--unload` / `--status` | | |
| `scripts/install-launchd.sh` | Renders `launchd/xyz.isotherm.{cre-settle,challenge-watch}.plist.template`; `--load` refuses a copy under `~/Documents` | | |
| `scripts/jobs-fork-e2e.sh` | Both jobs started by launchd from the runtime copy on an anvil fork (port 19330) warped to 02:06 Taipei, Oct 9 | 0 | no |
| `vps/push.sh`, `vps/setup.sh` | Ship the job's code to a VPS; install the pinned toolchain and the systemd units there (Ubuntu 24.04, amd64/arm64) | 0 | no |
| `vps/cutover.sh`, `vps/rollback.sh` | Move the hourly job Mac → VPS and back. Dry run by default; `--execute` switches launchd and systemd in a safe order | 0 | the VPS needs its own `cre login` (`vps/README.md` §4) |
| `vps/test/run-container-tests.sh` | The VPS kit rehearsed in Ubuntu 24.04 containers (systemd, ssh, anvil fork, stubbed launchd); writes `vps/evidence/` | 0 | no |

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
- `settle/e2e/`: the fork e2e, dry run, harness runner, receipt confirmation, the forwarder `send-report`, the
  per-run `evidence-record.ts`, `http.ts` (curl GET + the fork-only `ISOTHERM_TEST_RELABEL` hook) and `forge-report.ts`
  (fork only: a deliberately wrong report for the watcher test).
- `settle/ops/challenge-watch.ts`: the challenge watcher.
- `launchd/`: the two LaunchAgent templates.
- `vps/`: the Linux VPS kit (systemd units, `settle-vps.sh` with the single-writer guard, the Mac-side cutover and
  rollback, and the container rehearsal with its evidence). Runbook: `vps/README.md`.
- `settle/fixtures/`: real METAR captures, listed in `MANIFEST.json`.
- `evidence/`: the outputs referenced in `RESULT.md`.
