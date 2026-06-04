#!/usr/bin/env bash
# verify-boundary-lint.sh — confirm the client-no-daemon-runtime rule CATCHES violations.
#
# This script is run via `npm run lint:boundaries:verify`.
# It is NOT part of normal CI — it's a one-time verification helper for after
# lint config changes, confirming the rule is active and not silently passing.
#
# Exit 0 if lint correctly rejects the forbidden import; exit 1 otherwise.

set -euo pipefail

FIXTURE="src/_bad-import-fixture.ts"
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

# Write a deliberately-bad fixture: client importing daemon internal sub-path
cat > "$FIXTURE" << 'EOF'
// VERIFY FIXTURE — deliberately forbidden import.
// client/src/ must only import from the @tmuxcc/daemon barrel, not sub-paths.
// This file exists only to confirm the client-no-daemon-runtime lint rule is
// active.  Never commit real code like this.
import { createDaemon } from "@tmuxcc/daemon/src/runtime/daemon.js";
export { createDaemon };
EOF

cleanup() {
  rm -f "$FIXTURE"
}
trap cleanup EXIT

# Run lint — expect exit code != 0 (violation found)
if "$DEPCRUISE" "$FIXTURE" \
    --config .dependency-cruiser.cjs \
    --output-type err 2>&1; then
  echo "ERROR: lint:boundaries:verify FAILED — client-no-daemon-runtime rule did NOT catch the forbidden import." >&2
  exit 1
else
  echo "OK: client-no-daemon-runtime lint verified — forbidden client→daemon-subpath import was caught."
fi
