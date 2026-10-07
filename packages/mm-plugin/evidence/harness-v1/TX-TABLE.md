| # | command | step (intent sent to MetaMask) | gas est. | gas limit (billed) | gas used (fork) | MON @102 gwei | status |
|---|---|---|---|---|---|---|---|
| 1 | `mm weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.52` | AUSD for the Isotherm Zap: approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 2 | `mm weather buy taipei --date tomorrow --strike 30 --side yes --amount 20 --max-price 0.52` | Isotherm buyYes Tmax>=30C Taipei 2026-10-08 | 466003 | 582504 | 466003 | 0.0594 | CONFIRMED |
| 3 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.2` | AUSD for the Isotherm Zap: approve exact amount | 70680 | 77748 | 70237 | 0.0079 | CONFIRMED |
| 4 | `mm weather buy taipei --date tomorrow --strike 29 --side no --amount 10 --max-price 0.2` | Isotherm buyNo Tmax>=29C Taipei 2026-10-08 | 630841 | 788552 | 630841 | 0.0804 | CONFIRMED |
| 5 | `mm weather buy taipei --strike 29 --side yes --amount 5 --max-price 0.08 --approve max` | AUSD for the Isotherm Zap: approve unlimited | 71028 | 78131 | 70585 | 0.0080 | CONFIRMED |
| 6 | `mm weather buy taipei --strike 29 --side yes --amount 5 --max-price 0.08 --approve max` | Isotherm buyYes Tmax>=29C Taipei 2026-10-07 | 463041 | 578802 | 463041 | 0.0590 | CONFIRMED |
| 7 | `mm weather buy taipei --strike 30 --side no --amount 5 --max-price 0.9995` | Isotherm buyNo Tmax>=30C Taipei 2026-10-07 | 627255 | 784069 | 627255 | 0.0800 | CONFIRMED |
| 8 | `mm weather buy taipei --strike 27 --side yes --amount 5 --max-price 0.999` | Isotherm buyYes Tmax>=27C Taipei 2026-10-07 | 462941 | 578677 | 462941 | 0.0590 | CONFIRMED |
| 9 | `mm weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.43` | YES Tmax>=30C for the Isotherm Zap: approve exact amount | 62708 | 68979 | 62260 | 0.0070 | CONFIRMED |
| 10 | `mm weather sell taipei --date tomorrow --strike 30 --side yes --amount 15 --min-price 0.43` | Isotherm sellYes Tmax>=30C Taipei 2026-10-08 | 475456 | 594320 | 475456 | 0.0606 | CONFIRMED |
| 11 | `mm weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.08` | Isotherm buyYes (to close NO) Tmax>=29C Taipei 2026-10-08 | 462893 | 578617 | 462893 | 0.0590 | CONFIRMED |
| 12 | `mm weather sell taipei --date tomorrow --strike 29 --side no --amount 4 --min-price 0.08` | Isotherm merge 4.000000 YES+NO -> AUSD | 159980 | 175978 | 159980 | 0.0179 | CONFIRMED |
| 13 | `mm weather buy taipei --date tomorrow --strike 31 --side yes --amount 3 --max-price 0.15` | Isotherm buyYes Tmax>=31C Taipei 2026-10-08 | 462863 | 578579 | 462863 | 0.0590 | CONFIRMED |
| 14 | `mm weather buy taipei --date tomorrow --strike 31 --side no --amount 3 --max-price 0.95` | Isotherm buyNo Tmax>=31C Taipei 2026-10-08 | 627459 | 784324 | 627459 | 0.0800 | CONFIRMED |
| 15 | `mm weather redeem taipei --date 2026-10-08 --strike 31 --merge` | Isotherm merge 3.000000 YES+NO Tmax>=31C Taipei 2026-10-08 | 159992 | 175992 | 159992 | 0.0180 | CONFIRMED |
| 16 | `mm kuru limit 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --side buy --price 0.07 --size 30` | AUSD for the Kuru MarginAccount: approve exact amount | 70668 | 77735 | 70225 | 0.0079 | CONFIRMED |
| 17 | `mm kuru limit 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --side buy --price 0.07 --size 30` | Kuru MarginAccount deposit 2.100000 AUSD | 135819 | 156192 | 134356 | 0.0159 | CONFIRMED |
| 18 | `mm kuru limit 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --side buy --price 0.07 --size 30` | Kuru buy 30.000000 RCSS-20261008-GE31-Y @ 0.0700 AUSD (post-only) | 229854 | 264333 | 226915 | 0.0270 | CONFIRMED |
| 19 | `mm kuru cancel 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --all --withdraw` | Kuru cancel 1 order(s) on 0x4f5Ef4Bf… | 166769 | 191785 | 164815 | 0.0196 | CONFIRMED |
| 20 | `mm kuru cancel 0x4f5Ef4Bf256BDD88492C1e394B0D0f06A8265813 --all --withdraw` | Kuru MarginAccount withdraw all (base + quote) | 119903 | 131894 | 118690 | 0.0135 | CONFIRMED |
| 21 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | AUSD for the Kuru MarginAccount: approve exact amount | 70668 | 77735 | 70225 | 0.0079 | CONFIRMED |
| 22 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | Kuru MarginAccount deposit 3.000000 AUSD | 135819 | 156192 | 134356 | 0.0159 | CONFIRMED |
| 23 | `mm kuru limit 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --side buy --price 0.3 --size 10` | Kuru buy 10.000000 YES @ 0.3000 AUSD (post-only) | 321391 | 369600 | 317021 | 0.0377 | CONFIRMED |
| 24 | `mm kuru cancel 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --all --withdraw` | Kuru cancel 1 order(s) on 0x47cb4f32… | 192600 | 221490 | 190242 | 0.0226 | CONFIRMED |
| 25 | `mm kuru cancel 0x47cb4f32Eb554E4a873DA20CA86261bc3d9CD42A --all --withdraw` | Kuru MarginAccount withdraw all (base + quote) | 119903 | 131894 | 118690 | 0.0135 | CONFIRMED |
| 26 | `mm weather redeem taipei --date 2026-10-07` | Isotherm redeem Tmax>=27C Taipei 2026-10-07 | 146945 | 161640 | 146945 | 0.0165 | CONFIRMED |
| 27 | `mm weather redeem taipei --date 2026-10-07` | Isotherm redeem Tmax>=30C Taipei 2026-10-07 | 146963 | 161660 | 146963 | 0.0165 | CONFIRMED |

27 transactions, total gas limit 8605170 = 0.8777 MON at 102 gwei (Monad bills the limit).
