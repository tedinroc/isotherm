#!/usr/bin/env bash
# Installs this package's local toolchain into ./.tools (gitignored) and the workflow's npm deps.
#   - CRE CLI v1.37.0 (darwin-arm64). The release zip is SHA-256-pinned (also checked against the release's
#     checksums.txt). A copy already downloaded by spikes/cre is reused if its hash matches; otherwise it downloads.
#   - bun 1.4.2 (via npm). The CRE TypeScript SDK builds and tests with bun; the CLI needs bun on PATH.
# Afterwards:  export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
set -euo pipefail
cd "$(dirname "$0")"
V=v1.37.0
ZIP=cre_darwin_arm64.zip
PIN=b72d94ca7b3a6a88dbb68205c6a00c2edfb107814fb3dab1c15264aebdb0a7a0   # GitHub release asset digest, v1.37.0
SPIKE_DL=../../spikes/cre/.tools/dl
mkdir -p .tools/bin .tools/dl

if [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]; then
  echo "setup.sh pins the darwin-arm64 CLI; on other platforms install CRE CLI $V by hand" >&2
fi

if [ ! -x .tools/bin/cre ]; then
  if [ -f "$SPIKE_DL/$ZIP" ] && [ "$(shasum -a 256 "$SPIKE_DL/$ZIP" | awk '{print $1}')" = "$PIN" ]; then
    cp "$SPIKE_DL/$ZIP" .tools/dl/$ZIP
  else
    ( cd .tools/dl
      curl -sSL -O "https://github.com/smartcontractkit/cre-cli/releases/download/$V/$ZIP"
      curl -sSL -O "https://github.com/smartcontractkit/cre-cli/releases/download/$V/checksums.txt"
      want=$(grep darwin_arm64 checksums.txt | awk '{print $NF}')
      [ "$want" = "$PIN" ] || { echo "release checksums.txt does not match the pinned digest" >&2; exit 1; } )
  fi
  got=$(shasum -a 256 .tools/dl/$ZIP | awk '{print $1}')
  [ "$got" = "$PIN" ] || { echo "checksum mismatch: $got != $PIN" >&2; exit 1; }
  ( cd .tools/dl && unzip -o -q $ZIP && mv "cre_${V}_darwin_arm64" ../bin/cre )
  xattr -c .tools/bin/cre 2>/dev/null || true
fi

if [ ! -x .tools/node_modules/.bin/bun ]; then
  ( cd .tools && echo '{"name":"cre-tools","private":true}' > package.json && npm i --no-audit --no-fund bun@1.4.2 >/dev/null )
fi

export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
cre version
echo "bun $(bun --version)"
( cd settle && bun install --frozen-lockfile )
echo "ok. Now run: export PATH=\"$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:\$PATH\""
