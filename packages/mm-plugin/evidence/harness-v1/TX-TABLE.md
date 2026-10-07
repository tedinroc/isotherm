| # | command | step (intent sent to MetaMask) | gas est. | gas limit (billed) | gas used (fork) | MON @102 gwei | status |
|---|---|---|---|---|---|---|---|
| 1 | `mm weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.424` | AUSD for the Isotherm Zap: approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 2 | `mm weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.424` | Isotherm buyYes Tmax>=30C Taipei 2026-10-08 | 466037 | 582547 | 466037 | 0.0594 | CONFIRMED |
| 3 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.1719` | AUSD for the CollateralVault (mint complete sets): approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 4 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.1719` | YES Tmax>=29C Taipei 2026-10-08 for the Isotherm Zap (sell the YES leg): approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 5 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.1719` | Isotherm buy NO 1/2: vault.mintSet 10.000000 sets Tmax>=29C Taipei 2026-10-08 | 229217 | 252139 | 229217 | 0.0257 | CONFIRMED |
| 6 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.1719` | Isotherm buy NO 2/2: Zap.sellYes 10.000000 YES Tmax>=29C Taipei 2026-10-08 (min 8.240301 AUSD) | 475502 | 594378 | 475502 | 0.0606 | CONFIRMED |
| 7 | `mm weather buy taipei --strike 30 --side yes --amount 5 --max-price 0.05 --approve max` | AUSD for the Isotherm Zap: approve unlimited | 71028 | 78131 | 70585 | 0.0080 | CONFIRMED |
| 8 | `mm weather buy taipei --strike 30 --side yes --amount 5 --max-price 0.05 --approve max` | Isotherm buyYes Tmax>=30C Taipei 2026-10-07 | 480399 | 600499 | 480399 | 0.0613 | CONFIRMED |
| 9 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9991` | AUSD for the CollateralVault (mint complete sets): approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 10 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9991` | YES Tmax>=30C Taipei 2026-10-07 for the Isotherm Zap (sell the YES leg): approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 11 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9991` | Isotherm buy NO 1/2: vault.mintSet 5.000000 sets Tmax>=30C Taipei 2026-10-07 | 212217 | 233439 | 212217 | 0.0238 | CONFIRMED |
| 12 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9991` | Isotherm buy NO 2/2: Zap.sellYes 5.000000 YES Tmax>=30C Taipei 2026-10-07 (min 0.004970 AUSD) | 475358 | 594198 | 475358 | 0.0606 | CONFIRMED |
| 13 | `mm weather buy taipei --strike 28 --side yes --amount 5 --max-price 0.999` | Isotherm buyYes Tmax>=28C Taipei 2026-10-07 | 462929 | 578662 | 462929 | 0.0590 | CONFIRMED |
| 14 | `mm weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.363` | YES Tmax>=30C for the Isotherm Zap: approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 15 | `mm weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.363` | Isotherm sellYes Tmax>=30C Taipei 2026-10-08 | 475670 | 594588 | 475670 | 0.0606 | CONFIRMED |
| 16 | `mm weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.1041` | Isotherm buyYes (to close NO) Tmax>=29C Taipei 2026-10-08 | 462963 | 578704 | 462963 | 0.0590 | CONFIRMED |
| 17 | `mm weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.1041` | Isotherm merge 4.000000 YES+NO -> AUSD | 159980 | 175978 | 159980 | 0.0179 | CONFIRMED |
| 18 | `mm weather buy taipei --date tomorrow --strike 31 --side yes --amount 3 --max-price 0.097` | Isotherm buyYes Tmax>=31C Taipei 2026-10-08 | 445961 | 557452 | 445961 | 0.0569 | CONFIRMED |
| 19 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.9641` | AUSD for the CollateralVault (mint complete sets): approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 20 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.9641` | YES Tmax>=31C Taipei 2026-10-08 for the Isotherm Zap (sell the YES leg): approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 21 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.9641` | Isotherm buy NO 1/2: vault.mintSet 3.000000 sets Tmax>=31C Taipei 2026-10-08 | 212217 | 233439 | 212217 | 0.0238 | CONFIRMED |
| 22 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.9641` | Isotherm buy NO 2/2: Zap.sellYes 3.000000 YES Tmax>=31C Taipei 2026-10-08 (min 0.107352 AUSD) | 475468 | 594335 | 475468 | 0.0606 | CONFIRMED |
| 23 | `mm weather redeem taipei --date 2026-10-08 --strike 31 --merge` | Isotherm merge 3.000000 YES+NO Tmax>=31C Taipei 2026-10-08 | 159992 | 175992 | 159992 | 0.0180 | CONFIRMED |
| 24 | `mm weather buy taipei --date tomorrow --strike 30 --side no --amount 10 --max-price 0.6374` | AUSD for the CollateralVault (mint complete sets): approve exact amount | - | - | - | - | CONFIRMED (command then failed: see 20-buy-no-sandwiched.txt) |
| 25 | `mm weather buy taipei --date tomorrow --strike 30 --side no --amount 10 --max-price 0.6374` | YES Tmax>=30C Taipei 2026-10-08 for the Isotherm Zap (sell the YES leg): approve exact amount | - | - | - | - | CONFIRMED (command then failed: see 20-buy-no-sandwiched.txt) |
| 26 | `mm weather buy taipei --date tomorrow --strike 30 --side no --amount 10 --max-price 0.6374` | Isotherm buy NO 1/2: vault.mintSet 10.000000 sets Tmax>=30C Taipei 2026-10-08 | - | - | - | - | CONFIRMED (command then failed: see 20-buy-no-sandwiched.txt) |
| 27 | `mm weather redeem taipei --date 2026-10-08 --strike 30 --merge` | Isotherm merge 10.000000 YES+NO Tmax>=30C Taipei 2026-10-08 | 159980 | 175978 | 159980 | 0.0179 | CONFIRMED |
| 28 | `mm kuru limit 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --side buy --price 0.066 --size 30` | AUSD for the Kuru MarginAccount: approve exact amount | 70668 | 77735 | 70225 | 0.0079 | CONFIRMED |
| 29 | `mm kuru limit 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --side buy --price 0.066 --size 30` | Kuru MarginAccount deposit 1.980000 AUSD | 135819 | 156192 | 134356 | 0.0159 | CONFIRMED |
| 30 | `mm kuru limit 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --side buy --price 0.066 --size 30` | Kuru buy 30.000000 RCSS-20261008-GE31-Y @ 0.0660 AUSD (post-only) | 258494 | 297269 | 255107 | 0.0303 | CONFIRMED |
| 31 | `mm kuru cancel 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --all --withdraw` | Kuru cancel 1 order(s) on 0x4f5Ef4Bf… | 178132 | 204852 | 176000 | 0.0209 | CONFIRMED |
| 32 | `mm kuru cancel 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --all --withdraw` | Kuru MarginAccount withdraw all (base + quote) | 119903 | 131894 | 118690 | 0.0135 | CONFIRMED |
| 33 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | AUSD for the Kuru MarginAccount: approve exact amount | 70668 | 77735 | 70225 | 0.0079 | CONFIRMED |
| 34 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | Kuru MarginAccount deposit 3.000000 AUSD | 135819 | 156192 | 134356 | 0.0159 | CONFIRMED |
| 35 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | Kuru buy 10.000000 YES @ 0.3000 AUSD (post-only) | 321391 | 369600 | 317021 | 0.0377 | CONFIRMED |
| 36 | `mm kuru cancel 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --all --withdraw` | Kuru cancel 1 order(s) on 0x47cb4f32… | 192600 | 221490 | 190242 | 0.0226 | CONFIRMED |
| 37 | `mm kuru cancel 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --all --withdraw` | Kuru MarginAccount withdraw all (base + quote) | 119903 | 131894 | 118690 | 0.0135 | CONFIRMED |
| 38 | `mm weather redeem taipei --date 2026-10-07` | Isotherm redeem Tmax>=28C Taipei 2026-10-07 | 146933 | 161627 | 146933 | 0.0165 | CONFIRMED |
| 39 | `mm weather redeem taipei --date 2026-10-07` | Isotherm redeem Tmax>=30C Taipei 2026-10-07 | 182235 | 200459 | 182235 | 0.0204 | CONFIRMED |

39 confirmed transactions listed; total gas limit of the 36 with gas figures: 9374306 = 0.9562 MON at 102 gwei (Monad bills the limit).
Not listed: transactions that did not confirm (a reverted or denied step appears in the stub log, stub.log).
