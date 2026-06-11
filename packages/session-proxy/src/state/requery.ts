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
 * # Reparenting (break-pane)
 *
 * `break-pane` keeps the pane id (`%N` unchanged) but moves it to a new
 * window. Because the model and the wire use stable ids, the diff sees this
 * mechanically as: same paneId present in both `prev` and `next`, but with a
 * different `windowId`. The existing `diffModel` does NOT emit a delta for a
 * pane.windowId change — it only emits pane.opened (new id) / pane.closed
 * (gone id) / pane.resized / pane.mode-changed. A break-pane therefore
 * surfaces as: the OLD window's layout.updated (pane gone from layout) and
 * the NEW window's layout.updated (pane present in new layout). The pane
 * itself is unchanged on the wire, which is correct — clients keep its
 * scrollback. See the reparenting round-trip test in requery.test.ts.
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
 */

import type { CommandResult } from "../parser/correlator.js";
import type { SessionModel } from "./model.js";
import { emptyModel } from "./model.js";
import { diffModel } from "./projection.js";
import type { SessionProxyMessage } from "../wire/session-proxy-control.js";
import {
  bootstrapCommands,
  buildInitialModel,
  parsePanesReply,
  parseWindowsReply,
} from "./bootstrap.js";

// ---------------------------------------------------------------------------
// Pure core: parse two replies → fresh model → diff against prev
// ---------------------------------------------------------------------------

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
export function requeryDiff(
  prev: SessionModel,
  windowsResult: CommandResult,
  panesResult: CommandResult,
): RequeryResult {
  const windowRows = windowsResult.ok ? parseWindowsReply(windowsResult.body) : [];
  const paneRows = panesResult.ok ? parsePanesReply(panesResult.body) : [];

  const next = buildInitialModel(windowRows, paneRows);
  const deltas = diffModel(prev, next);

  return { next, deltas };
}

// ---------------------------------------------------------------------------
// RequeryEngine — driver
// ---------------------------------------------------------------------------

/**
 * Issue the two bootstrap-shape tmux commands and resolve when both replies
 * are in. The engine is transport-agnostic: it asks the caller for a
 * `submit(command)` function that writes the command and returns a Promise
 * for its `CommandResult` (the existing `CommandCorrelator.expectCommand()`
 * is the obvious provider — register the slot, then `host.write(cmd + "\n")`,
 * then return the promise).
 *
 * The engine sends both commands first, then awaits both replies — same as
 * the bootstrap coordinator. This preserves the FIFO ordering expected by the
 * correlator and gets pipelined replies from tmux.
 */
export type SubmitCommand = (command: string) => Promise<CommandResult>;

/** Options for `createRequeryEngine`. */
export interface RequeryEngineOptions {
  /**
   * Initial model. Defaults to `emptyModel()` (cold bootstrap). Pass the
   * last-served model for a reconnect that wants minimal deltas instead of
   * a full teardown-and-rebuild.
   */
  readonly initialModel?: SessionModel;

  /**
   * The tmux session name this engine is bound to. Forwarded to
   * `bootstrapCommands(sessionName)` so the queries are scoped to one session
   * (avoiding cross-session contamination on a shared tmux server, mirroring
   * the bootstrap coordinator's behavior). When absent the queries fall back
   * to `-a` (all sessions).
   */
  readonly sessionName?: string;

  /**
   * Function the engine calls to issue each tmux command. The engine writes
   * nothing itself — it asks the caller to submit and returns the awaited
   * `CommandResult`. Concretely, a wiring like
   *
   * ```ts
   * const submit: SubmitCommand = (cmd) => {
   *   const p = correlator.expectCommand();
   *   host.write(cmd + "\n");
   *   return p;
   * };
   * ```
   *
   * keeps the correlator FIFO in sync. The engine deliberately does NOT take
   * a `host` + `correlator` so it stays testable with a synthetic submit.
   */
  readonly submit: SubmitCommand;
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
export function createRequeryEngine(opts: RequeryEngineOptions): RequeryEngine {
  return new RequeryEngineImpl(opts);
}

class RequeryEngineImpl implements RequeryEngine {
  private _model: SessionModel;
  private readonly _sessionName: string | undefined;
  private readonly _submit: SubmitCommand;

  /** True iff `markDirty()` has been called since the last completed cycle. */
  private _dirty = false;

  /**
   * In-flight cycle promise, or null if idle. Concurrent `requery()` calls
   * latch onto this promise; we never run two cycles in parallel.
   */
  private _inFlight: Promise<RequeryResult> | null = null;

  constructor(opts: RequeryEngineOptions) {
    this._model = opts.initialModel ?? emptyModel();
    this._sessionName = opts.sessionName;
    this._submit = opts.submit;
  }

  getModel(): SessionModel {
    return this._model;
  }

  setModel(model: SessionModel): void {
    this._model = model;
  }

  markDirty(): void {
    this._dirty = true;
  }

  isDirty(): boolean {
    return this._dirty;
  }

  requery(): Promise<RequeryResult> {
    if (this._inFlight !== null) return this._inFlight;
    const startModel = this._model;
    this._inFlight = this._runCycles(startModel).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  /**
   * Run requery cycles until one completes clean (replies ok AND no
   * mid-flight dirty), then commit the candidate to `_model` and return
   * cumulative deltas against `startModel`. Bounded by `CYCLE_BUDGET`.
   *
   * Each cycle:
   *   1. Clear the dirty bit (notifications during this cycle re-arm it).
   *   2. Issue both `list-*` commands and await both replies.
   *   3. If either reply is `%error` (regardless of mid-flight dirties):
   *      treat the entire call as failed. Do NOT swap `_model`; re-arm the
   *      dirty bit; return `{ next: startModel, deltas: [], failed: true }`.
   *      The pure-core `requeryDiff` retains the BOOTSTRAP "missing rows =
   *      empty rows" semantic; the engine driver must never wipe the model
   *      on a transient command failure (a teardown burst that the next
   *      successful cycle would have to undo).
   *   4. Parse the replies into a CANDIDATE model held in a local. Do NOT
   *      write `_model` yet.
   *   5. If the dirty bit was set during this cycle: discard the candidate
   *      and loop. Otherwise: commit `_model = candidate`, compute
   *      `diffModel(startModel, _model)`, return success.
   *   6. If the budget is exhausted without a clean cycle: treat as failed
   *      (same shape as step 3). The coalescer's failed-path schedules a
   *      retry at the next ceiling boundary, and the heartbeat guarantees
   *      eventual convergence. Importantly, NO cycle of this call has
   *      observably committed: `_model` is still `startModel`, so future
   *      diffs are computed against the same baseline the caller knows.
   *
   * The accumulated deltas are `diffModel(startModel, _model)`, NOT the
   * concatenation of per-cycle deltas — concatenating would emit
   * pane.opened + pane.closed pairs for any pane that flickered through an
   * intermediate cycle. The diff against the original `startModel` gives
   * the minimal observable wire change, which is what clients want.
   */
  private async _runCycles(startModel: SessionModel): Promise<RequeryResult> {
    for (let attempt = 0; attempt < CYCLE_BUDGET; attempt++) {
      this._dirty = false;
      const [winCmd, paneCmd] = bootstrapCommands(this._sessionName);

      // Issue both commands before awaiting either, mirroring the bootstrap
      // coordinator's FIFO pairing. The correlator the caller wired up
      // matches replies in send order, so the first promise is the windows
      // reply and the second is the panes reply.
      const winPromise = this._submit(winCmd);
      const panePromise = this._submit(paneCmd);

      const [winResult, paneResult] = await Promise.all([winPromise, panePromise]);

      // Steady-state failure policy: if either list-* reply is %error, do
      // NOT clobber the model — re-arm the dirty bit so the coalescer's
      // next edge or heartbeat retries. The candidate (if any) is
      // discarded; _model is still startModel because we never wrote to it.
      if (!winResult.ok || !paneResult.ok) {
        this._dirty = true;
        return { next: startModel, deltas: [], failed: true };
      }

      // Parse into a CANDIDATE model held in a local. Crucially, do NOT
      // write `this._model` yet — that's the commit-only-clean invariant.
      // If a mid-flight notification dirtied us, this candidate is
      // possibly-stale and must be discarded.
      const windowRows = parseWindowsReply(winResult.body);
      const paneRows = parsePanesReply(paneResult.body);
      const candidate = buildInitialModel(windowRows, paneRows);

      if (!this._dirty) {
        // Clean cycle: commit the candidate and serve deltas against the
        // pre-call model. This is the ONLY place `_model` is written.
        this._model = candidate;
        const deltas = diffModel(startModel, candidate);
        return { next: candidate, deltas };
      }
      // Dirty mid-flight: discard candidate, loop (subject to budget).
    }

    // Budget exhausted: sustained notification storm dirtied every cycle.
    // Bound the loop, re-arm dirty so the coalescer retries at the next
    // ceiling boundary, and report failure. `_model` is unchanged from the
    // pre-call snapshot because no cycle ever committed.
    this._dirty = true;
    return { next: startModel, deltas: [], failed: true };
  }
}

/**
 * Maximum convergence cycles per `requery()` call (tc-128.5).
 *
 * Each cycle is ~0.5-1 ms (two pipelined `list-*` round-trips against tmux);
 * 5 comfortably covers the split-burst convergence case (one mid-flight
 * dirty, occasionally two) while bounding storm latency to ~5 ms before the
 * driver gives up and lets the coalescer's 1 Hz ceiling re-pace.
 *
 * Exported only via the module's internal contract; callers should not
 * depend on the exact value. A future change MAY tune this number based on
 * field observation, but the bound itself is structural.
 */
const CYCLE_BUDGET = 5;
