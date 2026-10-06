#!/usr/bin/env bash
# One command, from the repo root: the full Isotherm loop on the REAL Monad testnet (10143).
#   script/testnet-e2e.sh            -> preflight (read-only), then deploy + ladder + Kuru books + trades + CRE settle +
#                                       redeem, using a throwaway test station whose day ends ~12-27 min after launch
#   STATION=RCSS script/testnet-e2e.sh -> same on the real Taipei day (waits for 00:00 Taipei; resumable)
#   script/testnet-e2e.sh preflight  -> only the read-only balance/readiness check
# Needs `make -C spikes/e2e fork-e2e` to have run once (it measures logs/live-requirements.json). Testnet only.
set -euo pipefail
cd "$(dirname "$0")/../spikes/e2e"
[[ -d node_modules ]] || npm install --no-audit --no-fund >/dev/null
case "${1:-run}" in
  preflight) make testnet-preflight ;;
  run) if [[ "${STATION:-fast}" == "RCSS" ]]; then make testnet-e2e-rcss; else make testnet-e2e; fi ;;
  *) echo "usage: $0 [preflight|run]"; exit 1 ;;
esac
