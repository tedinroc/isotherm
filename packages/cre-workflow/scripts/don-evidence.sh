#!/usr/bin/env bash
# Writes evidence records for DON-delivered settlements (path "don") from the chain: settle/e2e/don-evidence.ts.
# Read-only (eth_call / eth_getLogs). With a CRE login it also captures `cre execution list` for the testnet-don
# workflow (status and timing only) and attaches the matching execution to each DON record.
#   scripts/don-evidence.sh [--rpc URL] [--out DIR] [--ladders N] [--from-block A --to-block B] [--no-cre]
#   scripts/don-evidence.sh --tx HASH [--rpc URL]   diagnose one report tx (accepted or not): the workflow owner and ID
#                                                   it carried vs the Resolver's pins, ReportProcessed, the attestation
# Default --out: the runtime copy's var/evidence when it exists (next to the Mac job's settle-runs.jsonl), else var/evidence.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=$PWD
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH:$HOME/.foundry/bin:/opt/homebrew/bin:/usr/local/bin"
RPC=https://testnet-rpc.monad.xyz
RT_EV="${ISOTHERM_RUNTIME:-$HOME/isotherm-live}/packages/cre-workflow/var/evidence"
OUT=""; USE_CRE=1; PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC=$2; shift ;;
    --out) OUT=$2; shift ;;
    --no-cre) USE_CRE=0 ;;
    --ladders|--from-block|--to-block|--tx) PASS+=("$1" "$2"); shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
case " ${PASS[*]-} " in *" --tx "*) USE_CRE=0; OUT=${OUT:-$PKG/var/evidence} ;; esac   # --tx only prints
if [ -z "$OUT" ]; then if [ "$RPC" = https://testnet-rpc.monad.xyz ] && [ -d "$RT_EV" ]; then OUT=$RT_EV; else OUT=$PKG/var/evidence; fi; fi
mkdir -p "$OUT"
EXEC_ARGS=()
if [ "$USE_CRE" = 1 ] && [ "$RPC" = https://testnet-rpc.monad.xyz ]; then
  CAP="$OUT/cre-executions-latest.json"
  if perl -e 'alarm shift; exec @ARGV' 90 cre execution list isotherm-settle --limit 50 --non-interactive --output json </dev/null 2>/dev/null \
      | jq '[.[] | {uuid, workflowName, status, startedAt, finishedAt}]' >"$CAP.tmp" 2>/dev/null; then
    mv "$CAP.tmp" "$CAP"; EXEC_ARGS=(--cre-executions "$CAP"); echo "captured $(jq length "$CAP") CRE executions -> $CAP"
  else
    rm -f "$CAP.tmp"; echo "no CRE execution list (not logged in, or no deployed workflow): chain evidence only"
  fi
fi
cd settle
bun e2e/don-evidence.ts --rpc "$RPC" --out "$OUT" ${PASS[@]+"${PASS[@]}"} ${EXEC_ARGS[@]+"${EXEC_ARGS[@]}"}
