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
 * # Convergence under mid-flight dirties
 *
 * `requery()` issues two commands and awaits both. Between them, tmux may
 * emit notifications signalling further topology changes. The engine exposes
 * `markDirty()`: callers (the dirty-bit coalescer in tc-128.2 — for now the
 * pipeline or tests) flip the bit whenever a topology-relevant notification
 * arrives. If the bit is set when a cycle completes, the engine re-runs the
 * cycle. This converges as long as the dirty-event rate is finite (the rate
 * limiter in tc-128.2 makes that guarantee operational).
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
 * completes, `requery()` immediately runs another cycle and returns the
 * concatenation of all cycles' deltas it consumed. The caller sees one
 * `RequeryResult` whose `next` is the latest model and whose `deltas` are the
 * cumulative wire deltas from the engine's pre-call `prev`.
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
   * Run a requery cycle: issue both commands, parse, diff, swap in the new
   * model. Returns the cumulative deltas from `getModel()` at call time to
   * the final model after the cycle (and any re-runs caused by mid-flight
   * dirties) settles.
   *
   * If a cycle is already in flight, returns the in-flight Promise — the
   * engine never runs two cycles in parallel. Callers that arrive while a
   * cycle is running should treat their `RequeryResult` as "the result of
   * the in-flight cycle plus any re-run it triggers".
   *
   * Concurrency model: the engine uses a single in-flight slot. The
   * `markDirty()` mid-flight case is handled by looping on cycle
   * completion: if the dirty bit is set, run another cycle, accumulate
   * deltas. Once the bit is clear at completion, the slot is freed and the
   * accumulated `RequeryResult` returned. The dirty bit is cleared the
   * MOMENT a cycle starts, so notifications that arrive AFTER both commands
   * are sent but BEFORE both replies arrive correctly cause a re-run.
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
   * Run requery cycles until the dirty bit is clear at completion.
   *
   * Each cycle:
   *   1. Clear the dirty bit (notifications during this cycle re-arm it).
   *   2. Issue both `list-*` commands and await both replies.
   *   3. If either reply is `%error`, treat the cycle as failed: do NOT swap
   *      the model, re-arm the dirty bit so the coalescer retries on the
   *      next edge/heartbeat, and abandon the loop. Returns
   *      `{ next: startModel, deltas: [], failed: true }`. This is the
   *      TL design call (tc-128.2): steady-state `list-*` failure must not
   *      wipe the model — that fallback is the BOOTSTRAP semantic of the
   *      pure `requeryDiff` only.
   *   4. Otherwise compute the fresh model via `buildInitialModel`; swap
   *      `_model` to it.
   *   5. If the bit is set (mid-flight dirty), go to 1; otherwise return.
   *
   * `startModel` is the model the FIRST cycle started from. The accumulated
   * deltas returned to the caller are `diffModel(startModel, finalModel)`,
   * NOT the concatenation of per-cycle deltas — concatenating would emit
   * pane.opened + pane.closed pairs for any pane that flickered through an
   * intermediate cycle. The diff against the original `startModel` gives
   * the minimal observable wire change, which is what clients want.
   */
  private async _runCycles(startModel: SessionModel): Promise<RequeryResult> {
    // Run at least one cycle, then loop as long as the dirty bit is set.
    do {
      this._dirty = false;
      const [winCmd, paneCmd] = bootstrapCommands(this._sessionName);

      // Issue both commands before awaiting either, mirroring the bootstrap
      // coordinator's FIFO pairing. The correlator the caller wired up
      // matches replies in send order, so the first promise is the windows
      // reply and the second is the panes reply.
      const winPromise = this._submit(winCmd);
      const panePromise = this._submit(paneCmd);

      const [winResult, paneResult] = await Promise.all([winPromise, panePromise]);

      // Steady-state failure policy (tc-128.2 TL call): if either list-*
      // reply is %error, do NOT clobber the model — the bootstrap fallback
      // of "missing rows = empty rows" would emit a full teardown delta
      // burst, which is wrong here. Re-arm the dirty bit so the coalescer's
      // next edge or heartbeat retries; the heartbeat guarantees eventual
      // convergence.
      if (!winResult.ok || !paneResult.ok) {
        this._dirty = true;
        return { next: startModel, deltas: [], failed: true };
      }

      // Parse and build the fresh model directly (we don't need the
      // per-cycle deltas because the caller-facing diff is against
      // startModel — see method JSDoc).
      const windowRows = parseWindowsReply(winResult.body);
      const paneRows = parsePanesReply(paneResult.body);
      this._model = buildInitialModel(windowRows, paneRows);
    } while (this._dirty);

    const deltas = diffModel(startModel, this._model);
    return { next: this._model, deltas };
  }
}
