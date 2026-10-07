# Isotherm core contracts: RESULT (2026-10-06)

**Verdict: it can be built, and the critical path works against live Monad testnet state.** Everything below
ran on a fork of the live testnet (block 68,693,965) with Monad execution rules: real testnet AUSD and its faucet,
the real Chainlink CRE `MockKeystoneForwarder`, and the real Kuru v1 Router. It has **not** run on the live chain
yet. The deployer holds 3.65 MON (rule: go live only at ≥5 MON), and the Kuru spike is using the same key (nonce
moving), so a parallel live run would collide.

## What was built (995 lines of Solidity in `src/`, 2,055 lines of tests)

| File | What it is |
|---|---|
| `src/OutcomeToken.sol` | 6-decimal ERC-20 + EIP-2612 permit. Deployed once as an implementation, then as an EIP-1167 clone with immutable args `(seriesId, station, date, strikeC, isYes)`. Only the vault can mint/burn. Name e.g. `Isotherm RCSS 20261007 Tmax>=30C YES`, symbol `RCSS-20261007-GE30-Y`. Permit domain is `{name:"Isotherm Outcome", version:"1", verifyingContract: clone}` (ERC-5267). |
| `src/StrikeFactory.sol` | Series registry (abstract, inherited by the vault, so there is one address and no deploy cycle). `createSeries` / `createLadder(station, date, int16[] strikes, closeTime)` are operator-only. They deploy the YES/NO pair with CREATE2 clones (address predictable via `predictTokenAddress`) and enforce `now < closeTime <= end of the station-local day`. A ladder is one (station, date). |
| `src/CollateralVault.sol` | Complete sets backed 1:1 by AUSD. `mintSet`, `mintSetTo`, `mintSetWithPermit` (relayer; AUSD always comes from the holder and tokens always go to the holder; no fallback to a standing allowance). `redeemSet` works at any time and is never paused. After resolution, `redeem(id, yesAmt, noAmt)` pays YES 1 / NO 0 when `tmax >= k`, the reverse otherwise, and 0.5/0.5 when void (rounded down; a full set always pays exactly 1). Collateral is tracked per series with checked subtraction. Guardian pause stops new mints only. `duePendingLadders(start,count)` lists the ladders the CRE workflow should settle. |
| `src/Resolver.sol` | CRE `IReceiver` (`onReport(bytes,bytes)` + ERC-165, interface id `0x805f2132`). Configurable forwarder. **Every report must carry an EIP-712 attestation** from `attester` over `Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash)`; the domain binds chainId and the resolver address. Results are write-once (no double settle or replay). Reports are only accepted after the local day ends. `voidIfStale` is open to anyone 24 h after day end and works even when paused. Guardian pause covers `onReport`. Optional workflowId/owner pinning reads the 64-byte KeystoneForwarder metadata. Attestation can only be switched off while a workflowId is pinned. Station UTC offsets are write-once. |
| `src/ForecastCommit.sol` | Mainnet calibration log. `commit(station,date,hash)` must land before local midnight that starts `date`, is keyed by `msg.sender`, and can never be overwritten. `reveal(station,date,int16[] strikes,uint16[] probBps,salt)` checks `keccak256(abi.encode(forecaster,station,date,strikes,probs,salt))`. Anyone can keep a record (Forecast Cup-ready). |
| `src/lib/StationTime.sol` | yyyymmdd to UTC day boundaries (days_from_civil). Validates ICAO codes and UTC offsets. |
| `script/Deploy.s.sol` | Testnet stack. Env: `ATTESTER` (required), `FORWARDER` (default mock `0xB9F7…d192`), `AUSD`, `GUARDIAN`, `OPERATOR`, `NEW_OWNER`. Refuses chain 143. Registers RCSS +8h, RJTT +9h, ZGSZ +8h, RKSI +9h. |
| `script/DeployForecastCommit.s.sol` | Mainnet ForecastCommit (a human broadcasts it). |
| `script/e2e.sh` | Full critical path as real transactions (anvil fork, or `MODE=live`). Signatures are made with `cast wallet sign --data`, independent of Solidity. |
| `script/attestation-vector.json` | EIP-712 test vector for the CRE workflow (public test key `0xa11ce`). |

Config: solc 0.8.37 (no known bugs), `evm_version = "osaka"`, `network = "monad"` (Foundry 1.8.5: MIP-8 page
storage, cold-access repricing, 128 KB code limit). OpenZeppelin v5.7.0 is vendored in `lib/` (trimmed to
`contracts/`). No upgradeability.

## Evidence (commands run and their real output)

**1. Build.** `forge build --sizes`. Runtime/initcode sizes: Vault 12,122/21,191 B; Resolver 11,034/12,127;
OutcomeToken 7,140/8,245; ForecastCommit 6,252/6,525. All under Ethereum's 24 KB limit too.

**2. Tests.** `MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz FORK_BLOCK=68693965 forge test`
```
Ran 8 test suites: 82 tests passed, 0 failed, 0 skipped (82 total tests)
 VaultInvariantTest invariants (runs: 256, calls: 32768, reverts: 0)
  executed (all runs): mintSet=1243 redeemSet=1202 transfer=1103 settle=501 voidStale=438 redeem=702
```
- 75 unit tests: Resolver 30, Vault 24, OutcomeToken 7, ForecastCommit 7, StationTime 7. They cover the forwarder
  check, metadata pinning, wrong signer, tampered payload, high-s and short signatures, cross-resolver and
  cross-chain replay, double settle, settle→void, void→settle, day-not-over, stale void (including while paused),
  pause roles, permit relay/front-run/expiry, the `tmax == k` boundary, whole-ladder settlement from one report,
  per-series isolation and the due-ladder view.
- 4 fuzz tests × 1,000 runs: a set pays exactly 1 for any amount/split/tmax/strike/void; the payout rule;
  mint→redeemSet round trip; no mint after close. Two date algorithms are cross-checked over 2000–2199.
- 5 invariants: vault AUSD == Σ per-series collateral; solvency (`2·collateral ≥ yH·YES + nH·NO`, and
  `YES == NO == collateral` while unresolved); conservation (deposited == held + paid; per-series paid ≤ minted);
  every full set pays exactly 1 and every redeem follows the rule; results are write-once. Also passes with
  `--fuzz-seed 0x7` and `0x99`.
- Offline (`forge test` without the env var) the 2 fork tests are skipped, not failed.

**3. Mutation check (do the tests catch bugs?).** 7 deliberate bugs were injected one at a time, then reverted
(the file hashes were checked afterwards). All 7 were **caught**: no double-settle guard, attestation ignored,
void overpays YES, payout not debited, report before day end, mint after close, `>` instead of `>=`.

**4. Live-state fork test** (`test/fork/MonadTestnetFork.t.sol`, block 68,693,965):
```
faucet.requestFunds gave (AUSD base units) 10000000000
ladder RCSS date 20261007
YES>=30 token 0x709C…35F8 RCSS-20261007-GE30-Y
MockKeystoneForwarder.report (incl. onReport) gas, in-test measure 159394
```
Checked in this test: AUSD on-chain `eip712Domain()` = "Agora Dollar"/"1"/10143. `typeAndVersion()` returns
"MockKeystoneForwarder 1.0.0" at `0xB9F79d863261869B234c481D1f9A7af84AeAd192` and "KeystoneForwarder 1.0.0" at
`0xF8344CFd5c43616a4366C34E3EEE75af79a74482`. A real AUSD EIP-2612 permit relayed into `mintSetWithPermit`
works. Through the real mock forwarder, a forged report gives `ReportProcessed(result=false)`, an attested one
gives `true`, and a replay gives `false`. Redeem then paid 130 AUSD exactly.

**5. Real transactions on an anvil fork** (`anvil --fork-url https://testnet-rpc.monad.xyz --fork-block-number
68693965`; `anvil_nodeInfo` reports `"network":"monad","hardFork":"MonadTen"`, so no flag is needed). Command:
`RPC=http://127.0.0.1:18947 script/e2e.sh`, run with the real deployer/maker/taker keys. Full log in
`script/evidence/e2e-anvil-console.txt`.
```
7. EIP-712: cast typed-data signature == signature over contract settlementDigest (0x60c8…f4d0)
7a. forged report via MockKeystoneForwarder (sent by an arbitrary EOA): ReportProcessed=REJECTED
7b. attested report: ReportProcessed=success result=(1, 31, 1791303002, 0x1e22…611a)
7c. replayed report: ReportProcessed=REJECTED
taker1 burned YES=190000000 NO=130000000 -> +190000000 AUSD units; taker2 burned YES=50000000 NO=110000000 -> +50000000
vault AUSD left=0 series30 collateral=0
```

**6. Kuru compatibility** (`script/evidence/kuru-compat-console.txt`). Our real YES clone was used as the base of
a Kuru v1 YES/AUSD market through Router `0x7EFb…4630`, with the spike's parameters (price precision 1e4,
tick 10, size precision 1e6). `deployProxy` succeeded. The maker deposited YES into the MarginAccount and posted
asks at 0.45/0.46; taker1 `placeAndExecuteMarketBuy` 50 AUSD gave **+110.758477 YES**.

**7. Live node cross-check of the gas model** (read-only `eth_estimateGas` on https://testnet-rpc.monad.xyz):
Resolver deploy 2,555,383 (fork: 2,534,104) and Vault 4,395,602 (fork: 4,359,833). They agree within about 1%.

**8. ForecastCommit mainnet dry-run** (simulation only, no key passed, mainnet nonce still 0):
`forge script script/DeployForecastCommit.s.sol --rpc-url https://rpc.monad.xyz --sender 0xb855…5c11` gave
"Estimated total gas used for script: 1982108", about 0.20 MON at 100 gwei (forge reserves 0.40 at max fee).

## Gas (Monad rules; **billed on gas LIMIT**; limit = used × 1.10; MON at 102 gwei)

| Action | gas used | suggested limit | MON |
|---|---|---|---|
| Resolver deploy | 2,534,104 | 2,787,514 | 0.2843 |
| CollateralVault deploy (+OutcomeToken impl) | 4,359,833 | 4,795,816 | 0.4892 |
| registerStation / setOperator | 60,851 / 59,746 | 67k | 0.0068 |
| createLadder, 6 strikes (12 clones) | 1,547,334 | 1,702,067 | 0.1736 |
| createSeries, 1 strike | 306,574–364,759 | 401,234 | 0.0409 |
| mintSet first / repeat | 282,367 / 180,367 | 310,603 / 198,403 | 0.032 / 0.020 |
| mintSetWithPermit (relayed) | 284,019 | 312,420 | 0.0319 |
| redeemSet | 159,969 | 175,965 | 0.0179 |
| CRE settle via MockKeystoneForwarder (whole ladder) | 148,685 | 163,553 | 0.0167 |
| redeem | 181,875 | 200,062 | 0.0204 |
| OutcomeToken transfer | 56,515 | 62,166 | 0.0063 |
| Kuru deployProxy YES/AUSD (per strike) | 1,310,524 | 1,441,576 | 0.1470 |
| Kuru addSellOrder (first / next) | 317,194 / 226,655 | 349k / 249k | 0.036 / 0.025 |
| Kuru market buy (2 fills) | 357,681 | 393,449 | 0.0401 |
| ForecastCommit commit / reveal (4 strikes) | 81,287 / 41,526 | 89k / 46k | 0.009 / 0.005 |

Budget: a one-time core deploy is about 0.8 MON. A 6-strike Taipei day is about 0.17 (ladder) + 0.88 (6 Kuru
markets) + about 0.02–0.04 (settlement), roughly **1.1 MON/day before maker quoting**. Kuru market creation
dominates. Gas is high relative to Ethereum because every mint touches 5 cold accounts (AUSD proxy+impl, two
clones, token impl) at Monad's 10,100 gas per cold account. Per-test gas: `test/.gas-snapshot`. Latency was not
measured, because that needs live transactions (no MON).

## Findings other builders need

- **The AUSD faucet has a GLOBAL 60 s cooldown.** `requestFunds` reverts with `MaxFrequencyExceeded()`
  (`0x20e5bc67`) until 60 s after the previous claim by *anyone*. Measured on the fork: +59 s reverts, +60 s
  succeeds. The drip/relayer must stockpile AUSD and not call the faucet per user. Each claim gives 10,000 AUSD.
- **Testnet AUSD supports both EIP-2612** (`permit`, `nonces`, `DOMAIN_SEPARATOR`) **and EIP-3009**
  (`receiveWithAuthorization`, `transferWithAuthorization`); I checked the selectors in the implementation
  `0xc1e3…12da`. The domain is "Agora Dollar" v1, chainId 10143. The vault uses 2612.
- **The MockKeystoneForwarder never reverts when our `onReport` reverts.** The tx succeeds and emits
  `ReportProcessed(receiver indexed, workflowExecutionId indexed, reportId indexed, bool result)`, topic
  `0x3617b009…16b5`. The CRE workflow and dashboards must check `result` or our
  `LadderResolved(bytes4,uint32,uint8,int16,bytes32,address)` event, topic `0xdaba13fd…ca0f`, **not** tx status.
  The mock is permissionless, which is why attestation is mandatory.
- The deployed mock reports version "1.0.0" (the `develop` source says "1.0.0-dev"), but its behaviour matched the
  source in every case tested.
- `rawReport` layout for the mock: `0x01 | execId(32) | ts(4) | donId(4) | cfgVersion(4) | workflowCid(32) |
  name(10) | owner(20) | reportId(2) | report`. The header is 109 bytes. See `script/attestation-vector.json`.
- Foundry 1.8.5 wraps every `--json` output in `{"schema_version","success","data",...}`. Negative ints go to
  `cast call` after `--` with options first (`cast call --rpc-url X addr sig -- -3`). The Bash tool runs zsh, so
  `[ a == b ]` fails there.

## Interfaces for the other workstreams

- Report payload: `abi.encode(bytes4 station, uint32 date, int16 tmaxC, bool isVoid, bytes32 sourcesHash, bytes sig65)`.
  `sig` is an EIP-712 signature over domain `{name:"Isotherm Resolver",version:"1",chainId:10143,verifyingContract:<Resolver>}`
  and type `Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash)`. The workflow can
  also read `settlementDigest(...)` and sign the raw digest; both give identical bytes (verified).
- `station` is ASCII bytes4 (`"RCSS"` = `0x52435353`) and `date` is local yyyymmdd. A ladder settles any time
  from `Resolver.dayEnd(station,date)` onward. Due list: `CollateralVault.duePendingLadders(0, 50)`.
- `seriesId = keccak256(abi.encode(bytes4 station, uint32 date, int16 strikeC))`. Tokens:
  `getSeries(id).yes/.no` or `predictTokenAddress(station,date,k,isYes)`.
- Vault: `mintSet(bytes32,uint256)`, `mintSetTo(bytes32,uint256,address)`,
  `mintSetWithPermit(bytes32,uint256,address holder,uint256 deadline,uint8,bytes32,bytes32)`,
  `redeemSet(bytes32,uint256)`, `redeem(bytes32,uint256 yes,uint256 no) returns (uint256)`,
  `previewRedeem`, `payoutHalves(bytes32) -> (2,0)|(0,2)|(1,1)`.
  Events: `SeriesCreated` (`0xd88d9fa7…a197`), `SetMinted` (`0x6976207c…7de4`), `Redeemed` (`0xc9949b3e…dfc9`).
- Set the CRE write gas limit to about 250k with the mock (the measured whole tx is 148,685). Add headroom for the
  production KeystoneForwarder's signature checks.

## Not done / limits (honest)

- **No live-testnet deployment yet** (deployer 3.65 MON < 5 MON rule; the key is shared with the Kuru spike).
  Command when ready: `ATTESTER=<addr> OPERATOR=0xd572…448a forge script script/Deploy.s.sol --rpc-url
  monad_testnet --broadcast --private-key $(cat ~/.config/isotherm/deployer.key) --gas-estimate-multiplier 110 --slow`.
  Run it only when no other agent is sending from the deployer.
- The production KeystoneForwarder path was only tested for "direct calls are rejected". Real DON signatures can't
  be produced on a fork. The workflowId pinning is unit-tested with the documented 64-byte metadata layout.
- Not in this scope: the Zap (mint + sell the other leg on Kuru), the SeriesConfig allowlist, the 1% settlement
  fee, and Sourcify verification. Settlement is final: there is no dispute window or admin override (by design),
  so the attester key is the trust anchor. Mitigations: guardian pause before a bad report lands; stale void
  after 24 h.
- Not audited. Static lints were reviewed; the remaining warnings are intentional (calendar math division,
  `transferFrom(holder)` after a permit).

## Human actions

1. **Attester key.** Create a dedicated key (not the deployer), e.g. `cast wallet new` saved to
   `~/.config/isotherm/attester.key` (chmod 600). Pass its address as `ATTESTER`, and give the key to the CRE
   workflow as a secret.
2. Testnet MON: about 1 MON for the core deploy, plus about 1.1 MON/day per 6-strike city before quoting. The
   faucet claim stays a human step.
3. Mainnet: about 0.2–0.4 MON on the mainnet deployer for `DeployForecastCommit` (broadcast by a human), plus
   about 0.01 MON/day for commits.
4. CRE deploy access (`cre account access`) to move from the mock to the production forwarder, then call
   `setForwarder(0xF834…4482)` and `setExpectedWorkflow(id, owner)`.
