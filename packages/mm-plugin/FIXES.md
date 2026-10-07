# mm-plugin-isotherm: fixes for the v1 security review (2026-10-07)

Scope: `packages/mm-plugin` only. No live transactions were sent and no testnet MON was spent. All trades ran on
anvil forks of live Monad testnet (ports 19541 and 19542, both freed afterwards). Contracts are unchanged.

## 1. Buy NO no longer uses `Zap.buyNo` (review finding N1)

**Change.** `mm weather buy … --side no` now runs these steps:
1. Approve AUSD to the CollateralVault, if needed.
2. Approve YES to the Zap, if needed.
3. Re-read the book. If the plan no longer holds, stop with nothing minted (`ISOTHERM_PRICE_LIMIT`).
4. `CollateralVault.mintSet(N)`.
5. `eth_call` the sell, then send `Zap.sellYes(N YES, minAusdOut)`.

NO received is exactly N. sellYes reverts rather than return less than `minAusdOut`, so the new
`plan.worstCaseNoPrice` is enforced on-chain.

If the mint confirms but the sell does not, the command stops with a new code, `ISOTHERM_SET_HELD`. It reports the
YES+NO the wallet now holds and gives the two exact follow-ups:
- `redeem --merge`, which returns the sets at par;
- `sell --side yes` at the same price limit.

It also says not to re-run the buy.

Other code changes:
- `gatedGuard` now checks the recipient of the mint, which is the wallet.
- `plan.ts` has a new pure `planBuyNo`.
- `doctor`'s allowlist note now mentions the YES approval.

Files: `src/commands/weather/buy.ts`, `src/lib/plan.ts`, `src/lib/trade.ts`, `src/commands/weather/doctor.ts`.

**Evidence.**
- **Unit tests.** `npm test` gives 34/34 (`evidence/unit-tests.txt`).
  - `planBuyNo` reproduces the earlier e2e numbers (8.171820 back, min 8.130960).
  - A pure N1 test shows that on a drained book the old `minAusdBack` passes at 0.999 per NO and the new `minAusdOut` fails.
- **Real mm 7.0.0 host, v1 fork** (block 68,907,593; tomorrow's ladder is the live RCSS 2026-10-08 ladder on its
  live canonical books). `evidence/harness-v1/09-buy-no.txt`: 4 transactions CONFIRMED (approve, approve, mintSet,
  sellYes). The trade bought 10 NO for 1.718290 AUSD, 0.1718 per NO, inside the planned worst case of 0.1760
  (`withinWorstCase: true`).
- **N1 replayed in the real host** (`evidence/harness-v1/20-buy-no-sandwiched.txt`, and the same in
  `harness-feasibility/`).
  - **Setup.** The stub held the plugin's signed `Zap.sellYes` and first ran `harness/sandwich.mjs`. An
    impersonated attacker sold into every Tmax≥30 bid (0.363 × 85, 0.343 × 50, 0.34 × 100) and left 0.001 × 5.
  - **Plugin.** Its `sellYes` reverted on-chain with `Slippage(4995, 3608238)`. The command ended with
    `ISOTHERM_SET_HELD`. Step 22's `redeem --merge` paid back 10.000000 AUSD.
  - **Control.** The pre-fix `Zap.buyNo` was `eth_call`-ed with the same amount and the same bound at the same
    post-attack state. It **would fill** 5 NO for 4.995 AUSD, 0.999 per NO, against a planned 0.637.
- **Gas.**
  - The new route costs 846,517 gas limit (0.0863 MON at 102 gwei) once approvals exist. With two fresh exact
    approvals it costs 993,244 (0.1013 MON).
  - The old `buyNo` cost 788,552 (0.0804 MON).
  - Source: `evidence/harness-v1/TX-TABLE.md`.

## 2. `quote` and `edge` show the maker snapshot's fair value and label the guardrail

**Change.** `src/lib/snapshot.ts` is new. It reads `GET <ISOTHERM_API_URL>/api/snapshot`:
- The default is the live API. `ISOTHERM_API_URL=off` disables it. Plain http is allowed only on localhost.
- A strike is used only if all of these hold:
  - the snapshot is at most 600 s old (`ISOTHERM_SNAPSHOT_MAX_AGE_S`);
  - the chain is 10143;
  - its seriesId and Kuru book match what the plugin read on-chain.
- Out-of-range numbers are dropped.
- It is display data only. It never sizes a trade, sets a min-out or picks a market.

Per strike, `quote` now shows:
- `fairValue` with `fairValueSource`: `maker-snapshot`, else `polymarket-live`;
- `fairValueBasis`: `polymarket` or `certain`, or a `fallback-*` model value. The API drops the maker's
  `fairSource`, so the basis is inferred from `flags` until the API passes it through;
- the plugin's own `polymarketImplied`;
- the maker's quote and mode;
- `guardrail {p, source, basis, flag}`.

The guardrail's source is the maker's bias-corrected v0 when the snapshot is fresh. Otherwise it is the plugin's
v0-lite, explicitly labelled as the cruder fallback. A `guardrailModel.role` field reads "GUARDRAIL ONLY: … not a
forecast and not a fair value".

`edge` measures the gap against `reference`, which is Polymarket-based only (the maker's fair when its basis is
polymarket or certain, else the live read). A model value never drives a suggestion.

`doctor` has a new optional check for the snapshot API.

Files: `src/lib/snapshot.ts` (new), `src/lib/view.ts`, `src/commands/weather/{quote,edge,doctor}.ts`.

**Why.** On 2026-10-07 for Taipei 2026-10-08, the plugin's v0-lite gave μ 27.9 °C:

| | P(Tmax ≥ 29) | P(Tmax ≥ 30) |
|---|---|---|
| plugin v0-lite | 0.346 | 0.145 |
| Polymarket-implied | 0.860 | 0.408 |
| maker's v0 guard (μ 29.8 °C) | 0.869 | 0.591 |

Before this fix, `quote` printed the v0-lite number for every strike.

**Evidence.**
- **Unit tests.** Four new tests:
  - the snapshot parser, run on a captured live API response (`test/fixtures/api-snapshot-2026-10-07.json`);
  - inference of the fair-value basis;
  - the order of preference between sources, and a check that a model fallback is never used as edge's reference;
  - the API URL policy.
- **v1 fork, tomorrow.** `harness-v1/04-quote-tomorrow.txt`: `makerSnapshot.used: true`, 29 s old, 4 strikes,
  `fairValueSource: maker-snapshot`, guardrail `maker-snapshot`.
- **v1 fork, today.** `harness-v1/03-quote-today.txt` is a fork-only ladder. It shows `polymarket-live`, the
  v0-lite guardrail, and a note saying why.
- **Feasibility fork.** `harness-feasibility/04-quote-tomorrow.txt`: the snapshot was ignored for strikes 28–31.
  The seriesIds are the same but the books differ, so the strikes fell back to the live read and a note says why.
- **Live testnet, signed-out host.** `evidence/02-readonly-live-signed-out.txt`: the quote for the live 2026-10-08
  ladder shows `maker-snapshot` fair values (18 s old) next to the live books.

## 3. Harness, evidence, tarball, docs

- `harness/run-all.sh` changes:
  - It uses ports 19541 and 19542 and exports `STUB_URL`.
  - Trade prices come from the run's own `quote` outputs (`harness/prices.py`), so the run works whatever the
    market does. It first used a heredoc, which bash 3.2 mangled; that is why the logic moved to a separate file.
  - It adds the buy-NO dry run, the N1 sandwich step, and the held-set positions and merge steps.
  - It parses streamed `_error` results and counts FAILED transactions.
- `harness/stub-backend.mjs` has an optional front-run hook (`STUB_FRONTRUN`, `STUB_FRONTRUN_MATCH`).
- `harness/sandwich.mjs` is the attacker plus the `buyNo` control.
- `harness/tx-table.mjs` also lists the confirmed steps of commands that end in an error.
- Results:
  - v1: 38/38 steps as expected, 39 CONFIRMED, 1 FAILED by design, 1 denied.
  - Feasibility: 38/38 steps as expected, with the same counts.
  - See `evidence/harness-{v1,feasibility}/SUMMARY.txt` and `TX-TABLE.md`.
- `mm-plugin-isotherm-0.1.0.tgz` was repacked. It has 48 files, 81.4 kB, sha256 `89deaeb3…051f34b`
  (`evidence/npm-pack.txt`). Its `dist/` is byte-identical to the build the harness installed in the host.
- Leak check over the package tree and the unpacked tarball:
  - It used the 12 files in `~/.config/isotherm` plus the harness mnemonic.
  - It found no key, token or mnemonic.
  - The only match was the public API URL, which `maker.env` also contains.
  - Only key names were printed.
- `README.md`, `SKILL.md` and `RESULT.md` were updated:
  - the new Buy NO route and `ISOTHERM_SET_HELD`;
  - a "Fair value and the guardrail" section;
  - the new tx table and the N1 result;
  - 34 unit tests and the new ports.

## Not done / open

- The real MetaMask signing service has still never broadcast one of our 10143 transactions. That needs a team member's
  `mm login`.
- `npm publish` is still a human step.
- A redeployed Zap with `minNoOut` would let Buy NO return to one transaction. The plugin does not switch to it
  automatically.
- `evidence/01-setup-fresh-home.txt` and `03-harness-setup-then-init.txt` were not re-run. The setup script did not
  change. The harness's `00-setup.txt` re-ran the setup path with the new tarball.
