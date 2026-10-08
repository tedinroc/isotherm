# Signed-in MetaMask Agent Wallet trade (2026-10-08)

Real `mm` 7.0.0 host, signed in, server wallet in Guard Mode (MetaMask's signing service signs; each transaction
needs an email approval). Plugin `mm-plugin-isotherm` 0.1.0 installed from the local tarball. Monad testnet 10143.

| File | What happened |
|---|---|
| 00-approve-watch.txt, 01-buy-yes-31.txt | First attempt: the approval email for the AUSD approve expired (request `938445db`); the host's poll also hit a transient network error. |
| 02-buy-yes-31-retry.txt | Approve signed by MetaMask and broadcast: `0x924dc91f0b89d91964ec83bb30d305f46f562a1ad7d07117251a96462b6f79c1` (mined, status 1). The plugin wrongly treated the service status `BROADCASTED` as a failure; fixed in `src/lib/exec.ts` (wait for the receipt on chain, then mark CONFIRMED). |
| 03-buy-yes-31-after-fix.txt | `mm weather buy taipei --strike 31 --side yes --amount 2 --max-price 0.36`: Zap.buyYes signed by MetaMask after the email approval, tx `0x82358f4884e1a6fc74ad56aaff7191f8855d4fa41a5de2e3a29ec932eb8152ee` (block 69285394, status 1): 2 AUSD → 6.054545 YES of RCSS 2026-10-09 ≥31 °C. |

Wallet `0xd3A60CD946f58D6A43412dB20b30D834B72b4682` is the MetaMask Agent Wallet server wallet used for this team test.
The MetaMask project id was replaced with `<mm-project-id>` in these logs.
