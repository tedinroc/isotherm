#!/usr/bin/env bash
# DEV HARNESS ONLY. Builds the MIT-licensed CRE CLI v1.37.0 from source with one change: `cre workflow simulate`
# is added to LoginExemptCommands, so the *local* simulator runs without a CRE account. Nothing else changes; the
# simulator does not need Chainlink services (telemetry is skipped without credentials, internal/telemetry/sender.go;
# only the GitHub update check runs). Use the official binary + `cre login` for anything you show judges.
# Needs Go >= 1.26.4 (https://go.dev/dl, verify sha256), ~5 GB temp module cache, ~13 min on this Mac.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${TMPDIR:-/tmp}/cre-cli-nologin"
rm -rf "$work" && git clone -q --depth 1 --branch v1.37.0 https://github.com/smartcontractkit/cre-cli.git "$work"
git -C "$work" apply "$here/cre-cli-v1.37.0-simulate-nologin.patch"
( cd "$work" && GOFLAGS=-mod=mod go build -p 4 \
    -ldflags "-w -X 'github.com/smartcontractkit/cre-cli/cmd/version.Version=v1.37.0-isotherm-nologin'" \
    -o "$here/../.tools/bin/cre-nologin-sim" . )
echo "built $here/../.tools/bin/cre-nologin-sim"
