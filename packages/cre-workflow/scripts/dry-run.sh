#!/usr/bin/env bash
# Live dry run: the real handler against LIVE Monad testnet reads + LIVE METAR sources; nothing is signed by the real
# attester and nothing is sent (0 MON, no login). Shows due ladders, decisions, and whether the Resolver would accept
# everything but the (throwaway) signature.
#   scripts/dry-run.sh                                  # what the hourly run would do right now
#   DRY_EXTRA=RCSS:2026-10-06,RJTT:2026-10-06 scripts/dry-run.sh   # plus replay targets
set -euo pipefail
cd "$(dirname "$0")/../settle"
export PATH="$PWD/../.tools/bin:$PWD/../.tools/node_modules/.bin:$PATH"
bun test --timeout 120000 ./e2e/dry-run.ts 2>&1 | grep -v "^bun test v\|^$\|^e2e/dry-run.ts:"
