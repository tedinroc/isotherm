# Shared by scripts/don-cutover.sh and scripts/don-rollback.sh (sourced, not run).
# Expects: PKG, MODE (dry|execute), RPC, FORK_UNLOCKED (0|1), FACTS (file or ""), CONFIRM_OWNER, LOG.
# Never prints a key: the owner key reaches settle/e2e/don-ops.ts as a file path (ISOTHERM_OWNER_KEY_FILE) only.

LIVE_RPC=https://testnet-rpc.monad.xyz
DEP="$PKG/../../deployments/testnet.json"
jdep() { jq -r "$1" "$DEP"; }
RESOLVER=$(jdep .resolver)
PROD=$(jdep .keystoneForwarder)
MOCK=$(jdep .mockForwarder)
LIVE_OWNER=$(jdep .roles.owner)
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
ZERO20=0x0000000000000000000000000000000000000000
OWNER_KEY_FILE=${ISOTHERM_OWNER_KEY_FILE:-$HOME/.config/isotherm/deployer.key}
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
say() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
GATES_FAILED=0
gate() { # gate <ok 0|1> <name> <detail>
  if [ "$1" = 1 ]; then say "GATE OK    $2: $3"; else say "GATE FAIL  $2: $3"; GATES_FAILED=$((GATES_FAILED + 1)); fi
}
ops() { (cd "$PKG/settle" && bun e2e/don-ops.ts "$@"); }
# human lines go to the terminal (stderr) and the log; the final `[don-ops] {json}` line is returned on stdout
ops_json() { ops "$@" 2>&1 | tee -a "$LOG" | awk '/^\[don-ops\] /{sub(/^\[don-ops\] /,""); last=$0; next} {print > "/dev/stderr"} END{if (last != "") print last}'; }

# ---- where are we? A fork is a loopback anvil; only there may --fork-unlocked / --facts be used.
IS_FORK=0
case "$RPC" in http://127.0.0.1:*|http://localhost:*) cast client --rpc-url "$RPC" 2>/dev/null | grep -qi anvil && IS_FORK=1 ;; esac
require_network() {
  [ "$(cast chain-id --rpc-url "$RPC")" = 10143 ] || { say "REFUSED: $RPC is not chain 10143"; exit 2; }
  if [ "$IS_FORK" = 0 ] && [ "$RPC" != "$LIVE_RPC" ]; then say "REFUSED: RPC must be $LIVE_RPC or a loopback anvil fork"; exit 2; fi
  if [ "$IS_FORK" = 0 ] && { [ "$FORK_UNLOCKED" = 1 ] || [ -n "$FACTS" ]; }; then
    say "REFUSED: --fork-unlocked and --facts exist for anvil-fork rehearsals only, never on live testnet"; exit 2
  fi
  say "network: $([ "$IS_FORK" = 1 ] && echo "anvil FORK of Monad testnet ($RPC)" || echo "LIVE Monad testnet 10143")"
}

# ---- who signs the owner calls (execute mode only). Sets SIGNER and SEND_FLAGS.
resolve_signer() {
  local onchain_owner=$1
  if [ "$FORK_UNLOCKED" = 1 ]; then
    cast rpc anvil_impersonateAccount "$onchain_owner" --rpc-url "$RPC" >/dev/null
    cast rpc anvil_setBalance "$onchain_owner" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
    SIGNER=$onchain_owner
    SEND_FLAGS=(--unlocked "$onchain_owner")
    say "signer: Resolver.owner() $onchain_owner impersonated on the fork (anvil_impersonateAccount; no key)"
  else
    [ -r "$OWNER_KEY_FILE" ] || { say "REFUSED: owner key file not readable: $OWNER_KEY_FILE"; exit 2; }
    [ "$(stat -f %Lp "$OWNER_KEY_FILE" 2>/dev/null || stat -c %a "$OWNER_KEY_FILE")" = 600 ] || { say "REFUSED: $OWNER_KEY_FILE must be chmod 600"; exit 2; }
    SIGNER=$(cd "$PKG/settle" && ISOTHERM_OWNER_KEY_FILE="$OWNER_KEY_FILE" bun e2e/don-ops.ts addr)
    if [ "$IS_FORK" = 1 ] && [ "$(lc "$SIGNER")" = "$(lc "$LIVE_OWNER")" ]; then
      say "REFUSED: the LIVE owner key on a fork. A transaction it signs for chain 10143 is valid on live testnet too. Use --fork-unlocked."; exit 2
    fi
    SEND_FLAGS=()
    export ISOTHERM_OWNER_KEY_FILE=$OWNER_KEY_FILE
    say "signer: address of the owner key file $SIGNER (key not printed)"
  fi
  gate "$([ "$(lc "$SIGNER")" = "$(lc "$onchain_owner")" ] && echo 1 || echo 0)" "run by the owner" "signer $SIGNER, Resolver.owner() $onchain_owner"
  if [ -z "$CONFIRM_OWNER" ] && [ -t 0 ]; then read -r -p "Type the Resolver owner address to confirm: " CONFIRM_OWNER; fi
  gate "$([ -n "$CONFIRM_OWNER" ] && [ "$(lc "$CONFIRM_OWNER")" = "$(lc "$onchain_owner")" ] && echo 1 || echo 0)" "operator confirmation" "typed '${CONFIRM_OWNER:-<none>}' (must equal Resolver.owner(); --confirm-owner or the prompt)"
}

owner_send() { # owner_send <fn signature> <comma-separated args>
  local j
  j=$(ops_json send --rpc "$RPC" --fn "$1" --args "$2" ${SEND_FLAGS[@]+"${SEND_FLAGS[@]}"}) || true
  [ "$(jq -r .status <<<"${j:-null}" 2>/dev/null)" = success ] || { say "FAILED: $1($2) did not succeed: ${j:-no output}"; return 1; }
  say "sent $1($2): $(jq -r .hash <<<"$j") (block $(jq -r .block <<<"$j"), gas limit $(jq -r .gasLimit <<<"$j"))"
}
plan_line() { # plan_line <n> <fn> <args> : prints the exact call, calldata and the equivalent cast command
  local data est
  data=$(cast calldata "$2" ${3//,/ })
  est=$(ops_json send --rpc "$RPC" --fn "$2" --args "$3" --unlocked "$PLAN_FROM" --dry | jq -r '.estimate // "?"' 2>/dev/null || echo "?")
  say "  $1. Resolver($RESOLVER).$2 args [$3]"
  say "     calldata $data  (eth_estimateGas from the owner: $est; sent with a 1.2x limit)"
  say "     by hand: cast send $RESOLVER '$2' ${3//,/ } --account <owner keystore> --rpc-url $LIVE_RPC"
}
