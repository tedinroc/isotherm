# FIXES: CRE ops round (2026-10-07)

**Goal.** Settle the live RCSS 2026-10-08 ladder automatically from 2026-10-08 18:05 UTC, with hourly retries, and
watch the 900 s challenge window. Nobody needs to be at the keyboard.

**Status.** Done. Both LaunchAgents are installed and loaded from `~/isotherm-live/packages/cre-workflow`, and both have
already run on live testnet from launchd with exit 0. Nothing was due, so nothing was signed or sent: 0 MON this
round. `cre login` was run later on 2026-10-07; since then the job takes the official path, and it settled the first live
ladder, RCSS 2026-10-08 at 28 °C, on 2026-10-08 18:05 UTC (`evidence/live-settle-RCSS-20261008.json`).

| # | Change | Evidence |
|---|---|---|
| 1 | **The settlement job runs outside `~/Documents`.** The old plist ran `run-official.sh` from `~/Documents`, which fails with exit 126 under macOS TCC. New `scripts/deploy-runtime.sh` copies the package to `~/isotherm-live/packages/cre-workflow`, the same pattern as the maker, and copies `packages/abi` and `deployments/testnet.json` with it. `scripts/install-launchd.sh --load` now refuses a copy under `~/Documents`, `~/Desktop` or `~/Downloads`. | `evidence/jobs-fork-e2e.txt` §F/§A: launchd ran `cre workflow build` and the settle job from the runtime copy (exit 0, binary hash `413d4429…` as before). `evidence/launchd-status.txt` |
| 2 | **`xyz.isotherm.cre-settle`** (hourly at :05) runs `scripts/settle-job.sh`. If `cre whoami` succeeds (bounded to 45 s), it runs the OFFICIAL `cre workflow simulate -T testnet --broadcast`. Otherwise it runs the HARNESS fallback: the same handler, the same `decide()` rule and the same v1 attestation through the MockKeystoneForwarder. After a failed official run, the next run uses the harness, and the run after that tries official again. Each run appends an evidence record that names the path and the reason: `var/evidence/settle-runs.jsonl`, `LATEST.json`, and `settlement-<ICAO>-<date>-<path>.json` per report sent. | Fork: harness path, RCSS 2026-10-08 settled 25 and confirmed (`ReportProcessed.result=true` + `LadderResolved`); a second kickstart was stopped by the 30-min spacing guard (`evidence/jobs-fork-e2e.txt` §A1–A2). Path switching official → harness → official, live and dry, using a test shim CLI (`evidence/settle-path-selection-live-dry.txt`). |
| 3 | **`xyz.isotherm.challenge-watch`** (every 120 s) runs `settle/ops/challenge-watch.ts`. It scans `LadderResolved`/`LadderChallenged` in 100-block pages, which is Monad's `eth_getLogs` limit, and also checks the vault's newest 64 ladders as a backstop. It recomputes each result with `sources.ts` `observe()`/`toDayStats()` and settle-core `decide()`. On a SETTLED-with-different-Tmax result that shows up again on a re-fetch, it calls `challenge()` from the guardian key if that key holds enough MON; otherwise it prints the exact `cast send … challenge(…)` command. A result it cannot reproduce gets a loud alert but no automatic challenge. A reported Void can only raise an alert (N2). It refuses the LIVE guardian key on a fork. | Fork, run by launchd: an honest result gives MATCH, with `sourcesHash` reproduced exactly. A forged 31 °C result was challenged automatically and became Void (gas used 44,432). With an unfunded guardian it printed the command, and running that command verbatim voided the result (§A3, §B, §C). The live key was refused (§D). Live passes run every 2 min (`evidence/launchd-status.txt`). |
| 4 | **`run-official.sh`:** <ul><li>On the live RPC, the lock, the spacing guard and the logs default to the runtime copy's `var/`, so a manual run from the repo and the launchd job never sign twice.</li><li>`cre whoami` is bounded to 45 s.</li><li>A `run.lock` older than 20 min is treated as stale and removed.</li></ul> | `evidence/settle-path-selection-live-dry.txt`; a stale-lock age check was run by hand. |
| 5 | **`harness-run.ts`:** <ul><li>On a loopback fork, the default anchor is the fork's chain time, so a warped fork is settled at its own time.</li><li>It prints a `[path] HARNESS FALLBACK … NOT the CRE engine` marker.</li><li>HTTP goes through the new `e2e/http.ts`.</li></ul> | `evidence/jobs-fork-e2e.txt` §A1 (`[time] anchor 2026-10-08T18:06:19Z (fork chain time)`) |
| 6 | **Test-only `ISOTHERM_TEST_RELABEL` (fork only).** The METARs for Oct 8 do not exist yet, so the fork test serves LIVE 2026-10-06 archive data relabelled to 2026-10-08. Both jobs refuse it on a non-loopback RPC. `e2e/forge-report.ts` (fork only, refuses the live attester key) makes the wrong report used to test the watcher. | `evidence/jobs-fork-e2e.txt` (every `[TEST]` line is labelled) |
| 7 | **Docs:** `docs/OPERATIONS.md` §6 (settlement section only), and `README.md` and `RESULT.md` §1.7/§4 in this package. The old `launchd/com.isotherm.cre-settle.plist.template` was removed. | |
| 8 | **Live read-only wiring check.** The guardian, the attester and the balances match. `estimateGas challenge()` from the guardian reverts `NotChallengeable(RCSS, 20261008)` as expected. The gas price is 102 gwei. | `evidence/live-readonly-settlement-ops.txt` |

**Funding.** Each report bills 0.0204 MON (200k gas limit × 102 gwei), and the runner wants ≥ 0.025 MON before each
send. The attester (`0x63D2…0Bb9`, 0.10 MON) therefore covers **4 reports**, which is enough for Oct 8 and Oct 9.
Add about 0.3 MON for two weeks of Taipei. The guardian (`0x30C8…7d50`, 0.05 MON) covers about 7 challenges at
about 0.0064 MON each.

**Tests.** `bun test`: 84 pass, 3 fork-skip. `bun run typecheck` (the WASM code): clean. The WASM and `workflow.ts`
are unchanged.

**Not done / limits**
- **The official engine path has still never run on live,** because there is no login. The fork test proves its
  compile step under launchd, and the earlier patched-simulator evidence covers the rest.
- **The watcher runs on the same Mac as the attester key.** Verifier finding N6 asks for a separate machine that holds
  only the guardian key.
- **The Mac must stay awake and logged in.**
