# CRE feasibility spike: result

**Verdict: feasible.** I ran the full settlement path end to end on live Monad testnet 10143. The path is: live IEM + aviationweather METAR, then agree-or-void, then an EIP-712-attested report, then the real MockKeystoneForwarder, then the contracts builder's unmodified `Resolver`. This was done twice:
- RCSS 2026-10-05 settled at **29 °C** through my SDK harness.
- RCSS 2026-10-04 settled at **35 °C** through the **official CRE simulator engine running our compiled WASM**. That engine is the CLI built from source with only the login check removed (§6).

Both values match the Polymarket-resolved highs.

What still needs a team member is the **CRE account**. Without a login, the official `cre workflow simulate` binary refuses to run, and so do `cre init` and every account or deploy command. `cre workflow build` and `cre workflow hash` work without a login. So do the TS SDK test harness and everything on-chain.

Once `cre login` is run, the unmodified official command in §4 will produce the same result as §6. The only thing my patch removes is the client-side login check.

Date: 2026-10-06. Tooling: CRE CLI v1.37.0, `@chainlink/cre-sdk` 1.23.0, bun 1.4.2, Foundry 1.8.5.

---

## 1. What works, with evidence

### 1.1 CRE CLI installed from a verified source
```
$ shasum -a 256 cre_darwin_arm64.zip   # GitHub release v1.37.0 (2026-10-05)
b72d94ca7b3a6a88dbb68205c6a00c2edfb107814fb3dab1c15264aebdb0a7a0   == checksums.txt == GitHub API asset digest
$ codesign -dv .tools/bin/cre  ->  Identifier=com.smartcontract.cre.cli  TeamIdentifier=U52857STQU
$ cre version  ->  CRE CLI version v1.37.0
```
To reproduce the install, run `./setup.sh`. It checks the checksum and installs the CLI and bun into `.tools/`, which is gitignored.

### 1.2 Which commands need `cre login`
I ran each command with no `~/.cre/cre.yaml` and no `CRE_API_KEY`. I then cross-checked the results against `cmd/root.go` `LoginExemptCommands` at tag v1.37.0.

| Works without login | Needs login (fails with *"Authentication required: not logged in and no CRE_API_KEY set"*) |
|---|---|
| `cre version`, `cre templates list`, **`cre workflow build`**, **`cre workflow hash`**, `cre workflow limits export`, `cre generate-bindings` | **`cre workflow simulate`**, `cre init`, `cre workflow supported-chains`, `cre workflow deploy/list`, `cre account access`, `cre whoami`, `cre registry list`, `cre secrets *`, `cre execution *` |

- The CRE docs also say this directly: "An account is required to log in with the CRE CLI and run any CLI commands, including simulating."
- `CRE_API_KEY` is not a way around this for a solo dev. API-key auth "requires your account to have deploy access approval" (docs/cre_reference_cli_authentication.md).

### 1.3 The TypeScript workflow is written, tested and compiles to WASM (no login)
Location: `project/` is a hand-scaffolded CRE project, because `cre init` needs a login. Its layout matches the official `sports-resolution-ts` template.

`project/settle/workflow.ts` does the following:
1. A cron trigger fires (`0 30 16 * * *` UTC, which is 00:30 Taipei).
2. An **EVM read** of `Resolver.resultOf(station, date)` skips city-days that are already resolved. Setting `readSettled:false` stubs the read out.
3. Two **node-mode HTTP fetches**, each aggregated across the DON with `ConsensusAggregationByFields({tmax: median, obs: median})`:
   - IEM ASOS raw METAR+SPECI, `tz=Etc/UTC`, filtered to the station-local day.
   - aviationweather.gov `format=raw&hours=24&date=<local-day-end>`. The window is pinned, so the result does not drift with "now".
4. **Agree-or-void**:
   - If both sources have at least `minObs` (40) observations and agree, the workflow settles.
   - If they disagree, it sends a VOID report.
   - If either is under `minObs`, it writes nothing and the next cron run retries.
5. It encodes `abi.encode(bytes4 station, uint32 yyyymmdd, int16 tmaxC, bool isVoid, bytes32 sourcesHash, bytes attestation)`. This is exactly `src/Resolver.sol`.
6. The attestation is an **EIP-712 signature** by the attester:
   - Domain: "Isotherm Resolver" v1, chainId, resolver.
   - Struct: `Settlement(bytes4 station,uint32 date,int16 tmaxC,bool isVoid,bytes32 sourcesHash)`.
   - It uses `@noble/curves`, which is synchronous and QuickJS-safe. The key comes from CRE secret `ISOTHERM_ATTESTER_KEY`.
7. `runtime.report()` then `evm.writeReport()` with a tight `gasLimit`.

Evidence:
```
$ bun test                                   (official @chainlink/cre-sdk/test harness: HttpActionsMock + EvmMock + newTestRuntime)
 8 pass  0 fail  27 expect() calls          (7 unit/handler tests + the e2e file, which no-ops unless ISOTHERM_E2E_RPC is set)
   - METAR parsing (negatives "M05", "05/", no RVR/fraction false positives, month-boundary ddhhmmZ)
   - real fixtures RCSS 10-03/10-04/10-05: IEM 30/35/29 == AWC 30/35/29
   - happy path: reads resultOf, 2 HTTP calls, report decodes to (RCSS, 20261005, 29, false) and the EIP-712 sig recovers to the attester
   - already-resolved -> no HTTP / no write; disagree -> isVoid=true,tmax=0; thin coverage -> no write
$ tsc --noEmit -> TYPECHECK_OK
$ cre workflow build ./settle -T anvil-fork   (no login)
✓ Workflow compiled successfully -> settle/binary.wasm (2,781,305 bytes; 2.7 s warm, 48 s first run)
$ cre workflow hash ./settle -T anvil-fork --wasm $PWD/settle/binary.wasm --public_key 0xb855…5c11
  Workflow hash: 00a6ccec…fff7ff   (this becomes the on-chain workflow ID once deployed)
```
Live data check (`bun run scripts/live-check.ts RCSS 480 2026-10-03 2026-10-04 2026-10-05`):
```
RCSS 2026-10-03 IEM tmax=30 obs=49 | AWC tmax=30 obs=49
RCSS 2026-10-04 IEM tmax=35 obs=45 | AWC tmax=35 obs=45
RCSS 2026-10-05 IEM tmax=29 obs=50 | AWC tmax=29 obs=50     (responses 4–5 KB; CRE HTTP limit is 250 KB)
```

### 1.4 Both forwarders exist on 10143, and their call shapes are verified
```
$ cast call 0xB9F79d863261869B234c481D1f9A7af84AeAd192 'typeAndVersion()(string)'  -> "MockKeystoneForwarder 1.0.0"  (4,579 B code)
$ cast call 0xF8344CFd5c43616a4366C34E3EEE75af79a74482 'typeAndVersion()(string)'  -> "KeystoneForwarder 1.0.0"      (8,591 B code)
```
- Full addresses:
  - Mock (simulation): `0xB9F79d863261869B234c481D1f9A7af84AeAd192`. This is the address hard-coded in the CLI (`supported_chains.go`), and the docs list the same one.
  - Production: `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`.
- Call shape: `report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)`, selector `0x11289565`.
- `rawReport` = a 109-byte header followed by the payload. The header layout is: `version(1) | executionId(32) | timestamp(4) | donId(4) | donConfigVersion(4) | workflowId(32) | workflowName(10) | workflowOwner(20) | reportId(2)`.
- The forwarder calls `IReceiver.onReport(metadata = rawReport[45:109] (64 bytes), report = rawReport[109:])` with `msg.sender = forwarder`. It checks ERC-165 `supportsInterface(IReceiver)` first.
- The mock forwarder does pass 64 bytes of metadata, which contradicts the docs. The simulator fills it with fixed values:
  - workflowId `0x1111…11`
  - name `"7721568293"` (sha256("isotherm-settle")[:10] as ASCII)
  - owner `0xaaaa…aa`
  - reportId `0x0001`
  - header timestamp hard-coded to `100`
  - Proven by the fork test `test_mockForwarder_metadataShape`. Source: chainlink `core/capabilities/fakes/consensus_nodag.go` and `cmd/cre/utils/standalone_engine.go`.
- The production DON is actively delivering on 10143. Example tx `0xf86ac0fa8113e6fc436180f3b3416490edd5dc717ba981de90dcd3f0fbedba88`:
  - Transmitter `0x926ee6a7…`, gas limit 319,532.
  - rawReport 141 B with a real workflowId `0x0082…7e8b`, a real unix timestamp and reportId `0x0000`.
  - 4 DON signatures and a 96-byte reportContext.

### 1.5 Foundry fork tests: the builder's `Resolver` driven through the real forwarder bytecode
`onchain/` compiles `../../../src/Resolver.sol` unmodified. Command: `forge test --fork-url http://127.0.0.1:18845 -vv`, against `anvil --fork-url https://testnet-rpc.monad.xyz --fork-block-number 68692800 --network monad`.
```
[PASS] test_liveForwardersIdentity()
[PASS] test_tsReport_settlesThroughMockForwarder()   <- the exact bytes produced by the TS workflow test settle the Resolver (tmax 29)
[PASS] test_mockForwarder_metadataShape()            <- metadata = 64 B: 1111…11 | 37373231353638323933 | aaaa…aa | 0001
[PASS] test_forgedReport_rejectedButTxSucceeds()     <- bad attester: ReportProcessed(result=false), tx still SUCCEEDS
[PASS] test_replay_rejected()                        <- second delivery: result=false (write-once)
[PASS] test_directOnReport_reverts()                 <- InvalidSender
[PASS] test_productionForwarder_requiresDonSignatures() <- prod KeystoneForwarder reverts without DON sigs
7 passed; 0 failed
```

### 1.6 E2E "login-free local simulator" on the anvil fork, then on **live testnet**
`project/settle/e2e/anvil.e2e.test.ts` runs the real `onCron` handler in the SDK test runtime. Its capabilities are wired to the real world:
- HTTP is a real curl.
- EVM read is a real `eth_call`.
- `writeReport` does what the CLI's `FakeEVMChain.WriteReport` does. It prepends the simulator's 109-byte header and calls `MockKeystoneForwarder.report`.
- Before running, it deploys the builder's Resolver and registers RCSS.

**Anvil fork** (`ISOTHERM_E2E_RPC=http://127.0.0.1:18845 bun test --timeout 120000 ./e2e/anvil.e2e.test.ts`):
```
[USER LOG] RCSS 2026-10-05: IEM tmax=29 obs=50 | AWC tmax=29 obs=50
report tx status=success gasUsed=149417 gasLimit=180000
MockKeystoneForwarder.ReportProcessed.result=[true]
Resolver.LadderResolved=[{"station":"0x52435353","date":20261005,"status":1,"tmaxC":29,...,"caller":"0xB9F79d86…d192"}]
workflow result #2: [{"station":"RCSS","date":20261005,"skipped":"already-resolved"}]
```
**Live Monad testnet 10143.** The deployer had 5 MON, so I ran the same test with `ISOTHERM_E2E_LIVE=1`. The full log is in `logs/e2e-live.log`.

| step | tx hash | result |
|---|---|---|
| deploy Resolver (builder's code, forwarder = mock, attester = spike key `0xbAD025FD362A8fd65B35EFD0ABE71A550103BEde`) | `0x08befe90c467eb6b8b80f47be27c784be982a6ced520886cfa3e1df275f11500` | Resolver at **`0xb7b91d408f74f4e5c444c75981208ca78e2bca09`** |
| `registerStation(RCSS, +8h)` | `0xe7631c880ed0f9ec5088b3d0772ab54cc0f69ccef2a7115140f8897e4e6dd783` | success |
| CRE report through the MockKeystoneForwarder (SDK harness) | **`0x482d7a1e5e013a3338061bf8539233b8887ddf4333ba440b59b225134c8a817c`** (block 68693830) | `ReportProcessed(result=true)` and `LadderResolved(RCSS, 20261005, Settled, 29)` |
| CRE report from the **official simulator engine** (WASM, `--broadcast`; §6) | **`0x999c2cce489beeba14a21899adb87b807f014b30608c16ebd579de5d77a8ca29`** (block 68697689) | `ReportProcessed(result=true)` and `LadderResolved(RCSS, 20261004, Settled, 35)` |

I checked the result independently:
```
$ cast call 0xb7b91d40…ca09 'resultOf(bytes4,uint32)((uint8,int16,uint64,bytes32))' 0x52435353 20261005
(1, 29, 1791292293, 0x83497709447509b3c11d431a9ddc958d22e218f0c7f35bdb14596c35fbce8089)
```
On the second run, the EVM read saw the result and skipped: no HTTP calls and no transaction.

### 1.7 `simulate --broadcast` against a custom RPC (an anvil fork) is supported
- RPCs come from `project.yaml` per target. I added the target `anvil-fork: rpcs: [{chain-name: monad-testnet, url: http://127.0.0.1:${ISOTHERM_ANVIL_PORT}}]`.
- The CLI's cleartext policy allows `http://` only for loopback hosts (`internal/rpc/cleartext.go`).
- Proof: `cre workflow hash -T anvil-fork` loads the settings fine. A non-loopback `http://203.0.113.10:8545` target fails with *"cleartext RPC URL … is not allowed; use https:// or pass --allow-insecure-rpc"*.
- The simulator then sends `MockKeystoneForwarder.report` from `CRE_ETH_PRIVATE_KEY`, using the hard-coded mock address for the monad-testnet selector. An anvil fork keeps chainId 10143 and the mock's code, so it works there.

---

## 2. What doesn't work, or needs care

1. **Official `cre workflow simulate` needs a login.** No flag or env var avoids it. `CRE_API_KEY` needs deploy access first.
2. **TX_STATUS_SUCCESS does not mean "settled".** Both forwarders swallow a reverting `onReport` and emit `ReportProcessed(result=false)`. The simulator would still print "Write report transaction succeeded" (proven by the forged-report test). Confirm settlement from `LadderResolved` or `resultOf`.
3. **The mock forwarder is permissionless.**
   - Anyone can call `MockKeystoneForwarder.report` or `route` with any bytes and any metadata. The forwarder check and any `expectedWorkflowId` check prove nothing in sim mode.
   - The EIP-712 attestation is the only real authentication. This is shown in the fork tests: a forged report is rejected, and a direct call reverts.
4. **Sim-mode metadata is fake but not empty.**
   - If the builder pins `expectedWorkflowId` to the real deployed ID, simulation reports fail (the mock passes `0x1111…`).
   - Production uses reportId `0x0000`; sim uses `0x0001`.
   - In sim, the header timestamp is always `100`. Never use it.
5. **The anvil-mode harness is not WASM.** It runs the TypeScript in Bun, not QuickJS. The WASM build itself is verified (`cre workflow build` passes); for the QuickJS run, see §6.
6. **The anvil fork's `finalized` block lags 64 blocks.** The workflow reads `resultOf` at `LAST_FINALIZED_BLOCK_NUMBER`, which is deterministic across DON nodes. A Resolver deployed on a fresh anvil fork is therefore invisible to it, and the first simulate failed with *"Cannot decode zero data ("0x")"*.
   - Fix on anvil: run `cast rpc anvil_mine 0x50` after deploying.
   - Live Monad has the same block for `finalized` and `latest` within about 1 s, so live testnet is unaffected.
7. **The simulator needs `bun` on PATH** to compile TypeScript workflows. Without it you get: *"bun is required for TypeScript workflows but was not found in PATH"*.
8. **`--config` limits:** the path is relative to the workflow folder and at most 97 characters.
9. **Other agents also use the deployer key.** I used nonces 0–2 and 8; other agents sent nonces 3–7 in between. The balance was 3.65 MON at the end. Watch for nonce races when several agents send from it at once.
10. **Headless 24/7 operation.**
   - `cre login` needs a browser plus 2FA.
   - A VPS can only run the cron through `CRE_API_KEY` (after deploy access), or a copied `~/.cre/cre.yaml` (session tokens with a refresh token; expiry is undocumented).
   - Otherwise, run it on the Mac with launchd.

## 3. Gas, cost and latency
| item | number |
|---|---|
| Report tx, sim path (Mock → Resolver.onReport, settle) | **149,417 gas used** with empty sigs (my harness). **155,961 gas used** with the official simulator (4 sigs plus a 96 B context in calldata). Both measured on anvil `--network monad`. Gas limit set to **180,000**; Monad bills the limit, so 180,000 × 102 gwei = **0.01836 MON per city-day**. Do not go below about 170k. |
| Real DON report on prod forwarder (4 sigs) | gas limit 319,532 (tx `0xf86ac0fa…`). In production the DON transmitter pays, not us. |
| Resolver deploy / registerStation (live) | 2,683,164 / 64,758 gas limit, which is 0.2737 / 0.0066 MON |
| Total live spend for this spike | **0.317 MON** (0.298648044 for deploy + register + report #1, plus 0.01836 for report #2 from the official engine) |
| Workflow run wall time | Harness: anvil 3.5 s, live 8.3 s (2 HTTP calls at about 1.3–1.6 s each, eth_call, tx). Official simulator: about 11 s end to end, including about 5 s of WASM compile. Report tx confirmed in 1,279 ms on live testnet. |
| WASM | 2.78 MB. Build takes 2.7 s warm. |
| CRE quotas that matter | 15 HTTP calls per run, so 7 stations at most per execution. 15 EVM reads, 5 secrets, 50 KB report, 10M gas per tx, cron no faster than every 30 s. |

## 4. Human actions (exact)
1. **Create the CRE account:**
   - Go to https://app.chain.link/cre/discover and choose "Create an account".
   - Enter your email and country, accept the ToS, and enter the 6-digit email code.
   - Set a password and set up 2FA (authenticator app).
2. **Log in on this Mac.** This opens a browser and asks for the 2FA code:
   ```bash
   cd spikes/cre   # from the repository root
   export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
   cre login && cre whoami
   ```
3. **Request deploy access.**
   - Run `cre account access` and answer **Yes**.
   - Suggested use-case text: *"Isotherm (Monad Metropolis hackathon): cron workflow settles daily airport max-temperature prediction markets on Monad testnet 10143 — fetches METAR from IEM + aviationweather.gov with DON consensus, writes an attested report to a Resolver via KeystoneForwarder."*
4. **Run the official simulator** (after step 2). Anvil fork first, no MON needed:
   ```bash
   anvil --fork-url https://testnet-rpc.monad.xyz --network monad --port 18845 &
   cd onchain && ISOTHERM_DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
     ISOTHERM_ATTESTER_ADDR=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 \
     forge script script/DeploySpikeResolver.s.sol --rpc-url http://127.0.0.1:18845 --broadcast   # public anvil keys, fork only
   cast rpc anvil_mine 0x50 --rpc-url http://127.0.0.1:18845     # make the deployment "finalized" (see §2.6)
   # put the printed Resolver address into project/settle/config.anvil.json "resolverAddress"
   cd ../project && cp env.example .env   # CRE_ETH_PRIVATE_KEY = anvil key #1, ISOTHERM_ATTESTER_KEY_ALL = anvil key #9 (0x optional), ISOTHERM_ANVIL_PORT=18845
   # (bun must be on PATH: the export in step 2 does that)
   cre workflow simulate ./settle -T anvil-fork --non-interactive --trigger-index 0 --broadcast
   ```
   Then on live testnet. `config.testnet.json` already points to the spike Resolver `0xb7b9…ca09`. Set `CRE_ETH_PRIVATE_KEY` to the deployer key, and `ISOTHERM_ATTESTER_KEY_ALL` to the contents of `spikes/cre/.secrets/attester.key`.
   ```bash
   cre workflow simulate ./settle -T testnet --non-interactive --trigger-index 0 --broadcast
   ```
   With no `dateOverride`, the workflow settles the most recently completed Taipei day (for example 2026-10-06 once it is past 16:00 UTC).
5. If deploy access is granted:
   - Set `deployment-registry: "private"` in `workflow.yaml`, run `cre secrets create`, then `cre workflow deploy ./settle -T testnet`.
   - On the Resolver, call `setForwarder(0xF8344CFd5c43616a4366C34E3EEE75af79a74482)` and `setExpectedWorkflow(<workflow id>, <owner>)`.
   - Only then is it safe to call `setAttestationRequired(false)`.

## 5. Notes for the contracts builder (`src/Resolver.sol`)
- Report ABI and EIP-712 struct: the workflow matches the current Resolver exactly. If either changes, update `project/settle/report.ts` and rerun `bun test` and the fork tests.
- `_checkWorkflowMetadata` is fine. The mock sends 64 bytes (not 0), with workflowId `0x11…11` and owner `0xaa…aa`. Leave `expectedWorkflow*` unset while using the mock.
- Consider exposing a cheap `isResolved(bytes4,uint32)`. Today the workflow decodes the `resultOf` tuple, which works but is heavier.

## 6. Official simulator engine without login (dev harness only)
The CRE CLI is MIT-licensed. I built v1.37.0 from source with a **one-line patch**: `"cre workflow simulate"` added to `LoginExemptCommands`.
- Patch: `patches/cre-cli-v1.37.0-simulate-nologin.patch`. Build script: `patches/build-nologin-sim.sh` (Go 1.26.8, sha256-verified; 13 min; module cache deleted afterwards).
- Binary: `.tools/bin/cre-nologin-sim`.
- Without credentials the CLI skips telemetry (`internal/telemetry/sender.go`). The simulator is entirely local apart from the workflow's own HTTP and RPC calls.

**Use it only for local development.** It runs the real engine, but judges and the CRE bounty should see the official binary after `cre login` (§4).

What it proves, beyond everything above:
- The compiled WASM runs in QuickJS. That covers noble secp256k1, viem EIP-712, TextDecoder, the regexes and BigInt.
- `simulate --broadcast` pointed at an anvil fork works exactly as designed.

```
$ cre-nologin-sim workflow simulate ./settle -T anvil-fork --non-interactive --trigger-index 0 --broadcast   (logs/sim-patched-broadcast.log)
[USER LOG] RCSS 2026-10-05: IEM tmax=29 obs=50 | AWC tmax=29 obs=50
[USER LOG] RCSS 2026-10-05: writeReport tx 0xe82c62dfc1aab6be5eb0e33e9ce1212416ad8f5631d080d380f5d03b81cab9e7
✓ Workflow Simulation Result: [{"station":"RCSS","date":20261005,"tmaxC":29,"isVoid":false,...}]
  -> fork receipt: status 1, gasUsed 155,961, from CRE_ETH_PRIVATE_KEY (anvil #1) to MockKeystoneForwarder,
     logs: Resolver LadderResolved + ReportProcessed(result=true); resultOf = (1, 29, …)
  -> decoded rawReport header: version 01 | ts 100 | don 1 | cfg 1 | workflowId 0x1111…11 | name "7721568293" | owner 0xaaaa…aa | reportId 0001
     reportContext 96 B, 4 signatures   (== the header my harness/CreReport.sol emulate)
$ (rerun after anvil_mine)  [USER LOG] RCSS 2026-10-05: already resolved (status=1), skip

$ cre-nologin-sim workflow simulate ./settle -T testnet --config ./config.testnet-replay.json --non-interactive --trigger-index 0 --broadcast
                                                                         (LIVE Monad testnet; logs/sim-patched-live-testnet.log)
[USER LOG] RCSS 2026-10-04: IEM tmax=35 obs=45 | AWC tmax=35 obs=45
[USER LOG] RCSS 2026-10-04: writeReport tx 0x999c2cce489beeba14a21899adb87b807f014b30608c16ebd579de5d77a8ca29
  -> block 68697689, status 1, gas 180,000 @ 102 gwei, from deployer 0xb855…5c11 to MockKeystoneForwarder
  -> cast call resultOf(RCSS,20261004) on 0xb7b91d40…ca09 = (1, 35, 1791293472, 0xf778ae82…a3d1)
```

## 7. Files
- `project/settle/{workflow,metar,report,main}.ts`: the workflow. `workflow.test.ts` holds the SDK-harness tests. `e2e/` holds the real-world harness. `fixtures/` holds real IEM/AWC captures and the encoded report.
- `project/{project.yaml,secrets.yaml,env.example}` and `project/settle/{workflow.yaml,config.*.json}`: CRE project config (targets `anvil-fork`, `testnet`).
  - `config.anvil.json` holds the fork-local Resolver address `0xC0BF…07e5`. Redeploy it and update the address on every fresh fork.
  - `config.testnet-replay.json` is `config.testnet.json` plus `dateOverride` (used for the 10-04 replay).
- `patches/`: the one-line CLI patch plus its build script (dev harness, §6).
- `onchain/`: Foundry project. `test/ForwarderFork.t.sol`, `src/CreReport.sol` (simulator header builder), `script/DeploySpikeResolver.s.sol`.
- `ref/chainlink-evm/`: MockKeystoneForwarder, KeystoneForwarder and IReceiver sources (MIT, chainlink-evm@b6427ea).
- `docs/`: captured CRE docs pages. `logs/`: e2e evidence logs and the go build log.
- `.secrets/attester.key`: spike attester key for the live Resolver (gitignored). `.tools/`: CLI and bun (gitignored, `./setup.sh`).
