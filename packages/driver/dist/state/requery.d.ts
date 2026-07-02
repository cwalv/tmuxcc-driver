/**
 * Requery engine — events-as-invalidation topology pipeline (tc-128.1).
 *
 * @module state/requery
 *
 * # Why this exists
 *
 * The reducer (tc-5dd) interprets each tmux notification to mutate the model
 * incrementally; that path is the source of every tc-3y8 bug (window-add
 * attribution, unlinked-window phantoms, the 3.4 layout-change gap, multi-line
 * gluing). state-model.md §6 (adopted 2026-06-10, decision tc-5ym) replaces
 * that with: demote every notification to a dirty bit; on dirty, requery
 * (`list-windows` + `list-panes`, ~0.5 ms round-trip), diff against the
 * previous model, emit deltas. Bootstrap, reconnect, and steady state become
 * one path: a diff against the empty model is a bootstrap; a diff against the
 * last-served model is a reconnect; a diff against the previous in-memory
 * model is steady state.
 *
 * # Scope of this bead (tc-128.1)
 *
 * - Pure `requeryDiff(prev, windowsResult, panesResult)` core: parse the
 *   bootstrap-format replies, build a fresh model via `buildInitialModel`,
 *   diff against `prev`, return `{ next, deltas }`.
 * - `RequeryEngine`: the driver. Owns the previous model; exposes a single
 *   `requery()` method that issues both `list-*` commands, awaits both,
 *   computes the diff, and atomically swaps in the new model. Handles the
 *   "two commands — not atomic" case via a dirty bit: a `markDirty()` call
 *   that lands while a requery is in flight causes the cycle to re-run on
 *   completion (converges).
 *
 * # What is NOT in scope (left for later beads)
 *
 * - **No coalescing / rate limiting.** tc-128.2 wraps this engine with a 1 Hz
 *   leading-edge coalescer. The engine itself runs immediately when called.
 * - **No output-before-topology buffering.** tc-128.3 owns that.
 * - **No reducer retirement.** tc-128.4 retires the reducer's event
 *   interpretation. Until then, the reducer path stays alive and functioning;
 *   this engine is additive.
 * - **No pipeline wiring.** The integration with `RuntimePipeline` is a
 *   downstream concern; this bead lands the building blocks.
 *
 * # Dead-pane semantics
 *
 * tmux's `list-panes` is authoritative for pane presence: a pane with
 * `remain-on-exit on` that has died is still listed (it has a dead process
 * but the pane container exists), so it stays in the model. A pane that has
 * exited fully (no remain-on-exit) is gone from `list-panes` and is therefore
 * removed by the diff — emitting `pane.closed`. This matches the existing
 * reducer behavior, because today the reducer's `handleLayoutChange` uses
 * the new layout's leaf set as the authoritative pane membership; layout
 * absence and `list-panes` absence are the same signal (tmux reflows the
 * layout when a pane is removed). The dead-pane reducer test suite remains
 * the contract: a pane that appears in `list-panes` survives, one that
 * doesn't is closed.
 *
 * tc-4bv2 / tc-295a.10 (shared pane-state shape): a surviving corpse is not
 * silent. The bootstrap requery reads `#{pane_dead}` / `#{pane_dead_status}`
 * (bootstrap.ts), so the model's `Pane.dead` / `Pane.exitCode` carry the
 * corpse state. The diff (projection.ts) therefore emits `pane.dead-changed`
 * when a live pane becomes a corpse in place, includes the dead flag on
 * `pane.opened` for a corpse seen for the first time, and carries the corpse's
 * `exitCode` through to `pane.closed` when the slot is finally reaped. This is
 * what lets an all-dead-pane session enter the snapshot and signal READY
 * (tc-4bv2) without weakening the "in list-panes ⇒ in model" rule above.
 *
 * # Reparenting (break-pane)
 *
 * `break-pane` keeps the pane id (`%N` unchanged) but moves it to a new
 * window. Because the model and the wire use stable ids, the diff sees this
 * mechanically as: same paneId present in both `prev` and `next`, but with a
 * different `windowId`. `diffModel` emits a dedicated `pane.moved` delta
 * (tc-4gor) carrying the pane's new `windowId` — the SINGLE wire signal that
 * re-points an existing pane's window membership. There is NO pane.closed +
 * pane.opened pair, so clients keep the pane's scrollback / dimensions / mode /
 * title / dead-state — the pane was moved, not recreated. The new window is
 * announced by `window.added` first (delta-ordering rule), then `pane.moved`
 * re-homes the existing pane into it.
 *
 * NOTE (tc-4gor): the `layout.updated` deltas alone are NOT sufficient. tmux 3.4
 * emits `%layout-change` for the OLD window but NOT for the detached new window,
 * and a layout tree never re-points a pane's owner anyway; a client that derives
 * window→pane grouping from `pane.windowId` (the Mirror's ClientModel, hence the
 * VS Code side-tree) MUST get `pane.moved` or it renders the new window empty
 * with the pane stuck under its old window (stable-wrong until a resnapshot).
 * See the reparenting round-trip test in requery.test.ts.
 *
 * # Convergence under mid-flight dirties (commit-only-clean, tc-128.5)
 *
 * `requery()` issues two commands and awaits both. Between them, tmux may
 * emit notifications signalling further topology changes. The engine exposes
 * `markDirty()`: callers (the dirty-bit coalescer in tc-128.2 — for now the
 * pipeline or tests) flip the bit whenever a topology-relevant notification
 * arrives.
 *
 * The engine drives a BOUNDED convergence loop inside one `requery()` call,
 * with two non-negotiable invariants:
 *
 * 1. **Commit only clean snapshots.** A candidate model is held in a local
 *    until a cycle completes with BOTH replies ok AND the dirty bit still
 *    clear. Only then is `this._model` swapped to the candidate and the
 *    cumulative deltas (against the pre-call model) returned. Possibly-torn
 *    intermediate models are never observable through `getModel()`, and the
 *    served deltas always describe the exact `getModel()` transition.
 * 2. **Bounded budget.** Convergence is capped at `CYCLE_BUDGET` iterations.
 *    Under a sustained notification storm (every cycle dirties mid-flight)
 *    the loop exits within the budget rather than spinning at cycle-rate.
 *    On budget exhaustion the engine treats the call as failed (re-arms
 *    dirty, returns `{ next: startModel, deltas: [], failed: true }`); the
 *    coalescer's existing failed-path schedules a retry at the next ceiling
 *    boundary and the heartbeat guarantees eventual convergence.
 *
 * On `%error` from either reply the cycle is also failed: model unchanged,
 * dirty re-armed, `failed: true`. The pure-core `requeryDiff` retains its
 * BOOTSTRAP semantic ("missing rows = empty rows"); the engine's driver path
 * never wipes the model on a transient command failure.
 *
 * The short-burst case is preserved: a single mid-flight dirty followed by a
 * clean cycle converges in-call and serves the cumulative deltas. Storms
 * (the tc-3y8.8 class, ~8000 notif/s) are bounded operationally by the
 * coalescer's 1 Hz ceiling and structurally by this engine's per-call
 * cycle budget.
 *
 * # Teardown-confirmation guard (tc-3si.2)
 *
 * The tc-128.4 bug class is "a garbage `list-*` reply parsed as an EMPTY
 * windows/panes set" — the canonical example is a `%pause` ack body
 * mis-bound onto a `list-windows` slot, producing zero rows and a candidate
 * model that closes every pane and window. Slots (tc-128.4 / tc-3si.1)
 * close the known reproducer at the source by making slot-registration
 * atomic with the write. The guard here is the SECOND line of defense:
 * any future regression of the class — anything that lets a garbage
 * snapshot reach the candidate-build step — is converted from catastrophe
 * (mass `pane.closed` / `window.closed` to every client) into a ~1 ms
 * self-heal AND an expected-zero counter trip.
 *
 * The guard's algorithm: a clean cycle whose candidate would close ≥
 * `teardownThreshold` (default 0.8) of the previous model's panes OR
 * windows is NOT committed immediately. The engine holds the candidate
 * and runs one CONFIRMING cycle.
 *
 *   - Confirming cycle's candidate ALSO crosses the threshold (against the
 *     same pre-call startModel): the teardown is real. Commit the
 *     CONFIRMING cycle's candidate (not the first one — tmux may have
 *     changed slightly between them), bump
 *     `requery_teardown_confirmations_total{outcome="confirmed"}`, return
 *     deltas as usual. The user pays one extra `list-*` round-trip
 *     (~0.5–1 ms) on a genuine session-end — a rare, user-driven event.
 *
 *   - Confirming cycle's candidate DOES NOT cross the threshold (it
 *     disagrees with the first one): the first snapshot was garbage.
 *     Discard both candidates, leave `_model` untouched, re-arm the dirty
 *     bit, return `failed: true`. Bump
 *     `requery_teardown_confirmations_total{outcome="refuted"}` AND log
 *     loudly to stderr with the candidate's teardown breakdown — the
 *     storm-alarm-style alert path (`metrics/storm-alarm.ts` pattern).
 *
 * # Budget interaction (the bd-comment design call)
 *
 * The confirmation cycle COUNTS against `CYCLE_BUDGET` — same iteration
 * counter as the convergence loop. Decision rationale: every cycle is one
 * `submit()` round-trip in the same `requery()` call, the budget exists to
 * structurally bound that, and exempting the confirm would re-introduce
 * an unbounded path. With the default budget of 5 there is plenty of
 * headroom: a real cycle, one mid-flight dirty re-run, and a confirming
 * cycle all fit comfortably. If the budget is exhausted MID-CONFIRMATION
 * the engine returns `failed: true` with no commit — same shape as the
 * storm-exhaustion path; the coalescer's retry + heartbeat eventually
 * re-evaluates. The teardown counter is NOT incremented in that case
 * (we never reached a confirm-vs-refute decision).
 *
 * The masking-risk reading (operator question, 2026-06-11): the refuted
 * counter inverts the usual error-absorbing-guard concern — this guard
 * protects clients from the catastrophic symptom AND makes the underlying
 * bug class MORE visible than today, because today a single mis-bound
 * teardown is silent on the metrics side (clients see a flash and recover
 * on the next requery; nothing fires loud). With the counter every
 * incident lands one stderr line + one expected-zero counter increment.
 */
import type { CommandResult } from "../parser/correlator.js";
import type { SessionModel } from "./model.js";
import type { SessionProxyMessage } from "@tmuxcc/protocol";
/**
 * Result of one requery cycle: the fresh model and the wire deltas needed to
 * transform a client holding `prev` into that fresh state.
 *
 * - `next` always reflects the parsed reply pair (or `emptyModel()` on a
 *   double `%error`). It is the new authoritative model.
 * - `deltas` is the output of `diffModel(prev, next)` and may be empty (no
 *   observable change). The `seq` fields are placeholders (0); the caller
 *   stamps real values before sending, exactly like the existing
 *   `diffModel` contract.
 * - `failed` is set by the `RequeryEngine` driver when either `list-*` reply
 *   was `%error`. The engine treats steady-state `%error` as "leave the model
 *   alone, stay dirty, retry on the next edge or heartbeat" (TL design call,
 *   tc-128.2): wiping the model on a transient command failure would emit a
 *   teardown burst that the next successful cycle would then have to undo.
 *   The pure `requeryDiff` function never sets `failed` — its `%error`
 *   handling is the BOOTSTRAP semantic ("treat missing rows as empty"). When
 *   `failed` is true, `next === prev` and `deltas` is empty.
 */
export interface RequeryResult {
    readonly next: SessionModel;
    readonly deltas: readonly SessionProxyMessage[];
    readonly failed?: boolean;
}
/**
 * Parse a windows + panes reply pair into a fresh `SessionModel` and compute
 * the wire deltas needed to transform `prev` into that model.
 *
 * This is the pure core of the engine: no I/O, no state, no timing. It is
 * what makes "bootstrap = diff against empty model" and "reconnect = diff
 * against last-served model" mechanical. Pass `emptyModel()` for `prev` to
 * get the full snapshot's worth of deltas (a cold attach); pass the
 * last-served model to get the minimal deltas needed for a reconnecting
 * client.
 *
 * If either reply is `%error` the corresponding rows are treated as empty —
 * the same fallback the bootstrap coordinator uses. A double `%error`
 * produces `next === emptyModel()` and deltas closing whatever was in
 * `prev`. Callers that want to ignore failed requeries should check
 * `ok`-ness BEFORE handing the replies to this function.
 *
 * @param prev               Previous model (use `emptyModel()` for bootstrap).
 * @param windowsResult      Reply from `list-windows -F BOOTSTRAP_WINDOWS_FORMAT`.
 * @param panesResult        Reply from `list-panes  -F BOOTSTRAP_PANES_FORMAT`.
 * @returns                  `{ next, deltas }` — the new model and wire deltas.
 */
export declare function requeryDiff(prev: SessionModel, windowsResult: CommandResult, panesResult: CommandResult): RequeryResult;
/**
 * Issue the two bootstrap-shape tmux commands and resolve when both replies
 * are in. The engine is transport-agnostic: it asks the caller for a
 * `submit(command)` function that atomically registers a correlator slot AND
 * writes the command, returning the Promise for its `CommandResult`. The
 * obvious provider is `correlator.send` (tc-3si.1) — slot registration and
 * the host write happen together, so the FIFO sequence stays in lockstep with
 * tmux's reply order no matter how many concurrent writers are active.
 *
 * The engine sends both commands first, then awaits both replies — same as
 * the bootstrap coordinator. This preserves the FIFO ordering expected by the
 * correlator and gets pipelined replies from tmux.
 */
export type SubmitCommand = (command: string) => Promise<CommandResult>;
/**
 * Diagnostic snapshot of a teardown-confirmation outcome (tc-3si.2).
 *
 * Passed to `RequeryEngineOptions.onTeardownConfirmation` after each
 * mass-teardown candidate is either confirmed or refuted. Used by tests to
 * verify the guard's behavior without parsing stderr, and by the
 * registry-wired path to surface the per-class breakdown into
 * `requery_teardown_confirmations_total{outcome}` plus the loud stderr
 * log on `refuted`.
 *
 * - `outcome === "confirmed"`: the confirming cycle ALSO crossed the
 *   teardown threshold; the teardown is served as usual.
 * - `outcome === "refuted"`: the confirming cycle did NOT cross the
 *   threshold; the first candidate was garbage and is discarded.
 *
 * `closedPanesFraction` / `closedWindowsFraction` are the fractions of the
 * pre-call model's panes / windows that the FIRST candidate would have
 * closed — what tripped the guard. They are computed against `startModel`
 * (the engine's pre-call snapshot), not against the previous cycle's
 * intermediate candidate, so they describe what the WIRE would have shown.
 */
export interface TeardownConfirmation {
    readonly outcome: "confirmed" | "refuted";
    readonly closedPanesFraction: number;
    readonly closedWindowsFraction: number;
    readonly threshold: number;
    /** Pane count in the engine's pre-call model. */
    readonly startPanes: number;
    /** Window count in the engine's pre-call model. */
    readonly startWindows: number;
}
/** Options for `createRequeryEngine`. */
export interface RequeryEngineOptions {
    /**
     * Initial model. Defaults to `emptyModel()` (cold bootstrap). Pass the
     * last-served model for a reconnect that wants minimal deltas instead of
     * a full teardown-and-rebuild.
     */
    readonly initialModel?: SessionModel;
    /**
     * The tmux session name this engine is bound to. Used ONLY to scope the
     * very first cold requery cycle (`list-* -t =<name>`), before any reply has
     * revealed the session's immutable id. On the first successful reply the
     * engine captures `#{session_id}` (already in the bootstrap format) and
     * targets `$<id>` on every subsequent cycle — which survives a
     * `rename-session` (tc-0v59). The name thereafter is a human display label
     * only, never a query target. When absent the queries fall back to `-a`
     * (all sessions) and the id is NOT captured (the engine deliberately tracks
     * every session in that mode).
     */
    readonly sessionName?: string;
    /**
     * Function the engine calls to issue each tmux command. The engine writes
     * nothing itself — it asks the caller to submit and returns the awaited
     * `CommandResult`. Concretely, a wiring like
     *
     * ```ts
     * const submit: SubmitCommand = (cmd) => correlator.send(cmd);
     * ```
     *
     * keeps the correlator FIFO in sync — `send` is atomic slot+write (tc-3si.1).
     * The engine deliberately does NOT take a `host` + `correlator` so it stays
     * testable with a synthetic submit.
     */
    readonly submit: SubmitCommand;
    /**
     * Threshold (fraction in (0, 1]) for the teardown-confirmation guard
     * (tc-3si.2). A clean cycle whose candidate would close ≥ this fraction
     * of EITHER the previous model's panes OR its windows is held back and
     * confirmed by a follow-up cycle before being served. Defaults to 0.8
     * (80%) per state-model.md §6's design discussion.
     *
     * Set to 1.0 to require a 100% teardown before confirming (still catches
     * the canonical "empty list-windows reply" garbage case); values > 1 or
     * ≤ 0 are clamped to the default.
     *
     * The guard NEVER fires when the pre-call model has zero panes and zero
     * windows (no teardown to verify), so cold bootstrap is unaffected.
     */
    readonly teardownThreshold?: number;
    /**
     * Optional sink called once per teardown-confirmation evaluation
     * (tc-3si.2) — exactly once per `requery()` call that triggered the
     * guard, regardless of outcome. Mirrors `storm-alarm.ts`'s `onTrip`
     * pattern: the engine ALSO logs loudly to stderr on `refuted` and bumps
     * `requery_teardown_confirmations_total` via the wired registry hook
     * (see `onTeardownOutcome`), but this sink is the test hook + extension
     * point. Throws are caught and swallowed so a misbehaving subscriber
     * cannot break the pipeline.
     */
    readonly onTeardownConfirmation?: (info: TeardownConfirmation) => void;
    /**
     * Optional registry-shaped hook for the per-outcome counter (tc-3si.2).
     * Production wiring passes `(outcome) => metrics.incTeardownConfirmation(outcome)`;
     * tests can pass a spy. Decoupled from the full registry interface so
     * the engine has no metrics dependency.
     */
    readonly onTeardownOutcome?: (outcome: "confirmed" | "refuted") => void;
    /**
     * Optional registry-shaped hook for the per-reason failure counter
     * (tc-3si.5). Fired once per `requery()` call that returns `failed: true`,
     * just before the return. The engine ALSO loud-logs the
     * budget-exhausted variant to stderr (storm-alarm-style alert path) so
     * the bug class stays visible without metrics wired.
     *
     * `reason="error"` — a `list-*` reply was `%error` from tmux. The
     * coalescer's failed-path schedules a retry at the next ceiling boundary.
     *
     * `reason="budget"` — the convergence loop exhausted `CYCLE_BUDGET`
     * iterations without producing a clean cycle (typically a sustained mid-
     * flight rearm storm). The engine ALSO bumps the standalone
     * `requery_budget_exhausted_total` via `onBudgetExhausted` (kept on a
     * separate surface so a reader sees the exhaustion total at a glance
     * without filtering the failed-cycles counter by reason).
     *
     * Throws are caught and swallowed so a misbehaving subscriber cannot
     * break the pipeline.
     */
    readonly onCycleFailed?: (reason: "error" | "budget") => void;
    /**
     * Optional registry-shaped hook for the convergence-budget exhaustion
     * counter (tc-3si.5). Fired exactly once per `requery()` call that
     * exits via the budget path (i.e. concurrent with `onCycleFailed("budget")`).
     * Kept on a separate surface from the failed-cycles counter so the
     * "budget exhausted" total is readable at a glance — that single counter
     * being non-zero in the absence of a storm-alarm trip is itself the
     * convergence-pathology diagnostic.
     */
    readonly onBudgetExhausted?: () => void;
}
/**
 * Stateful requery driver.
 *
 * Lifecycle:
 *   const engine = createRequeryEngine({ submit, sessionName });
 *   engine.markDirty();                  // optional — initial cycle anyway
 *   const { deltas } = await engine.requery();
 *   // ... later, when a topology notification arrives ...
 *   engine.markDirty();
 *   const { deltas: more } = await engine.requery();
 *
 * Convergence (the "two commands — not atomic" requirement): a `markDirty()`
 * call during an in-flight `requery()` is remembered; when the in-flight cycle
 * completes, `requery()` immediately runs another cycle. The driver iterates
 * (up to a small budget — see `CYCLE_BUDGET`) until a cycle completes with
 * the dirty bit still clear, then commits the candidate model to
 * `this._model` and returns the cumulative deltas against the engine's
 * pre-call model. If the budget is exhausted or a cycle hits `%error`, the
 * engine returns `{ next: startModel, deltas: [], failed: true }` with the
 * model unchanged from the pre-call snapshot and the dirty bit re-armed.
 * The caller sees one `RequeryResult` whose `next` is either the freshly
 * converged model (success) or the engine's pre-call model (failure).
 *
 * Concurrent `requery()` calls return the SAME Promise — the engine never
 * runs two cycles in parallel. This matches the wire-contract expectation
 * that a single client only ever sees a consistent prev→next transition.
 */
export interface RequeryEngine {
    /**
     * The current authoritative model (the result of the last completed
     * cycle, or the `initialModel` if none have run).
     */
    getModel(): SessionModel;
    /**
     * Overwrite the engine's stored model with `model`.
     *
     * Used by the pipeline's model-patch path (tc-128.4) for the cases where
     * the model needs to change WITHOUT a tmux-side requery: optimistic
     * updates from `input-path` (synchronize-panes etc.) and the
     * `%subscription-changed sync-watch` value feed.
     *
     * The patched model becomes the baseline for the next requery cycle's
     * diff — without this, the next `engine.requery()` would emit a
     * compensating delta that undoes the patch.
     *
     * Does NOT clear the dirty bit, does NOT cancel an in-flight cycle: if a
     * requery is currently running, its result still commits cleanly (the
     * candidate model is built from the FRESH tmux replies, not from
     * `_model`). The caller is responsible for sequencing: callers should
     * apply patches only when no requery is in flight, or accept that a
     * concurrent requery will overwrite the patch with the authoritative
     * snapshot — which is the correct behaviour for any field tmux also
     * reports (window-option subscriptions land in `list-windows` output as
     * well, so a follow-up requery will reaffirm the same value).
     *
     * Throws nothing; pure assignment.
     */
    setModel(model: SessionModel): void;
    /**
     * Mark the engine dirty. If a `requery()` is currently in flight the
     * cycle will be re-run on completion (the "dirtied mid-flight" case from
     * the bead description). If no cycle is in flight this is a hint for the
     * caller; it does not itself trigger a cycle. tc-128.2 will own the policy
     * of when `requery()` is called in response to a dirty flag.
     */
    markDirty(): void;
    /**
     * True iff `markDirty()` has been called since the last completed cycle.
     * Read-only; useful for the coalescer in tc-128.2 to know when to schedule
     * the next requery.
     */
    isDirty(): boolean;
    /**
     * Run a requery cycle: issue both commands, parse, and — only if the cycle
     * completes clean (both replies ok AND no `markDirty()` arrived mid-flight)
     * — swap in the new model and return the deltas against the engine's
     * pre-call model.
     *
     * If a cycle is already in flight, returns the in-flight Promise — the
     * engine never runs two cycles in parallel.
     *
     * Convergence model (tc-128.5, "commit-only-clean"): the driver loops on
     * cycle completion up to a small budget (`CYCLE_BUDGET`). Each cycle holds
     * its candidate model in a local; the engine's `_model` is written ONLY
     * when a cycle completes clean. If `markDirty()` arrives mid-flight, the
     * candidate is discarded and a fresh cycle is run. If the budget is
     * exhausted (sustained notification storm) or any cycle's reply is
     * `%error`, the engine returns `{ next: startModel, deltas: [], failed:
     * true }` with `_model` unchanged from the pre-call snapshot and the dirty
     * bit re-armed. The coalescer's existing failed-path schedules the retry
     * at the next ceiling boundary; the heartbeat guarantees eventual
     * convergence.
     *
     * The dirty bit is cleared the MOMENT a cycle starts, so notifications
     * that arrive AFTER both commands are sent but BEFORE both replies arrive
     * correctly cause a re-run (subject to the budget).
     */
    requery(): Promise<RequeryResult>;
}
/**
 * Create a `RequeryEngine`. See `RequeryEngine` for the lifecycle contract.
 */
export declare function createRequeryEngine(opts: RequeryEngineOptions): RequeryEngine;
//# sourceMappingURL=requery.d.ts.map