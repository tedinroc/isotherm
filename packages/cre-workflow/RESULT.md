# packages/cre-workflow: RESULT (2026-10-07)

**Verdict: done, with one human step left.** The product workflow is built and tested. It settles the live v1 contracts
(Resolver `0x9c78…962B`, Vault `0xae36…7B39`) and implements the validated rule exactly. It also:
- catches up on every due ladder within the CRE quotas;
- emits the v1 report with an EIP-712 attestation that is byte-identical to the contracts agent's cast-signed vector;
- builds to WASM without a login.

It has been proven against the deployed bytecode three ways, all on anvil forks with 0 MON spent:
- the bun SDK harness;
- the CRE simulator engine running our compiled WASM;
- a live read-only dry run.

**I sent nothing to live testnet.** Running the unpatched `cre workflow simulate --broadcast` on live testnet needs a
human `cre login`. `scripts/run-official.sh` detects a missing login and prints the steps.

The first real ladder is the maker's **RCSS 2026-10-08** (strikes 28–31, 300 AUSD each, closes 17:30 Taipei).
It becomes settleable at **2026-10-08 18:00Z (02:00 Taipei, Oct 9)**.

Tooling: CRE CLI v1.37.0 (sha256-pinned), `@chainlink/cre-sdk` 1.23.0, bun 1.4.2, Foundry 1.8.5, Node 22.

## 1. What works, with evidence

### 1.1 The settlement rule is implemented exactly, on the validated code
- `settle/settle-core.ts` is **byte-identical** to `packages/forecast/src/settle-core.ts` and
  `spikes/weather/src/settle-core.ts` (sha256 `119832de…3d62`). A test enforces this.
- The URLs, parsers, the completeness rule (≥ 20 distinct local hours AND last report ≥ 23:00 local) and `decide()` are all used unchanged.
- Each source is fetched in CRE node mode and reduced to a numeric Observation. The DON takes the per-field median.
- A test proves that the reduction (body → Observation → median → DayStats) equals settle-core's `dayStats` on every fixture.
- A median that falls between disagreeing nodes (for example 29.5) makes that source incomplete. It never produces a half degree.

Golden days use real captures and are compared with Polymarket's resolved winners. Two of them are new captures for this package:

| Day | IEM | AWC | Ogimet | Workflow | Polymarket |
|---|---|---|---|---|---|
| RCSS 2026-10-05 | 29 | 29 | – | SETTLED 29 | 29 |
| RJTT 2026-10-05 | 22 | 22 | – | SETTLED 22 | 22 |
| RCSS 2026-10-06 (new) | 25 | 25 | 25 | SETTLED 25 | 25 |
| RJTT 2026-10-06 (new) | 26 | 26 | 26 | SETTLED 26 | 26 |
| RCSS 2026-05-04 | 25 | aged out | 25 | SETTLED 25 (2-of-3) | 24 (resolver-side miss; see weather RESULT) |
| RCSS 2025-11-15 | 20 (1 report) | – | 26 | PENDING, then VOID after 36 h | n/a |

Fidelity over all days, from the weather spike and not re-derived here: **183/184 RCSS, 209/209 RJTT**.

### 1.2 The decision policy adds three guards on top of `decide()` and never changes it
- **Disagreement → PENDING.** Complete IEM and AWC that disagree stay PENDING until **dayEnd + 36 h**, then VOID. Before
  that point no report is written; the fallback is not consulted (the validated rule).
- **A fetch failure never voids (new).** Found on live data: Ogimet throttles back-to-back queries and answers in about
  7.8 s, close to CRE's 10 s HTTP timeout. In the first WASM run that turned RCSS 2026-05-04, which should settle at 25,
  into a VOID. Fix:
  - every source now reports whether its answer looked like a genuine archive response;
  - "genuine" includes aviationweather's definitive no-data answers: HTTP 204, an empty body, and HTTP 400 "Data is
    available for up to 30 days" (captured today);
  - after 36 h, VOID is allowed only if every consulted source was healthy;
  - a **46 h backstop** voids regardless, still before the on-chain 48 h `STALE_WINDOW`, so no third party needs to call `voidIfStale`.
- **At most one Ogimet query per run.** It is configurable. Further fallback days wait for the next hourly run, which is
  logged as `deferred`. The workflow never decides, and never VOIDs, without consulting the fallback.
- **Proof in the CRE engine with live data** (`evidence/sim-fork-fallback.txt`):
  - RCSS 2025-11-15 → VOID: one complete source, all sources healthy.
  - RCSS 2026-05-04: deferred in run 1, then **SETTLED 25 by 2-of-3** in run 2.

### 1.3 Catch-up with a cursor, within CRE quotas
- **Due ladders.** `ladderCount()` plus `duePendingLadders(start, 32)` pages over the newest 64 ladders (at or above `ladderCursorStart`).
- **Order and gate.** Targets run oldest dayEnd first. Nothing is attempted before **dayEnd + 2 h**, which is 02:00 local
  and the delivery floor, and never earlier than dayEnd + 60 s.
- **HTTP batching.** Each station-date costs 2 HTTP calls (IEM + AWC), plus 1 Ogimet call only when needed.
- **Hard caps.** 15 HTTP calls, 15 EVM reads (with reads reserved for post-write confirmations), and 5 reports per run.
  Anything left over is `deferred` to the next hourly run.
- **Tests.**
  - A backlog of 8 due ladders uses ≤ 15 HTTP calls and writes 5 reports; the next run writes the other 3.
  - Paused Resolver → no HTTP and no writes.
  - Unknown station → skipped.
  - `extraTargets` (replay only) settle only if `resultOf` is None.
- **Live dry run** (`evidence/dry-run-live.txt`). Against live testnet the workflow reads the real vault. Replaying
  RCSS and RJTT 10-06 gives tmax 25 and 26, and an `eth_call` of `onReport` as the forwarder fails only with
  `InvalidAttestation`, because a throwaway key was used on purpose. Every other check passes on the live contract:
  day over, not resolved, encoding, range.

### 1.4 v1 report and attestation
- **Encoding.** `abi.encode(bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash, uint64 validUntil, bytes sig)`.
- **Signature.** 65 bytes r||s||v (v = 27/28, low-s), RFC 6979 deterministic.
- **EIP-712.** Domain "Isotherm Resolver" v1 / 10143 / Resolver, typehash `0x5bbd…0535`.
- **Byte-for-byte match** with `script/attestation-vector.json`: the digest, the signature and the full report bytes
  all equal the cast-signed vector. The domain separator equals the deployment's `0xc64a…e9b5`.
- **`validUntil` = anchor + 1500 s**, where anchor = min(cron `scheduledExecutionTime`, DON time `runtime.now()`).
  Both values are consensus-identical across nodes:
  - On a DON, the anchor is the scheduled time.
  - Finding: `cre workflow simulate` passes the **next** fire time, 06:30Z for a 05:48Z run. Without the min(),
    `validUntil` would be about 67 min ahead, and the 02:00 and 36 h gates would open up to an hour early. Fixed and
    tested, and the engine shows `triggerTime 05:53:13Z / scheduledTime 06:30Z`.
- **Never two live signatures for one station-date.** Cron fires are at least 30 min apart (a test enumerates 3 days of
  fires); the TTL is 25 min; there is one signature per station-date per run. The runner adds a 30-min spacing guard and a lock.
- **`sourcesHash`** = keccak256 of a published canonical string that anyone can recompute from the public archives, for example
  `isotherm-sources-v1|RCSS|20261006|SETTLED|IEM:25,44,24,23:30,1|AWC:25,44,24,23:30,1|OGIMET:-`.
  A failed source is written as `unavailable`.

### 1.5 Round trip against the live v1 bytecode on an anvil fork (`evidence/fork-e2e.txt`, 3/3 tests, 79 expects)
The Resolver's attester is pointed at a public test key through owner impersonation, so the real key is never used.

**A. Our report is accepted through the real MockKeystoneForwarder.**
- `ReportProcessed.result=true`, `LadderResolved(RCSS,20261006,Settled,25)`, `finalAt − resolvedAt = 900`, 149,875 gas used.
- Our digest equals `settlementDigest()` read by `eth_call`.
- 9 tampered reports are delivered. Each tx succeeds (the mock never reverts), but `ReportProcessed.result=false`. The
  decoded reasons are: tmaxC flipped / VOID flag flipped / wrong key / chainId 143 / v0 Resolver domain → `InvalidAttestation`;
  expired → `AttestationExpired`; high-s → `ECDSAInvalidSignatureS`; future day → `DayNotOver`; tmaxC 71 → `TmaxOutOfRange`.
- A replay gives `AlreadyResolved`. A direct EOA call gives `InvalidSender`.

**B. The real handler does a catch-up run over the vault** (SDK harness; reads are `eth_call` at finalized; writes use
the simulator's forwarder call). It includes the **live maker ladder RCSS 2026-10-08**, reused on the fork.
- 02:00 Taipei: RJTT and RCSS 10-08 are settled (22 and 29, from 10-05 data relabelled to the future dates, test only).
  RCSS 10-09 has a tampered AWC and stays PENDING.
- One hour later: still PENDING, and no transaction.
- At dayEnd + 36.5 h: VOID, at a `resolvedAt` before `staleAt`.
- After the 900 s window: `payoutHalves` is correct for every series. RCSS k28/k29 = 2/0, k30/k31 = 0/2; RJTT k21/k22 = 2/0,
  k23 = 0/2; the void ladder pays 1/1.

### 1.6 The CRE engine running our compiled WASM, with live METAR data, on an anvil fork
These runs used the spike's dev build of CRE CLI v1.37.0, with only the client-side login check removed (dev evidence only):
- **`evidence/sim-fork.txt`.** Binary hash `413d4429…`. Replaying RCSS and RJTT 10-06 settles 25 and 26.
  `confirm.ts` decodes both receipts as `ReportProcessed.result=true` + `LadderResolved`; gas used is 156,383 and 139,407.
  Rerun → `already-resolved`, no transaction. Replaying the exact calldata gives `ReportProcessed.result=false`,
  and `confirm.ts` exits 4.
- **`evidence/sim-fork-fallback.txt`.** See §1.2.
- **`evidence/sim-fork-trigger{0,1}.txt`.** The `TZ=Asia/Taipei 0 0 2 * * *` and `TZ=Asia/Tokyo …` triggers are accepted
  by the engine; their next fires are 18:00Z and 17:00Z, which is 02:00 local.

### 1.7 Build, runner and launchd
- **`cre workflow build` succeeds with no login** (`evidence/build.txt`). The WASM is 2,816,479 B, hash `413d4429…`,
  identical for both targets, with no non-determinism warnings. `cre workflow hash` gives workflow hash `001aaae8…73ef`
  for owner `0xb855…5c11`. A real deployment's ID depends on the CRE account that owns it.
- **`scripts/run-official.sh`.** Official `cre workflow simulate ./settle -T testnet --broadcast`. It detects a missing
  login (exit 3 with exact steps) and refuses a patched CLI.
  - Preflight, run live (`--preflight-only`, reads only): the attester key file's address equals the live
    `Resolver.attester()` `0x63D2…0Bb9`; the tx sender holds 0.100 MON; the vault has 1 ladder.
  - Then a 30-min spacing guard and a lock, the run, and receipt confirmation (`settle/e2e/confirm.ts`, which also
    decodes the spike's live txs `0x999c…`/`0x482d…` correctly).
  - It refuses the live attester key on any non-live RPC (shown in `evidence/harness-fork.txt`).
- **Harness fallback (`--harness` / `--harness-if-no-login`): NOT the CRE engine.** The same handler runs under Bun and
  delivers the same attested report through the same forwarder call, so the live ladder can settle before anyone logs in.
  Proven on a fork (`evidence/harness-fork.txt`):
  - the 10-06 replay settled and was confirmed;
  - at 02:05 Taipei on Oct 9 the live RCSS 10-08 ladder was found as due and correctly left PENDING, because its data does not exist yet.
- **Superseded on 2026-10-07 (ops round, see `FIXES.md`):** the old `com.isotherm.cre-settle` template ran from
  `~/Documents` and would have failed with exit 126 (macOS TCC). It was replaced by two LaunchAgents that run from the
  runtime copy `~/isotherm-live/packages/cre-workflow` and are **installed and loaded**:
  - `xyz.isotherm.cre-settle`, hourly at :05. It takes the official path when `cre whoami` succeeds and the labelled
    harness fallback otherwise, and it writes an evidence record per run.
  - `xyz.isotherm.challenge-watch`, every 120 s.

  Both were run by launchd end to end on a warped anvil fork (`evidence/jobs-fork-e2e.txt`).

### 1.8 Tests: 84 pass + 3 fork e2e pass (`evidence/bun-test.txt`, `evidence/bun-test-junit.xml` lists all 87 by name)
- **Golden fixtures and settle-core identity:** 13.
- **Source reduction and health:** 22.
- **v1 encoding and vector:** 8.
- **Plan, cursor, calendar and cron policy:** 13.
- **Config ↔ deployments ↔ ABI:** 6.
- **SDK-harness handler:** 22, run against a model of `Resolver.onReport`'s acceptance rules, with real signature recovery.
- **Fork e2e:** 3, run against the live bytecode.
- **Typecheck:** `tsc --noEmit` is strict and clean for `main.ts` and everything it imports, which is the code in the WASM.
  Test and e2e files run under bun only; the SDK mock typings use protobuf `Message` types.

## 2. Costs and limits

| | |
|---|---|
| Report gas used | 139k–156k accepted (the simulator adds 4 signatures + context); 82k–101k rejected. **Limit 200,000 → 0.0204 MON per report** at 102 gwei (Monad bills the limit) |
| One run | 2 targets: about 13 s in the engine (HTTP 1–8 s per call; Ogimet is the slowest). Harness: 8.3 s |
| Per run | ≤ 15 HTTP calls, ≤ 15 EVM reads, ≤ 5 reports, ≤ 1 Ogimet call; responses ≤ 27 KB (CRE limit 250 KB) |
| Tx sender funds | The attester holds 0.1 MON, about 4 reports. One city needs 1 report per day |

## 3. Honest boundary: what does not work, or needs care
1. **The official engine path has never run.** No login exists. The WASM in the CRE engine is proven only through the
   spike's patched dev build on forks. No live transaction was sent; my task allowed none.
2. **Trust is the simulation forwarder plus attestation, until CRE deploy access exists.**
   - The MockKeystoneForwarder is permissionless. The only authentication is the single attester key's EIP-712
     signature, bounded by `validUntil` and the guardian's 900 s challenge window. The guardian still holds 0 MON.
   - In simulation the "DON" is one local node, so the median consensus adds nothing.
   - BFT value needs a real deployment: deploy access, the production KeystoneForwarder `0xF834…4482`, and `setExpectedWorkflow`.
   - Even then, the v1 Resolver always requires the attester signature (a contracts design choice).
3. **The fallback source is fragile.** Ogimet is slow (about 7.8 s against the 10 s HTTP limit) and throttles. The health
   gate and backstop keep this from producing a wrong VOID, but such days stay PENDING longer. AWC keeps only 30 days,
   so older days rely on IEM + Ogimet.
4. **The harness fallback is not CRE.** If it is used, evidence must say so.
5. **Tests use relabelled data.** The fork tests' 10-08/10-09 values reuse 10-05 data shifted to future dates (test only).
   The live 10-08 ladder will be settled from its own real data.
6. **Not audited.**

## 4. Human actions
(Updated 2026-10-07. The settlement job and the challenge watcher are installed, so no step is required for the
RCSS 2026-10-08 ladder to settle. Without a login, it settles through the labelled harness fallback.)
1. **Optional: log in to CRE, so the job takes the OFFICIAL path.** Do it once, at any time before
   **2026-10-08 18:05Z**. The job checks `cre whoami` on every run.
   - Go to https://app.chain.link/cre/discover and choose "Create an account". You need an email, a 6-digit code, a
     password and an authenticator for 2FA.
   - Then run:
     ```bash
     cd ~/isotherm-live/packages/cre-workflow && export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
     cre login && cre whoami
     bash scripts/install-launchd.sh --status        # after the next :05 run: "latest settle run ... path=official"
     ```
2. **Fund the report sender.** `0x63D2523dDC4BB055A19682Bf2d61fe94959D0Bb9` (the attester, also the default tx sender)
   has 0.1 MON. That covers 4 reports at 0.0204 MON each, which is enough for Oct 8 and Oct 9. Add about 0.3 MON for
   two weeks of Taipei, or set `ISOTHERM_TX_KEY_FILE` to a funded key. The guardian's 0.05 MON covers about 7
   challenges at about 0.0064 MON each.
3. **Keep the Mac awake and logged in around 02:00–03:00 Taipei** (11:00–12:00 PDT the day before). launchd runs a
   missed job when the Mac wakes, but sleep delays settlement.
4. **Optional, for a real DON:**
   - run `cre account access`, then (with the CRE secret set) `cre workflow deploy ./settle -T testnet`;
   - from the owner key, call `setForwarder(0xF834…4482)` and `setExpectedWorkflow(id, owner)`;
   - **unload the settle job** (`scripts/deploy-runtime.sh --unload`, or `launchctl bootout gui/$(id -u)/xyz.isotherm.cre-settle`),
     so that two signers never overlap.

## 5. Interfaces for others
- **Status.** Watch `Resolver.LadderResolved` and `LadderChallenged`, or read `resultOf(station,date)`.
- **Timeline per ladder:**
  - first attempt at dayEnd + 2 h (02:00 local), then hourly retries (on a DON: the :30 UTC cron; on this Mac: the launchd job at :05);
  - VOID on disagreement or missing data only after dayEnd + 36 h with healthy sources;
  - backstop at 46 h;
  - on-chain stale void at 48 h.
- **For live RCSS 2026-10-08:** attempts from 2026-10-08 18:00Z, deadline 2026-10-10 04:00Z, backstop 14:00Z, stale 16:00Z.
- **`sourcesHash`** is keccak256 of `isotherm-sources-v1|ICAO|yyyymmdd|STATUS|IEM:t,n,h,HH:MM,c|AWC:…|OGIMET:…`, where
  `-` means not fetched and `unavailable` means error/timeout/throttle. The web can show the per-source values from the
  workflow result JSON.
- **Config.** `settle/config.testnet.json`. Addresses are checked against `deployments/testnet.json` in tests.
