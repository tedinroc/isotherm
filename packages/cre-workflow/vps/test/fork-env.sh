#!/usr/bin/env bash
# TEST ONLY, on the (test) VPS: points the installed unit AND every ssh session of this user at an anvil fork, so that
# vps/cutover.sh and vps/rollback.sh can be rehearsed from the Mac end to end without any live key.
#   fork-env.sh up     anvil fork (Ankr RPC) warped to 2026-10-09 18:05 UTC; Resolver.attester -> anvil #9 (owner
#                      impersonated, fork only); a fresh random tx key with 1 MON; ~/.ssh/environment (needs
#                      PermitUserEnvironment, set in the test image) and a unit drop-in with the same variables
#   fork-env.sh down   stops anvil, removes the environment, the drop-in and the test keys, disables the timer
set -uo pipefail
PKG="$HOME/isotherm/packages/cre-workflow"
export PATH="$PKG/.tools/bin:$PATH"
PORT=${PORT:-19370}; RPC="http://127.0.0.1:$PORT"; T="$HOME/cutover-test"
DROP="$HOME/.config/systemd/user/isotherm-settle.service.d"
case "${1:-}" in
  up)
    rm -rf "$T"; mkdir -p "$T/keys" "$T/state"
    nohup anvil --fork-url "${ISOTHERM_FORK_URL:-https://rpc.ankr.com/monad_testnet}" --port "$PORT" --silent >"$T/anvil.log" 2>&1 &
    echo $! >"$T/anvil.pid"
    for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
    DEP="$PKG/../../deployments/testnet.json"
    RES=$(node -e 'console.log(require(process.argv[1]).resolver)' "$DEP"); OWN=$(node -e 'console.log(require(process.argv[1]).roles.owner)' "$DEP")
    printf '%s' 0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 >"$T/keys/attester.key"   # anvil #9 (public)
    read -r TXA TXK < <(cast wallet new 2>/dev/null | tail -n1); printf '%s' "$TXK" >"$T/keys/tx.key"; unset TXK
    chmod 600 "$T/keys/"*.key
    cast rpc anvil_impersonateAccount "$OWN" --rpc-url "$RPC" >/dev/null
    cast rpc anvil_setBalance "$OWN" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
    cast rpc anvil_setBalance "$TXA" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null
    cast send --unlocked --from "$OWN" "$RES" "setAttester(address)" 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 --rpc-url "$RPC" >/dev/null
    [ "$(cast call "$RES" 'attester()(address)' --rpc-url "$RPC" 2>/dev/null)" = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720 ] \
      || { echo "fork-env up FAILED: the fork did not take setAttester (the fork source RPC timed out?); run it again" >&2; exit 1; }
    cast rpc evm_setNextBlockTimestamp "$(node -e 'console.log(Date.parse("2026-10-09T18:05:00Z")/1000)')" --rpc-url "$RPC" >/dev/null
    cast rpc anvil_mine 0x50 0x1 --rpc-url "$RPC" >/dev/null
    VARS="ISOTHERM_RPC=$RPC
ISOTHERM_ATTESTER_KEY_FILE=$T/keys/attester.key
ISOTHERM_TX_KEY_FILE=$T/keys/tx.key
ISOTHERM_STATE_DIR=$T/state
ISOTHERM_TEST_RELABEL=RCSS:2026-10-09=2026-10-08"
    printf '%s\n' "$VARS" >"$HOME/.ssh/environment"; chmod 600 "$HOME/.ssh/environment"
    mkdir -p "$DROP"; { echo "[Service]"; printf '%s\n' "$VARS" | sed 's/^/Environment=/'; } >"$DROP/cutover-test.conf"
    systemctl --user daemon-reload
    echo "fork-env up: anvil :$PORT (block $(cast block-number --rpc-url "$RPC")), attester anvil #9, tx sender $TXA (fresh key), state $T/state"
    ;;
  down)
    kill "$(cat "$T/anvil.pid" 2>/dev/null)" 2>/dev/null || true
    rm -f "$HOME/.ssh/environment" "$DROP/cutover-test.conf"; rmdir "$DROP" 2>/dev/null || true
    systemctl --user disable --now isotherm-settle.timer >/dev/null 2>&1 || true
    chmod 700 "$HOME/.config/systemd/user/timers.target.wants" 2>/dev/null || true
    systemctl --user daemon-reload; rm -rf "$T/keys"
    echo "fork-env down"
    ;;
  block-enable)   # make `systemctl --user enable` fail (so vps/cutover.sh's E3 fails and its undo path runs)
    mkdir -p "$HOME/.config/systemd/user/timers.target.wants"; chmod 500 "$HOME/.config/systemd/user/timers.target.wants"; echo "enable blocked" ;;
  unblock-enable) chmod 700 "$HOME/.config/systemd/user/timers.target.wants"; echo "enable unblocked" ;;
  *) echo "usage: fork-env.sh up|down|block-enable|unblock-enable" >&2; exit 2 ;;
esac
