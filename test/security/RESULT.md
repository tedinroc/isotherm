> **Status (2026-10-07, contracts v1):** every Medium (#1, #2, #4, #6, #7) and the cheap Lows (#8, #9, #10) are fixed in
> `src/` and deployed to Monad testnet (see `deployments/testnet.json`). #3 (CRE `decide()`) and #5 (maker kill switch) are
> off-chain and belong to the workflow and maker owners. The FINDING tests below were turned into `FIXED_*` tests that
> assert the exploit no longer works. Details: `script/RESULT.md`. The text below is the original review, kept unchanged.

# Isotherm security review: RESULT

Scope: `src/` (CollateralVault, StrikeFactory, OutcomeToken, Resolver, ForecastCommit, StationTime) and the Zap/integration contracts (`spikes/e2e/src/IsothermZap.sol`, plus a lighter look at `spikes/kuru/src/KuruZap.sol` and `spikes/dynamic/contracts/src/GaslessDepositor.sol`). Also the CRE workflow's settle decision, because on-chain results are final.
Reviewer date: 2026-10-06. Foundry 1.8.5, solc 0.8.37, `network = "monad"` gas schedule.

## Verdict

The core money path is sound. Nobody can drain collateral, double-redeem, profit from rounding or forge settlement. I found no Critical issue. The real risks sit in three places:
- **Trust and timing around settlement:** the stale-void window, guardian powers, the single attester key, and the CRE void policy.
- **Kuru integration:** the Zap accepts any verified book for the YES token, and maker quotes are exposed after close.
- **One configuration footgun:** fixed in `src/Resolver.sol`.

## Evidence (commands and real output)

| What | Command | Output |
|---|---|---|
| Full suite (existing + new), fork pinned | `MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FORK_BLOCK=68693965 forge test` | `Ran 14 test suites: 115 tests passed, 0 failed, 0 skipped` (was 84 before; +31 new) |
| New security tests only | `forge test --match-path 'test/security/*.t.sol'` | 26 passed; the 5 fork tests skip without the env var |
| Adversarial invariant | same | `invariants (runs: 128, calls: 12288, reverts: 0)`: 4 invariants pass. 8 attack selectors include forged signer, malleable twin, replay re-targeted to other ladders, direct onReport, over-redeem, token mint/burn, early void, garbage permit and attacker admin calls. `test_handlerPathsAllExecute` proves the settle, stale-void and redeem paths really run (`attackSuccesses == 0`) |
| Fork attacks on live state (real MockKeystoneForwarder, Kuru v1, AUSD) | `... FORK_BLOCK=68693965 forge test --match-path test/security/ForkAttacks.t.sol -vv` | 5/5 pass. Logs: `10 AUSD via canonical book -> YES 19980000`, `via hostile book -> YES 2000000`, `sniper profit 49900000` |
| Do the new tests catch bugs? | scratchpad `secreview/mutate.py` (inject, run, restore, sha256-check) | **6/6 injected bugs CAUGHT**, and all files were restored with verified hashes. The bugs: no attestation re-arm; signer not compared; `OutcomeToken.mint` not vault-only; `redeem` without `nonReentrant`; mint close `>` instead of `>=`; void payout rounds up. The `>` mutation was MISSED at first. I fixed that by biasing the fuzz to the boundary and adding `test_monadCloseAtDayEndSameSecondBoundary` |
| Live read-only checks (eth_call only) | `cast call` on Router `0x7EFb…4630` | `deployProxy(0, existingYES, AUSD, …, takerFee=9000, …)` from an arbitrary address returns a market address, so it succeeds. `takerFee=10000` reverts `0xa9269545`. `verifiedMarket(random)` returns all zeros |
| Live CRE spike Resolver `0xb7b9…ca09` | `cast call` | attestationRequired=true, forwarder=mock, attester `0xbAD0…BEde` ≠ owner, owner = guardian = deployer. Runtime is 11,034 B, i.e. **pre-fix code** |
| Deployer balance | `cast balance 0xb855…5c11` | 3.652621182 MON at nonce 9, below the 5 MON threshold, so **no live tx was sent** (none were needed for this review) |

## Fix applied (one change, in `src/Resolver.sol`)

`setForwarder` now re-arms attestation: if `attestationRequired` was false, it sets it to true and emits `AttestationRequiredUpdated(true)`.

- **Why:** the documented go-live is `setForwarder(prod)`, `setExpectedWorkflow`, then `setAttestationRequired(false)`. If the owner later points back at the permissionless MockKeystoneForwarder (to rerun `cre workflow simulate --broadcast`), the mock passes caller-written metadata through, and the pinned id is public via `expectedWorkflowId()`. Without the fix, anyone could then settle any ladder with an unsigned report.
- **Proof:** I proved the exploit against the **real** mock at `0xB9F7…d192` on a fork (`test_fork_RESIDUAL_*`: settles at Tmax = 70). The fix is covered by `test_FIXED_*` (unit and fork). Mutation M1 shows the test fails without the fix.
- **Cost:** +135 B runtime (11,034 → 11,169), `setForwarder` costs ~30–35k gas, and `onReport` is unchanged.
- **Compatibility:** the documented order still works, and the existing tests pass unchanged.

## Findings (most severe first)

| # | Sev | Finding | Test | Concrete fix |
|---|---|---|---|---|
| 1 | Medium (Fixed / residual) | Attestation-off behind a permissionless forwarder lets anyone settle anything. Fixed when you switch *back* to the mock. Still possible if the owner disables attestation *while still on the mock* (wrong order of the go-live steps) | `ResolverAttacks.test_FIXED_*`, `test_RESIDUAL_*`, `ForkAttacks.test_fork_*` | Done: re-arm on switch. Also: never call `setAttestationRequired(false)` before `setForwarder(0xF834…4482)`. Better, keep attestation always on (defense in depth with the DON) |
| 2 | Medium | **`voidIfStale` is a free option for the losing side.** The on-chain `STALE_WINDOW` is 24h, but the validated weather rule voids only at **36h** after day end. The CRE workflow has no Ogimet fallback and only looks at "yesterday" (`workflow.ts:118`), so it never catches up on a missed day. The IEM RCSS archive was down for 158 days in 2025-26, and in that state IEM returns fewer than 40 obs, so the workflow retries forever. Then the NO holder voids at +24h, and the YES winner gets 0.5 instead of 1 | `test_staleVoidLetsLosingSideFrontRunALateReport` | Set `STALE_WINDOW` to at least 48–72h (≥ the off-chain deadline plus margin). Add the Ogimet 2-of-3 fallback and catch-up of all `duePendingLadders` to the workflow |
| 3 | Medium | **CRE `decide()` voids on the FIRST disagreement** (`spikes/cre/project/settle/metar.ts:133-139`, minObs=40). The validated rule (`spikes/weather/src/settle-core.ts:7-9,122-131`) needs "complete" (≥20 hours, last report ≥23:00) and keeps a disagreement PENDING until the deadline. IEM lags AWC by 1–2h, so a premature VOID is possible, and on-chain results are final | code reading only, no test | Port `settle-core.ts decide()` into the workflow unchanged; use golden fixtures |
| 4 | Medium | **IsothermZap accepts any Kuru-verified YES/AUSD book.** Testnet market creation is permissionless, so anyone can add a 2nd book on our YES with a 90% taker fee or 0.999 asks. `verifiedMarket` reports base = YES and quote = AUSD, so `_market()` passes. A victim routed there with `minYesOut = 0` lost 90% (2.0 vs 19.98 YES for 10 AUSD) | `ForkAttacks.test_fork_zapAcceptsHostileSecondBookForSameYes` | Record the canonical market per seriesId on-chain (operator-set, write-once) and require `market == canonical[seriesId]`. Cap `takerFeeBps` and require the expected precisions. Clients must always pass `minOut` computed from `getL2Book` |
| 5 | Medium (ops) | **Kuru books keep matching after close, day end and settlement**, and Isotherm cannot halt them. A forgotten maker ask was sniped: +49.9 AUSD on 50 AUSD, risk-free. The day's max is effectively public from METAR hours before settlement | `test_fork_staleMakerQuotesAfterSettlementAreFreeMoney` | Maker kill switch: cancel all orders at closeTime from a separate watchdog. Skew or stop quoting once intraday METAR max ≥ strike. Withdraw margin after close |
| 6 | Medium (privileged) | **The guardian alone can turn any outcome into a void**: it pauses the Resolver at dayEnd, waits 24h, and `voidIfStale` ignores pause. Unpause cannot undo the void. The guardian defaults to the shared deployer key | `test_guardianPauseCanForceVoidOnAnyLadder` | While paused, extend the stale deadline (accumulate paused time), or allow `voidIfStale` during a pause only after a long max (e.g. 7 days). Use a separate guardian key |
| 7 | Medium (trust) | **A single hot attester key is final.** No dispute window; redemption is immediate. A leaked attester key (it lives on the Mac for the launchd cron) means: buy the wrong side cheap on Kuru, sign, redeem. The owner can also `setAttester`; the owner is the deployer key shared by several agents | design | Add a short challenge window before `redeem` pays (e.g. 2h) in which the guardian can convert to void. Use separate keys for owner, guardian, attester and operator; owner via `NEW_OWNER` on a key no bot uses |
| 8 | Low | **Permit doesn't bind seriesId**: a front-runner replays the relayer's `mintSetWithPermit` with another open series. No loss (sets redeem at par), but the flow fails and the user pays gas to unwind. A related point: `GaslessDepositor.depositWithPermit` (try/catch plus allowance fallback) lets anyone spend a holder's standing allowance, so don't port that pattern | `test_permitDoesNotBindSeries_frontRunnerChoosesTheSeries` | Add `mintSetWithAuthorization` via EIP-3009 `receiveWithAuthorization` (front-run-proof, since payee = caller), with `nonce = keccak256(abi.encode(seriesId, amount, salt))` recomputed in the vault |
| 9 | Low | **Attestations never expire.** A report whose delivery failed (sent 1s early, which can happen since ~3 Monad blocks share a second; or OOG under a tight Monad gas limit) stays valid in public calldata. If the workflow later signs a different outcome, the beneficiary picks which lands | `test_failedDeliveryLeavesAValidAttestationThatCanRaceANewerOne` | The workflow must never sign two outcomes for one (station, date): persist and reuse the first signed body. Or add `validUntil` to the EIP-712 struct. Deliver at ≥ dayEnd + 60s |
| 10 | Low | **Fee-on-transfer collateral breaks solvency.** The vault credits `amount`, not what it received. AUSD is upgradeable, and the constructor only checks decimals == 6 | `test_feeOnTransferCollateralMakesLastRedeemerInsolvent` | Check the balance delta in `_mintSet` (costs ~1 extra balanceOf), or document AUSD-only and pin it in the deploy script |
| 11 | Info | Void rounding: each call loses ≤0.5 base unit, and the dust is stuck forever (no sweep). A permit wipes a standing max approval. Clients must take the permit domain from `eip712Domain()`, not `name()` ("Isotherm Outcome" ≠ token name). `duePendingLadders` always scans from index 0: 43,182 gas + **14,925 per ladder** (cold, Monad schedule), about 2,000 ladders per 30M eth_call, so the CRE should keep a cursor. ForecastCommit: unrevealed commits must count as misses (selective reveal), and use a 32-byte random salt. `spikes/kuru/src/KuruZap.sol` trusts any `market`/`set` address: never deploy it | `testFuzz_voidRoundingNeverOverpays`, `test_voidOneUnitRedemptions…`, `test_permitOverwritesStandingAllowance`, `MonadGas.t.sol` | as stated |

### Checked and holding (no issue found)
- Per-series checked accounting: vault AUSD == Σ collateral == deposits − payouts.
- No double redeem (burn before pay); no cross-series redemption.
- Replay rejected across contract, chain (10143 and 143), station, date and every single field. The malleable twin (raw `ecrecover` accepts it), EIP-2098 64-byte signatures and dirty ABI words are rejected.
- Re-entry from a hooked collateral is blocked on all 6 attempts.
- Monad timestamp: for every closeTime ≤ dayEnd, mint and settle can never both succeed in one second, including 3 blocks sharing a second.
- Admins cannot move collateral, and exits work with vault and resolver both paused.
- Monad reserve-balance / EIP-7702: the contracts never hold or send MON, so there is no contract-level impact. It only affects relayer and deployer EOAs: keep >10 MON or value transfers revert.

## Human actions
1. Decide policy for #2, #6 and #7 (stale window length, guardian veto, challenge window); these are product choices I did not make unilaterally.
2. Split keys: owner (not the shared deployer), guardian, attester and operator/maker. Deploy with `ATTESTER`, `GUARDIAN` and `NEW_OWNER` set.
3. Redeploy any Resolver you keep: the live spike `0xb7b9…ca09` has pre-fix bytecode.
4. CRE go-live order is strict: `setForwarder(0xF834…4482)`, then `setExpectedWorkflow`, then (optionally) `setAttestationRequired(false)`.

## Next steps (for the owners of those files)
- **Workflow (spikes/cre):** port `settle-core.ts decide()` with the Ogimet fallback; add catch-up over `duePendingLadders` with a cursor; use sign-once persistence.
- **Zap (spikes/e2e):** add the canonical market registry and fee cap; keep `minOut` mandatory in the UI and plugin.
- **Maker bot:** kill switch at closeTime, plus intraday-max-aware quoting.
- **Vault:** add `mintSetWithAuthorization` with the series bound in the nonce; optionally the balance-delta check.

## Files
- `test/security/SecUtils.sol`: PermissionlessForwarder (mock-forwarder semantics), RawReport builder, HookToken, FeeToken
- `test/security/ResolverAttacks.t.sol` (12 tests), `VaultAttacks.t.sol` (11), `AdversarialInvariant.t.sol` (1 invariant suite + 1 test), `ForkAttacks.t.sol` (5, fork), `MonadGas.t.sol` (1)
- Changed: `src/Resolver.sol` (`setForwarder` only)
