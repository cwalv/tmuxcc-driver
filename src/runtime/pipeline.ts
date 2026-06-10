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
import type { CommandResult } from "../parser/correlator.js";
import { BootstrapCoordinator } from "../state/bootstrap.js";
import { createPaneBufferStore } from "../state/scrollback.js";
import { checkInvariants, windowId } from "../state/model.js";
import type { SessionModel, InvariantViolation } from "../state/model.js";
import type { PaneBufferStore } from "../state/reducer.js";
import type { SwitchClientOutcome } from "../state/reducer.js";
import type { TmuxHost } from "./tmux-host.js";
import { setOption, refreshClientSubscribeWindows } from "../parser/commands.js";

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

  /**
   * Inject a synthetic (internal) NotificationEvent directly into the live
   * pipeline, bypassing the tmux wire.
   *
   * Used by input-path.ts for the optimistic-update path (tc-7xv.12):
   * after sending a tmux command, callers inject the expected model change so
   * the model and delta stream are updated immediately — without waiting for a
   * tmux notification that may never arrive.
   *
   * No-op before start() resolves (pipeline not yet live).
   * Fires onModelChange if the injected event changes the model.
   */
  injectNotification(event: NotificationEvent): void;

  /**
   * Register a pending tmux command slot on the underlying CommandCorrelator
   * (tc-7xv.37).
   *
   * Callers issuing a tmux command directly (bypassing the bootstrap path)
   * should call `expectCommand()` BEFORE sending the bytes so that the
   * correlator's FIFO queue stays in sync with tmux's reply order.  The
   * returned Promise resolves when the matching `%end` or `%error` block is
   * fully received: `result.ok === true` on `%end`, `false` on `%error`.
   *
   * Used by input-path.ts to observe set-option command outcomes for the
   * optimistic-update error-reversal pattern.
   *
   * Note: the pipeline does not write the command itself — that remains the
   * caller's responsibility (e.g. via `host.write()` from input-path).
   */
  expectCommand(): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Subscription name constant
// ---------------------------------------------------------------------------

/**
 * Name of the tmux control-mode subscription used to detect external
 * synchronize-panes changes (tc-7xv.28).
 *
 * Registered via `refresh-client -B 'sync-watch:@*:#{?synchronize-panes,1,0}'`
 * after bootstrap. When `%subscription-changed sync-watch …` arrives, the
 * pipeline injects an `internal:set-window-sync` event to update the model.
 */
const SYNC_WATCH_SUBSCRIPTION_NAME = "sync-watch";

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

    // tc-95lue §3.4: Enable monitor-activity on all windows (global window
    // default) so that tmux tracks pane activity.  This is a fire-and-forget
    // command — we do not need to await the reply block; the option takes
    // effect immediately and the %activity notification is available from this
    // point on.  Using `-wg` (global window option) ensures every existing and
    // future window in the session gets the option without per-window setup.
    //
    // NOTE: VS Code's tab-activity affordance (italicized name / dot) is
    // triggered automatically by `onDidWrite` firing on a non-focused
    // Pseudoterminal — it does NOT require monitor-activity.  Enabling
    // monitor-activity here satisfies acceptance criterion (1) and ensures
    // tmux-level activity tracking is on in case future features rely on it.
    if (!this._stopped) {
      this._host.write(setOption("window-global", "monitor-activity", "on") + "\n");
    }

    // tc-7xv.28: register a per-window subscription so the daemon detects
    // synchronize-panes changes made by external tmux clients (e.g.
    // `tmux set-option -wt @N synchronize-panes on`).
    //
    // tmux 3.4 does NOT emit %window-option-changed for synchronize-panes
    // (confirmed by tc-7xv.12 investigation).  The subscription mechanism
    // (`refresh-client -B`) polls the format string on a 1-second timer and
    // delivers %subscription-changed only when the value changes — giving us
    // reactive detection with at most ~1 s latency, at zero polling overhead
    // when sync state is stable.
    //
    // _onNotificationToken handles "subscription-changed" events for the
    // SYNC_WATCH_SUBSCRIPTION_NAME subscription name by injecting an
    // `internal:set-window-sync` synthetic event into the pipeline.
    if (!this._stopped) {
      this._host.write(
        refreshClientSubscribeWindows(
          SYNC_WATCH_SUBSCRIPTION_NAME,
          "#{?synchronize-panes,1,0}",
        ) + "\n",
      );
    }

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

  injectNotification(event: NotificationEvent): void {
    const coordinator = this._coordinator;
    // No-op if pipeline not yet live (start() not called or bootstrap incomplete).
    if (coordinator === null || !coordinator.isLive()) return;

    const prev = coordinator.getModel();
    coordinator.onNotification(event);
    const next = coordinator.getModel();

    if (next !== prev) {
      this._emitModelChange(next, prev);
    }
  }

  expectCommand(): Promise<CommandResult> {
    // Delegates to the underlying correlator; safe to call before start()
    // (the slot will be filled when the matching %begin/%end arrives, though
    // in practice callers issue this only after start() resolves).
    return this._correlator.expectCommand();
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

    // tc-7xv.28: intercept %subscription-changed for the sync-watch subscription
    // BEFORE feeding it to the coordinator/reducer, so we can inject the correct
    // synthetic event. The reducer treats "subscription-changed" as a no-op; we
    // produce an `internal:set-window-sync` instead, which the reducer handles.
    if (
      coordinator.isLive() &&
      event.kind === "subscription-changed" &&
      event.name === SYNC_WATCH_SUBSCRIPTION_NAME &&
      event.windowId !== null
    ) {
      this._handleSyncWatchNotification(event.windowId, event.value);
      // Also fire notification subscribers for observability (e.g. tests).
      if (this._notificationHandlers.size > 0) {
        for (const handler of this._notificationHandlers) {
          try {
            handler(event);
          } catch (e) {
            console.warn("[pipeline] notification handler threw:", e);
          }
        }
      }
      return; // Skip the generic coordinator.onNotification path for this event.
    }

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

    // tc-fx4: %window-add carries NO layout, and tmux (verified on 3.4) does
    // NOT follow up with a %layout-change for a freshly created window — the
    // notification sequence for `new-window` is just:
    //
    //   %window-add @N
    //   %session-window-changed $S @N
    //   %sessions-changed
    //
    // Without intervention the new window registers with ZERO panes, no
    // pane.opened delta ever reaches clients, and a `tmuxcc.newWindow` looks
    // like a silent no-op (the original tc-fx4 bug).  Fix: query the new
    // window's layout explicitly and synthesize the %layout-change line the
    // reducer already knows how to reconcile (handleLayoutChange adds the
    // missing panes → pane.opened deltas flow to clients).
    //
    // Live phase only: during bootstrap the list-windows/list-panes replies
    // carry the layout for every existing window.
    //
    // tc-3y8.9: NEVER reconcile %unlinked-window-add — it announces a window
    // of ANOTHER session on the same tmux server (the reducer ignores it).
    // Reconciling it would graft the other session's layout/panes onto our
    // model (`list-windows -a` is server-wide), surfacing phantom panes.
    if (coordinator.isLive() && event.kind === "window-add" && !event.unlinked) {
      this._reconcileNewWindowLayout(event.windowId);
    }
  }

  /**
   * tc-fx4: fetch the layout AND name of a newly-added window and inject
   * synthetic `%window-renamed` + `%layout-change` notifications so the
   * reducer registers the window's name and pane(s).
   *
   * Uses the documented expectCommand()-before-write pattern (same FIFO
   * pairing as bootstrap and input-path's optimistic updates; safe because
   * the slot registration and the write happen synchronously back-to-back on
   * the single JS event loop).
   *
   * `list-windows -a` (rather than a `-t @N` targeted form) mirrors the
   * bootstrap query shape and is immune to target-resolution quirks; we pick
   * the line for our window from the reply.
   *
   * Why the name too (tc-3y8.9): %window-add carries no name and the reducer
   * creates the window with `name: ""`.  tmux only sends %window-renamed
   * later, when automatic-rename kicks in — so a quick-pick / tab label
   * rendered right after the pane.opened delta shows a blank window name
   * ("1:  · 1 pane").  The reconcile reply already contains the authoritative
   * name; injecting it closes the gap.  Idempotent with a real
   * %window-renamed arriving afterwards (last write wins, same value).
   *
   * Idempotent with a real %layout-change arriving for the same window (e.g.
   * a later split): handleLayoutChange reconciles authoritatively, so a
   * duplicate apply is a no-op.
   *
   * @param tmuxWindowId  Numeric tmux window id from the %window-add line.
   */
  private _reconcileNewWindowLayout(tmuxWindowId: number): void {
    const resultPromise = this._correlator.expectCommand();
    this._host.write(`list-windows -a -F "#{window_id}\t#{window_name}\t#{window_layout}"\n`);

    void resultPromise.then(
      (result: CommandResult) => {
        if (this._stopped || !result.ok) return;
        const text = new TextDecoder().decode(result.body);
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed === "") continue;
          // Three tab-separated fields.  The layout never contains a tab, so
          // split at the FIRST tab (id|rest) and the LAST tab (name|layout) —
          // robust even if the window name itself contains a tab.
          const firstTab = trimmed.indexOf("\t");
          const lastTab = trimmed.lastIndexOf("\t");
          if (firstTab === -1 || lastTab === firstTab) continue;
          const winIdStr = trimmed.slice(0, firstTab);
          const nameStr = trimmed.slice(firstTab + 1, lastTab);
          const layoutStr = trimmed.slice(lastTab + 1).trim();
          if (winIdStr !== `@${tmuxWindowId}` || layoutStr === "") continue;
          // Name first so window.renamed precedes the pane.opened delta —
          // a client rendering on pane.opened already sees the final name.
          if (nameStr !== "") {
            this.injectNotification({
              kind: "window-renamed",
              windowId: tmuxWindowId,
              name: nameStr,
              unlinked: false,
            });
          }
          // Synthesize the exact raw line shape handleLayoutChange parses:
          //   %layout-change @<winId> <layoutString>\n
          const rawLine = new TextEncoder().encode(
            `%layout-change @${tmuxWindowId} ${layoutStr}\n`,
          );
          this.injectNotification({ kind: "unknown", keyword: "layout-change", rawLine });
          return;
        }
        // Window vanished between %window-add and the reply (e.g. instantly
        // killed) — nothing to reconcile; %window-close handles removal.
      },
      (err: unknown) => {
        console.warn("[pipeline] tc-fx4 window-add layout reconcile failed:", err);
      },
    );
  }

  /**
   * Handle a %subscription-changed event for the sync-watch subscription
   * (tc-7xv.28).
   *
   * @param tmuxWindowId  The numeric tmux window id from the notification header.
   * @param value         The formatted value: "1" (on) or "0" (off).
   */
  private _handleSyncWatchNotification(tmuxWindowId: number, value: string): void {
    const on = value.trim() === "1";
    const wid = windowId("w" + tmuxWindowId);
    this.injectNotification({ kind: "internal:set-window-sync", windowId: wid, on });
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
