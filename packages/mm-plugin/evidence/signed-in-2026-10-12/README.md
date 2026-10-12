# Signed-in MetaMask Agent Wallet session (2026-10-12)

Real `mm` 7.0.0 host, signed in, server wallet in Guard Mode (MetaMask's signing service signs; each transaction
needs an email approval). Plugin `mm-plugin-isotherm` 0.1.0 installed from the repository's tarball. Monad testnet
10143, the live Taipei (RCSS) 2026-10-13 ladder. Each file is one command, run verbatim, with its full output
(stdout and stderr) and the UTC time of its first and last output line. The approval request IDs are replaced with
`<request-id>`; nothing else was changed.

| File | Command | Signed transactions (all status 1, from the wallet below) |
|---|---|---|
| 01-doctor.txt | `mm weather doctor` | none |
| 02-markets.txt | `mm weather markets taipei` | none |
| 03-quote.txt | `mm weather quote taipei` | none |
| 04-edge.txt | `mm weather edge taipei` | none |
| 05-buy-yes-33.txt | `mm weather buy taipei --strike 33 --side yes --amount 2 --max-price 0.42` | AUSD approve `0x6ce5c785e01d1255050b60231d1c17bcd288673865bac3d217d6bcd84d34d78a` (block 70,471,713); `Zap.buyYes` `0x2c20f1a0168433b29d28931b79f102a5117ce00f1b9a4f06b547842007a18be8` (block 70,471,985): 2 AUSD → 5.123076 YES (≥ 33 °C) |
| 06-positions.txt | `mm weather positions` | none |
| 07-kuru-limit.txt | `mm kuru limit 0xa6886df9EbBB0602531DeA4B1F2A9E35F354424A --side buy --price 0.27 --size 5` | AUSD approve to the Kuru MarginAccount `0x43916da7b9429e0497bce63a7fefd04f661acb87129eed825b1b9801575420e0` (70,473,095); MarginAccount deposit 1.35 AUSD `0x881c8d27a383444eab3ad0af6162c32f932f9d4742c79869c8bc930ebacd46cb` (70,473,252); post-only buy 5 @ 0.27, order 9 `0xe2fe21e75fa51141948098708bb1962ddf70a2d9e7f6380829dc79b4223dfaee` (70,473,409) |
| 08-kuru-book.txt | `mm kuru book 0xa6886df9…424A` | none (order 9 resting below the best bid) |
| 09-kuru-cancel-withdraw.txt | `mm kuru cancel 0xa6886df9…424A --all --withdraw` | cancel `0x824dd86d25a14390bd2521d75d2208b64a441f8e3d30f47d9a5fc6da42606015` (70,473,923); withdraw `0x42a4aae18a6e7dd5c18209e734b4183ae6ecb2db9ad21b0354b3c65bf2ce60b6` (70,474,055) |
| 10-positions-after.txt | `mm weather positions` | none |

Wallet `0xd3A60CD946f58D6A43412dB20b30D834B72b4682` is the MetaMask Agent Wallet server wallet used for this team test
(the same one as in [`../signed-in/`](../signed-in/README.md), Oct 8). The commands with `| jq …` in the files are
shown exactly as run; jq only formats the plugin's JSON output.
