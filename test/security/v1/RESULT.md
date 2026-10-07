# Isotherm v1: security diff review (2026-10-07)

**Scope.** I reviewed the changes from the feasibility contracts to v1:
- the uncommitted diffs in `src/Resolver.sol`, `src/CollateralVault.sol`, `src/StrikeFactory.sol` and `src/interfaces/IIsothermResolver.sol`;
- the new files `src/IsothermZap.sol`, `src/interfaces/IERC3009.sol` and `src/interfaces/IKuru.sol`;
- the API relayer in `apps/api`.

I checked them against the earlier findings in `test/security/RESULT.md` and `spikes/verify/RESULT.md`.

**Rules I followed.**
- I sent no live transactions. Live checks were `eth_call` reads plus one `GET /api/health`.
- `src/` is unchanged, so the deployed bytecode still matches the source (Sourcify exact match).
- I deployed nothing.
- Anvil and wrangler ran only on ports 19410–19412, and every process I started has exited.

## Verdict

- **Every earlier Medium finding that lives in the contracts (#1, #2, #4, #6, #7) is fixed or mitigated as claimed, and I found no regression in the core money path.** Solvency and the stale-void rules hold on the live state. The live configuration matches `deployments/testnet.json`.
- **#7 is only partly contained.** The challenge window does not stop someone who steals the attester key, and the docs overstate how much it protects.
- **I found 3 new Medium issues on-chain and 2 in the API.** I fixed the API code but did not deploy it.

**No contract redeploy is needed for the testnet demo.** Before any real money is involved, two contracts need a redeploy:
- the Zap, for N1;
- the Resolver, for N2. The Vault and Zap must be redeployed with it, because each holds the address of the one below it as an immutable.

The Cloudflare Worker needs a redeploy to put the API fixes live (command under Human actions).

## Earlier findings: status

| # | Earlier finding | v1 status | My evidence |
|---|---|---|---|
| 1 | Attestation could be switched off behind the permissionless mock forwarder | **Fixed.** The switch was removed and every report must be signed. | Existing `test_FIXED_unsignedReportRejectedWhateverTheForwarderConfig` and the fork test pass. On the live chain, `forwarder()` is the mock and `attester()` is 0x63D2…0Bb9. |
| 2 | Stale void (24 h) came before the workflow's own 36 h deadline | **Fixed.** The stale window is now 48 h. | `testFuzz_HOLDS_staleVoidScheduleUnderPauseToggles` (new): it never fires before dayEnd + 48 h. |
| 3 | The CRE `decide()` voided on the first disagreement | **Off-chain; the CRE owner reports it fixed.** The decision block in `packages/cre-workflow/settle/workflow.ts:202-218` returns PENDING before the deadline, allows VOID after 36 h only when every source answered, and voids at 46 h regardless. | I read the code but did not re-run it. |
| 4 | The Zap accepted any Kuru book listed for our YES token | **Fixed.** There is now one canonical market per strike, written once and checked against Kuru's market registry. | All 4 live canonical books pass `validateMarket` (base = the strike's YES token, quote = AUSD, 1e4 / 1e6 precision, 10 bps fee): `test_live_configRolesWiringAndSolvency`. |
| 5 | Kuru books keep matching after close | **Off-chain, residual.** The maker's kill switch exists, per the maker's own evidence. | Not re-verified. |
| 6 | The guardian could force a void by pausing | **Fixed.** Stale voids are blocked while paused, there is 24 h of grace after an unpause, and 7 days is a hard limit. | The new fuzz test above covers random pause/unpause schedules. Mutants "no resume grace" and "stale void while paused" are both caught. |
| 7 | A stolen attester key decides the result for good | **Partly.** A false *Settled* result gets a 15-minute window in which the guardian can challenge it. **See N2:** a false *Void* skips the window, and a successful challenge still pays the thief 0.5. | `test_RESIDUAL_compromisedAttesterSignsVoid_finalInstantly_guardianCannotAct`, `test_RESIDUAL_challengedFalseResultStillPaysTheThiefHalf` |
| 8 | A permit does not bind the series | **Fixed for EIP-3009 authorizations**, which bind the series and amount through the nonce. The permit path remains as a documented residual. | `test_HOLDS_authorizationBoundToVaultInstanceAcrossRedeploys` (new): an authorization signed for the live vault cannot be used by a redeployed vault, even though the seriesId is the same. The existing redirect test passes. |
| 9 | Attestations never expired | **Fixed**: `validUntil` is enforced. **Residual (N7):** the chain does not cap how far ahead `validUntil` can be set. | `test_RESIDUAL_validUntilLifetimeIsNotCappedOnChain` |
| 10 | Fee-on-transfer collateral | **Fixed** with a balance-delta check. | Existing tests pass. |
| verify E | The deployed bytecode differed from the source | **Fixed** (Sourcify exact match). | I left `src/` untouched. |
| verify F | A mnemonic stored in plain text in the harness homes | **Still present**: `spikes/mm/.mmhome-{harness,setuptest}/.metamask/mnemonic.json`. They are gitignored. | Human action. |

## New findings (most severe first)

| ID | Severity | Finding | Proof | Fix |
|---|---|---|---|---|
| N1 | **Medium** (new in v1 Zap) | **`Zap.buyNo`'s slippage bound fails on partial fills.** The only bound is `minAusdBack`, and `ausdBack` counts the unsold YES merged back at par. A sandwich takes the maker's bid and leaves a 0.001 bid. The victim's buyNo still clears a 2 %-slippage minimum but pays **0.999 per NO instead of 0.57**, for half the NO. `buyYes` and `sellYes` are properly bounded. The web app and the mm plugin both call `buyNo`. | Real Kuru v1 plus the **deployed** Zap on a fork: `test_live_RESIDUAL_buyNoSandwichOnRealKuruAndDeployedZap` (`NO out 50000000, AUSD paid 49950050`). Offline: `test_RESIDUAL_buyNoSandwich_minAusdBackPassesAtTerriblePrice` | **No redeploy:** route "Buy No" in the web app and plugin through `vault.mintSet` + `zap.sellYes(minAusdOut)`; `test_mitigation_mintSetPlusSellYes…` shows the same sandwich then reverts. **Redeploy (Zap only):** add `minNoOut` to `buyNo` and require both bounds. That deploy costs about 1.87 M gas, plus 130 k per strike to re-register each canonical market in the new Zap. |
| N2 | **Medium** (trust; finding #7 is only half fixed) | **The challenge window does not contain a stolen attester key.** (a) A reported **Void** is final in the same block, so the guardian cannot challenge it and the thief redeems the cheap side at 0.5. (b) A challenged false **Settled** result becomes Void, which also pays the thief's cheap side 0.5 (25× on a 0.02 buy). The challenge halves the theft but does not stop it. The docs call it "contained". | `test_RESIDUAL_compromisedAttesterSignsVoid_finalInstantly_guardianCannotAct`, `test_RESIDUAL_challengedFalseResultStillPaysTheThiefHalf` | **Redeploy (Resolver, then Vault and Zap):** give reported Voids the same `finalAt = resolvedAt + challengeWindow`. Make `challenge()` reset the result to *None* rather than Void, and push `staleAt` back by at least RESUME_GRACE, so an honest report can land after the owner rotates the attester. **Now:** keep the attester key off the machine that holds the guardian and owner keys, run a watcher (N6), and correct the "contained" wording in the docs. |
| N3 | **Medium** (ops/trust) | **The owner of the Resolver and the Vault is still the deployer key.** That is the hot key used by `fund.mjs` and the agents. With it alone, an attacker can call `setGuardian(0)` and `setAttester(evil)` and then decide any pending ladder, with no timelock. On-chain the roles are separate, but all 8 keys sit in `~/.config/isotherm` on one Mac. | `test_RESIDUAL_ownerKeyAloneControlsEveryOutcome`. Live: `owner() = 0xb855…5c11` and `pendingOwner() = 0` on both contracts (`evidence/live-readonly-checks.txt`). | **No redeploy:** call `transferOwnership(cold)` on the Resolver and the Vault, then `acceptOwnership()` from the cold key. That is 4 transactions, about 0.02 MON. Stop using that key for funding. |
| N4 | **Medium** (API) — **fixed in code, not deployed** | **The relay caps were check-then-act.** `checkRelay` ran before several RPC awaits, outside the single-sender queue, so concurrent requests all passed it. 8 parallel requests for one holder were all broadcast against a per-address cap of 2, and the daily cap could be overrun the same way. | `apps/api/test/unit/relay-abuse.test.ts`. Before the fix: `expected 8 to be 2` (`evidence/api-relay-race-before-fix.txt`). After: 2, then the daily cap stops at 3. | `relayer.ts`: the cap is checked again inside the queued job (jobs run one at a time, and `recordRelay` runs before the next one starts). |
| N5 | **Medium** (API, availability during judging) | **Anyone can drain the relayer for free.** The per-IP drip limit was keyed on the full IPv6 address, and one home connection usually has a whole /64 (2^64 addresses). The relay has no IP limit and accepts 1-unit (0.000001 AUSD) mints, each costing the relayer about 0.034 MON. The configured caps (drips about 6 MON/day, relays about 2 MON/day) are far above the relayer's **0.599 MON** live balance, so a griefer can switch off drips and gasless mints for everyone for the day. | Live `/api/health`: `monBalance 0.599`, `dripsTotal 3`. IPv6 bucketing test in `relay-abuse.test.ts`. | **Code (done):** IPv6 is now keyed by its /64 (`ipBucket` in `util.ts`, used in `index.ts`). **Config (human):** set `RELAY_DAILY_CAP` and `DRIP_DAILY_CAP` to what the balance can pay for; add a minimum relay amount (e.g. 1 AUSD); add a Cloudflare rate-limit rule on `/api/*`; optionally Turnstile on `/api/drip`. A venue behind one NAT still gets only 3 drips per day (`DRIP_PER_IP_PER_DAY=3`). |
| N6 | Low–Medium (ops) | **Nobody watches the 15-minute challenge window.** Settlement runs around 02:00–03:00 Taipei, nothing watches results automatically, and the guardian key is a hot key on the same Mac as the attester key. The documented emergency `pause()` neither stops nor extends the clock, and the vault ignores the Resolver's pause. A guardian who pauses instead of challenging lets a false result pay out in full. | `test_RESIDUAL_pauseDoesNotFreezeTheChallengeClockOrRedemption` | **Runbook:** challenge first, then pause. Add a small watcher on another machine that recomputes Tmax with `settle-core.ts` on each `LadderResolved` event and challenges on a mismatch. **At redeploy:** make `finalAt` wait while the Resolver is paused. |
| N7 | Low | **The chain enforces `validUntil` but does not cap it.** A long-lived signature stays deliverable until the ladder resolves. "TTL ≤ 30 min" and "sign at most one live outcome" are rules in the workflow only. | `test_RESIDUAL_validUntilLifetimeIsNotCappedOnChain` | **At redeploy:** reject when `validUntil > block.timestamp + MAX_TTL`. That limits a delivery window's length, not its start. |
| N8 | Low (API) — **fixed in code** | **`/api/health` amplified traffic onto our RPC.** It is public and uncached, and each call made 3 reads on the public Monad RPC, which allows about 25 requests per second per client IP and is shared with the drip, the relay and the scanner. A flood could get the relayer rate-limited. | New test: 50 concurrent `info()` calls make 1 RPC call. | `relayer.ts`: `info()` is cached for 5 s and concurrent callers share one in-flight request. |
| N9 | Low (API) — **fixed in code** | **The snapshot's `polymarket.url` was stored as-is and rendered as an `<a href>`.** React 18 does not block `javascript:` links. Exploiting it needs the snapshot token, but it would give script access in a page that keeps dev-wallet burner keys in localStorage. | New test in `relay-abuse.test.ts` | `snapshot.ts`: only `https://(*.)polymarket.com` URLs are kept; slugs must match `[a-z0-9-]` and are URL-encoded. |
| N10 | Info | **Smaller notes:** <ul><li>The compliance gate checks only the mint recipient. Allowlisting the Zap would open gated series to everyone through `buyNo` (`test_INFO_gateIsRecipientBased_anAllowlistedRouterOpensIt`).</li><li>The API still offers permit-mode relays, which a front-runner can redirect to another series. Disable them for the v1 vault.</li><li>Kuru's owner can change market state; the Zap checks market parameters only when the market is registered.</li><li>The relay reads its nonce with `getTransactionCount('pending')` per job. That is the same stale-pending quirk golive hit. Jobs wait for receipts, so this is a reliability note, not a security issue.</li></ul> | | |

**Checked and holding:**
- No second exists in which a challenge and a redemption can both succeed (fuzz, with half the runs within ±2 s of finalAt).
- A report rejected during a pause has expired by the time of the unpause.
- The guardian can only push a result to Void. It cannot re-open a ladder or administer the contracts.
- The EIP-3009 nonce binds the series, the amount and the vault instance.
- Live vault AUSD 1,200,000,000 = Σ series collateral 1,200,000,000.
- Every live series is ungated, every closeTime ≤ dayEnd, and the 4 roles are distinct.
- API:
  - it relays only to two fixed vault functions (no arbitrary calls);
  - no endpoint fetches a URL that a user supplies (no SSRF);
  - bearer tokens are compared in constant time;
  - error text is limited to viem's short message, so the key never appears in it;
  - drips go only to codeless addresses at or above 0x10000.
- **No secrets leaked.** A scan of 181,738 files (`src test script deployments packages/abi apps docs README ARCHITECTURE`, plus `~/isotherm-live`, including `apps/*/dist`, `.wrangler` and `node_modules`) against all 11 key and token files in `~/.config/isotherm` found 0 hits. Only paths were printed.

## Fixes I applied (API only; contracts untouched)

1. **`apps/api/src/relayer.ts`**
   - In `relayMint`, `checkRelay(...)` runs again inside the `enqueue` job before the balance check and the broadcast (N4).
   - `info()` is cached for 5 s and dedupes in-flight calls (N8).
2. **`apps/api/src/util.ts`**: new `ipBucket(ip)`. IPv4 is unchanged; IPv6 becomes its /64; `::ffff:a.b.c.d` becomes the IPv4 address. **`apps/api/src/index.ts`**: the drip's per-IP tag uses `ipTag(ipBucket(ip), …)` (N5).
3. **`apps/api/src/snapshot.ts`**: new `polymarketLink(url, slug)`, an https allowlist for polymarket.com (N9).
4. **`apps/api/test/unit/relay-abuse.test.ts`** (new): 4 tests covering the relay-cap race, the health memo, IPv6 bucketing and the URL sanitiser.

Why `src/` was not changed: a fix there could not be deployed in this task, and it would bring back the source drift that verify finding E was about.

## Tests added (`test/security/v1/`)

- **`V1ResolverAttacks.t.sol`** (9 tests)
  - 5 RESIDUAL tests: void bypasses the window, a challenged result still pays half, pause does not freeze the clock, the owner key decides outcomes, validUntil is uncapped.
  - 4 HOLDS tests: the challenge/redeem boundary fuzz, the stale-void fuzz under random pause/unpause schedules, a paused report has expired by the unpause, the guardian can only void.
- **`V1ZapVaultAttacks.t.sol`** (4 tests)
  - the buyNo sandwich on an offline multi-level book;
  - the mintSet + sellYes mitigation;
  - the recipient-only gate;
  - the 3009 authorization bound to the vault instance.
- **`V1LiveFork.t.sol`** (2 fork tests on the **deployed** v1 addresses read from `deployments/testnet.json`)
  - the live roles, wiring, canonical books and solvency;
  - the buyNo sandwich on real Kuru through the deployed Zap. The fork impersonates the live operator to create a fresh RJTT series.

## Evidence (`test/security/v1/evidence/`)

| What | Command | Result |
|---|---|---|
| Whole suite, fork | `MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FORK_BLOCK=68898133 forge test -vv` | **18 suites, 149 passed, 0 failed, 0 skipped**: 134 existing + 15 new (`forge-test-full-fork68898133.txt`) |
| Whole suite, offline | `forge test` | 139 passed, 10 fork tests skipped |
| Mutation (scratch copy; each file restored and checked by sha256) | `mutate.py` | **5/5 caught by the full suite, 4/5 by the new tests**: challenge allowed at finalAt; no resume grace; onReport not pausable; stale void while paused; 3009 nonce ignores the series (caught only by the existing tests) (`mutation-v1-tests.txt`) |
| API unit tests + typecheck | `cd apps/api && npx vitest run test/unit && npx tsc --noEmit` | 24/24 pass (20 existing + 4 new); tsc exit 0 |
| API fork integration after the fixes (real Durable Object, KV, anvil fork) | Copy of `test/integration/api.fork.test.ts` on ports 19410/19411/19412, deleted afterwards | 6/6 pass (`api-fork-integration-after-fix.txt`) |
| Relay race before the fix | `vitest -t "caps hold"` | `expected 8 to be 2` (`api-relay-race-before-fix.txt`) |
| Live reads | `cast call` / `cast balance` / `GET /api/health` | `live-readonly-checks.txt` |

## Human actions

1. **Redeploy the Worker** so N4, N5 (IPv6), N8 and N9 go live:
   ```
   cd apps/api && XDG_CONFIG_HOME=<wrangler config dir> npm run deploy
   ```
   `npm run deploy` uses the local wrangler 3.114. Then check `/api/health`.
2. **Size the relayer caps to its MON (N5).** Set `RELAY_DAILY_CAP`, `RELAY_PER_ADDRESS_PER_DAY` and `DRIP_DAILY_CAP` in `apps/api/wrangler.toml`. Add a Cloudflare dashboard rate-limit rule on `<former API host>/api/*`. Permit-mode relays can only be turned off in code (`relayModes()` in `relayer.ts`); there is no config switch for it, and the web app already uses authorization mode against v1.
3. **Move ownership of the Resolver and the Vault to a cold key (N3)**: `transferOwnership(cold)` from the deployer key, then `acceptOwnership()` from the cold key.
4. **Web app and mm-plugin owners (N1):** make "Buy No" use `vault.mintSet` followed by `zap.sellYes(minAusdOut)`, or cap buyNo at the top-of-book bid size. Before real money, redeploy the Zap with `minNoOut`.
5. **Guardian runbook (N6):** challenge first, then pause. Set up a watcher on a separate machine that holds only the guardian key.
6. **Docs owner:** say that the challenge window caps a stolen attester key's gain at 0.5 per token on Settled results and does not cover reported Voids (N2). Do not call it "contained".
7. Delete `spikes/mm/.mmhome-harness` and `.mmhome-setuptest` before sharing the folder (verify F).
8. **Before any real-money deployment**, apply the N2, N6 and N7 changes in a redeploy of the Resolver, Vault and Zap. Leave the live RCSS 2026-10-08 ladder on v1 until it settles.

Not audited. Testnet, faucet AUSD only.
