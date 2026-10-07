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
    - **Sell N Yes for ≥ M AUSD** sells at a fresh quote.

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
