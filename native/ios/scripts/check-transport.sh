#!/bin/bash
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /private/path/pairing.json" >&2
  exit 2
fi
native_dir="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$native_dir/evidence"
smoke_binary="$native_dir/evidence/native-transport-smoke"
xcrun swiftc -swift-version 5 \
  "$native_dir/GlanceQM/MeetingModels.swift" \
  "$native_dir/GlanceQM/MeetingAPI.swift" \
  "$native_dir/GlanceQM/NativeDiagnostics.swift" \
  "$native_dir/GlanceQM/TranscriptRevisionTracker.swift" \
  "$native_dir/scripts/transport-smoke.swift" -o "$smoke_binary"
"$smoke_binary" "$1"
