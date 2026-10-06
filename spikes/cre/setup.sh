#!/usr/bin/env bash
# Installs the spike's local toolchain into ./.tools (gitignored):
#   - CRE CLI v1.37.0 (darwin-arm64) from GitHub releases, SHA-256 checked against the release's checksums.txt
#   - bun (via npm) — the CRE TypeScript SDK compiles/tests with bun
# then installs the workflow's npm deps and compiles the Solidity side.
set -euo pipefail
cd "$(dirname "$0")"
V=v1.37.0
mkdir -p .tools/bin .tools/dl
if [ ! -x .tools/bin/cre ]; then
  ( cd .tools/dl
    curl -sSL -O "https://github.com/smartcontractkit/cre-cli/releases/download/$V/cre_darwin_arm64.zip"
    curl -sSL -O "https://github.com/smartcontractkit/cre-cli/releases/download/$V/checksums.txt"
    want=$(grep darwin_arm64 checksums.txt | awk '{print $NF}')
    got=$(shasum -a 256 cre_darwin_arm64.zip | awk '{print $1}')
    [ "$want" = "$got" ] || { echo "checksum mismatch: $got != $want" >&2; exit 1; }
    unzip -o -q cre_darwin_arm64.zip
    mv "cre_${V}_darwin_arm64" ../bin/cre )
  xattr -c .tools/bin/cre || true
fi
if [ ! -x .tools/node_modules/.bin/bun ]; then
  ( cd .tools && echo '{"name":"cre-tools","private":true}' > package.json && npm i bun@1.4.2 >/dev/null )
fi
export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
cre version
bun --version
( cd project/settle && bun install --frozen-lockfile )
( cd onchain && PATH="$PATH:$HOME/.foundry/bin" forge build )
echo "ok — now: export PATH=\"$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:\$PATH\""
