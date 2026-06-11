# Testing policy — @remux/session-proxy

## Real-tmux timing-sensitive suites

`flow-load.test.ts` and `resilience.test.ts` exercise the full session-proxy stack
against a real tmux process.  Their timing-sensitive assertions (pause/resume
engagement, host-exit detection) make them the only suites with production-grade
async-reply timing.  A flake in these suites is a **correctness signal**, not
noise.

### Flake-is-a-bug policy

> **A flake in `flow-load.test.ts` or `resilience.test.ts` is a P2 bug by default.**

When the `ci:soak` step fails with a non-deterministic outcome (some runs pass,
some fail):

1. **Do not retry to green.**  Retrying silences the signal.
2. **File a P2 bug immediately.**  Use the `bd` tool:
   ```sh
   bd new --title "Flake in <suite>: <brief description>" --priority P2
   ```
   Include: which run(s) failed, the failure output, the SOAK_N value, and the
   host environment (tmux version, node version, OS).
3. **Block the merge** until the bug has a bead and a root-cause hypothesis.
4. Exceptions (downgrade to P3) require explicit TL sign-off with written
   rationale in the bug comment.

Rationale: the tc-e3m/tc-128.4 incident showed that a real timing bug
(FIFO mis-bind) was announcing itself through intermittent failures that got
retried into silence.  These suites are the production-grade async timing
layer; their flakes are the canary.

### `ci:soak` step

`npm run ci:soak` (from the workspace root or directly via
`npm run ci:soak -w @remux/session-proxy`) runs `flow-load.test.ts` and
`resilience.test.ts` **N=3 consecutive times** (override with `SOAK_N=5`).
CI fails if:

- Any single run fails (consistent failure).
- Outcomes differ across runs (non-deterministic / flake).

Wall-clock budget: **2 minutes** hard limit (typical: ~36 s for N=3).  If the
suites grow and the budget is routinely exceeded, increase `SOAK_BUDGET_SECS`
in `scripts/soak-real-tmux.sh` **and update this doc** with the new target.

`npm run ci` includes `ci:soak` as a named step between `ci:fast` and
`test-integration`:

```
ci:fast  →  ci:soak  →  test-integration
```

### Running the soak step locally

```sh
# From the workspace root (recommended):
npm run ci:soak

# With a larger N:
SOAK_N=5 npm run ci:soak

# Directly from the package:
cd github/cwalv/remux/packages/session-proxy
SOAK_N=3 bash scripts/soak-real-tmux.sh
```

### tmux socket hygiene

These suites use unique `tmuxcc-test-<pid>-...` sockets and must **never** touch
the production `tmuxcc` socket.  Do not change the socket-naming scheme in the
test harness; `test-tmux-cleanup.ts` guards the sweep pattern.
