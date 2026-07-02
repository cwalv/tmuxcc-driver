/**
 * tc-hfxb.15 — Bootstrap-requery stall recovery (real tmux 3.4).
 *
 * REGRESSION TARGET. The driver bootstrap requery in `pipeline.start()` is a
 * `list-windows` / `list-panes` round-trip over the freshly-forked `tmux -CC`
 * stream. That round-trip had NO timeout anywhere in the chain: under host load
 * the first reply could STALL, and with no timeout a single transient stall
 * silently consumed the caller's whole connect budget (the e2e suite's 15 s
 * terminal-appearance wait failing at serial position ~22 — the tc-crnt.17 /
 * tc-0eds class). The only existing retry (`connectWithBoundedRetry`,
 * extension-side) fires on a thrown REJECTION, never on a stall.
 *
 * THE FIX (tc-hfxb.15, driver-side): `pipeline.start()` now races each
 * bootstrap `engine.requery()` against `bootstrapRequeryTimeoutMs`; on a stall
 * it CANCELS the stalled cycle's two `list-*` correlator slots
 * (`CommandCorrelator.cancelOldest`, which leaves drained placeholders in the
 * FIFO so a late `%end` can't mis-bind a subsequent command) and RE-ISSUES the
 * (idempotent) requery. The 15 s envelope is unchanged.
 *
 * # Stall-injection seam (test-only, NO production change)
 *
 * `DelayingWriteHost` wraps a real `TmuxHost` and WITHHOLDS the first
 * `delayWrites` writes (the bootstrap `list-windows` + `list-panes` commands)
 * for `releaseAfterMs` before forwarding them to real tmux. Because
 * `correlator.send` registers the slot BEFORE calling `host.write`, the slots
 * are queued immediately (FIFO intact) but tmux only RECEIVES the commands
 * after the delay — so its replies arrive late, exactly reproducing the
 * production stall. After release, the late `list-*` replies must be absorbed
 * by the cancelled placeholder slots (path d below). Production behaviour is
 * untouched when the wrapper isn't used.
 *
 * Asserts, against REAL tmux (no Electron / Chrome):
 *   (a) the bounded timeout FIRES (recovery happens on the order of the stall
 *       delay, NOT after an unbounded 15 s+ hang);
 *   (b) the requery is RE-ISSUED and the session BOOTSTRAPS (model has ≥1
 *       window / ≥1 pane, pipeline is live);
 *   (c) recovery lands within a small budget (well under the 15 s envelope);
 *   (d) NO correlator slot mis-bind: a LATE `%end` from the abandoned first
 *       requery does NOT corrupt a subsequent command's response.
 *
 * Excluded from the session-proxy tsconfig build (real-tmux test, tsx-run).
 *
 * @module runtime/bootstrap-requery-stall.test
 */
export {};
//# sourceMappingURL=bootstrap-requery-stall.test.d.ts.map