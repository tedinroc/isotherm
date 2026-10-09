#!/usr/bin/env bash
# One-time, idempotent setup of the hourly settlement job on a small Linux VPS: Ubuntu 24.04 LTS, amd64 or arm64.
# Run it ON THE VPS as the non-root user that will own the job, from the copy that vps/push.sh shipped:
#   bash ~/isotherm/packages/cre-workflow/vps/setup.sh
#
#   1. refuses root; checks the OS (Ubuntu 24.04 expected; other glibc distributions are untested) and the CPU
#   2. apt packages (sudo): ca-certificates curl unzip tar perl nodejs jq rsync procps dbus-user-session
#   3. Foundry `cast` v1.8.5 from the SHA-256-pinned release tarball (only cast; into .tools/bin, no foundryup)
#   4. ../setup.sh: CRE CLI v1.37.0 (SHA-256-pinned linux build), bun 1.4.2 (pinned), bun install --frozen-lockfile
#   5. `cre workflow build` check (compile only, no login): the WASM hash, compared with the Mac's 413d4429…
#   6. ~/.config/isotherm (chmod 700); the systemd USER units rendered into ~/.config/systemd/user/ (installed, NOT
#      enabled: vps/cutover.sh enables the timer); `loginctl enable-linger` (sudo) so the timer runs with nobody
#      logged in
# Options: --no-apt (the packages are already there), --no-units (no systemd, e.g. a plain container),
#          --with-anvil (also install anvil from the same tarball; fork tests only)
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
APT=1; UNITS=1; ANVIL=0
for a in "$@"; do
  case "$a" in
    --no-apt) APT=0 ;; --no-units) UNITS=0 ;; --with-anvil) ANVIL=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done
say() { echo "[vps/setup] $*"; }
[ "$(id -u)" != 0 ] || { echo "run as the non-root user that will own the job (not root): its home holds the keys and the CRE session" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "this is the Linux VPS setup; on the Mac use ../setup.sh" >&2; exit 1; }
case "$(uname -m)" in
  x86_64) FARCH=amd64; FPIN=6c66ffcc55fa4249197721baa3098bc208014ea1d8aa04b2ed50ac6bccffb226 ;;
  aarch64|arm64) FARCH=arm64; FPIN=5bdce3dade8b6f0a65d4fccf6908426aee4905a988b08dce79d0a72fe7498310 ;;
  *) echo "unsupported CPU $(uname -m) (amd64 or arm64)" >&2; exit 1 ;;
esac
# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
[ "${ID:-}-${VERSION_ID:-}" = ubuntu-24.04 ] || say "WARNING: expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}; continuing"

# ---- 2. system packages
if [ "$APT" = 1 ]; then
  say "apt packages (sudo)"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ca-certificates curl unzip tar gzip perl nodejs jq rsync procps dbus-user-session >/dev/null
fi
for c in curl unzip tar perl node jq; do command -v "$c" >/dev/null || { echo "missing $c (apt-get install it, or drop --no-apt)" >&2; exit 1; }; done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "node >= 18 needed" >&2; exit 1; }

# ---- 3. Foundry cast (release v1.8.5, GitHub asset digests)
mkdir -p "$PKG/.tools/bin" "$PKG/.tools/dl"
FT="foundry_v1.8.5_linux_${FARCH}.tar.gz"
want_bins="cast"; [ "$ANVIL" = 1 ] && want_bins="cast anvil"
need=0; for b in $want_bins; do [ -x "$PKG/.tools/bin/$b" ] || need=1; done
if [ "$need" = 1 ]; then
  if [ ! -f "$PKG/.tools/dl/$FT" ] || [ "$(sha256sum "$PKG/.tools/dl/$FT" | awk '{print $1}')" != "$FPIN" ]; then
    say "downloading $FT"
    curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o "$PKG/.tools/dl/$FT" "https://github.com/foundry-rs/foundry/releases/download/v1.8.5/$FT"
  fi
  got=$(sha256sum "$PKG/.tools/dl/$FT" | awk '{print $1}')
  [ "$got" = "$FPIN" ] || { echo "checksum mismatch for $FT: $got != $FPIN" >&2; exit 1; }
  # shellcheck disable=SC2086
  tar -xzf "$PKG/.tools/dl/$FT" -C "$PKG/.tools/bin" $want_bins
  [ "$ANVIL" = 1 ] || rm -f "$PKG/.tools/dl/$FT"   # 120 MB; keep it only when anvil may be needed again
fi
say "$("$PKG/.tools/bin/cast" --version | head -1)"

# ---- 4. CRE CLI + bun + workflow deps (shared with the Mac)
bash "$PKG/setup.sh"
export PATH="$PKG/.tools/bin:$PKG/.tools/node_modules/.bin:$PATH"

# ---- 5. official toolchain compile check (no login needed)
say "cre workflow build (compile check, no login)"
BUILD_LOG="$PKG/var/setup-build.log"; mkdir -p "$PKG/var"
if ! (cd "$PKG/settle" && cre workflow build . -T testnet -R ..) >"$BUILD_LOG" 2>&1; then cat "$BUILD_LOG" >&2; echo "cre workflow build FAILED" >&2; exit 1; fi
grep -v "Update available\|cre update\|upgrade\.$" "$BUILD_LOG" | sed 's/^/  /' || true
WASM=$(sha256sum "$PKG/settle/binary.wasm" | awk '{print $1}')
if [ "$WASM" = 413d4429ab2c3d619cf60e8098fab1ca242b1989082d9b7aeba1cfb1268e4938 ]; then
  say "binary.wasm $WASM: byte-identical to the Mac build (2026-10-07 onward)"
else
  say "NOTE: binary.wasm $WASM differs from the Mac build 413d4429…; the official run compiles its own copy and logs its Binary hash"
fi

# ---- 6. key dir, units, linger
install -d -m 700 "$HOME/.config/isotherm"
mkdir -p "$PKG/var"
if [ "$UNITS" = 1 ]; then
  UD="$HOME/.config/systemd/user"; mkdir -p "$UD"
  for u in isotherm-settle.service isotherm-settle.timer; do
    sed "s#@PKG@#$PKG#g" "$PKG/vps/systemd/$u.in" >"$UD/$u"
  done
  say "units installed in $UD (timer NOT enabled; vps/cutover.sh enables it)"
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
    say "loginctl enable-linger (sudo): the user's systemd runs at boot, so the timer needs no SSH session"
    sudo loginctl enable-linger "$(id -un)"
  fi
  if systemctl --user daemon-reload 2>/dev/null; then
    systemd-analyze --user verify "$UD/isotherm-settle.service" "$UD/isotherm-settle.timer" 2>&1 | sed 's/^/  verify: /' || true
  else
    say "NOTE: no user systemd reachable from this shell yet (log in again over SSH, then: systemctl --user daemon-reload)"
  fi
fi

cat <<EOF

[vps/setup] done. Next (vps/README.md):
  - attester key: from the Mac, scp ~/.config/isotherm/attester.key <vps>:.config/isotherm/ ; then here: chmod 600 ~/.config/isotherm/attester.key
  - CRE login through the SSH tunnel: ssh -t -L 53682:127.0.0.1:53682 <vps> bash ${PKG#"$HOME"/}/vps/isotherm-vps.sh login
  - check: bash ${PKG#"$HOME"/}/vps/isotherm-vps.sh preflight ; then ... dry-run ; then ... status
  - cutover from the Mac: packages/cre-workflow/vps/cutover.sh <vps>   (dry run first, then --execute)
EOF
