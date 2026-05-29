/**
 * Render-hook interface — the headless seam between the client core and any renderer.
 *
 * # Architecture
 *
 * The render-hook is a BIDIRECTIONAL seam:
 *
 *   Client → Renderer (push):
 *     The client calls RenderHook callbacks when pane/window/layout/focus state
 *     changes and when raw output bytes arrive for a pane.  The renderer
 *     IMPLEMENTS RenderHook.  Every callback is fire-and-forget from the
 *     client's perspective.
 *
 *   Renderer → Client (pull):
 *     The renderer holds a ClientController and calls sendInput / resizePane
 *     to forward user input and viewport resize events to the daemon.
 *
 * Usage (from the renderer side):
 * ```ts
 * const hook: RenderHook = myRendererImpl;
 * const controller: ClientController = { sendInput, resizePane };
 * const driver = createRenderHookDriver(hook, modelSource, byteSource, inputSink);
 * const stop = driver.start();   // begins observing; calls hook immediately with
 *                                // current panes / layout / focus
 * // ... later:
 * stop();                        // detach from model + byte sources
 * ```
 *
 * # HEADLESS INVARIANT
 *
 * This file MUST NOT import or reference:
 *   - DOM APIs (window, document, HTMLElement, …)
 *   - VS Code APIs (vscode.*, Pseudoterminal, …)
 *   - Any host-specific type
 *   - tmux internal vocabulary (%output, %begin/%end, layout strings, …)
 *
 * E6 (tmuxcc-vscode) IMPLEMENTS RenderHook using VS Code APIs.  That code
 * lives in tmuxcc-vscode, not here.
 *
 * # Concurrent sibling integration (tc-eots / tc-3fb / tc-fpf)
 *
 * This file defines ABSTRACT local interfaces for the driver's dependencies so
 * it can be compiled and tested independently of concurrent sibling beads:
 *
 *   ModelSource  ← tc-eots (mirror.ts): getModel() + onModelChange()
 *   ByteSource   ← tc-3fb (pane-stream.ts): onPaneOutput()
 *   InputSink    ← tc-fpf (input.ts): sendInput() + resizePane()
 *
 * Integration wiring (TL action at sync time):
 *   modelSource → the ClientMirror exported by tc-eots' mirror.ts
 *   byteSource  → the PaneStream / consumer exported by tc-3fb' pane-stream.ts
 *   inputSink   → the InputApi exported by tc-fpf's input.ts
 *
 * The driver uses only these abstract shapes, so no import change is needed in
 * render-hook.ts; the TL wires the concrete instances at call-site (wherever
 * createRenderHookDriver is called from the top-level client entry point).
 */

import type { PaneId, WindowId, SessionId, WindowLayout, PaneMode } from "@tmuxcc/daemon";

// ---------------------------------------------------------------------------
// Re-export wire primitives that renderers reference (convenience)
// ---------------------------------------------------------------------------

export type { PaneId, WindowId, SessionId, WindowLayout, PaneMode };

// ---------------------------------------------------------------------------
// Value types used in callbacks
// ---------------------------------------------------------------------------

/**
 * Snapshot of a single pane's identity and geometry at the time of an event.
 * Passed to onPaneOpened and onPaneResized callbacks.
 */
export interface PaneInfo {
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
  /** Width in terminal columns. */
  readonly cols: number;
  /** Height in terminal rows. */
  readonly rows: number;
  /**
   * True if this pane is the focused pane at the moment the event fires.
   * Renderers MAY use this to avoid a separate focus event on startup.
   */
  readonly active: boolean;
}

/**
 * Current focus state: which pane, window, and session are active.
 * All three are null when no pane is focused (e.g. no sessions exist).
 */
export interface FocusInfo {
  readonly paneId: PaneId | null;
  readonly windowId: WindowId | null;
  readonly sessionId: SessionId | null;
}

/**
 * Snapshot of a window's identity at the time of an event.
 */
export interface WindowInfo {
  readonly windowId: WindowId;
  readonly sessionId: SessionId;
  readonly name: string;
  /** True if this window is the active window in its session. */
  readonly active: boolean;
}

// ---------------------------------------------------------------------------
// RenderHook — the contract a renderer implements
// ---------------------------------------------------------------------------

/**
 * The contract a renderer (VS Code / web / console) implements.
 *
 * The CLIENT calls these callbacks.  The renderer is responsible for
 * translating these events into host-specific output (VS Code terminal
 * panes, DOM nodes, console output, …).
 *
 * ## Callback contract
 *
 * - All callbacks are SYNCHRONOUS from the driver's perspective: the driver
 *   calls them inline and does not await them.  Renderers that need async
 *   work must schedule it themselves.
 * - The driver serialises all calls on the JavaScript event loop; renderers
 *   need not be thread-safe, but they must not block.
 * - onPaneOutput may be called at high frequency (every byte chunk from the
 *   pane).  Renderers should buffer/batch if heavy work is triggered.
 *
 * ## Method groups
 *
 * Pane lifecycle:
 *   onPaneOpened, onPaneClosed, onPaneResized, onPaneModeChanged
 *
 * Output bytes:
 *   onPaneOutput
 *
 * Window lifecycle:
 *   onWindowAdded, onWindowClosed, onWindowRenamed
 *
 * Layout:
 *   onLayoutChanged
 *
 * Focus:
 *   onFocusChanged
 *
 * Connection:
 *   onConnected, onDisconnected
 *
 * ## NO host vocabulary
 *
 * No DOM, no VS Code, no Pseudoterminal, no tmux.  If you're adding a method
 * that references a host type, it belongs in E6 (or E7), not here.
 */
export interface RenderHook {
  // ── Pane lifecycle ──────────────────────────────────────────────────────

  /**
   * A new pane appeared (new window, split, or daemon snapshot replay).
   *
   * Called once per pane on initial snapshot load (during driver.start()) and
   * thereafter whenever a pane.opened event arrives.
   *
   * Renderers should allocate any pane-local state (e.g. a terminal emulator
   * instance) here.  The pane is guaranteed not to have been seen before; the
   * driver tracks known pane ids and suppresses duplicates.
   */
  onPaneOpened(pane: PaneInfo): void;

  /**
   * A pane was closed (its process exited or it was killed).
   *
   * Called when a pane.closed event arrives.  After this, no further
   * onPaneOutput / onPaneResized callbacks will fire for this paneId.
   *
   * Renderers should destroy pane-local state here.
   */
  onPaneClosed(paneId: PaneId): void;

  /**
   * A pane's dimensions changed.
   *
   * Called when a pane.resized event confirms the daemon applied a resize.
   * This is the authoritative size; renderers should update their viewport.
   */
  onPaneResized(paneId: PaneId, cols: number, rows: number): void;

  /**
   * A pane entered or left a mode (normal ↔ copy ↔ view, or future modes).
   *
   * Renderers may use this to show a status badge or change input handling.
   * Unknown mode strings must be tolerated (treated as opaque).
   */
  onPaneModeChanged(paneId: PaneId, mode: PaneMode): void;

  // ── Output bytes ────────────────────────────────────────────────────────

  /**
   * Raw output bytes arrived from a pane.
   *
   * `bytes` is a Uint8Array of raw terminal bytes — NOT a decoded string.
   * The data may contain arbitrary byte values (including non-UTF-8 sequences,
   * ANSI escape sequences, control characters, etc.).  The renderer (E6) feeds
   * this to a terminal emulator (e.g. xterm.js write()).
   *
   * PERFORMANCE: this is the hot path.  The driver calls this for every chunk
   * received from the byte source.  Renderers must handle it efficiently.
   *
   * NOTE: this callback may be called BEFORE onPaneOpened if the first byte
   * chunk races the lifecycle event (daemon implementation detail).  Renderers
   * should tolerate this gracefully (buffer or discard).
   */
  onPaneOutput(paneId: PaneId, bytes: Uint8Array): void;

  // ── Window lifecycle ────────────────────────────────────────────────────

  /**
   * A new window was added to a session.
   *
   * Called once per window during snapshot replay and for each window.added
   * event thereafter.  Renderers that track tab/window UI should create a new
   * entry here.
   */
  onWindowAdded(window: WindowInfo): void;

  /**
   * A window was closed (all its panes exited or it was killed).
   *
   * Renderers should remove the window's UI entry here.
   */
  onWindowClosed(windowId: WindowId): void;

  /**
   * A window was renamed.
   *
   * Renderers should update any displayed window name / tab label.
   */
  onWindowRenamed(windowId: WindowId, newName: string): void;

  // ── Layout ──────────────────────────────────────────────────────────────

  /**
   * The layout of a window changed (panes added, removed, or resized).
   *
   * `layout` is the complete current geometry as a structured tree (see
   * WindowLayout in @tmuxcc/daemon).  Renderers should apply the layout
   * ATOMICALLY: update all pane rects in one pass to avoid flicker.
   *
   * This callback fires both from snapshot replay (one call per window that
   * has a non-trivial layout) and from layout.updated events.
   */
  onLayoutChanged(windowId: WindowId, layout: WindowLayout): void;

  // ── Focus ───────────────────────────────────────────────────────────────

  /**
   * The active (focused) pane changed.
   *
   * `focus.paneId` is null when no pane is focused (e.g. no sessions).
   * Renderers should update any focus indicator / cursor highlight.
   *
   * Called once during driver.start() with the current focus state and
   * thereafter for each focus.changed event.
   */
  onFocusChanged(focus: FocusInfo): void;

  // ── Connection ──────────────────────────────────────────────────────────

  /**
   * The client successfully connected to the daemon and the initial snapshot
   * has been applied.
   *
   * Fired once at the start of driver.start(), AFTER onPaneOpened /
   * onWindowAdded / onLayoutChanged / onFocusChanged have been called for all
   * entities in the snapshot.  Renderers may use this to hide a loading UI.
   */
  onConnected(): void;

  /**
   * The connection to the daemon was lost (clean close or error).
   *
   * `reason` is a human-readable string for display/logging.  After this
   * callback no further pane/window/layout/focus/output callbacks will fire
   * until the driver is restarted.
   */
  onDisconnected(reason: string): void;
}

// ---------------------------------------------------------------------------
// ClientController — renderer → client input surface
// ---------------------------------------------------------------------------

/**
 * The handle the renderer uses to send input and resize requests toward the
 * daemon.  The renderer CALLS these methods; the client IMPLEMENTS them.
 *
 * Handed to the renderer alongside the driver (e.g. returned from
 * createRenderHookDriver alongside a stop function, or bundled in a
 * RenderSession object).
 *
 * Integration wiring: at call-site the concrete implementation delegates to
 * tc-fpf's InputApi (sendInput / resizePane methods).
 */
export interface ClientController {
  /**
   * Send text/key input to a pane.
   *
   * `data` is a UTF-8 string.  The client forwards it to the daemon's input
   * message, which writes bytes directly to the pane's pty.  Special keys
   * (escape sequences, function keys) should be pre-encoded as their byte
   * sequences before calling sendInput.
   */
  sendInput(paneId: PaneId, data: string): void;

  /**
   * Notify the daemon that the renderer's viewport for a pane changed size.
   *
   * Called when the host UI resizes (e.g. VS Code panel resized).  The daemon
   * applies the resize to tmux and confirms with a pane.resized event, which
   * the driver will translate into an onPaneResized callback.
   */
  resizePane(paneId: PaneId, cols: number, rows: number): void;
}

// ---------------------------------------------------------------------------
// Abstract source/sink interfaces — driver dependencies
// ---------------------------------------------------------------------------
//
// These are LOCAL minimal interfaces that the driver is parameterised over.
// They exist so the driver compiles + tests independently of the concurrent
// sibling beads (tc-eots / tc-3fb / tc-fpf).
//
// TL integration wiring at sync time:
//   ModelSource  → ClientMirror from tc-eots (mirror.ts)
//     getModel() → mirror.getModel()
//     onModelChange(cb) → mirror.onModelChange(cb); returns unsubscribe fn
//
//   ByteSource   → PaneStream from tc-3fb (pane-stream.ts)
//     onPaneOutput(paneId, cb) → stream.onPaneOutput(paneId, cb); returns unsubscribe
//
//   InputSink    → InputApi from tc-fpf (input.ts)
//     sendInput(paneId, data) → inputApi.sendInput(paneId, data)
//     resizePane(paneId, cols, rows) → inputApi.resizePane(paneId, cols, rows)

/**
 * The current client model: a flat snapshot of all sessions, windows, panes,
 * and focus state.  The driver reads this on every model-change tick to diff
 * the previous state and derive lifecycle events for the renderer.
 *
 * Integration: this is a projection of what tc-eots' ClientMirror exposes.
 * The mirror's getModel() should return a value compatible with ClientModel.
 */
export interface ClientModel {
  /** All panes known to the client, keyed by PaneId string. */
  readonly panes: ReadonlyMap<PaneId, PaneInfo>;
  /** All windows known to the client, keyed by WindowId string. */
  readonly windows: ReadonlyMap<WindowId, WindowInfo>;
  /** Current focus state. */
  readonly focus: FocusInfo;
}

/**
 * Abstract model source — provided by tc-eots' mirror at integration time.
 *
 * @remarks
 * The driver calls getModel() synchronously on each model-change tick to
 * obtain the latest state.  onModelChange registers a listener that fires
 * whenever the mirror applies a snapshot or delta; the returned function
 * removes the listener.
 */
export interface ModelSource {
  /** Returns the current model state (snapshot of all panes/windows/focus). */
  getModel(): ClientModel;
  /**
   * Register a callback to be invoked whenever the model changes.
   * Returns an unsubscribe function; call it to stop receiving notifications.
   */
  onModelChange(callback: () => void): () => void;
}

/**
 * Abstract byte source — provided by tc-3fb's pane-stream at integration time.
 *
 * @remarks
 * The driver calls onPaneOutput for EVERY pane that exists at driver start,
 * and re-subscribes when new panes open.  The returned function unsubscribes.
 * If the sibling supports global subscription (all panes through one callback),
 * the TL should adapt the interface at the call-site.
 */
export interface ByteSource {
  /**
   * Subscribe to raw output bytes for a specific pane.
   * Returns an unsubscribe function.
   */
  onPaneOutput(paneId: PaneId, callback: (bytes: Uint8Array) => void): () => void;
}

/**
 * Abstract input sink — provided by tc-fpf's InputApi at integration time.
 *
 * @remarks
 * The driver builds a ClientController whose methods delegate to this sink.
 * At integration, swap the local fake (used in tests) for the real InputApi.
 */
export interface InputSink {
  /** Forward text/key input to a pane. */
  sendInput(paneId: PaneId, data: string): void;
  /** Forward a resize notification for a pane. */
  resizePane(paneId: PaneId, cols: number, rows: number): void;
}

// ---------------------------------------------------------------------------
// RenderSession — the combined handle returned to a renderer
// ---------------------------------------------------------------------------

/**
 * The complete handle vended to a renderer by createRenderHookDriver.
 *
 * `controller` — for renderer→client input/resize.
 * `stop`       — call to detach from all model/byte sources and stop
 *                receiving callbacks.  Idempotent.
 */
export interface RenderSession {
  readonly controller: ClientController;
  /** Stop observing model + byte sources.  Safe to call more than once. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// createRenderHookDriver — the driver implementation
// ---------------------------------------------------------------------------

/**
 * Create a render-hook driver that translates model changes and byte events
 * into RenderHook callbacks.
 *
 * The driver:
 *   1. On start(), reads the current model via modelSource.getModel() and
 *      calls onWindowAdded / onPaneOpened / onLayoutChanged for every entity
 *      in the snapshot, then onFocusChanged, then onConnected.
 *   2. Subscribes to modelSource.onModelChange and diffs prev/next model on
 *      each tick to derive onPaneOpened / onPaneClosed / onPaneResized /
 *      onWindowAdded / onWindowClosed / onWindowRenamed / onLayoutChanged /
 *      onFocusChanged callbacks.
 *   3. Subscribes to byteSource.onPaneOutput for each known pane (and adds
 *      new subscriptions when onPaneOpened fires) and calls hook.onPaneOutput.
 *   4. Builds a ClientController that delegates to inputSink.
 *
 * Model diff strategy (step 2):
 *   - Panes added   (in next but not prev) → onPaneOpened
 *   - Panes removed (in prev but not next) → onPaneClosed
 *   - Panes resized (same id, different cols/rows) → onPaneResized
 *   - Windows added / removed / renamed — same pattern
 *   - Layout: the driver compares the layout from the model's windows; if the
 *     layout field changed for a window, onLayoutChanged fires.  (The sibling
 *     tc-eots may expose richer layout info; the TL can specialise this at
 *     integration if needed.)
 *   - Focus changed → onFocusChanged (compare prev.focus vs next.focus)
 *
 * @param hook        - Renderer implementation of RenderHook.
 * @param modelSource - Abstract model source (see ModelSource).
 * @param byteSource  - Abstract byte source (see ByteSource).
 * @param inputSink   - Abstract input sink (see InputSink).
 * @returns           RenderSession with controller + stop().
 */
export function createRenderHookDriver(
  hook: RenderHook,
  modelSource: ModelSource,
  byteSource: ByteSource,
  inputSink: InputSink,
): { start(): RenderSession } {
  return {
    start(): RenderSession {
      // Track previously-seen model to diff against.
      let prevModel: ClientModel = {
        panes: new Map(),
        windows: new Map(),
        focus: { paneId: null, windowId: null, sessionId: null },
      };

      // Byte-source unsubscribe functions keyed by PaneId string.
      const byteUnsubs = new Map<string, () => void>();

      // Whether the driver has been stopped.
      let stopped = false;

      // ── Byte subscription helper ─────────────────────────────────────────

      function subscribeBytes(paneId: PaneId): void {
        if (byteUnsubs.has(paneId)) return; // already subscribed
        const unsub = byteSource.onPaneOutput(paneId, (bytes) => {
          if (!stopped) hook.onPaneOutput(paneId, bytes);
        });
        byteUnsubs.set(paneId, unsub);
      }

      function unsubscribeBytes(paneId: PaneId): void {
        const unsub = byteUnsubs.get(paneId);
        if (unsub !== undefined) {
          unsub();
          byteUnsubs.delete(paneId);
        }
      }

      // ── Model diff ───────────────────────────────────────────────────────

      function applyModelDiff(next: ClientModel): void {
        const prev = prevModel;

        // Windows: added / removed / renamed
        for (const [wid, win] of next.windows) {
          const prevWin = prev.windows.get(wid);
          if (prevWin === undefined) {
            hook.onWindowAdded(win);
          } else if (prevWin.name !== win.name) {
            hook.onWindowRenamed(wid, win.name);
          }
          // Layout: compare WindowLayout from PaneInfo — if layout changed for
          // this window, fire onLayoutChanged.  The driver does not store layout
          // separately; tc-eots may expose it on the model.  For now the driver
          // relies on the model including layout via the windows map.
          // (The TL may enrich WindowInfo with layout at integration.)
        }
        for (const [wid] of prev.windows) {
          if (!next.windows.has(wid)) {
            hook.onWindowClosed(wid);
          }
        }

        // Panes: added / removed / resized
        for (const [pid, pane] of next.panes) {
          const prevPane = prev.panes.get(pid);
          if (prevPane === undefined) {
            hook.onPaneOpened(pane);
            subscribeBytes(pid);
          } else if (prevPane.cols !== pane.cols || prevPane.rows !== pane.rows) {
            hook.onPaneResized(pid, pane.cols, pane.rows);
          }
        }
        for (const [pid] of prev.panes) {
          if (!next.panes.has(pid)) {
            hook.onPaneClosed(pid);
            unsubscribeBytes(pid);
          }
        }

        // Focus
        const pf = prev.focus;
        const nf = next.focus;
        if (pf.paneId !== nf.paneId || pf.windowId !== nf.windowId || pf.sessionId !== nf.sessionId) {
          hook.onFocusChanged(nf);
        }

        prevModel = next;
      }

      // ── Initial snapshot replay ──────────────────────────────────────────

      const initial = modelSource.getModel();

      // Windows first (panes are children of windows).
      for (const win of initial.windows.values()) {
        hook.onWindowAdded(win);
      }

      // Panes + byte subscriptions.
      for (const [pid, pane] of initial.panes) {
        hook.onPaneOpened(pane);
        subscribeBytes(pid);
      }

      // Focus.
      hook.onFocusChanged(initial.focus);

      // Signal connected.
      hook.onConnected();

      prevModel = initial;

      // ── Subscribe to model changes ───────────────────────────────────────

      const unsubModel = modelSource.onModelChange(() => {
        if (stopped) return;
        applyModelDiff(modelSource.getModel());
      });

      // ── Controller ───────────────────────────────────────────────────────

      const controller: ClientController = {
        sendInput(paneId: PaneId, data: string): void {
          inputSink.sendInput(paneId, data);
        },
        resizePane(paneId: PaneId, cols: number, rows: number): void {
          inputSink.resizePane(paneId, cols, rows);
        },
      };

      // ── Stop ─────────────────────────────────────────────────────────────

      function stop(): void {
        if (stopped) return;
        stopped = true;
        unsubModel();
        for (const unsub of byteUnsubs.values()) {
          unsub();
        }
        byteUnsubs.clear();
        hook.onDisconnected("driver stopped");
      }

      return { controller, stop };
    },
  };
}

// ---------------------------------------------------------------------------
// Reference implementations
// ---------------------------------------------------------------------------

/**
 * A no-op RenderHook.  All callbacks are no-ops.
 *
 * Use as a template for new renderer implementations or as a base to extend in
 * tests where only a subset of hooks need to be observed.
 */
export const NoOpRenderHook: RenderHook = {
  onPaneOpened(_pane: PaneInfo): void {},
  onPaneClosed(_paneId: PaneId): void {},
  onPaneResized(_paneId: PaneId, _cols: number, _rows: number): void {},
  onPaneModeChanged(_paneId: PaneId, _mode: PaneMode): void {},
  onPaneOutput(_paneId: PaneId, _bytes: Uint8Array): void {},
  onWindowAdded(_window: WindowInfo): void {},
  onWindowClosed(_windowId: WindowId): void {},
  onWindowRenamed(_windowId: WindowId, _newName: string): void {},
  onLayoutChanged(_windowId: WindowId, _layout: WindowLayout): void {},
  onFocusChanged(_focus: FocusInfo): void {},
  onConnected(): void {},
  onDisconnected(_reason: string): void {},
};

/**
 * A recording RenderHook — captures every call in an ordered log.
 *
 * Useful for:
 *   - Tests: assert the exact sequence and arguments of callbacks.
 *   - Debugging: log all events to the console.
 *   - E6 development: verify the driver fires the right events before wiring
 *     VS Code APIs.
 *
 * Each entry is a discriminated record with a `type` matching the method name.
 */
export type RenderHookCall =
  | { type: "paneOpened"; pane: PaneInfo }
  | { type: "paneClosed"; paneId: PaneId }
  | { type: "paneResized"; paneId: PaneId; cols: number; rows: number }
  | { type: "paneModeChanged"; paneId: PaneId; mode: PaneMode }
  | { type: "paneOutput"; paneId: PaneId; bytes: Uint8Array }
  | { type: "windowAdded"; window: WindowInfo }
  | { type: "windowClosed"; windowId: WindowId }
  | { type: "windowRenamed"; windowId: WindowId; newName: string }
  | { type: "layoutChanged"; windowId: WindowId; layout: WindowLayout }
  | { type: "focusChanged"; focus: FocusInfo }
  | { type: "connected" }
  | { type: "disconnected"; reason: string };

/**
 * A RenderHook that records every callback call for inspection in tests.
 *
 * ```ts
 * const echo = new EchoRenderHook();
 * // drive the driver...
 * assert.equal(echo.calls[0].type, "windowAdded");
 * assert.equal(echo.calls[1].type, "paneOpened");
 * echo.clear();  // reset between test cases
 * ```
 */
export class EchoRenderHook implements RenderHook {
  /** Ordered log of every call made to this hook. */
  readonly calls: RenderHookCall[] = [];

  /** Reset the call log (useful between test cases). */
  clear(): void {
    this.calls.length = 0;
  }

  onPaneOpened(pane: PaneInfo): void {
    this.calls.push({ type: "paneOpened", pane });
  }

  onPaneClosed(paneId: PaneId): void {
    this.calls.push({ type: "paneClosed", paneId });
  }

  onPaneResized(paneId: PaneId, cols: number, rows: number): void {
    this.calls.push({ type: "paneResized", paneId, cols, rows });
  }

  onPaneModeChanged(paneId: PaneId, mode: PaneMode): void {
    this.calls.push({ type: "paneModeChanged", paneId, mode });
  }

  onPaneOutput(paneId: PaneId, bytes: Uint8Array): void {
    this.calls.push({ type: "paneOutput", paneId, bytes });
  }

  onWindowAdded(window: WindowInfo): void {
    this.calls.push({ type: "windowAdded", window });
  }

  onWindowClosed(windowId: WindowId): void {
    this.calls.push({ type: "windowClosed", windowId });
  }

  onWindowRenamed(windowId: WindowId, newName: string): void {
    this.calls.push({ type: "windowRenamed", windowId, newName });
  }

  onLayoutChanged(windowId: WindowId, layout: WindowLayout): void {
    this.calls.push({ type: "layoutChanged", windowId, layout });
  }

  onFocusChanged(focus: FocusInfo): void {
    this.calls.push({ type: "focusChanged", focus });
  }

  onConnected(): void {
    this.calls.push({ type: "connected" });
  }

  onDisconnected(reason: string): void {
    this.calls.push({ type: "disconnected", reason });
  }
}
