#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
TIMING_FILE="${ARGUS_TIMING_FILE:-src/timing.ts}"
if ! git show origin/main:src/timing.ts | cmp -s - "$TIMING_FILE"; then
  echo "doctor=fail timing.ts differs from origin/main"
  exit 1
fi
if ! node .cursor/skills/verify-argus/check-cameras.mjs; then
  echo "doctor=fail camera config"
  exit 1
fi
npx tsc -p tsconfig.json --noEmit
echo "head=$(git rev-parse HEAD)"
echo "mini=not-contacted"
echo "doctor=ok"
