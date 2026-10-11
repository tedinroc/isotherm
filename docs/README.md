# docs

| Path | What |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | Runbook for the live testnet deployment: roles and keys, daily MON caps, emergency steps, funding and the treasury, API and web deploys, settlement, the Cloudflare maker that runs live since 2026-10-08 (cutover, operation, rollback), and the original launchd setup kept as the rollback path |
| [SETTLEMENT-VPS.md](SETTLEMENT-VPS.md) | The hourly CRE settlement job on a small Linux server since 2026-10-10: why, what stayed identical, the single-writer guard and the rollback (full runbook in [`packages/cre-workflow/vps/`](../packages/cre-workflow/vps/README.md)) |
| [evidence/golive/](evidence/golive/RESULT.md) | Go-live of the first Taipei ladder (2026-10-07): every transaction with its receipt status, independent book checks, maker snapshots and phone screenshots |
| [evidence/docs-pass/](evidence/docs-pass/) | The full Foundry run (149 tests in 18 suites on a fork at block 68,898,133) and the `IKuru.sol` header bytecode check |

Repo-level documents: [README.md](../README.md) (overview, live links, sponsor integrations, addresses, quick start, disclosures) and [ARCHITECTURE.md](../ARCHITECTURE.md) (contracts, lifecycle, trading paths, pricing, settlement, roles, onboarding, gas, failure modes, security model and hardening). Logo and video cover: [../brand/](../brand/).
