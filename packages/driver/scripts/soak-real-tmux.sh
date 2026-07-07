#!/usr/bin/env bash
# soak-real-tmux.sh — Run real-tmux timing-sensitive suites N times.
#
# Policy (tc-3si): a flake in flow-load.test.ts or resilience.test.ts is a
# correctness signal, not noise.  This step runs each suite N times and
# fails CI if any run fails or if outcomes are non-deterministic (pass-then-fail
# across runs).
#
# A flake found here MUST be filed as a P2 bug before retrying to green.
# See: packages/session-proxy/TESTING.md
#
# Wall-clock budget: N=3 runs × ~18 s/run = ~54 s typical; limit hard-coded
# below prevents silent bloat.  Increase SOAK_BUDGET_SECS if suites grow.
#
# Usage:
#   bash scripts/soak-real-tmux.sh              # N=3 (default)
#   SOAK_N=5 bash scripts/soak-real-tmux.sh    # override N

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOAK_N="${SOAK_N:-3}"
SOAK_BUDGET_SECS=120   # 2 minutes — fail if wall clock exceeds this

# Node.js test runner invocation.  The tsx import lets us run .test.ts files
# directly without a prior tsc compile step (though dist/ must already exist
# for the imports inside the test to resolve — run `npm run build` first, or
# use `npm run soak` which includes the build step).
#
# tc-3si.8: topology-canary.test.ts is the targeted canary for the slot-less
# %end mis-bind that corrupts the committed topology snapshot — flow-load and
# resilience cover gate state / byte accounting / output delivery but no
# existing real-tmux test had a flow-control command in flight concurrently
# with a topology requery (the precise tc-e3m interleaving).
NODE_TEST_CMD=(
  node --import tsx --test
  --test-timeout=60000
  src/runtime/flow-load.test.ts
  src/runtime/resilience.test.ts
  src/runtime/topology-canary.test.ts
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ts() { date '+%H:%M:%S'; }
log() { echo "[soak $(ts)] $*"; }
fail() { echo "[soak $(ts)] FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Budget watchdog (background; kills whole process group on expiry)
# ---------------------------------------------------------------------------

SOAK_START=$(date +%s)

budget_watchdog() {
  sleep "${SOAK_BUDGET_SECS}"
  local elapsed=$(( $(date +%s) - SOAK_START ))
  echo "[soak] BUDGET EXCEEDED: ${elapsed}s elapsed, limit ${SOAK_BUDGET_SECS}s" >&2
  kill -TERM 0 2>/dev/null || true
}
budget_watchdog &
WATCHDOG_PID=$!
trap 'kill "${WATCHDOG_PID}" 2>/dev/null || true' EXIT

# ---------------------------------------------------------------------------
# Run N times
# ---------------------------------------------------------------------------

log "Starting soak: N=${SOAK_N}, budget=${SOAK_BUDGET_SECS}s"
log "Suites: flow-load.test.ts, resilience.test.ts, topology-canary.test.ts"
log "Working dir: ${PACKAGE_DIR}"

declare -a OUTCOMES=()   # "pass" or "fail" per run

for (( run=1; run<=SOAK_N; run++ )); do
  LOG_FILE="/tmp/soak-run-${run}-$$.log"
  log "Run ${run}/${SOAK_N} ..."

  RUN_START=$(date +%s)
  if (cd "${PACKAGE_DIR}" && "${NODE_TEST_CMD[@]}") > "${LOG_FILE}" 2>&1; then
    RUN_END=$(date +%s)
    log "Run ${run}/${SOAK_N} PASS ($(( RUN_END - RUN_START ))s)"
    OUTCOMES+=("pass")
  else
    RUN_END=$(date +%s)
    log "Run ${run}/${SOAK_N} FAIL ($(( RUN_END - RUN_START ))s)"
    echo "--- Run ${run} output ---" >&2
    cat "${LOG_FILE}" >&2
    echo "--- end Run ${run} ---" >&2
    OUTCOMES+=("fail")
  fi
done

# ---------------------------------------------------------------------------
# Evaluate outcomes
# ---------------------------------------------------------------------------

TOTAL_ELAPSED=$(( $(date +%s) - SOAK_START ))
log "All ${SOAK_N} runs complete in ${TOTAL_ELAPSED}s."

PASS_COUNT=0
FAIL_COUNT=0
for o in "${OUTCOMES[@]}"; do
  if [[ "${o}" == "pass" ]]; then
    PASS_COUNT=$(( PASS_COUNT + 1 ))
  else
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  fi
done

log "Results: ${PASS_COUNT} pass, ${FAIL_COUNT} fail."

if [ "${FAIL_COUNT}" -gt 0 ] && [ "${PASS_COUNT}" -gt 0 ]; then
  # Non-deterministic: some passed, some failed.
  fail "FLAKE DETECTED (non-deterministic): ${PASS_COUNT} pass, ${FAIL_COUNT} fail across ${SOAK_N} runs." \
    $'\nPolicy: file a P2 bug before retrying to green. See packages/session-proxy/TESTING.md'
elif [ "${FAIL_COUNT}" -gt 0 ]; then
  fail "CONSISTENT FAILURE: ${FAIL_COUNT}/${SOAK_N} runs failed."
fi

log "SOAK PASS: all ${SOAK_N} runs passed in ${TOTAL_ELAPSED}s (budget: ${SOAK_BUDGET_SECS}s)."
