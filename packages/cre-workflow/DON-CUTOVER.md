# Settlement on a Chainlink DON: prepared and rehearsed (not live)

**Status (2026-10-10).** Isotherm settles through the official CRE CLI v1.37.0
(`cre workflow simulate --broadcast`, one local node, MockKeystoneForwarder plus the v1 attestation), hourly on a small
Linux server since 2026-10-10 08:18 UTC (`docs/SETTLEMENT-VPS.md`, `docs/OPERATIONS.md` §6). Everything needed to run
the same workflow on a Chainlink DON is built and was rehearsed end to end on an anvil fork of Monad testnet:

- a `testnet-don` target on the private registry, with a gas limit measured against the production KeystoneForwarder;
- a gated cutover script and a rollback script, both dry-run by default;
- evidence records for DON settlements, read from the chain.

Running it on a DON needs CRE deploy access for the project's account. With access, the switch would take about
three hours, most of it waiting for two shadow executions, plus about 30 minutes of the owner's time (section 6).

Nothing in this document has been deployed or sent to live testnet. No live document's claims change until the first
DON settlement lands (section 8).

## 1. What changes, and what stays the same

| | Today (CRE CLI simulation) | On the DON (`testnet-don`) |
|---|---|---|
| Workflow code and WASM | `settle/` (binary `413d4429…`) | the same code and the same binary |
| Config | `config.testnet.json` | `config.don.json`: identical except `gasLimit` 200,000 → **420,000** |
| Who runs it | one local node on a small Linux server (on the Mac until 2026-10-10 08:18 UTC), hourly at :05 | the DON, on the workflow's own crons (02:00 Taipei, 02:00 Tokyo, hourly at :30) |
| Forwarder | MockKeystoneForwarder `0xB9F7…d192` (permissionless) | KeystoneForwarder 1.0.0 `0xF834…4482` (f+1 DON signatures) |
| Checks on every report | the EIP-712 attestation | DON signatures **and** workflow-owner pinning **and** the same attestation (v1 cannot switch it off) |
| Who pays report gas | the attester key (about 0.0204 MON per report) | the DON transmitter |
| Attester key | `~/.config/isotherm/attester.key`, read by the CLI | the same key, stored once in the Vault DON as secret `ISOTHERM_ATTESTER_KEY` |
| Registry | none (simulation) | private registry: no linked key, no Ethereum-mainnet gas, no onchain identity record |

On chain, going to production is two owner calls on the live v1 Resolver: `setForwarder(0xF8344CFd5c43616a4366C34E3EEE75af79a74482)`,
then `setExpectedWorkflow(0x00…00, <organization owner>)`. Only the owner is pinned, because any change of config or binary
gives the workflow a new ID.

## 2. Gas: measured on a fork, not guessed

`scripts/don-gas-fork.sh` (test `settle/e2e/don-gas.fork.test.ts`; evidence `evidence/don-gas-fork.{txt,json}`, run
2026-10-09 14:18 UTC at fork block 69,561,070) delivers our real v1 report, DON-signed, through the **production**
KeystoneForwarder bytecode into the **live** v1 Resolver bytecode on an anvil fork. The fork registers a throwaway
DON with the shape of the live DON reports on Monad testnet: donId 1, f = 3 (4 signatures), a 96-byte report context
and reportId `0x0000`. Both Resolver pins are set, so `onReport` takes its most expensive path. Every trial replays
from one snapshot with identical calldata (1,444 bytes).

| Gas limit | Outcome |
|---|---|
| 200,000 (today's `config.testnet.json`) | **whole transaction reverts**: `InsufficientGasForRouting` |
| 275,000 | reverts: `InsufficientGasForRouting` |
| **about 278,900** (278,863–278,887 across runs; it varies with the report bytes) | **minimum that settles**; one gas less reverts |
| 300,000 – 1,000,000 | settles: `ReportProcessed(result=true)`, `LadderResolved`, transmission `SUCCEEDED` |
| 420,000 (`config.don.json`) | settles; also with 6 DON signatures (f = 5 needs about 312,800) |

- The minimum is set by the forwarder, not by our receiver: `route()` keeps a 30,000-gas reserve and refuses to route
  with less than 130,000 left for the receiver, and the 63/64 rule applies on top. Gas actually used is about 239,700.
- **Sizing rule:** `max(350,000, ceil10k(1.5 × minimum))` = **420,000**. Monad bills the gas limit, so this costs the
  DON transmitter about 0.043 MON per report at 102 gwei. Our attester no longer pays for reports.
- **The simulation path keeps 200,000.** It goes through the MockKeystoneForwarder, where a report used 139,000–156,000, and
  there the attester pays the limit.
- **Fork fidelity.** `eth_estimateGas` of the same three read-only calls on live testnet and on the fork differs by
  +302 to +352 gas (0.4 % on the forwarder-sized call). The 1.5× margin covers that many times over.
- **Live reference.** The three latest live DON transmissions through the same forwarder carry 4 signatures, a
  141-byte raw report and gas limits of 319,490–319,518. Their receipts report `gasUsed` equal to the limit (Monad
  bills the limit), so live receipts cannot show consumption; the fork is where it is measured.
- **Rejections still hold** on the production path. Signatures from keys outside the DON config revert in the
  forwarder (`InvalidSigner`). A report carrying the simulator's owner `0xaa…aa` is refused by the Resolver
  (`result=false`). Once the switch is made, the MockKeystoneForwarder can no longer deliver anything (`InvalidSender`).

## 3. The `testnet-don` target

- `settle/workflow.yaml`: `testnet-don` with `deployment-registry: "private"`, `config-path: ./config.don.json`,
  `secrets-path: ../secrets.yaml`.
- `project.yaml`: a `testnet-don` RPC entry for `monad-testnet` (the same public RPC as `testnet`).
- `settle/config.don.json`: `config.testnet.json` with `gasLimit` `"420000"`.
- `secrets.yaml`: unchanged mapping, names only (`ISOTHERM_ATTESTER_KEY` ← `ISOTHERM_ATTESTER_KEY_ALL`). The value goes
  to the Vault DON from the owner's own terminal (section 6, C1).

**Validation** (`evidence/don-target-validate.txt`, 2026-10-09 14:21 UTC; no CRE login used):

| Check | Result |
|---|---|
| `bun test` | 93 pass, 11 skip (the fork suites, which need an anvil RPC), 0 fail. DON-specific: `config.don.json` equals `config.testnet.json` except the gas limit; the target points at the private registry; the handler run with `config.don.json` produces byte-identical reports with a 420,000 limit; the cutover time window, the production report header offsets, DON signature recovery and the sizing rule (`settle/test/don.test.ts`) |
| `bun run typecheck` | clean |
| `cre workflow build . -T testnet-don` | binary hash `413d4429…`, unchanged since 2026-10-07 (the workflow code did not change) |
| `cre workflow hash` | `testnet` reproduces the 2026-10-07 workflow hash `001aaae8…` exactly; `testnet-don` config hash `7acd5307…` |
| `cre workflow simulate -T testnet-don` | stops at authentication: `simulate` needs a CRE login, and this preparation does not use the login session. `build` and `hash` parse the same target |

The deployed workflow ID is derived from (owner, name, binary, config) by the same function `cre workflow hash` uses,
with the organization's owner. `don-cutover.sh` recomputes it from this checkout with the owner that
`cre workflow get` reports and refuses to switch unless the two match, which also confirms the owner the DON will
write into report metadata.

## 4. Scripts

| Script | What it does | Sends |
|---|---|---|
| `scripts/don-gas-fork.sh` | The gas measurement above, on its own anvil fork (port 19341) | nothing live |
| `scripts/don-cutover.sh` | Checks every gate and prints the exact owner calls with calldata and estimates. With `--execute`, when run by the Resolver owner and confirmed by typing the owner address, it re-checks the chain gates, sends `setForwarder` then `setExpectedWorkflow`, verifies by `eth_call`, and sets `activeForwarder` in `deployments/testnet.json` | only with `--execute`; owner key file read only then, never printed |
| `scripts/don-rollback.sh` | R1 `cre workflow pause`, R2 `setExpectedWorkflow(0,0)`, R3 `setForwarder(mock)`, R4 `eth_call` checks + `activeForwarder`, R5 runtime-copy `activeForwarder` + reload **only** `xyz.isotherm.cre-settle` | only with `--execute` |
| `scripts/don-evidence.sh` | Appends a record per settlement to `don-runs.jsonl`, labelled `don`, `mac` or `stale-void` by the forwarder that called the Resolver (the `caller` in `LadderResolved`). It decodes the DON header (workflow ID and owner, DON id, signature count), `ReportProcessed`, and the attestation signer against the attester at that block. With a CRE login it also attaches the matching `cre execution list` entry. `--tx <hash>` diagnoses one report transaction that did not settle: the workflow owner and ID it carried against the Resolver's pins, and the attestation signer | nothing (reads) |
| `scripts/don-rehearse-fork.sh` | The rehearsal in section 5 | nothing live |
| `scripts/lib-don.sh` | Shared helpers (network detection, gates, owner signer, sends) | |
| `scripts/run-official.sh` (changed) | The Mac job **stands down** when `Resolver.forwarder()` is not the mock: it logs `SKIPPED … settlement runs on the Chainlink DON`, exits 0 and signs nothing; its evidence record says `stoodDownForDon: true`. The installed job runs from the runtime copy, so that copy must be synced before the switch (gate 7) | |

**Cutover gates** (all must pass; the dry run shows each one):
1. `cre whoami` shows `Deploy Access: Enabled`. Only that line is read, never the account box.
2. `cre workflow get ./settle -T testnet-don` shows `ACTIVE`.
3. There is at least one `SUCCESS` execution, and the latest execution succeeded (the shadow).
4. The latest execution's logs (`cre execution logs`) contain the workflow's summary `nothing to settle (ladders=N, …)`
   with N ≥ 1: the DON read the Resolver and the Vault on monad-testnet. The dry run also prints on how many nodes.
5. The organization owner is known, is neither zero nor `0xaa…aa`, and the deployed workflow ID reproduces from this
   checkout with it.
6. The Mac job `xyz.isotherm.cre-settle` is not loaded. `--execute` always checks this with `launchctl print`.
7. The installed Mac job stands down by itself: the runtime copy's `run-official.sh` carries the forwarder check.
   `launchctl bootout` does not survive a restart (the plist stays installed, so launchd loads the job again at the
   next login), and an older copy would keep signing reports that can no longer land.
8. `Resolver.paused()` is false, and the Resolver still points at the MockKeystoneForwarder.
9. Nothing is due: no unresolved ladder past its day end, none due within the next hour, and no Settled ladder inside
   its 900 s challenge window.
10. The time is outside minutes :55–:10 (the Mac job runs at :05; the 02:00-local crons fire at :00), outside :25–:35
    (the DON's hourly :30 run), and outside 16:45–18:15 UTC (the daily first attempts, RJTT 17:00 Z and RCSS 18:00 Z).
    Gates 8–10 are checked again just before sending.
11. `--execute` only: the signer is `Resolver.owner()`, and the operator types the owner address.

Fork-only switches (`--fork-unlocked` to impersonate the owner, `--facts` to stand in for the CRE CLI and launchd) are
refused on live testnet. The live owner key is refused on a fork, because a transaction it signs for chain 10143 would
also be valid live. The CLI output fields the script reads (`workflow.workflowId/ownerAddress/status`,
`lastExecution.uuid/status`, the execution list and log JSON) were checked against the CLI v1.37.0 source.

## 5. Rehearsal on an anvil fork (`evidence/don-rehearsal-fork.txt`: 29 checks, 0 failures)

`scripts/don-rehearse-fork.sh` runs the whole switch against the live v1 contracts on a fork (2026-10-09 15:05 UTC,
fork block 69,570,289). It uses no MON, no real key, no CRE login and no launchd: the CRE and launchd answers come
from facts files, the DON is a throwaway signer set registered on the forked forwarder, and the attester is a public
test key. Temperatures settled on the fork are test values. The timeline is computed from the fork's own clock, so the
rehearsal can be re-run at any time of day. In this run the next allowed window came after the Taipei day end, so the
rehearsal first settled RCSS 2026-10-09 through the Mac path at 18:05 UTC, as the hourly job would, and switched
after its challenge window. (A run at 14:22 UTC the same day found a window at 14:40 and settled RCSS 2026-10-09 on the
DON path instead; the evidence file holds the latest run.)

1. **Refusals.** The cutover is refused for each of these: inside the :30 window (18:28 UTC); deploy access "Not
   enabled" (today's real state); no successful execution; a failed latest execution; a shadow run whose logs show no
   chain read; a workflow ID that does not reproduce with the organization owner; the Mac job still loaded; an
   installed Mac job without the stand-down check; fork-only flags on the live RPC; a key that is not the owner's; a
   wrong typed confirmation.
2. **Dry run READY at 18:40 UTC.** The exact calls were printed and the Resolver was unchanged.
3. **Cutover `--execute` as the impersonated owner.** Both owner calls succeeded (gas limits 41,565 and 61,877, about
   0.0106 MON), and the post-checks passed:
   - the production forwarder with the organization owner gets through to the attestation check;
   - owner `0xaa…aa` gets `InvalidWorkflowOwner`;
   - the mock gets `InvalidSender`.
4. **The Mac job stands down.** `run-official.sh` printed `SKIPPED` and signed nothing. A second cutover was a no-op.
5. **First DON settlement, 2026-10-10 18:00:30 UTC (02:00:30 Taipei).** A DON-signed report from another workflow
   owner came first: `ReportProcessed(result=false)`, nothing settled, and `don-evidence.sh --tx` named the owner
   mismatch and its fix. Then our organization's report for the live vault ladder RCSS 2026-10-10 went through the
   production forwarder with the 420,000 limit from `config.don.json`: `ReportProcessed(result=true)`,
   `LadderResolved(Settled)`, 239,511 gas used.
6. **Evidence.** `don-evidence.sh` wrote a `don` record (4 DON signatures, workflow owner = the organization owner,
   attestation by the attester) and two `mac` records: the fork's Mac-path settlement of RCSS 2026-10-09 and the real
   RCSS 2026-10-08 settlement, whose attestation matches the live attester at its block
   (`evidence/don-rehearsal-evidence.jsonl`).
7. **Rollback `--execute`.** R2 and R3 were sent, and the R4 checks passed. R1 (CRE pause) and R5 (launchd) were
   printed, not run, on the fork. The Mac preflight passed again, a Mac-path report through the MockKeystoneForwarder
   settled RJTT 2026-10-10, and a second rollback was a no-op.
8. **Gates right after a settlement.** A cutover was refused: the challenge window was open and the time was inside
   16:45–18:15 UTC.
9. **Key-file signing path.** Ownership was moved on the fork to a public test account, so the signing code ran
   without a real key. Cutover and rollback were then signed from a key file, at the next allowed window (18:40 UTC).

Also on live testnet, reads only (`evidence/don-live-dryrun.txt`, 14:23 UTC): the cutover dry run reports NOT READY
on the six CRE gates alone (no login and no deployment yet); every chain gate passed (not paused, still on the mock,
nothing due, challenge window clear, time window open), and the owner calls were estimated at 34,996 gas for
`setForwarder`. The rollback dry run reports nothing to change. (That run predates gate 7; it passes once the runtime
copy is synced, step C4.)

## 6. Cutover day: the owner's steps

Run everything from `packages/cre-workflow` in the owner's own logged-in terminal, with
`export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"`. Times are UTC; the Taipei ladder settles at
18:00 (02:00 Taipei).

| Step | Who | When (UTC) | Command / action |
|---|---|---|---|
| C0 | owner | any time | `cre whoami` shows `Deploy Access: Enabled`; `cre registry list` lists `private` |
| C1 | owner (browser OAuth) | any time | Store the attester key in the Vault DON without echoing it: `ISOTHERM_ATTESTER_KEY_ALL="$(tr -d '[:space:]' < ~/.config/isotherm/attester.key)" cre secrets create secrets.yaml -T testnet-don --secrets-auth=browser`. Keep this same attester key through judging, so a rollback needs no `setAttester` |
| C2 | owner | a nothing-due window: from about 18:40 (after the night's settlement and its 15-minute challenge window) until about 12:00 the next day, so two shadow runs and C4 still fit before 15:00; avoid :55–:10 and :25–:35 | `cre workflow deploy ./settle -T testnet-don --yes`, then `cre workflow get ./settle -T testnet-don`. Note the workflow ID and the owner address. While the Resolver still points at the mock, any DON write fails with `InvalidSender` inside the forwarder and changes nothing |
| C3 | owner | after at least two hourly :30 runs | `scripts/don-cutover.sh --no-launchd-probe` (dry run). Everything but the Mac-job gates (6, and 7 until the sync in C4) must pass; gate 4 prints the summary line and how many nodes logged it. If the chain reads failed (`cre execution list <workflow ID>`, `cre execution logs <uuid>`): `cre workflow pause ./settle -T testnet-don --yes`, stay on the Mac, and send the logs to Chainlink |
| C4 | owner | the same window, before 15:00 | `scripts/deploy-runtime.sh` (sync only, no `--load`: the installed job then carries the stand-down check, gate 7), then `launchctl bootout gui/$(id -u)/xyz.isotherm.cre-settle` (the plist stays installed, so launchd loads it again after a restart and it stands down by itself), then `scripts/don-cutover.sh --execute` and type the owner address. It sends the two owner calls (about 42k and 62k gas limit, about 0.011 MON) from `~/.config/isotherm/deployer.key` and verifies them |
| C5 | owner or agent | from about 18:05 | `scripts/don-evidence.sh` (a `don` record), and `cast call 0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B 'resultOf(bytes4,uint32)((uint8,int16,uint64,uint64,bytes32))' 0x52435353 <date> --rpc-url https://testnet-rpc.monad.xyz`. The Worker watcher should show MATCH within 15 minutes, and no `SETTLEMENT OVERDUE` alert should appear at 19:00 |
| C5b | owner | no `LadderResolved` by 19:40 (after the 18:00, 18:30, 19:00 and 19:30 runs) | `scripts/don-rollback.sh --execute`. The Mac's next :05 run settles through the mock. Before that, if the DON's execution logs (`cre execution logs <uuid>`) show a report tx (`tx <hash> -> not-accepted`), run `scripts/don-evidence.sh --tx <hash>`: when it names a workflow-owner mismatch and the report's workflow ID is our deployed one (`cre workflow get`), `setExpectedWorkflow(0x00…00, <that owner>)` fixes it without a rollback |
| C6 | agent, then owner | after the first DON settlement | Merge the prepared live-document text (section 8). Copy that day's `don-runs.jsonl` record into `evidence/`. Commit `deployments/testnet.json` (`activeForwarder`). Keep the Mac plist installed but unloaded through Nov 3. Rotate the attester after judging (a new key into the Vault DON, then `setAttester`) |

### 6.1 If the hourly job runs on the VPS (`vps/README.md`)

After `vps/cutover.sh`, settlement runs on a Linux VPS under `isotherm-settle.timer`, and the Mac job is unloaded and
disabled.
- **C4.** No `launchctl` step is needed. Leave the VPS timer on: the VPS runs the same `run-official.sh`, so it stands
  down by itself once `Resolver.forwarder()` is not the mock.
- **Gates.** Gate 6 passes because the Mac job is unloaded. Gate 7 passes because `cutover.sh` synced the Mac's runtime
  copy.
- **Rollback, R5.** `scripts/don-rollback.sh` does not reload the Mac job while the Mac's runtime copy holds
  `var/writer.released`; it says so instead. The VPS's next :05 run settles through the mock.
- **`deployments/testnet.json` on the VPS** must say `activeForwarder` = mock for the harness fallback. Do not push to
  the VPS during the DON period, or run `vps/push.sh` again after the rollback.

## 7. Rollback, and why each step is there

- **R1 `cre workflow pause`** stops DON executions. If CRE itself is the problem and the pause fails, the script
  carries on: after R3, any DON report fails with `InvalidSender` and changes nothing.
- **R2 `setExpectedWorkflow(0, 0)` is mandatory, and it comes first.** The MockKeystoneForwarder always passes owner
  `0xaa…aa`. If the owner pin were left in place, every Mac report would fail `_checkWorkflowMetadata`.
- **R3 `setForwarder(0xB9F79d863261869B234c481D1f9A7af84AeAd192)`** brings back the Mac path.
- **R4** checks by `eth_call` that the mock gets through to the attestation and the production forwarder is refused.
- **R5** sets `activeForwarder` back to the mock in the runtime copy too (the harness fallback delivers to it), then
  reloads only the settlement job. The challenge watcher stays on the Cloudflare Worker;
  `deploy-runtime.sh --load` would also start the Mac watcher.
- **No time gate.** Rollback is the emergency path, and owner calls work while the Resolver is paused. If a DON
  attestation and a Mac attestation exist for the same city-day, the Resolver is write-once and both come from the
  same rule, so only one can land and it carries the same result.
- Cost: about 0.0084 MON from the owner key (two calls).

## 8. The live documents after a cutover

No live document changes until a first DON settlement exists. The replacement text for `docs/OPERATIONS.md`,
`ARCHITECTURE.md`, `packages/cre-workflow/README.md` and the web app's "How it works" screen is kept as a private draft
outside this repository, so nothing here reads as a DON settlement before one has happened.

## 9. Open questions for Chainlink

- **EVM reads.** Can a deployed DON do EVM reads (`callContract` at the finalized block) on monad-testnet, and which
  block does it treat as finalized there? This is strongly implied but unverified: reads and writes share one
  capability ID per chain, and production DON writes on Monad testnet are live. Gate 4 checks it on the shadow runs
  before any Resolver change.
- **Gas limit semantics.** Is `gasConfig.gasLimit` the limit of the whole transmission transaction, or of the receiver
  call only? The docs say "gas limit for the transaction". Either way, 420,000 covers the measured 278,887 minimum with
  margin.
- **Private registry.** It is in beta (3 workflows per organization). CRE credit pricing is unpublished, and the
  activation time after `cre workflow deploy` is unknown.
- **Secret custody.** How the Vault DON releases the attester key to nodes is not documented here. The key stays in a
  different trust domain from the guardian key, which lives on the Cloudflare Worker.
