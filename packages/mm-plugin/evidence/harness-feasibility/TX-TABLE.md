| # | command | step (intent sent to MetaMask) | gas est. | gas limit (billed) | gas used (fork) | MON @102 gwei | status |
|---|---|---|---|---|---|---|---|
| 1 | `mm weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.52` | AUSD for the Isotherm Zap: approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 2 | `mm weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.52` | Isotherm buyYes Tmax>=30C Taipei 2026-10-08 | 496823 | 621029 | 496823 | 0.0633 | CONFIRMED |
| 3 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.2` | AUSD for the Isotherm Zap: approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 4 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.2` | Isotherm buyNo Tmax>=29C Taipei 2026-10-08 | 656741 | 820927 | 656741 | 0.0837 | CONFIRMED |
| 5 | `mm weather buy taipei --strike 29 --side yes --amount 5 --max-price 0.08 --approve max` | AUSD for the Isotherm Zap: approve unlimited | 71028 | 78131 | 70585 | 0.0080 | CONFIRMED |
| 6 | `mm weather buy taipei --strike 29 --side yes --amount 5 --max-price 0.08 --approve max` | Isotherm buyYes Tmax>=29C Taipei 2026-10-07 | 493873 | 617342 | 493873 | 0.0630 | CONFIRMED |
| 7 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9995` | Isotherm buyNo Tmax>=30C Taipei 2026-10-07 | 653167 | 816459 | 653167 | 0.0833 | CONFIRMED |
| 8 | `mm weather buy taipei --strike 27 --side yes --amount 5 --max-price 0.999` | Isotherm buyYes Tmax>=27C Taipei 2026-10-07 | 493773 | 617217 | 493773 | 0.0630 | CONFIRMED |
| 9 | `mm weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.43` | YES Tmax>=30C for the Isotherm Zap: approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 10 | `mm weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.43` | Isotherm sellYes Tmax>=30C Taipei 2026-10-08 | 506266 | 632833 | 506266 | 0.0645 | CONFIRMED |
| 11 | `mm weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.08` | Isotherm buyYes (to close NO) Tmax>=29C Taipei 2026-10-08 | 493725 | 617157 | 493725 | 0.0630 | CONFIRMED |
| 12 | `mm weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.08` | Isotherm merge 4.000000 YES+NO -> AUSD | 159957 | 175953 | 159957 | 0.0179 | CONFIRMED |
| 13 | `mm weather buy taipei --date tomorrow --strike 31 --side yes --amount 3 --max-price 0.15` | Isotherm buyYes Tmax>=31C Taipei 2026-10-08 | 493695 | 617119 | 493695 | 0.0629 | CONFIRMED |
| 14 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.95` | Isotherm buyNo Tmax>=31C Taipei 2026-10-08 | 653359 | 816699 | 653359 | 0.0833 | CONFIRMED |
| 15 | `mm weather redeem taipei --date 2026-10-08 --strike 31 --merge` | Isotherm merge 3.000000 YES+NO Tmax>=31C Taipei 2026-10-08 | 159969 | 175966 | 159969 | 0.0179 | CONFIRMED |
| 16 | `mm kuru limit 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --side buy --price 0.07 --size 30` | AUSD for the Kuru MarginAccount: approve exact amount | 70668 | 77735 | 70225 | 0.0079 | CONFIRMED |
| 17 | `mm kuru limit 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --side buy --price 0.07 --size 30` | Kuru MarginAccount deposit 2.100000 AUSD | 135819 | 156192 | 134356 | 0.0159 | CONFIRMED |
| 18 | `mm kuru limit 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --side buy --price 0.07 --size 30` | Kuru buy 30.000000 RCSS-20261008-GE31-Y @ 0.0700 AUSD (post-only) | 229854 | 264333 | 226915 | 0.0270 | CONFIRMED |
| 19 | `mm kuru cancel 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --all --withdraw` | Kuru cancel 1 order(s) on 0x9567594d… | 166769 | 191785 | 164815 | 0.0196 | CONFIRMED |
| 20 | `mm kuru cancel 0x9567594d6d19AfDfBe1dF99d5a7c3191A4E038C2 --all --withdraw` | Kuru MarginAccount withdraw all (base + quote) | 119903 | 131894 | 118690 | 0.0135 | CONFIRMED |
| 21 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | AUSD for the Kuru MarginAccount: approve exact amount | 70668 | 77735 | 70225 | 0.0079 | CONFIRMED |
| 22 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | Kuru MarginAccount deposit 3.000000 AUSD | 135819 | 156192 | 134356 | 0.0159 | CONFIRMED |
| 23 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | Kuru buy 10.000000 YES @ 0.3000 AUSD (post-only) | 321391 | 369600 | 317021 | 0.0377 | CONFIRMED |
| 24 | `mm kuru cancel 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --all --withdraw` | Kuru cancel 1 order(s) on 0x47cb4f32… | 192600 | 221490 | 190242 | 0.0226 | CONFIRMED |
| 25 | `mm kuru cancel 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --all --withdraw` | Kuru MarginAccount withdraw all (base + quote) | 119903 | 131894 | 118690 | 0.0135 | CONFIRMED |
| 26 | `mm weather redeem taipei --date 2026-10-07` | Isotherm redeem Tmax>=27C Taipei 2026-10-07 | 146583 | 161242 | 146583 | 0.0164 | CONFIRMED |
| 27 | `mm weather redeem taipei --date 2026-10-07` | Isotherm redeem Tmax>=30C Taipei 2026-10-07 | 146601 | 161262 | 146601 | 0.0164 | CONFIRMED |

27 transactions, total gas limit 8932661 = 0.9111 MON at 102 gwei (Monad bills the limit).
