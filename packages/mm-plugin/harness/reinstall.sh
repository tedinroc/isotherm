#!/bin/sh
# Rebuild, pack and (re)install the plugin tarball into the harness home (and optionally other homes).
set -eu
P="$(cd "$(dirname "$0")/.." && pwd)"
cd "$P"
npm pack --silent >/dev/null 2>&1
TGZ="$P/mm-plugin-isotherm-$(node -p 'require("./package.json").version').tgz"
for HOME_DIR in "$P/harness/.mmhome-harness" ${EXTRA_HOMES:-}; do
  MM_HOME="$HOME_DIR" "$P/harness/bin/mm-harness" plugins install "file:$TGZ" --accept-permissions 2>&1 | grep -v -E "npm notice|^\s*$|prepare script|expected files" || true
done
