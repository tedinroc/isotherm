#!/bin/bash
# launchd entry for xyz.isotherm.challenge-watch (every 120 s): one pass of settle/ops/challenge-watch.ts.
# On every LadderResolved it recomputes Tmax with the workflow's own decide() rule; on a reproduced mismatch it calls
# Resolver.challenge() from the guardian key if that key holds MON, otherwise it prints the exact manual command.
# Read-only unless a mismatch is found. Logs: $STATE/watch/ (watch.jsonl, ALERTS.log, heartbeat.json, state.json).
# Runs from the runtime copy (~/isotherm-live/packages/cre-workflow); see scripts/deploy-runtime.sh.
set -uo pipefail
cd "$(dirname "$0")/../settle"
export PATH="$PWD/../.tools/bin:$PWD/../.tools/node_modules/.bin:$HOME/.foundry/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec bun ops/challenge-watch.ts "$@"
