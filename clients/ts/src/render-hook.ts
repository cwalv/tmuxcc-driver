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
 *     to forward user input and viewport resize events to the session-proxy.
 *
 * Usage (from the renderer side):
 * ```ts
 * const handle = await connectClient(transport);
 * const hook: RenderHook = myRendererImpl;
 * handle.mirror.attach(hook);  // catches up from current mirror state + subscribes
 * // ... later:
 * handle.mirror.detachHook();  // detach from all sources
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
 */

import type { PaneId, WindowId, SessionId, WindowLayout, PaneMode, WireCommand } from "@tmuxcc/session-proxy";

// ---------------------------------------------------------------------------
// Re-export wire primitives that renderers reference (convenience)
// ---------------------------------------------------------------------------

export type { PaneId, WindowId, SessionId, WindowLayout, PaneMode, WireCommand };

// ---------------------------------------------------------------------------
// Value types used in callbacks
// ---------------------------------------------------------------------------

/**
 * Snapshot of a single pane's identity and geometry at the time of an event.
 * Passed to onPaneOpened and onPaneResized callbacks.
 *
 * v3: sessionId is absent — the session-proxy wire is single-session.
 */
export interface PaneInfo {
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  /** Width in terminal columns. */
  readonly cols: number;
  /** Height in terminal rows. */
  readonly rows: number;
  /**
   * True if this pane is the focused pane at the moment the event fires.
   * Renderers MAY use this to avoid a separate focus event on startup.
   */
  readonly active: boolean;
  /**
   * tc-zna.12: True iff this onPaneOpened call corresponds to a freshly-arriving
   * pane delta (a `pane.opened` event the Mirror just received and applied).
   * False when the pane is replayed from the initial snapshot during
   * `Mirror.attach()` — the pane was already in the model before the renderer
   * attached, so the call is a catch-up replay, not a new pane creation.
   *
   * Renderers that gate provenance / own-verb attribution (e.g. the VS Code
   * `PerPaneTerminalFactory` bind-on-provenance gate) consume this to avoid
   * letting a snapshot-replay pane race past the next-pane-open observer
   * before the verb's real pane arrives.  Other renderers MAY ignore it.
   */
  readonly created: boolean;
  /**
   * tc-4bv2 / tc-295a.10: True when this pane is already dead at the moment it
   * enters the model — a `remain-on-exit` corpse observed on cold attach /
   * reconnect / snapshot replay. Renderers should render the pane in its dead
   * state immediately (exit banner, dead icon) without waiting for a separate
   * close event (a dead corpse never "closes" until reaped). Absent / false
   * means the pane is live.
   */
  readonly dead?: boolean;
  /**
   * tc-4bv2 / tc-295a.10: exit code when `dead` is true and known (tmux
   * `pane_dead_status`); absent when alive or unknowable.
   */
  readonly exitCode?: number;
}

/**
 * Current focus state: which pane and window are active.
 * Both are null when no pane is focused.
 *
 * v3: sessionId is absent — the session-proxy wire is single-session.
 */
export interface FocusInfo {
  readonly paneId: PaneId | null;
  readonly windowId: WindowId | null;
}

/**
 * Snapshot of a window's identity and geometry at the time of an event.
 *
 * v3: sessionId is absent — the session-proxy wire is single-session.
 */
export interface WindowInfo {
  readonly windowId: WindowId;
  readonly name: string;
  /** True if this window is the active window in its session. */
  readonly active: boolean;
  /**
   * Current split-tree geometry for this window.
   *
   * Set from the mirror's ClientWindow.layout on every model update.  During
   * initial snapshot replay the driver calls onLayoutChanged for every window
   * whose layout root is non-trivial (i.e. not the zero-placeholder emitted by
   * window.added deltas).  Thereafter onLayoutChanged fires on every model
   * tick where this field differs from the previous tick.
   */
  readonly layout: WindowLayout;
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
   * A new pane appeared (new window, split, or session-proxy snapshot replay).
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
   * `exitCode` is the process exit code if the session-proxy captured it.  It is
   * absent when the underlying tmux notification did not carry exit status
   * (the most common case — see PaneClosedMessage in @tmuxcc/session-proxy).
   *
   * Renderers should show an exit message and mark the terminal as exited here.
   * The tab MUST NOT auto-close; that is a user-driven action.
   */
  onPaneClosed(paneId: PaneId, exitCode?: number): void;

  /**
   * A pane's dimensions changed.
   *
   * Called when a pane.resized event confirms the session-proxy applied a resize.
   * This is the authoritative size; renderers should update their viewport.
   */
  onPaneResized(paneId: PaneId, cols: number, rows: number): void;

  /**
   * A pane's dead state changed WITHOUT the pane leaving the session
   * (tc-4bv2 / tc-295a.10 shared pane-state shape).
   *
   * Called when a `pane.dead-changed` delta arrives: a live pane became a
   * `remain-on-exit` corpse in place (`dead === true`), or — defensively — a
   * dead pane respawned back to live (`dead === false`). The pane is NOT
   * removed; `onPaneClosed` is the separate event for a pane whose slot left
   * tmux entirely.
   *
   * Renderers should reflect the dead state (exit banner, dead icon,
   * reap/rebind affordances) but keep the pane's terminal/tab in place.
   * `exitCode` is the process exit code when `dead` is true and known.
   *
   * Default-implementable as a no-op for renderers that do not distinguish a
   * dead corpse from a live pane.
   */
  onPaneDeadChanged(paneId: PaneId, dead: boolean, exitCode?: number): void;

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
   * chunk races the lifecycle event (session-proxy implementation detail).  Renderers
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
   * WindowLayout in @tmuxcc/session-proxy).  Renderers should apply the layout
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
   * The client successfully connected to the session-proxy and the initial snapshot
   * has been applied.
   *
   * Fired once at the start of driver.start(), AFTER onPaneOpened /
   * onWindowAdded / onLayoutChanged / onFocusChanged have been called for all
   * entities in the snapshot.  Renderers may use this to hide a loading UI.
   */
  onConnected(): void;

  /**
   * The connection to the session-proxy was lost (clean close or error).
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
 * session-proxy.  The renderer CALLS these methods; the client IMPLEMENTS them.
 *
 * Obtained from `connectClient(transport).controller`.
 *
 * Integration wiring: the concrete implementation (built in client.ts) delegates
 * to tc-fpf's InputApi (sendInput / resizePane methods).
 */
export interface ClientController {
  /**
   * Send text/key input to a pane.
   *
   * `data` is a UTF-8 string.  The client forwards it to the session-proxy's input
   * message, which writes bytes directly to the pane's pty.  Special keys
   * (escape sequences, function keys) should be pre-encoded as their byte
   * sequences before calling sendInput.
   */
  sendInput(paneId: PaneId, data: string): void;

  /**
   * Notify the session-proxy that the renderer's viewport for a pane changed size.
   *
   * Called when the host UI resizes (e.g. VS Code panel resized).  The session-proxy
   * applies the resize to tmux and confirms with a pane.resized event, which
   * the driver will translate into an onPaneResized callback.
   */
  resizePane(paneId: PaneId, cols: number, rows: number): void;

  /**
   * Send a model-level command to the sessionProxy (VS Code → tmux direction).
   *
   * Wraps `cmd` in a `command.request` wire message with a monotonically-
   * increasing correlationId and sends it over the connection.  The resulting
   * tmux state change (new pane opened, window closed, etc.) flows back as
   * normal `onWindowAdded` / `onPaneOpened` / `onPaneClosed` callbacks.
   *
   * Fire-and-forget: this does not wait for the matching `command.response`.
   * Errors from the sessionProxy (malformed command, unknown pane id, etc.) arrive
   * as `onDisconnected` or are silently ignored by the session-proxy depending on the
   * error type.
   *
   * Common commands:
   *   { kind: "open-window", sessionId }         — tmux new-window
   *   { kind: "split-pane", paneId, direction }  — tmux split-window
   *
   * tc-9hk: used by the VS Code `tmuxcc.newWindow` / `tmuxcc.splitPane`
   * commands in extension.ts to drive tmux from the editor.
   */
  sendCommand(cmd: WireCommand): void;

  /**
   * Request on-demand per-pane hydration on THIS connection (tc-295a.8).
   *
   * Sends `pane.attach{paneId}` to the session-proxy, which validates the pane
   * exists and emits `pane.hydration.begin` → (clear+replay on the data plane)
   * → `pane.hydration.end`. A vanished pane surfaces `pane.attach.failed`
   * (observable via `Mirror.onHydrationEvent`).
   *
   * Used by the §1.4 bindNew flow: when the renderer binds a NEW VS Code tab to
   * a pane that already exists on an already-connected session, the new tab's
   * terminal buffer is empty — this triggers a fresh clear+replay for that pane
   * on the existing transport so the new tab shows the pane's scrollback.
   *
   * Fire-and-forget: the hydration sentinels (or the failure) are the response.
   */
  attachPane(paneId: PaneId): void;
}

// ---------------------------------------------------------------------------
// ByteSource — abstract byte source used by Mirror.attach and client.ts
// ---------------------------------------------------------------------------

/**
 * Abstract byte source — provided by tc-3fb's pane-stream at integration time.
 *
 * Implemented by PaneStreamConsumer (pane-stream.ts) and adapted via
 * consumerToByteSource() in client.ts.  Exposed here so mirror.ts and
 * client.ts can share the interface without a circular import.
 */
export interface ByteSource {
  /**
   * Subscribe to raw output bytes for a specific pane.
   * Returns an unsubscribe function.
   */
  onPaneOutput(paneId: PaneId, callback: (bytes: Uint8Array) => void): () => void;
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
  onPaneClosed(_paneId: PaneId, _exitCode?: number): void {},
  onPaneResized(_paneId: PaneId, _cols: number, _rows: number): void {},
  onPaneDeadChanged(_paneId: PaneId, _dead: boolean, _exitCode?: number): void {},
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
  | { type: "paneClosed"; paneId: PaneId; exitCode?: number }
  | { type: "paneResized"; paneId: PaneId; cols: number; rows: number }
  | { type: "paneDeadChanged"; paneId: PaneId; dead: boolean; exitCode?: number }
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

  onPaneClosed(paneId: PaneId, exitCode?: number): void {
    if (exitCode !== undefined) {
      this.calls.push({ type: "paneClosed", paneId, exitCode });
    } else {
      this.calls.push({ type: "paneClosed", paneId });
    }
  }

  onPaneResized(paneId: PaneId, cols: number, rows: number): void {
    this.calls.push({ type: "paneResized", paneId, cols, rows });
  }

  onPaneDeadChanged(paneId: PaneId, dead: boolean, exitCode?: number): void {
    if (exitCode !== undefined) {
      this.calls.push({ type: "paneDeadChanged", paneId, dead, exitCode });
    } else {
      this.calls.push({ type: "paneDeadChanged", paneId, dead });
    }
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
