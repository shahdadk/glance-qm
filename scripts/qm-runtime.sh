#!/usr/bin/env bash
set -euo pipefail
QM_CALLER_SOURCE_DIR="${QM_SOURCE_DIR:-}"
QM_RUNTIME_ENV="${QM_RUNTIME_ENV:-$HOME/.config/glance-qm/runtime.env}"
if [[ ! -f "$QM_RUNTIME_ENV" ]]; then
  echo "Missing runtime configuration: $QM_RUNTIME_ENV" >&2
  exit 1
fi
set -a
source "$QM_RUNTIME_ENV"
set +a
QM_SOURCE_DIR="${QM_CALLER_SOURCE_DIR:-${QM_SOURCE_DIR:-$HOME/.cache/glance-qm/qm}}"
if [[ -d /opt/homebrew/opt/node@24/bin ]]; then
  export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
elif [[ -d /usr/local/opt/node@24/bin ]]; then
  export PATH="/usr/local/opt/node@24/bin:$PATH"
fi
cd "$QM_SOURCE_DIR"
exec bash scripts/dev-instance.sh "${@:-status}"
