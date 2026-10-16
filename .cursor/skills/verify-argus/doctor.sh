#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
if git diff --name-only origin/main -- src/timing.ts | grep -q .; then
  echo "doctor=fail timing.ts differs from origin/main"
  exit 1
fi
npx tsc -p tsconfig.json --noEmit
echo "head=$(git rev-parse HEAD)"
echo "mini=not-contacted"
echo "doctor=ok"
