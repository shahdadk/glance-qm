#!/usr/bin/env bash
set -euo pipefail
# Dedicated GBrain state; never reads or writes the operator's personal brain.
root="${GLANCE_GBRAIN_RUNTIME:-$HOME/.local/share/glance-qm/gbrain-runtime}"
source "$root/host.env"
exec "${BUN_BIN:-$HOME/.local/bin/bun}" "${GLANCE_GBRAIN_SOURCE:-$HOME/.local/share/glance-qm/gbrain-source}/src/cli.ts" "$@"
