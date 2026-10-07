# apps/web: fix round (2026-10-07)

This round fixes the web issues the v1 verifier raised (`test/security/v1/RESULT.md`, finding N1 and the copy notes). The fixes are live at https://isotherm.pages.dev (Pages deployment `<retired-deployment>`).

How it was tested:
- Every write flow ran only on an anvil fork of Monad testnet (`127.0.0.1:19520`).
- The live chain got read-only checks only. No MON or AUSD was spent on it.
- Contracts are untouched.

## 1. Buy No now uses `vault.mintSet` + `zap.sellYes(minAusdOut)`; `Zap.buyNo` is never called (N1)

**What changed**
- **`src/lib/buyNoPlan.ts`** (new, pure). `planBuyNo` turns a quote into a plan:
  - `mint`: the number of pairs to mint;
  - `minAusdOut`: the quoted YES proceeds × (1 − slippage), never 0;
  - `worstCost`;
  - which one-time approvals are missing.
- **`src/lib/buyNo.ts`** (new). `runBuyNo` runs the steps in this order:
  1. the one-time approvals, if any: AUSD → vault and YES → Zap. They come first, so a failed approval can never leave the user holding pairs.
  2. `vault.mintSet`.
  3. `zap.sellYes` with the hard minimum.
  4. A merge (`redeemSet`), only if the sale filled partly but still cleared the minimum. This way a "Buy No" never leaves the user holding YES.

  If step 2 fails, `runBuyNo` throws `SellLegFailed` with the number of pairs the user now holds.
- **`src/lib/book.ts`**. `quoteBuyNoViaSell` replaces `quoteBuyNo` and `sizeBuyNoForBudget`. It sizes the mint so that:
  - the net cost is at most the budget;
  - the mint is at most the wallet's AUSD;
  - the mint is at most today's bid depth, so step 2 is expected to fill completely and no merge is needed.
- **`src/lib/abi.ts`**. `Zap.buyNo` and `ZapBuyNo` are removed from the app ABI. `mintSet`, `SetMinted` and `SetRedeemed` are added. The built bundle contains no `function buyNo`.
- **`src/lib/actions.ts`**: `buyNo()` is removed, `mintSet()` is added, and `ensureAusdAllowance` takes a spender. **`src/lib/data.ts`**: balances now include `ausdAllowanceVault`.
- **`src/components/TradeSheet.tsx`**. One tap still starts the whole flow, and the sheet now shows its steps:
  - **Progress list: "One tap, two transactions".** It shows ① Mint N pairs and ② Sell N Yes for at least M AUSD, plus a "· One-time approvals" row only when approvals are needed.
  - **Step status.** Each step shows a spinner, ✓ or ✕, with a tx link.
  - **Button label.** It reads "Step 1 of 2 · minting pairs…" and then "Step 2 of 2 · selling Yes…".
  - **Max loss row.** It now also shows the worst case at the slippage limit ("10.00 AUSD · ≤ 10.10").
  - **If step 2 does not go through,** a recovery box says the user holds N Yes + N No, which always redeem for N AUSD. It offers two buttons:
    - **Merge back → N AUSD** is the primary button: `redeemSet`, with no price risk.
    - **Sell N Yes for ≥ M AUSD** sells at a fresh quote. *(Round 2: the minimum can no longer go below the original plan's per-unit minimum; see "Fix round 2" below.)*

    New trades are blocked until the user picks one, or closes the sheet; Portfolio still offers Merge and Sell Yes.
  - **The MON check covers the whole flow before step 1,** so a Buy No never stops between its two transactions for lack of gas.
- **i18n (en + 繁中).** New `trade.*` strings cover the steps, the busy labels, the recovery box and the fee note.

**Evidence**

*Unit tests.* `npm test` passes **10/10**. Three tests are new:
- the sizing stays within the budget, the balance and the bid depth;
- the plan keeps a hard minimum and asks only for the missing approvals;
- **the N1 sandwich model:** the old `minAusdBack` bound passes at more than 0.99 per NO, while `toUnits6(sandwiched proceeds) < plan.minAusdOut`.

*Headless fork run* (`scripts/fork-buyno-sandwich.ts`). It used the deployed v1 vault and Zap and the real Kuru book of the live RCSS 2026-10-08 ≥30 °C strike, copied into the fork at block 68905793. Output: `evidence/fix-round/fork-buyno-sandwich-rcss-20261008-ge30.json`.

| Scenario | Result |
|---|---|
| **A. Normal Buy No, 10 AUSD** | Minted 15.143713 pairs and sold the YES for 5.143651 AUSD (quote 5.143713, minimum 5.040838). Paid **10.00 AUSD for 15.14 NO = 0.660 per NO**, as quoted. |
| **B. Sandwich between the quote and step 2** | The attacker takes the 0.34 bid and leaves 7.57 YES bid at 0.001. Step 2 **reverts**. The victim holds 15.14 YES + 15.14 NO and merges back. **Net AUSD change 0** (the victim pays gas only). |
| **C. The same sandwich against the old `Zap.buyNo`** | The `minAusdBack` bound passes. The victim pays **7.56 AUSD for 7.57 NO = 0.999 per NO**, against 0.660 quoted. This is the bug the app no longer exposes. |
| D. Buy Yes (unchanged, already properly bounded) | 466,041 gas |

*In-app browser at 375 px, dev wallet, fork* (`evidence/fix-round/01…15*.jpg`; transactions in `browser-fork-dev-wallet-txs.json`):
- `02`–`04`: first Buy No on ≥30 °C. It needed two approvals, a mint and a sale, and filled **15.14 No for 10.00 AUSD**. Mining was slowed to 3 s blocks so the progress states could be captured.
- `05`–`06`: Buy Yes filled **21.26 Yes for 10.00 AUSD**.
- `07`: second Buy No. No approvals were needed, so only steps ① and ② appear.
- **`08`: a real same-block mempool sandwich** (`scripts/fork-sandwich-watcher.ts`, output `browser-sandwich-step2-reverted.json`):
  - block 68905850 holds, in order: the attacker's market sell, then the attacker's 0.001 dust bid, then the victim's `sellYes`;
  - the victim's tx **reverted with `Slippage(7492, 5040838)`** (from `cast run`);
  - the sheet showed the recovery box.
- `09`: Merge back returned 15.14 AUSD, and the AUSD balance went back to 980.00.
- `10`: the session log.
- `15`: the 繁中 Buy No sheet.

**Costs and tradeoffs** (gas measured on the fork; MON priced at the live 102 gwei × the gas limit, which is what Monad bills):

| | Before | Now |
|---|---|---|
| Repeat Buy No | `buyNo` ≈ 0.071 MON | mint 0.026 + sell 0.053 = **0.079 MON** |
| First Buy No on a strike | 0.079 MON | **0.094 MON**: two approvals (≈ 0.015) are added, AUSD → vault and YES → Zap for that strike |
| First Buy Yes | — | **0.060 MON** |

- A single 0.15 MON drip therefore covers a first Buy No (0.094) or a first Buy Yes (0.060), but not both (0.154). If MON allows, a drip of ≥ 0.16 MON fixes that.
- **A sandwiched step 2 still costs its gas** (≈ 0.05 MON, because Monad bills the limit), and Merge back costs ≈ 0.018 MON. The AUSD is safe.
- **What the gasless relayed mint would change:** it would save the mint's gas. It was not used because it would spend the scarce relayer MON on every Buy No.

## 2. Copy fixes (en + 繁中), `src/components/HowItWorks.tsx`
- **"three METAR archives" is now two.** The text reads: "On the one miss (2026-05-04), two independent METAR archives (IEM and Ogimet) both hold a 25 °C report that Polymarket's 24 °C result missed." The 繁中 text says the same.
- **The challenge window no longer renders as "0.3-hour".** The new `windowLabel()` renders **"15-minute"** / **"15 分鐘"** for windows under an hour; it rounds hours to one decimal from one hour up.
- **Two honesty qualifiers were added to "Who settles".** Neither was on the issue list.
  - The window applies to a reported temperature; a reported void is final at once (verifier N2).
  - So far, real days were settled by the CRE simulator run locally (built from the MIT CRE CLI with only its login check removed) or by an SDK harness, against the earlier feasibility contracts, not by a deployed DON.
- Evidence: screenshots `11`–`14` (fork), and a live check of `document.body.innerText`:

  | Check | en | 繁中 |
  |---|---|---|
  | two archives (IEM and Ogimet) | true | true |
  | "three METAR" | false | false |
  | "15-minute" / "15 分鐘" | true | true |
  | "0.3-hour" | false | false |
  | CRE qualifier | true | not checked |

## 3. Login wording
- **`WalletSheet.tsx`.** When Dynamic is not configured, the sign-in sheet now says: "Dynamic login (email / social) is wired but not enabled yet, so this demo uses a testnet burner wallet." It is in en and 繁中 (screenshot `01`). The email button still appears only when `VITE_DYNAMIC_ENVIRONMENT_ID` is set.
- **`README.md`.** It now says: "Dynamic login is wired but not enabled; the demo uses a testnet burner wallet until it is." It also documents the two-step Buy No and the two new fork scripts.

## 4. Build, deploy, live smoke (read-only)
- `npm test` passes 10/10, `tsc -b` exits 0, and `npm run build` succeeds (main chunk 549.6 kB, 178.7 kB gzip). The bundle has the live RPC and API and no fork URLs.
- I deployed with `XDG_CONFIG_HOME=<wrangler config dir> npx wrangler@3 pages deploy dist --project-name isotherm --branch main`. The deployment is https://<retired-deployment>.isotherm.pages.dev, and https://isotherm.pages.dev serves `assets/index-BJ2g1e3Y.js`.
- **Live smoke, at 375 px.** No trade button was pressed. The result:
  - The live RCSS 2026-10-08 ladder loads with all 4 strikes and the snapshot's Fair and Polymarket values.
  - The ≥30 °C Buy No sheet shows the two-step preview, and the existing burner wallet there is held at "Get test funds first" by the MON check.
  - How it works passes the checks above.
  - The console shows no errors.
  - Screenshots: `16`, `17`.
- Cleanup: anvil :19520 and vite :5180 were started by me and are stopped. A key scan of `apps/web` (excluding `node_modules`) against `~/.config/isotherm/*` found 0 hits.

## Not done here (for other owners)
- **`apps/RESULT.md` (shared web + API doc)** still says "buy Yes and buy No through the Zap" and gives the old buyNo gas figure (630,693). It needs: "Buy No = mintSet + sellYes (FIXES.md)".
- **The mm plugin's `weather buy --side no`** needs the same mintSet + sellYes routing. That is the plugin owner's job; `planBuyNo` / `quoteBuyNoViaSell` can serve as a reference.
- **The Zap redeploy** (`buyNo` with `minNoOut`) is the contracts' fix before real money. The web app does not depend on it.

---

# Fix round 2 (2026-10-07, verifier item 2)

Live at https://isotherm.pages.dev (Pages deployment `<retired-deployment>`, main bundle `assets/index-sVKTc5nx.js`). Every write ran on an anvil fork (`127.0.0.1:19601`); the live chain got read-only checks only, and no MON or AUSD was spent on it.

## 1. Failed capability reads are no longer cached (`src/lib/data.ts`, `src/state.tsx`)
- **Before:** `capabilities()` turned a failed `getCode` into `'0x'` and a failed `challengeWindow()` read into `0`, then cached the result for the whole session. One RPC hiccup on first load meant "no canonical registry" (every strike without a book) and "no challenge window" until a full reload.
- **Now:**
  - `getCode` errors throw, so nothing is cached and the next refresh asks again.
  - The resolver's bytecode is checked for the `challengeWindow()` selector (new `SELECTORS.challengeWindow`). Without the selector, as on the feasibility resolver, 0 is the real answer and is cached. With it, a failed read falls back to `DEFAULT_CHALLENGE_WINDOW` for that call only and is retried.
  - Only a complete read is cached. Concurrent callers share one in-flight read.
  - `refreshLadders` (every 60 s) calls `capabilities()` before `loadLadders` and pushes the result into app state. The caps state therefore heals as soon as a read succeeds; before, it was set once at mount.
- **Fallback window = the deployed value, not 0.** `normalizeDeployments` now reads `params.challengeWindow` from `deployments/testnet.json` (900 s), matching that key exactly, so `maxChallengeWindow` is ignored. `DEFAULT_CHALLENGE_WINDOW` is used by `capabilities()` on a failed read and by `HowItWorks` while caps are still loading. The live check confirms that the v1 resolver bytecode has the selector and returns 900, and that the feasibility resolver has no selector.

## 2. A retried step 2 keeps the original per-unit minimum (`src/lib/buyNoPlan.ts`, `src/components/TradeSheet.tsx`)
- **Before:** after step 2 reverted, `retrySell` used `minOut(today's quote)`. After the N1 sandwich (bids taken, 7.57 YES left at 0.001), the button read "Sell 15.14 Yes for ≥ 0.01 AUSD" and was enabled, so the retry would have paid about 0.9995 per No. That is the N1 loss again, one transaction later.
- **Now:** `planRetrySell(original, pairs, quotedProceeds, slippage)` (pure, unit-tested) computes:
  - `floor`: the original `minAusdOut × pairs / mint`, rounded up;
  - `minAusdOut`: max(today's quote × (1 − slippage), `floor`);
  - `blocked`: today's bids cannot pay `floor`, so the sale would revert;
  - the implied No price now and the original worst case per No.

  The stranded state now stores the plan the user accepted at tap time (`origin`). It no longer reads `run.plan`, which a side switch could clear. A failed retry keeps that same origin.
- **UI:**
  - **Blocked:** the Sell button is disabled, and a warning (en + 繁中, `trade.retryBlocked`) states today's proceeds, the implied No price and the original worst case, and points to Merge back.
  - **Not blocked:** a fine-print line reads "The sale keeps your original limit: each No costs at most X AUSD" (`trade.retryNote`).
  - The stranded-box copy now says "or sell the Yes again, never below your original limit" instead of "at today's price".

## Evidence
- **Unit tests.** `npm test` passes **20/20**. The 10 new tests are in `test/retry-and-caps.test.ts`:
  - **getCode failure:** throws, then succeeds, then stays cached.
  - **challengeWindow failure:** returns 900 and is not cached; the next call reads 1800 and caches it.
  - **Feasibility resolver:** 0 is cached and `readContract` is never called.
  - **Concurrent callers:** they share one read.
  - **`params.challengeWindow` parsing.**
  - **Retry floor:** sandwiched book (blocked; the old minimum would have meant > 0.99 per No), unchanged book, a slightly worse book inside the slippage (the floor binds), a better book (the fresh minimum is above the floor), and partial pairs with no bids.
- **Build.** `tsc -b` exits 0 and `npm run build` succeeds (main chunk 551.6 kB, 179.6 kB gzip). The main chunk holds the live API and RPC, no `127.0.0.1`/`localhost`, and no `function buyNo`.
- **In-app browser, 375 px, anvil fork** (`evidence/fix-round-2/`):
  - `00`: a real same-block sandwich of the dev wallet's Buy No step 2. Victim `sellYes` `0x5aa078bc…` (minAusdOut 5.040838) **reverted**. Output: `browser-sandwich-step2-reverted.json`.
  - `01`: the recovery box on the sandwiched book. **"Sell 15.14 Yes for ≥ 5.04 AUSD" is disabled**, with the warning "Today's bids would pay only 0.01 AUSD for the 15.14 Yes, so each No would cost 1.000 AUSD, above your original worst case of 0.67…". Merge back stays enabled, and the main Buy No button is disabled.
  - `02`: a fork-only bid of 100 YES @ 0.34 was restored. The retry is offered at the 5.04 floor, with the note "each No costs at most 0.67 AUSD".
  - `03`: the retry filled **15.14 No for 10.00 AUSD**. The on-chain `sellYes` args show `minAusdOut = 5040838`, which is exactly the original plan's minimum (`browser-retry-floor.json`).
  - `04`: capability retry.
    1. The fork RPC was stopped and the page freshly loaded. How it works still said "15-minute challenge window" (the deployments fallback), and Markets showed "HTTP request failed".
    2. The RPC was restarted.
    3. On the next 60 s refresh, with no reload, the ladder came back with Kuru book prices from `Zap.canonicalMarket` (`browser-caps-retry.json`).
    4. Because the browser pane was hidden, `document.visibilityState` was overridden to `visible` for this inspection only, so the visibility-gated refresh would run.
- **Live smoke (read-only), 375 px** (`05`):
  - The page serves `index-sVKTc5nx.js`.
  - The RCSS 2026-10-08 ladder loads with all 4 strikes and the snapshot's Fair and Polymarket values, with no horizontal overflow.
  - How it works shows "15-minute" (en) and "15 分鐘" (繁中), and the new "Who settles" copy.
  - The ≥30 °C Buy No sheet shows the two-step preview (mint 15.14, sell for ≥ 5.04). The existing burner there is held at "Get test funds first", and that button was not pressed.
  - The console shows no errors.
- **Cleanup and key scan.** anvil :19601 and vite :5190 were started by me and are stopped. A key scan of `apps/web` (excluding `node_modules`) against `~/.config/isotherm/*` found 0 hits.

## Note for the docs owner
This deploy also shipped the "Who settles" copy in `src/components/HowItWorks.tsx` (en + 繁中), exactly as the docs worker had left it in the working tree at build time. If that copy changes again, Pages needs another `npm run build` and deploy.
