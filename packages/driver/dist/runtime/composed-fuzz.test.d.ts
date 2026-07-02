/**
 * Adversarial-timing fuzz harness for the composed requery pipeline (tc-3si.3).
 *
 * # Why
 *
 * All three tc-128 review bugs were COMPOSITION bugs invisible to friendly-
 * timing unit tests — the engine, coalescer, and pipeline drain are each
 * unit-green; the bugs lived in the seams (engine x coalescer ceiling bypass;
 * bootstrap-mode x dirty-bit disconnect; correlator FIFO x slot-less writers).
 * The state-model.md §6 quantitative invariants are properties of the COMPOSED
 * system: 1 Hz ceiling bounds storms, staleness bounded by requery round-trip,
 * convergence after quiet. Verifying them needs an adversarial scheduler that
 * injects notifications in EVERY phase (pre-bootstrap, during the bootstrap
 * requery, during the drain, during steady-state cycles in flight, during
 * %error retries, across stop()) — not just BETWEEN cycles in the friendly
 * unit suites.
 *
 * # Design
 *
 * Every seed runs the same composed graph (`createRuntimePipeline` over a
 * `FuzzTmuxHost`) under a fake clock (`makeFuzzClock`) and seeded PRNG
 * (`mulberry32`). The harness:
 *
 *   1. Builds a synthetic tmux WORLD (sessions/windows/panes) that the
 *      schedule mutates and the host queries lazily — list-* replies always
 *      reflect the world AT REPLY TIME (so a notification arriving during a
 *      cycle changes what that cycle's reply will contain, modelling the
 *      adversarial mid-flight race).
 *
 *   2. Generates a randomized schedule of events tagged with virtual times:
 *      notifications (pre-bootstrap, mid-bootstrap, post-drain steady state),
 *      reply latencies (so list-* replies don't all arrive instantly — the
 *      ceiling/budget/dirty-mid-flight regimes need finite cycle durations),
 *      and occasional %error replies that exercise the coalescer retry path.
 *
 *   3. Drives the clock forward and asserts three invariants per seed:
 *
 *      (a) Cycle-rate ceiling. In any rolling 1-second window across the
 *          run, the number of `engine.requery()` CALLS (one per coalescer
 *          fire — leading edge / trailing edge / heartbeat / retry) is
 *          bounded by `1 + CYCLE_BUDGET` (leading edge plus at most
 *          CYCLE_BUDGET in-call retries, all fired at the same lastRequeryAt
 *          stamp). This is the design's "storm rendering at 1 fps" property.
 *
 *      (b) Convergence after quiet. After the last scheduled notification +
 *          a quiet window (≥ ceilingMs + reply latency + heartbeat tick),
 *          the served model deep-equals the synthetic world AND replaying
 *          all observed (prev → next) deltas onto the bootstrap snapshot
 *          reproduces the final served snapshot exactly. No spurious open/
 *          close pairs.
 *
 *      (c) No starvation. After the quiet window, the engine reports
 *          `isDirty() === false`, the coalescer has no pending trailing-edge
 *          timer (the test's FuzzClock pendingCount() drops to ≤ 1, the
 *          heartbeat), and no requery() promises are stuck pending in the
 *          host's reply queue.
 *
 * On any assertion failure we PRINT THE SEED so the failure replays
 * deterministically: re-run with `SP_FUZZ_SEED=<seed> SP_FUZZ_N=1`.
 *
 * # Tuning
 *
 * - `DEFAULT_N_SEEDS = 200` keeps the harness under a few seconds locally
 *   (each seed is a few ms of fake time + microtask flushes).
 * - Override via `SP_FUZZ_N` (e.g. `SP_FUZZ_N=2000 node --test ...`) for
 *   deeper soak runs outside CI.
 * - Override `SP_FUZZ_SEED` to replay one schedule.
 *
 * # Verification
 *
 * Two scratch-commit demonstrations are recorded against the bead (tc-3si.3
 * comments):
 *   - Re-introducing the tc-128.5 unbounded loop (delete the cycle budget
 *     bound) trips invariant (a) with a logged seed.
 *   - Re-introducing the drain-discard bug (drop notifications during the
 *     bootstrap buffer instead of replaying) trips invariant (b) with a
 *     logged seed.
 *
 * @module runtime/composed-fuzz.test
 */
export {};
//# sourceMappingURL=composed-fuzz.test.d.ts.map