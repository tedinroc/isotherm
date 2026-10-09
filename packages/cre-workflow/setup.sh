#!/usr/bin/env bash
# Installs this package's local toolchain into ./.tools (gitignored) and the workflow's npm deps.
#   - CRE CLI v1.37.0, SHA-256-pinned per platform; every pin is also checked against the release's checksums.txt:
#       darwin-arm64 (the Mac; a copy already downloaded by spikes/cre is reused if its hash matches), darwin-amd64,
#       linux-amd64 and linux-arm64 (glibc >= 2.36, e.g. Ubuntu 24.04; the release's "ldd2-35" build below 2.36).
#       On Linux, vps/setup.sh installs the system packages first and then calls this script.
#   - bun 1.4.2: via npm on macOS (as before); on Linux the SHA-256-pinned release zip from GitHub
#     (the "baseline" build on x86-64 CPUs without AVX2).
# Afterwards:  export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
set -euo pipefail
cd "$(dirname "$0")"
V=v1.37.0
REL="https://github.com/smartcontractkit/cre-cli/releases/download/$V"
SPIKE_DL=../../spikes/cre/.tools/dl
mkdir -p .tools/bin .tools/dl
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
glibc_old() { # true when glibc < 2.36 (the release then ships a separate "_ldd2-35" build)
  local v; v=$(ldd --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+' | tail -n1) || return 1
  [ -n "$v" ] && [ "$(printf '%s\n' "$v" 2.36 | sort -V | head -n1)" = "$v" ] && [ "$v" != 2.36 ]
}

# GitHub release asset digests of CRE CLI v1.37.0 (identical to the release's checksums.txt)
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLAT=darwin_arm64; ASSET=cre_darwin_arm64.zip; PIN=b72d94ca7b3a6a88dbb68205c6a00c2edfb107814fb3dab1c15264aebdb0a7a0 ;;
  Darwin-x86_64) PLAT=darwin_amd64; ASSET=cre_darwin_amd64.zip; PIN=6f1aa58a375cb8286f253ce867a1fae5d2b9aa0070e0960de4405fdf899d2cfc ;;
  Linux-x86_64)
    PLAT=linux_amd64
    if glibc_old; then ASSET=cre_linux_amd64_ldd2-35.tar.gz; PIN=3c8a73540ed78210ab3ed23d792d8a6bfb4e56deb49bc77d61dfbdd54a147155
    else ASSET=cre_linux_amd64.tar.gz; PIN=1e660e955be607bca3ae683d5f264bb354252f6af657f0d86e56108438536503; fi ;;
  Linux-aarch64|Linux-arm64)
    PLAT=linux_arm64
    if glibc_old; then ASSET=cre_linux_arm64_ldd2-35.tar.gz; PIN=49c48b60a737ada370fb10213bcb1c364bce71508b4e2557512956a3b4289280
    else ASSET=cre_linux_arm64.tar.gz; PIN=8454d872386a1633e9f1792d593b13b3f1dd7f8101bc09cbb6f67069edcb5dfa; fi ;;
  *) echo "no pinned CRE CLI $V for $(uname -s)-$(uname -m); install it by hand" >&2; exit 1 ;;
esac
MEMBER="cre_${V}_${PLAT}"   # the one file inside every release archive

if [ ! -x .tools/bin/cre ]; then
  if [ "$PLAT" = darwin_arm64 ] && [ -f "$SPIKE_DL/$ASSET" ] && [ "$(sha256 "$SPIKE_DL/$ASSET")" = "$PIN" ]; then
    cp "$SPIKE_DL/$ASSET" ".tools/dl/$ASSET"
  else
    ( cd .tools/dl
      curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o "$ASSET" "$REL/$ASSET"
      curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o checksums.txt "$REL/checksums.txt"
      grep -F "$PIN" checksums.txt | grep -q "_${PLAT}" || { echo "release checksums.txt does not list the pinned digest for $ASSET" >&2; exit 1; } )
  fi
  got=$(sha256 ".tools/dl/$ASSET")
  [ "$got" = "$PIN" ] || { echo "checksum mismatch for $ASSET: $got != $PIN" >&2; exit 1; }
  rm -rf .tools/dl/x && mkdir -p .tools/dl/x
  case "$ASSET" in
    *.zip) [ "$(unzip -Z1 ".tools/dl/$ASSET")" = "$MEMBER" ] || { echo "unexpected archive members in $ASSET" >&2; exit 1; }
           unzip -o -q ".tools/dl/$ASSET" "$MEMBER" -d .tools/dl/x ;;
    *.tar.gz) [ "$(tar -tzf ".tools/dl/$ASSET")" = "$MEMBER" ] || { echo "unexpected archive members in $ASSET" >&2; exit 1; }
              tar -xzf ".tools/dl/$ASSET" -C .tools/dl/x "$MEMBER" ;;
  esac
  mv ".tools/dl/x/$MEMBER" .tools/bin/cre && rmdir .tools/dl/x
  chmod +x .tools/bin/cre
  xattr -c .tools/bin/cre 2>/dev/null || true
fi

if [ "$(uname -s)" = Darwin ]; then
  if [ ! -x .tools/node_modules/.bin/bun ]; then
    ( cd .tools && echo '{"name":"cre-tools","private":true}' > package.json && npm i --no-audit --no-fund bun@1.4.2 >/dev/null )
  fi
elif [ ! -x .tools/bin/bun ]; then
  # bun-v1.4.2 GitHub release asset digests
  case "$PLAT" in
    linux_amd64)
      if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then BZ=bun-linux-x64; BPIN=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
      else BZ=bun-linux-x64-baseline; BPIN=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f; fi ;;
    linux_arm64) BZ=bun-linux-aarch64; BPIN=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;;
  esac
  curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o ".tools/dl/$BZ.zip" "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/$BZ.zip"
  got=$(sha256 ".tools/dl/$BZ.zip")
  [ "$got" = "$BPIN" ] || { echo "checksum mismatch for $BZ.zip: $got != $BPIN" >&2; exit 1; }
  rm -rf ".tools/dl/$BZ" && unzip -o -q ".tools/dl/$BZ.zip" "$BZ/bun" -d .tools/dl
  mv ".tools/dl/$BZ/bun" .tools/bin/bun && rmdir ".tools/dl/$BZ"
  chmod +x .tools/bin/bun && ln -sf bun .tools/bin/bunx
fi

export PATH="$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:$PATH"
cre version
echo "bun $(bun --version)"
( cd settle && bun install --frozen-lockfile )
echo "ok. Now run: export PATH=\"$PWD/.tools/bin:$PWD/.tools/node_modules/.bin:\$PATH\""
