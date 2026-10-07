| # | command | step (intent sent to MetaMask) | gas est. | gas limit (billed) | gas used (fork) | MON @102 gwei | status |
|---|---|---|---|---|---|---|---|
| 1 | `mm weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.424` | AUSD for the Isotherm Zap: approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 2 | `mm weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.424` | Isotherm buyYes Tmax>=30C Taipei 2026-10-08 | 496857 | 621072 | 496857 | 0.0633 | CONFIRMED |
| 3 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.1719` | AUSD for the CollateralVault (mint complete sets): approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 4 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.1719` | YES Tmax>=29C Taipei 2026-10-08 for the Isotherm Zap (sell the YES leg): approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 5 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.1719` | Isotherm buy NO 1/2: vault.mintSet 10.000000 sets Tmax>=29C Taipei 2026-10-08 | 214367 | 235804 | 214367 | 0.0241 | CONFIRMED |
| 6 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.1719` | Isotherm buy NO 2/2: Zap.sellYes 10.000000 YES Tmax>=29C Taipei 2026-10-08 (min 8.240301 AUSD) | 506324 | 632905 | 506324 | 0.0646 | CONFIRMED |
| 7 | `mm weather buy taipei --strike 30 --side yes --amount 5 --max-price 0.05 --approve max` | AUSD for the Isotherm Zap: approve unlimited | 71028 | 78131 | 70585 | 0.0080 | CONFIRMED |
| 8 | `mm weather buy taipei --strike 30 --side yes --amount 5 --max-price 0.05 --approve max` | Isotherm buyYes Tmax>=30C Taipei 2026-10-07 | 511243 | 639054 | 511243 | 0.0652 | CONFIRMED |
| 9 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9991` | AUSD for the CollateralVault (mint complete sets): approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 10 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9991` | YES Tmax>=30C Taipei 2026-10-07 for the Isotherm Zap (sell the YES leg): approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 11 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9991` | Isotherm buy NO 1/2: vault.mintSet 5.000000 sets Tmax>=30C Taipei 2026-10-07 | 197367 | 217104 | 197367 | 0.0221 | CONFIRMED |
| 12 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9991` | Isotherm buy NO 2/2: Zap.sellYes 5.000000 YES Tmax>=30C Taipei 2026-10-07 (min 0.004970 AUSD) | 506192 | 632740 | 506192 | 0.0645 | CONFIRMED |
| 13 | `mm weather buy taipei --strike 28 --side yes --amount 5 --max-price 0.999` | Isotherm buyYes Tmax>=28C Taipei 2026-10-07 | 493761 | 617202 | 493761 | 0.0630 | CONFIRMED |
| 14 | `mm weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.363` | YES Tmax>=30C for the Isotherm Zap: approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 15 | `mm weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.363` | Isotherm sellYes Tmax>=30C Taipei 2026-10-08 | 506480 | 633100 | 506480 | 0.0646 | CONFIRMED |
| 16 | `mm weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.1041` | Isotherm buyYes (to close NO) Tmax>=29C Taipei 2026-10-08 | 493795 | 617244 | 493795 | 0.0630 | CONFIRMED |
| 17 | `mm weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.1041` | Isotherm merge 4.000000 YES+NO -> AUSD | 159957 | 175953 | 159957 | 0.0179 | CONFIRMED |
| 18 | `mm weather buy taipei --date tomorrow --strike 31 --side yes --amount 3 --max-price 0.097` | Isotherm buyYes Tmax>=31C Taipei 2026-10-08 | 493793 | 617242 | 493793 | 0.0630 | CONFIRMED |
| 19 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.9641` | AUSD for the CollateralVault (mint complete sets): approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 20 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.9641` | YES Tmax>=31C Taipei 2026-10-08 for the Isotherm Zap (sell the YES leg): approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 21 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.9641` | Isotherm buy NO 1/2: vault.mintSet 3.000000 sets Tmax>=31C Taipei 2026-10-08 | 197367 | 217104 | 197367 | 0.0221 | CONFIRMED |
| 22 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.9641` | Isotherm buy NO 2/2: Zap.sellYes 3.000000 YES Tmax>=31C Taipei 2026-10-08 (min 0.107352 AUSD) | 506290 | 632863 | 506290 | 0.0646 | CONFIRMED |
| 23 | `mm weather redeem taipei --date 2026-10-08 --strike 31 --merge` | Isotherm merge 3.000000 YES+NO Tmax>=31C Taipei 2026-10-08 | 159969 | 175966 | 159969 | 0.0179 | CONFIRMED |
| 24 | `mm weather buy taipei --date tomorrow --strike 30 --side no --amount 10 --max-price 0.6374` | AUSD for the CollateralVault (mint complete sets): approve exact amount | - | - | - | - | CONFIRMED (command then failed: see 20-buy-no-sandwiched.txt) |
| 25 | `mm weather buy taipei --date tomorrow --strike 30 --side no --amount 10 --max-price 0.6374` | YES Tmax>=30C Taipei 2026-10-08 for the Isotherm Zap (sell the YES leg): approve exact amount | - | - | - | - | CONFIRMED (command then failed: see 20-buy-no-sandwiched.txt) |
| 26 | `mm weather buy taipei --date tomorrow --strike 30 --side no --amount 10 --max-price 0.6374` | Isotherm buy NO 1/2: vault.mintSet 10.000000 sets Tmax>=30C Taipei 2026-10-08 | - | - | - | - | CONFIRMED (command then failed: see 20-buy-no-sandwiched.txt) |
| 27 | `mm weather redeem taipei --date 2026-10-08 --strike 30 --merge` | Isotherm merge 10.000000 YES+NO Tmax>=30C Taipei 2026-10-08 | 159957 | 175953 | 159957 | 0.0179 | CONFIRMED |
| 28 | `mm kuru limit 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --side buy --price 0.066 --size 30` | AUSD for the Kuru MarginAccount: approve exact amount | 70668 | 77735 | 70225 | 0.0079 | CONFIRMED |
| 29 | `mm kuru limit 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --side buy --price 0.066 --size 30` | Kuru MarginAccount deposit 1.980000 AUSD | 135819 | 156192 | 134356 | 0.0159 | CONFIRMED |
| 30 | `mm kuru limit 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --side buy --price 0.066 --size 30` | Kuru buy 30.000000 RCSS-20261008-GE31-Y @ 0.0660 AUSD (post-only) | 258494 | 297269 | 255107 | 0.0303 | CONFIRMED |
| 31 | `mm kuru cancel 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --all --withdraw` | Kuru cancel 1 order(s) on 0x9567594d… | 178132 | 204852 | 176000 | 0.0209 | CONFIRMED |
| 32 | `mm kuru cancel 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --all --withdraw` | Kuru MarginAccount withdraw all (base + quote) | 119903 | 131894 | 118690 | 0.0135 | CONFIRMED |
| 33 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | AUSD for the Kuru MarginAccount: approve exact amount | 70668 | 77735 | 70225 | 0.0079 | CONFIRMED |
| 34 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | Kuru MarginAccount deposit 3.000000 AUSD | 135819 | 156192 | 134356 | 0.0159 | CONFIRMED |
| 35 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | Kuru buy 10.000000 YES @ 0.3000 AUSD (post-only) | 321391 | 369600 | 317021 | 0.0377 | CONFIRMED |
| 36 | `mm kuru cancel 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --all --withdraw` | Kuru cancel 1 order(s) on 0x47cb4f32… | 192600 | 221490 | 190242 | 0.0226 | CONFIRMED |
| 37 | `mm kuru cancel 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --all --withdraw` | Kuru MarginAccount withdraw all (base + quote) | 119903 | 131894 | 118690 | 0.0135 | CONFIRMED |
| 38 | `mm weather redeem taipei --date 2026-10-07` | Isotherm redeem Tmax>=28C Taipei 2026-10-07 | 146571 | 161229 | 146571 | 0.0164 | CONFIRMED |
| 39 | `mm weather redeem taipei --date 2026-10-07` | Isotherm redeem Tmax>=30C Taipei 2026-10-07 | 181873 | 200061 | 181873 | 0.0204 | CONFIRMED |

39 confirmed transactions listed; total gas limit of the 36 with gas figures: 9692488 = 0.9886 MON at 102 gwei (Monad bills the limit).
Not listed: transactions that did not confirm (a reverted or denied step appears in the stub log, stub.log).
