# Isotherm contracts v1: RESULT (2026-10-07)

**Verdict: done.** All 7 Medium findings from the security review and the independent verification are fixed or moved
off-chain, along with the cheap Lows. 134/134 tests pass. 22/22 injected bugs are caught. The v1 stack is **live on
Monad testnet 10143** and source-verified (Sourcify `exact_match` on two verifiers). A cast-signed end-to-end run
against the *deployed* bytecode (on an anvil fork) passes. No ladders and no markets were created on the live chain.
That is the go-live step.

The v0 feasibility result is kept as `script/RESULT-v0-feasibility.md`.

## Live deployment (single source of truth: `deployments/testnet.json`)

| | address | deploy tx |
|---|---|---|
| Resolver | `0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B` | `0x80f5f607…cf75e` (block 68,884,377) |
| CollateralVault (= factory) | `0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39` | `0xc1be9aab…d56f1` |
| IsothermZap | `0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0` | `0xb30472f1…6a804` |
| OutcomeToken impl | `0x5EfaB33DDad0715b66f514Fe12d78Ca23f3e31fC` | created by the vault constructor |

- **Stations.** `registerStation` RCSS = +28,800 s (`0xea018c8c…`) and RJTT = +32,400 s (`0xeb126bef…`).
- **Operator.** `setOperator(operator)` (`0xc13e88ed…`).
- **Funding.** The operator got 0.15 MON (`0xf3b482e0…`) and the attester 0.1 MON (`0x54236068…`). The full hashes are
  in the JSON.
- **Roles.** Each role has its own key in `~/.config/isotherm/*.key` (chmod 600, never printed):

  | role | address |
  |---|---|
  | owner (deployer) | `0xb855…5c11` |
  | guardian | `0x30C8E371719Ff00577284dd9c10587Fa89357d50` |
  | attester | `0x63D2523dDC4BB055A19682Bf2d61fe94959D0Bb9` |
  | operator | `0x602dbf3937558B1d18d76315635fD5410089bd51` |

  The deploy script refuses to run if any role equals the deployer.
- **Cost.** The deploy was billed **1.0625 MON**: 10,315,665 gas limit at 102 gwei with a 1.08 multiplier, inside the
  1.3 budget. Including the funding, the deployer spent 1.3168 MON and now holds 4.6603 MON.
- **Rehearsal.** The same script ran on an anvil fork first (`script/evidence/deploy-anvil/`). It produced the same
  addresses and a gas limit of 10,229,586.
- **Verification.** `script/verify-sourcify.sh` reports `Status: exact_match` for all 4 contracts on
  `https://sourcify-api-monad.blockvision.org/` (MonadVision) and on `https://sourcify.dev/server/`. The sourcify.dev v2
  lookup shows runtimeMatch `exact_match` for all four. Logs: `script/evidence/sourcify-verify*.txt`.
- **Exports.** The ABIs are in `packages/abi/*.json`, written by `script/export-abi.sh`. Each file is a plain ABI array
  ready for viem. Addresses are in `addresses.json`.

## Fixes (what changed, and the test that proves each one)

| # | Finding | v1 fix | Proof |
|---|---|---|---|
| a | Stale-void free option (24 h < the workflow's 36 h); guardian forces a void via pause | `STALE_WINDOW = 48 h`. While paused, `voidIfStale` is blocked. After any unpause, the workflow gets `RESUME_GRACE = 24 h` before anyone may void. `MAX_STALE_WINDOW = 7 d` is a hard liveness bound that works even while paused. New view `staleAt(station,date)` | `test_FIXED_staleVoidCannotFrontRunAReportWithinWorkflowDeadline`, `test_FIXED_guardianPauseCannotForceStaleVoid`, `test_staleVoidBlockedWhilePausedUntilHardMax`, `test_resumeGraceAfterUnpause`, `testFuzz_staleVoidNeverBeforeWindow` |
| b | A single attester key is final; no dispute | Deploy-time `challengeWindow` (testnet 900 s, max 2 d). A **Settled** result gets `finalAt = resolvedAt + challengeWindow`. Before then, only the **guardian** can call `challenge(station,date,reasonHash)`, which converts it to Void (0.5/0.5) and makes it final at once. Void results (reported or stale) are final immediately. The vault's `redeem`, `payoutHalves` and `previewRedeem` revert `NotFinal` until `finalAt`. `redeemSet` (a complete set at par) is always open | `test_FIXED_compromisedAttesterContainedByChallengeWindow`, `test_guardianChallengeConvertsToVoid`, `test_challengeRules`, `test_redeemWaitsForChallengeWindow`, `test_challengedResultPaysHalf`, the invariant `challenge`/`lateChallenge` actions |
| c | The Zap accepts any Kuru-verified book (hostile 90 % fee) | `src/IsothermZap.sol`. A write-once `canonicalMarket[seriesId]` set by a vault operator or the owner. It is validated against `Router.verifiedMarket`: base = series YES, quote = AUSD, 6/6 decimals, pricePrecision 1e4, sizePrecision 1e6, taker fee ≤ 30 bps, maker fee ≤ taker fee. Every flow requires `market == canonical`, a non-zero min-out and a non-zero recipient, and trades only before the series' closeTime | `test_fork_FIXED_zapRejectsHostileSecondBookForSameYes` (real Kuru), `IsothermZapTest` (4 offline tests), live-bytecode e2e step 3/5 |
| d | A permit does not bind the series (front-run) | `mintSetWithAuthorization(seriesId, amount, holder, validAfter, validBefore, salt, v, r, s)` uses AUSD EIP-3009 `receiveWithAuthorization`, with `nonce = keccak256(abi.encode(seriesId, amount, salt))` recomputed by the vault. Payee == caller, so only the vault can consume it. `mintSetWithPermit` is kept for 2612-only wallets (documented residual) | `test_mintSetWithAuthorizationCannotBeRedirected`, the fork step `_step4b_authorizationMint` on **real AUSD**, live-bytecode e2e step 4 |
| e | Fee-on-transfer collateral overstates reserves | Every deposit path credits only if the vault's AUSD balance grew by exactly `amount`, else `CollateralTransferMismatch` | `test_FIXED_feeOnTransferCollateralCannotOverstateReserves`, `test_feeOnTransferCollateralRejected` |
| f | Attestations never expire | `validUntil` (uint64, inclusive) is signed in the EIP-712 struct and checked in `onReport`. **Attestation can no longer be switched off** (`setAttestationRequired` was removed), which also closes finding #1 (attestation off behind the permissionless mock) in every order of go-live steps | `test_FIXED_expiredAttestationCannotRaceANewerOne`, `test_attestationExpiry`, `testFuzz_expiredAttestationNeverAccepted`, `test_FIXED_unsignedReportRejectedWhateverTheForwarderConfig`, `test_fork_FIXED_realMockForwarderNeverAcceptsUnsignedReports` |
| g | Shared keys | Owner, guardian, attester and operator are 4 different keys, enforced in `Deploy.s.sol` | `deployments/testnet.json` (`roles` is read back from chain) |
| h | Compliance flag | `Series.gated` (packed in slot 0, so no gas cost for open series), `setSeriesGated` and `setAllowlisted` (owner). A gated series mints only to allowlisted recipients. Secondary transfers and exits are not gated | `test_gatedSeriesMintsOnlyToAllowlisted` |
| — | Verify D (130 % gas multiplier) and E (source drift) | The deploy uses a 1.08 multiplier. The deployed source equals `src/` (Sourcify exact match) | above |

Findings #3 (the CRE `decide()` rule) and #5 (maker kill switch) are off-chain. They belong to the workflow and maker
owners (see the interfaces below).

### Trust model (also written in the `Resolver` NatSpec)

- **attester.** Decides the outcome by signing it.
- **guardian.** Can pause `onReport` and can veto a Settled result to Void during the window. It can never pick a
  winner. Residual risk (documented): it can void an honest result inside the window
  (`test_RESIDUAL_guardianCanVoidAnHonestResultInsideTheWindow`).
- **owner.** Registers stations (write-once), rotates the forwarder, attester and guardian, pins the workflow, and
  unpauses. Admins have no path to collateral.
- **Liveness.** Funds are never locked longer than dayEnd + 7 d.

## Tests: 134 passed, 0 failed (with `MONAD_TESTNET_RPC`, fork block 68,886,592)

Command: `MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FORK_BLOCK=68886592 forge test`, which gives
`Ran 15 test suites: 134 tests passed, 0 failed, 0 skipped`. Full log: `script/evidence/forge-test-full.txt`. Offline it
gives 126 passed and 8 fork tests skipped.

| Suite | Tests |
|---|---|
| unit | 94: Resolver 38, CollateralVault 31, IsothermZap 4 (new, mock Kuru), OutcomeToken 7, ForecastCommit 7, StationTime 7 |
| fuzz | 4 in `VaultFuzz`. There are 14 `testFuzz_*` across all files, at 1,000 runs each |
| invariant | `VaultInvariant`: 5 invariants, 256 runs × 128 depth, 32,768 calls, 0 reverts. Actions executed: mint 1069, redeemSet 990, settle 567, voidStale 364, redeem 547, challenge 83, lateChallenge (must fail) 201 |
| security | 27: ResolverAttacks 13, VaultAttacks 11, AdversarialInvariant (4 invariants + path test; 20 handler selectors, 0 attack successes), MonadGas 1. Every v0 `FINDING` test was rewritten as `FIXED_*` (exploit no longer works) or `RESIDUAL_*` (documented) |
| fork (live state) | 8: MonadTestnetFork 2 (with a real-AUSD EIP-3009 mint), ForkAttacks 4 (real Kuru, real MockKeystoneForwarder), IsothermE2EFork 2 (full loop with the v1 Zap and canonical markets) |

**Mutation check.** I injected 22 bugs, one at a time, in a scratch copy, ran `forge test` after each, then restored
the file and checked its sha256. All 22 were caught.
- **Resolver and vault (14):** validUntil not checked / not signed; pause ignored; no resume grace; no hard max;
  STALE_WINDOW = 24 h; challenge after final; anyone can challenge; Settled final immediately; vault ignores finalAt;
  no balance-delta check; nonce ignores the series; gate not enforced; challenge keeps finalAt.
- **Zap (8):** canonical equality, fee cap, zero min-out, trading after close, write-once, anyone registers, price
  precision, base token. The first Zap run *missed* 2 of these because of a memory-struct aliasing bug in my test. I
  fixed the test and both are now caught.

## End-to-end against the deployed bytecode (`script/e2e.sh`)

I ran it on an anvil fork of live testnet taken after the deploy. It uses the real AUSD, faucet, Kuru Router and
MarginAccount, the real MockKeystoneForwarder, and the role keys. Every EIP-712 Settlement and EIP-3009 signature is
produced by `cast wallet sign --data`, and each Settlement signature is cross-checked against the on-chain
`settlementDigest`. Log: `script/evidence/e2e-v1/console.txt`.

```
createLadder RCSS 20261010 [28,29,30] + RJTT [20] (operator)
Kuru YES>=29/AUSD market; hostile 90%-fee book on the same YES (validateMarket=false)
refused: taker2 registers (NotOperator) | operator registers hostile (InvalidMarket) | re-registration (CanonicalMarketAlreadySet)
refused: front-runner re-targets the 3009 authorization -> AUSD InvalidSignature();  relayed EIP-3009 mint: taker1 YES>=30 = 50000000
refused: Zap via hostile book (MarketMismatch), minOut 0 (ZeroMinOut);  Zap.buyYes 10 AUSD -> 19980000 YES
forged REJECTED | expired REJECTED | attested Tmax=29 accepted | replay REJECTED ; resultOf=(1, 29, t, t+900, ...) isFinal=false
refused: redeem inside the challenge window (NotFinal);  at finalAt: +19980000 AUSD
RJTT attested 25 -> refused: non-guardian challenge (NotGuardian); guardian challenge -> (2, 0, ...) ; void 10 YES + 10 NO -> +10000000
vault AUSD 280020000 == pre-run 0 + sum(series collateral) 280020000 : OK
```

`script/attestation-vector.sh` signs a Settlement with the public test key 0xa11ce and checks that the `cast` typed-data
signature equals a signature over the **live** Resolver's `settlementDigest` (read with `eth_call`): OK. The output is
`script/attestation-vector.json` (v1 struct). That signature is rejected on chain, because the attester is a different
key.

## Gas (Monad bills the gas limit; numbers are gasUsed from the e2e on the live bytecode)

| Action | gasUsed | Notes |
|---|---|---|
| createLadder, 3 strikes / 1 strike | 848,818 / 365,957 | |
| mintSet, first | 297,217 | +15k vs v0: the balance-delta check |
| mintSetWithAuthorization (relayed EIP-3009) | 309,470 | |
| setCanonicalMarket | 130,039 | one per strike per day (operator) |
| Kuru deployProxy | 1,321,336 | |
| Zap.buyYes | 483,159 | |
| CRE report via the mock: accepted / forged / expired / replay | 149,863 / 89,840 / 82,333 / 109,345 | set the workflow gas limit to about 200k |
| redeem / redeemSet | 146,957 / 160,004 | |
| guardian challenge | 44,432 | |
| Deploy (Resolver / Vault / Zap) | 3,048,824 / 5,197,792 / 1,870,311 | live limits, ×1.08 |

## Not done / limits (honest)

- **No live trades yet.** No ladder, Kuru market, mint or report has happened on the live chain with v1, per the task.
  The go-live step does that. Everything after the deploy was proven on forks.
- **Production KeystoneForwarder.** Its path is still untested with real DON signatures. The Resolver is on the mock.
  Attestation is mandatory either way.
- **Unfunded guardian.** It holds 0 MON, so it cannot pause or challenge until funded (see human actions).
- **Legacy harnesses.** The spikes (e.g. `spikes/e2e`, `spikes/cre/onchain`) compile or call the v0 ABI. They are kept
  as evidence and will not work against v1. `script/testnet-e2e.sh` is marked LEGACY.
- **Still open.**
  - The Kuru books themselves still match after close. Only the maker can stop that (finding #5).
  - `mintSetWithPermit` still does not bind the series.
  - Void rounding dust stays in the vault.
- **Not audited.**

## Human actions

1. **Fund the guardian** `0x30C8…7d50` with about 0.05 MON, so it can `pause` (about 30k gas) or `challenge` (44k gas)
   in an emergency. The guardian key is `~/.config/isotherm/guardian.key`. It is a hot key on the Mac; move it to
   hardware or a separate machine if this goes beyond a demo.
2. **Give the attester key to the CRE workflow** as a secret (`ISOTHERM_ATTESTER_KEY`). Keep it off any machine that
   also holds the guardian key.
3. **CRE go-live (optional).** Run `cre login` and `cre account access`, then `setForwarder(0xF834…4482)` and
   `setExpectedWorkflow(id, owner)` from the owner key. Attestation stays on (it can't be turned off).
4. **Testnet MON for daily operation.** The deployer holds 4.66 MON after this step.
