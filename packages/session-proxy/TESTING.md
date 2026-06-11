# Testing policy — @tmuxcc/session-proxy

## Real-tmux timing-sensitive suites

`flow-load.test.ts`, `resilience.test.ts`, and `topology-canary.test.ts`
exercise the full session-proxy stack against a real tmux process.  Their
timing-sensitive assertions (pause/resume engagement, host-exit detection,
committed-model topology under interleaved flow-control + requery) make them
the only suites with production-grade async-reply timing.  A flake in these
suites is a **correctness signal**, not noise.

`topology-canary.test.ts` (tc-3si.8) is the targeted canary for the slot-less
%end mis-bind that corrupts the committed topology snapshot: a firehose
drives `refresh-client -A` pause/continue traffic AND a split-pane forces a
`list-windows`/`list-panes` requery, then assertions read the **committed
model** (panes.size, windows referencing real panes, well-formed pane ids) —
not just gate state or byte counts.  Without this canary the soak step
cannot catch the one bug class motivated by tc-e3m / tc-128.4.

### Flake-is-a-bug policy

> **A flake in `flow-load.test.ts`, `resilience.test.ts`, or
> `topology-canary.test.ts` is a P2 bug by default.**

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
`npm run ci:soak -w @tmuxcc/session-proxy`) runs `flow-load.test.ts`,
`resilience.test.ts`, and `topology-canary.test.ts` **N=3 consecutive times**
(override with `SOAK_N=5`).  CI fails if:

- Any single run fails (consistent failure).
- Outcomes differ across runs (non-deterministic / flake).

Wall-clock budget: **2 minutes** hard limit (typical: ~50 s for N=3 once the
canary is included).  If the suites grow and the budget is routinely
exceeded, increase `SOAK_BUDGET_SECS` in `scripts/soak-real-tmux.sh` **and
update this doc** with the new target.

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
cd github/cwalv/tmuxcc-driver/packages/session-proxy
SOAK_N=3 bash scripts/soak-real-tmux.sh
```

## Assertion conventions (tc-cbh)

These rules exist because of tc-cbh: a test computed drain arithmetic from a
stale counter snapshot while real tmux output was still in flight, then failed
with a message that pointed at the product. Two readers chased phantom product
bugs (boundary direction, trigger lag) before the test's own unstated
assumption was found. The conventions make required-vs-assumed legible:

1. **A bare `assert` claims a synchronous product guarantee.** You must be
   able to point at the synchronous code path that makes it true, and cite
   the contract clause being verified (e.g. `// verifies FC-3` — see the
   numbered FC-N invariants in `flow-control.ts`). Anything eventual or
   environment-dependent uses `waitFor`. Asserting something no contract
   clause promises is a test bug.

2. **Assert exactly where deterministic; eventually where racing.** A
   quiesced drain leaves *exactly* `LOW_WATER − 1` — assert equality, not
   `<`. The sharper assert doubles as a free ledger check (FC-1). Inversely,
   never assert exact values on state the environment can still move.

3. **`delay()` is not synchronization.** If test arithmetic depends on a
   state (producer stopped, counter stable), observe that state — e.g.
   `waitForQuiescent` polls until the counter is stable across consecutive
   ticks — never approximate it with a sleep. Any bare `delay()` standing in
   for a state wait is a latent flake and a review flag.

4. **Preconditions get asserted, not assumed.** If the math needs
   "counter > HIGH_WATER" or "producer quiesced", assert it before the act.
   A violated precondition then fails self-diagnosingly ("did not quiesce")
   instead of misleadingly at the postcondition.

Worked example: `flow-load.test.ts` F2 (quiesce → precondition assert →
synchronous read+drain → exact residual).

### tmux socket hygiene

These suites use unique `tmuxcc-test-<pid>-...` sockets and must **never** touch
the production `tmuxcc` socket.  Do not change the socket-naming scheme in the
test harness; `test-tmux-cleanup.ts` guards the sweep pattern.
