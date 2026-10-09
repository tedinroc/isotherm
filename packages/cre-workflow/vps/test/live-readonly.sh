#!/usr/bin/env bash
# TEST ONLY, on the (test) VPS: read-only checks against LIVE Monad testnet. No real key exists here; a throwaway key
# stands in for the attester, so the preflight refuses before anything could be signed. 0 MON.
#   L1 scripts/dry-run.sh: the real handler on live chain reads + live METAR sources (no key at all)
#   L2 isotherm-vps.sh dry-run (ISOTHERM_SETTLE_DRY=1 settle-job.sh in var/dry) with a throwaway key: path choice,
#      live reads, then "attester key address != Resolver.attester()" (exit 2)
#   L3 the key-file mode check on Linux: a 644 key is refused (the BSD `stat -f %Lp` form could never pass here)
#   L4 isotherm-vps.sh status
set -u
PKG=$HOME/isotherm/packages/cre-workflow; export PATH=$PKG/.tools/bin:$PATH
echo "# $(date -u +%FT%TZ) live read-only checks on $(. /etc/os-release; echo "$PRETTY_NAME") $(uname -m); RPC https://testnet-rpc.monad.xyz"
echo; echo "## L1. scripts/dry-run.sh: the real handler against LIVE chain reads and LIVE METAR sources; no key, nothing signed or sent"
bash "$PKG/scripts/dry-run.sh" 2>&1 | tail -n 8
echo; echo "## L2. the job's dry run (isotherm-vps.sh dry-run) with a THROWAWAY key: live reads, then the preflight refuses"
T=$HOME/live-test; rm -rf "$T"; mkdir -p "$T/keys"
read -r A K < <(cast wallet new 2>/dev/null | tail -n1); printf '%s' "$K" >"$T/keys/throwaway.key"; chmod 600 "$T/keys/throwaway.key"; unset K
echo "   throwaway address $A"
ISOTHERM_STATE_DIR=$T/state ISOTHERM_ATTESTER_KEY_FILE=$T/keys/throwaway.key bash "$PKG/vps/isotherm-vps.sh" dry-run 2>&1 | grep -vE '^\s*$'
echo "   evidence: $(node -e 'const r=require(process.argv[1]); console.log(JSON.stringify({job:r.job,host:r.host,path:r.path,network:r.network,dryRun:r.dryRun,exitCode:r.exitCode,exitMeaning:r.exitMeaning}))' "$T/state/dry/evidence/LATEST.json")"
echo; echo "## L3. key-file mode on Linux: 600 passes (L2 reached the address check), 644 is refused"
chmod 644 "$T/keys/throwaway.key"
ISOTHERM_STATE_DIR=$T/state ISOTHERM_ATTESTER_KEY_FILE=$T/keys/throwaway.key bash "$PKG/scripts/run-official.sh" --harness --preflight-only 2>&1 | tail -n1
f=$(mktemp); chmod 600 "$f"
echo "   before this change: run-official.sh compared \$(stat -f %Lp key) with 600; on Linux that prints file-system info:"
echo "   '$(stat -f %Lp "$f" 2>/dev/null | head -n1)' -> never 600, so every Linux preflight failed. Now: '$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")'"
rm -f "$f"
echo; echo "## L4. isotherm-vps.sh status (no claim on this test VPS)"
ISOTHERM_STATE_DIR=$T/state ISOTHERM_ATTESTER_KEY_FILE=$T/keys/throwaway.key bash "$PKG/vps/isotherm-vps.sh" status 2>&1
rm -rf "$T/keys"
echo; echo "# $(date -u +%FT%TZ) done"
