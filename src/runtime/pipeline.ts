/**
 * Runtime pipeline — wire stdout→tokenizer→parser→reducer→live model + deltas (tc-4fo).
 *
 * This is the SPINE of the daemon runtime (E4): it connects a TmuxHost's raw
 * stdout byte stream to the E2 parser (ControlTokenizer + parseNotification +
 * CommandCorrelator) and the E3 state layer (BootstrapCoordinator + reduce),
 * maintaining the live SessionModel and emitting model-change signals.
 *
 * # Data flow
 *
 *   TmuxHost.onData(chunk: Uint8Array)
 *     → ControlTokenizer.push(chunk): ControlToken[]
 *     → route each token:
 *         notification → parseNotification → BootstrapCoordinator.onNotification
 *                        (buffered during bootstrap, applied to reduce() when live)
 *         block-begin/body/end/error → CommandCorrelator.push(token)
 *                        (bootstrap commands resolve via expectCommand() promises)
 *
 * # Bootstrap integration
 *
 *   On start():
 *     1. Register two `expectCommand()` slots on the correlator (FIFO order).
 *     2. Send the two bootstrap commands (list-windows + list-panes) to tmux.
 *     3. Await both command results, delivering them to BootstrapCoordinator.
 *     4. After bootstrap, the coordinator is "live"; subsequent notifications
 *        are applied directly via reduce().
 *
 * # Model change signals
 *
 *   Downstream beads consume:
 *   - `getModel()` — current SessionModel (immutable snapshot).
 *   - `onModelChange(cb)` — called after each model update with (newModel, prevModel).
 *     Returns an unsubscribe function. Fires synchronously within the event loop tick.
 *
 * # %output bytes and PaneBufferStore
 *
 *   The BootstrapCoordinator (and the reduce() ctx) receive a PaneBufferStore.
 *   When the reducer processes an `output` or `extended-output` event it calls
 *   `ctx.buffers.append(paneId, bytes)` — this is the ONLY write to the buffer
 *   store done by the pipeline. tc-fbz (demux) reads from the store to frame
 *   pane byte streams for the wire.
 *
 * # Seam for downstream beads
 *
 *   tc-dv3 (serve-control-plane): consumes `getModel()` + `onModelChange`.
 *   tc-fbz (%output demux): reads PaneBufferStore supplied to createRuntimePipeline.
 *   tc-1ho (flow control): no pipeline changes needed; writes flow-control
 *     commands via host.write() directly; pause/continue events are no-ops in reduce.
 *   tc-kvk (input/resize): writes keystrokes and resize escapes via host.write()
 *     directly; no pipeline changes needed.
 *
 * @module runtime/pipeline
 */

import { ControlTokenizer } from "../parser/tokenizer.js";
import type { ControlToken } from "../parser/tokenizer.js";
import { parseNotification } from "../parser/notifications.js";
import type { NotificationEvent } from "../parser/notifications.js";
import type { NotificationToken } from "../parser/tokenizer.js";
import { CommandCorrelator } from "../parser/correlator.js";
import { BootstrapCoordinator } from "../state/bootstrap.js";
import { createPaneBufferStore } from "../state/scrollback.js";
import { checkInvariants } from "../state/model.js";
import type { SessionModel, InvariantViolation } from "../state/model.js";
import type { PaneBufferStore } from "../state/reducer.js";
import type { SwitchClientOutcome } from "../state/reducer.js";
import type { TmuxHost } from "./tmux-host.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Called after each model update with the new and previous model.
 * Returning an unsubscribe function from `onModelChange` allows cleanup.
 */
export type ModelChangeHandler = (model: SessionModel, prev: SessionModel) => void;

/**
 * Called for every notification token emitted by the pipeline, regardless of
 * whether the notification causes a model change.  This is the seam for
 * components (e.g. FlowController) that must act on %pause / %continue /
 * %extended-output without going through the model.
 *
 * Fired synchronously, inside the same event-loop tick as the notification
 * arrival.  Only called while the pipeline is live (after start() resolves).
 *
 * Returns an unsubscribe function.
 */
export type NotificationHandler = (event: NotificationEvent) => void;

/** Options for `createRuntimePipeline`. */
export interface RuntimePipelineOptions {
  /**
   * Per-pane byte buffer store. Defaults to a new store created with
   * `createPaneBufferStore()`. Callers may supply their own to share it
   * with tc-fbz (demux) or with test assertions.
   */
  buffers?: PaneBufferStore;

  /**
   * If true, check model invariants after every notification event and
   * log violations (does NOT throw). Useful for development / tests.
   * Default: false (no invariant checks in production hot path).
   */
  checkInvariantsOnUpdate?: boolean;

  /**
   * The tmux session name this daemon is attached to.
   * Forwarded to `BootstrapCoordinator` so that after bootstrap the
   * coordinator can resolve `boundSessionId` from the initial model and
   * wire it into the ReducerContext for switch-client narrowing (tc-j9c.7).
   */
  sessionName?: string;

  /**
   * Called when the reducer detects a switch-client drift from the bound
   * session (tc-j9c.7). Forwarded into `BootstrapCoordinator` which places
   * it in the ReducerContext after `boundSessionId` is resolved.
   *
   * "reattach"    — bound session still present.
   * "unavailable" — bound session gone.
   */
  onSwitchClientDetected?: (outcome: SwitchClientOutcome) => void;
}

/**
 * RuntimePipeline — the live tmux→model spine.
 *
 * Lifecycle:
 *   const pipeline = createRuntimePipeline(host, { buffers });
 *   pipeline.onModelChange((model, prev) => { ... });
 *   await pipeline.start();   // issues bootstrap commands, wires onData
 *   // model updates arrive via onModelChange
 *   pipeline.stop();          // unsubscribes from host data
 *   pipeline.getModel();      // always safe to call
 */
export interface RuntimePipeline {
  /**
   * Wire the pipeline to the host: subscribes to `host.onData`, issues the
   * bootstrap commands, and awaits their replies before transitioning to live
   * reduce mode.
   *
   * The host must be started (or start()ing) before calling this.
   * Resolves once the bootstrap command block replies have been delivered to
   * the BootstrapCoordinator — the model is then populated with the initial
   * session/window/pane state and `isLive()` returns true.
   */
  start(): Promise<void>;

  /**
   * Unsubscribe from `host.onData`. Idempotent. Does NOT stop the host.
   * After stop(), the model reflects the last state before stop().
   */
  stop(): void;

  /**
   * The current live SessionModel. Always safe to call; returns the empty
   * model before start() resolves.
   */
  getModel(): SessionModel;

  /**
   * Whether the bootstrap phase has completed and the pipeline is live.
   * False before start() resolves (or if start() hasn't been called).
   */
  isLive(): boolean;

  /**
   * Register a callback for model updates. Called synchronously after each
   * update. Returns an unsubscribe function.
   *
   * Downstream seam:
   *   - tc-dv3 uses this to broadcast deltas to connected clients.
   *   - tc-fbz uses the PaneBufferStore (supplied to createRuntimePipeline)
   *     directly — %output bytes are appended there by reduce().
   */
  onModelChange(handler: ModelChangeHandler): () => void;

  /**
   * Register a callback for every notification event, fired synchronously
   * before the model-change signal (and even for no-op notifications like
   * %pause / %continue that do not change the model).
   *
   * Only called while the pipeline is live (after start() resolves).
   * Returns an unsubscribe function.
   *
   * Use this for components (e.g. FlowController) that need to react to
   * %pause / %continue / %extended-output without going through the model.
   */
  onNotification(handler: NotificationHandler): () => void;

  /**
   * The PaneBufferStore used by this pipeline for %output/%extended-output bytes.
   * tc-fbz reads from this store to frame pane byte content for the wire.
   */
  readonly buffers: PaneBufferStore;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class RuntimePipelineImpl implements RuntimePipeline {
  private readonly _host: TmuxHost;
  private readonly _opts: Required<Omit<RuntimePipelineOptions, "sessionName" | "onSwitchClientDetected">> & {
    sessionName: string | undefined;
    onSwitchClientDetected: ((outcome: SwitchClientOutcome) => void) | undefined;
  };
  private readonly _tokenizer: ControlTokenizer;
  private readonly _correlator: CommandCorrelator;
  private _coordinator: BootstrapCoordinator | null = null;
  private readonly _modelChangeHandlers = new Set<ModelChangeHandler>();
  private readonly _notificationHandlers = new Set<NotificationHandler>();
  private _unsubData: (() => void) | null = null;
  private _started = false;
  private _stopped = false;

  readonly buffers: PaneBufferStore;

  constructor(host: TmuxHost, opts: RuntimePipelineOptions = {}) {
    this._host = host;
    this.buffers = opts.buffers ?? createPaneBufferStore();
    this._opts = {
      buffers: this.buffers,
      checkInvariantsOnUpdate: opts.checkInvariantsOnUpdate ?? false,
      sessionName: opts.sessionName,
      onSwitchClientDetected: opts.onSwitchClientDetected,
    };

    // The correlator routes notification tokens back to _onNotificationToken
    // synchronously (called within the correlator's push() handler).
    this._correlator = new CommandCorrelator({
      onNotification: (token: NotificationToken) => this._onNotificationToken(token),
    });

    this._tokenizer = new ControlTokenizer();
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    // Create the bootstrap coordinator with our buffer store and session binding.
    const coordinatorOpts: import("../state/bootstrap.js").BootstrapCoordinatorOptions = {
      buffers: this.buffers,
      ...(this._opts.sessionName !== undefined ? { sessionName: this._opts.sessionName } : {}),
      ...(this._opts.onSwitchClientDetected !== undefined
        ? { onSwitchClientDetected: this._opts.onSwitchClientDetected }
        : {}),
    };
    const coordinator = new BootstrapCoordinator(coordinatorOpts);
    this._coordinator = coordinator;

    // Register two expectCommand() slots BEFORE sending the bootstrap commands
    // so the FIFO guarantee holds (correlator matches replies in send order).
    const winResultPromise = this._correlator.expectCommand();
    const paneResultPromise = this._correlator.expectCommand();

    // Wire host.onData → tokenizer → correlator (which routes notifications
    // back to _onNotificationToken).
    this._unsubData = this._host.onData((chunk: Uint8Array) => {
      const tokens: ControlToken[] = this._tokenizer.push(chunk);
      for (const token of tokens) {
        this._correlator.push(token);
      }
    });

    // Send bootstrap commands to tmux.
    const [winCmd, paneCmd] = coordinator.bootstrapCommands();
    this._host.write(winCmd + "\n");
    this._host.write(paneCmd + "\n");

    // Await both replies in order (they arrive FIFO per tmux protocol).
    const winResult = await winResultPromise;
    coordinator.onWindowsResult(winResult);

    const paneResult = await paneResultPromise;
    coordinator.onPanesResult(paneResult);

    // After both replies, the coordinator is live. The model now has the
    // initial session/window/pane state from bootstrap + any buffered events.
    // Fire a model-change so downstream beads see the initial snapshot.
    const initialModel = coordinator.getModel();
    this._emitModelChange(initialModel, initialModel /* prev same as next for init */);
  }

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    this._unsubData?.();
    this._unsubData = null;
  }

  getModel(): SessionModel {
    return this._coordinator?.getModel() ?? emptySessionModel();
  }

  isLive(): boolean {
    return this._coordinator?.isLive() ?? false;
  }

  onModelChange(handler: ModelChangeHandler): () => void {
    this._modelChangeHandlers.add(handler);
    return () => {
      this._modelChangeHandlers.delete(handler);
    };
  }

  onNotification(handler: NotificationHandler): () => void {
    this._notificationHandlers.add(handler);
    return () => {
      this._notificationHandlers.delete(handler);
    };
  }

  // -------------------------------------------------------------------------
  // Internal: notification routing
  // -------------------------------------------------------------------------

  /**
   * Called by the CommandCorrelator for every notification token that arrives
   * between (or before/after) command blocks. Parses and feeds the event to
   * the BootstrapCoordinator, which either buffers it (bootstrapping phase) or
   * applies it directly via reduce() (live phase).
   *
   * We capture the model before+after to emit a model-change signal only when
   * the model actually changed (by reference comparison — reduce() returns the
   * same reference on no-ops). During bootstrapping, the coordinator buffers the
   * event and doesn't update the model yet, so prev===next===empty; we skip the
   * signal. Once live, each notification may update the model, and we emit.
   */
  private _onNotificationToken(token: NotificationToken): void {
    const coordinator = this._coordinator;
    if (coordinator === null) return; // start() not yet called — should not happen

    const event = parseNotification(token);
    const prev = coordinator.getModel();
    coordinator.onNotification(event);
    const next = coordinator.getModel();

    // Fire notification subscribers while live — even for no-op notifications
    // like %pause / %continue that don't change the model.  Subscribers such as
    // FlowController need to react to these without going through the model.
    if (coordinator.isLive() && this._notificationHandlers.size > 0) {
      for (const handler of this._notificationHandlers) {
        try {
          handler(event);
        } catch (e) {
          console.warn("[pipeline] notification handler threw:", e);
        }
      }
    }

    // Only emit model-change if something changed and we're in live mode.
    // During bootstrap the coordinator buffers events without updating the
    // model, so prev === next (both are emptyModel()) — no signal needed.
    // After bootstrap transitions to live (replays buffer), the first real
    // update after start() resolves emits the initial model change.
    if (coordinator.isLive() && next !== prev) {
      this._emitModelChange(next, prev);
    }
  }

  private _emitModelChange(model: SessionModel, prev: SessionModel): void {
    if (this._opts.checkInvariantsOnUpdate) {
      const violations: InvariantViolation[] = checkInvariants(model);
      if (violations.length > 0) {
        console.warn("[pipeline] invariant violations after model update:", violations);
      }
    }
    for (const handler of this._modelChangeHandlers) {
      try {
        handler(model, prev);
      } catch (e) {
        console.warn("[pipeline] model-change handler threw:", e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lazy empty model (avoid importing emptyModel at module load time if unused)
// ---------------------------------------------------------------------------

import { emptyModel } from "../state/model.js";

function emptySessionModel(): SessionModel {
  return emptyModel();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `RuntimePipeline` that connects a `TmuxHost`'s stdout bytes to the
 * E2 parser and E3 state layer.
 *
 * The pipeline is not yet started. Call `pipeline.start()` after (or while)
 * calling `host.start()`.
 *
 * @param host - A TmuxHost (already created; start() may or may not have been called).
 * @param opts - Optional options (shared buffers, invariant checking).
 * @returns A RuntimePipeline whose `start()` issues bootstrap commands and
 *          wires the data path.
 *
 * @example
 * ```ts
 * const host = createTmuxHost({ socketName: "myapp" });
 * const buffers = createPaneBufferStore();
 * const pipeline = createRuntimePipeline(host, { buffers });
 *
 * pipeline.onModelChange((model, prev) => {
 *   const deltas = diffModel(prev, model);
 *   // broadcast deltas to clients (tc-dv3)
 * });
 *
 * await host.start();
 * await pipeline.start();  // bootstrap completes; pipeline is live
 *
 * // Ongoing: model updates arrive via onModelChange
 * // Pane bytes: pipeline.buffers.getContents(paneId) (read by tc-fbz)
 *
 * // Shutdown:
 * pipeline.stop();
 * await host.stop();
 * ```
 */
export function createRuntimePipeline(
  host: TmuxHost,
  opts?: RuntimePipelineOptions,
): RuntimePipeline {
  return new RuntimePipelineImpl(host, opts);
}
