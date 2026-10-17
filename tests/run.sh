#!/usr/bin/env bash
# Typecheck + run the advisor plugin's behavioral suite.
#
#   ./run.sh          run everything
#   ./run.sh -t       typecheck only (no behavior)
#
# How it works: copies the live plugin (../plugins/advisor/index.ts) to
# ./advisor.index.ts so tests always exercise the real, current code. The copy
# is transient and gitignored; nothing is written back to the plugin.
set -euo pipefail
cd "$(dirname "$0")"

# Prefer the locally-installed SDK + tsc (matches the typecheck harness pinned
# to @opencode/plugin@2.0.32); fall back to a one-shot npx if node_modules is
# missing.
if [ -x ./node_modules/.bin/tsc ]; then
  TSC=./node_modules/.bin/tsc
else
  TSC="npx --yes typescript@5.6.3 tsc"
  echo "[run.sh] tests/node_modules missing — installing pinned deps once"
  npm install --silent
fi

# The suite imports the plugin via "./advisor.index.ts". A plain copy (not a
# symlink) is required: Node's ESM resolver resolves package imports like
# "@opencode/plugin" relative to the file's REAL path, and a symlink would point
# back into ../plugins/advisor/ which has no node_modules.
cp ../plugins/advisor/index.ts ./advisor.index.ts

echo "=== typecheck ==="
$TSC -p tsconfig.json
echo "typecheck clean"

if [ "${1:-}" = "-t" ]; then
  echo "(-t given, skipping behavior)"
  exit 0
fi

echo "=== behavior ==="
node advisor.test.ts
