#!/usr/bin/env bash
# verify-boundary-lint.sh — confirm the parser-no-wire rule CATCHES violations.
#
# This script is run via `npm run lint:boundaries:verify` (make lint-boundaries-verify).
# It is NOT part of normal CI — it's a one-time verification helper for after
# lint config changes, confirming the rule is active and not silently passing.
#
# Exit 0 if lint correctly rejects the forbidden import; exit 1 otherwise.

set -euo pipefail

FIXTURE="src/parser/_bad-import-fixture.ts"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Find depcruise: check package-local node_modules, then walk up to the
# workspace root (npm hoists devDependencies to the workspace root).
if [ -f "$PKG_DIR/node_modules/.bin/depcruise" ]; then
  DEPCRUISE="$PKG_DIR/node_modules/.bin/depcruise"
else
  # Walk up directories looking for node_modules/.bin/depcruise
  DIR="$PKG_DIR"
  DEPCRUISE=""
  while [ "$DIR" != "/" ]; do
    if [ -f "$DIR/node_modules/.bin/depcruise" ]; then
      DEPCRUISE="$DIR/node_modules/.bin/depcruise"
      break
    fi
    DIR="$(dirname "$DIR")"
  done
  if [ -z "$DEPCRUISE" ]; then
    echo "ERROR: depcruise not found. Run 'npm install' first." >&2
    exit 1
  fi
fi

# Write a deliberately-bad fixture: parser importing from wire
cat > "$FIXTURE" << 'EOF'
// VERIFY FIXTURE — deliberately forbidden import.
// parser/ must not import from wire/.  This file exists only to confirm
// the parser-no-wire lint rule is active.  Never commit real code like this.
import type { FrameHeader } from "../wire/framing.js";
export type { FrameHeader };
EOF

cleanup() {
  rm -f "$FIXTURE"
}
trap cleanup EXIT

# Run lint — expect exit code != 0 (violation found)
if "$DEPCRUISE" "$FIXTURE" \
    --config .dependency-cruiser.cjs \
    --ts-pre-compilation-deps \
    --output-type err 2>&1; then
  echo "ERROR: lint:boundaries:verify FAILED — parser-no-wire rule did NOT catch the forbidden import." >&2
  exit 1
else
  echo "OK: parser-no-wire lint verified — forbidden parser→wire import was caught."
fi
