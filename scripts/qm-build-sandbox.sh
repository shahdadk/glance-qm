#!/usr/bin/env bash
set -euo pipefail
QM_CALLER_SOURCE_DIR="${QM_SOURCE_DIR:-}"
QM_RUNTIME_ENV="${QM_RUNTIME_ENV:-$HOME/.config/glance-qm/runtime.env}"
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
QM_BUILD_ARCH="$(docker info --format '{{.Architecture}}')"
case "$QM_BUILD_ARCH" in
  aarch64|arm64) QM_BUILD_ARCH=arm64 ;;
  x86_64|amd64) QM_BUILD_ARCH=amd64 ;;
  *) echo "Unsupported Docker architecture: $QM_BUILD_ARCH" >&2; exit 1 ;;
esac
docker build --platform "linux/$QM_BUILD_ARCH" --build-arg "TARGETARCH=$QM_BUILD_ARCH" -f fly/Dockerfile -t qm-sandbox-base:dev .
QM_FINGERPRINT="$(node --input-type=module -e 'const {computeSandboxImageFingerprint}=await import("./src/sandbox/local-sandbox.ts");console.log(await computeSandboxImageFingerprint(process.cwd()));')"
docker build --platform "linux/$QM_BUILD_ARCH" -f local/Dockerfile --build-arg BASE=qm-sandbox-base:dev --label "qm.sandbox-fingerprint=$QM_FINGERPRINT" -t qm-sandbox-local:latest .
