#!/usr/bin/env bash
set -u
export PATH="$PATH:$HOME/.foundry/bin"
V=${V:-https://sourcify-api-monad.blockvision.org/}  # also works: https://sourcify.dev/server/
LOG=${LOG:-script/evidence/sourcify-verify.txt}
: > "$LOG"
while read -r A C; do
  echo "== $C $A ($V)" | tee -a "$LOG"
  forge verify-contract "$A" "$C" --chain 10143 --verifier sourcify --verifier-url "$V" --watch 2>&1 \
    | grep -vE '^warning|│|╭|├|╰|━|^\s*$' | tail -6 | tee -a "$LOG"
done <<'L'
0x9c7876Bc27df6cB473f2eaFA296FdEC22747962B src/Resolver.sol:Resolver
0xae36cf0a163bAfCde4D40a6Ab7b5E3C762ad7B39 src/CollateralVault.sol:CollateralVault
0x1ACaf47987Fe570df5d136Ae1CaC0D45E2B8CFb0 src/IsothermZap.sol:IsothermZap
0x5EfaB33DDad0715b66f514Fe12d78Ca23f3e31fC src/OutcomeToken.sol:OutcomeToken
L
