/**
 * Client-side model mirror — tc-eots
 *
 * Maintains a client-side mirror of the daemon's session model by consuming
 * a SnapshotMessage (full-state baseline) followed by incremental delta
 * messages from the DaemonConnection.onControl stream.
 *
 * # Architecture
 *
 * Two layers:
 *   1. Pure core: `applySnapshot` / `applyDelta` operate on `ClientModel`
 *      (plain data structures, no side effects). Fully testable in isolation.
 *
 *   2. `Mirror` class: thin stateful wrapper that holds the current model,
 *      manages seq-gap detection, fires change/resync callbacks, and provides
 *      `getModel()` for renderers. `Mirror.connectTo(connection)` wires a
 *      DaemonConnection to the mirror automatically.
 *
 * # Client model shape
 *
 * The `ClientModel` is intentionally simpler than the daemon's `SessionModel`:
 *   - No scrollback handles (daemon-internal).
 *   - No invariant-checking overhead.
 *   - Flat maps keyed by the same branded id types the wire uses.
 *   - `ClientPane` includes `mode` (rendered by tc-7v9 as visual indicator).
 *   - `ClientWindow` includes `layout` (WindowLayout — the full geometry tree).
 *   - `ClientSession` includes `active` flag mirrored from snapshot/deltas.
 *   - A `focus` triple (`paneId | null`, `windowId | null`, `sessionId | null`).
 *
 * # Seq-gap detection policy
 *
 * The snapshot's `seq` is the baseline. Each delta MUST have `seq === lastSeq + 1`.
 * When a gap is detected:
 *   - The delta is NOT applied (the mirror stays at its last known-good state).
 *   - All registered `onResyncNeeded` handlers are called with the gap info.
 *   - The caller (e.g. a reconnect loop) should request a fresh snapshot and
 *     call `applySnapshot` again; the mirror resets cleanly.
 *
 * In-order deltas never trigger the resync signal.
 *
 * # Renderer seam (tc-7v9)
 *
 * `mirror.getModel()` — returns the current `ClientModel` snapshot (immutable
 * reference; mirror replaces it atomically on each apply).
 *
 * `mirror.onModelChange(handler)` — fires after every successful `applySnapshot`
 * or `applyDelta`, passing the new model. Handlers are appended (not replaced).
 * Returns an unsubscribe function.
 *
 * `mirror.onResyncNeeded(handler)` — fires when a seq gap is detected. Handlers
 * receive a `SeqGapInfo` describing the gap. Returns an unsubscribe function.
 *
 * # NO DOM, NO vscode, NO host API, NO Pseudoterminal
 */

import type {
  SnapshotMessage,
  DaemonMessage,
  ClientMessage,
  ResyncRequestMessage,
  PaneId,
  WindowId,
  SessionId,
  WindowLayout,
  PaneMode,
} from "@tmuxcc/daemon";
import type { DaemonConnection } from "./connection.js";
import type { RenderHook, ByteSource } from "./render-hook.js";

// ---------------------------------------------------------------------------
// Client model types
// ---------------------------------------------------------------------------

/**
 * A pane as tracked by the client mirror.
 *
 * Projection from the wire: paneId, windowId, cols, rows are direct from
 * SnapshotPane / delta messages. `mode` is tracked from pane.mode-changed
 * deltas (defaults to "normal" at snapshot time since SnapshotPane has no mode).
 *
 * v3: sessionId is absent — the daemon wire is single-session and does not
 * carry sessionId on pane messages.
 */
export interface ClientPane {
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  readonly cols: number;
  readonly rows: number;
  /** Current pane mode. Defaults to "normal" after a snapshot. */
  readonly mode: PaneMode;
}

/**
 * A window as tracked by the client mirror.
 *
 * `active` is true when this window is the active window in its session
 * (driven by snapshot active flags and focus.changed deltas).
 * `layout` is the current WindowLayout tree for this window (may be the
 * zero-placeholder if no layout.updated has arrived yet — matches projection.ts
 * semantics for window.added).
 *
 * v3: sessionId is absent — the daemon wire is single-session and does not
 * carry sessionId on window messages.
 */
export interface ClientWindow {
  readonly windowId: WindowId;
  readonly name: string;
  readonly active: boolean;
  readonly layout: WindowLayout;
}

/**
 * A session as tracked by the client mirror.
 *
 * v3: the daemon wire is single-session. `ClientModel.session` holds this
 * scalar directly (not a map).
 */
export interface ClientSession {
  readonly sessionId: SessionId;
  readonly name: string;
}

/**
 * Global focus pair. Both are null when no pane is focused.
 *
 * v3: sessionId is absent from focus — the daemon wire is single-session.
 */
export interface ClientFocus {
  readonly paneId: PaneId | null;
  readonly windowId: WindowId | null;
}

/**
 * The client-side model — a flat, normalized view of the daemon's session state.
 *
 * Maps are keyed by the same branded id types the wire uses. This model is
 * replaced atomically by `applySnapshot` / `applyDelta`; renderers should call
 * `getModel()` after each change notification to get the latest reference.
 *
 * v3: single-session. The bound session is a scalar `session` field, not a map.
 * Rendering hint: iterate `windows` → `panes` (by windowId) to build a tree.
 */
export interface ClientModel {
  /** The bound session (single-session v3 wire). */
  readonly session: ClientSession;
  /** All windows, keyed by windowId. */
  readonly windows: ReadonlyMap<WindowId, ClientWindow>;
  /** All panes across all windows, keyed by paneId. */
  readonly panes: ReadonlyMap<PaneId, ClientPane>;
  /** Global focus pair. */
  readonly focus: ClientFocus;
  /**
   * Exit codes for panes that have closed, keyed by paneId.
   *
   * Populated when a `pane.closed` delta arrives carrying an `exitCode`.
   * The entry persists in this map after the pane is removed from `panes` so
   * that the mirror's diff path can pass the code to `onPaneClosed`.
   * Entries are removed when the next snapshot arrives (full reset) or when
   * the mirror is detached.
   *
   * Absent from `panes` (pane is closed) does NOT guarantee an entry here —
   * most pane-closed events have no exit code because the underlying tmux
   * notification (%window-close) does not carry one. See PaneClosedMessage.
   */
  readonly exitCodes: ReadonlyMap<PaneId, number>;
  /**
   * Number of daemon-protocol clients currently connected to this session.
   *
   * tc-1elae (Phase 2 — §11.4): initially populated from
   * `SnapshotMessage.attachedClientCount` (static baseline at connect time).
   *
   * tc-44wu0 (Phase 4): subsequently kept live by `client-count.changed`
   * delta messages, which the daemon broadcasts whenever a client connects
   * or disconnects. After tc-44wu0 lands this value reflects the real-time
   * count, not merely the snapshot-time count.
   *
   * Absent (undefined) when the snapshot did not carry this field (older daemon
   * predating Phase 2) or before the first snapshot arrives. The status bar
   * falls back to 1 when absent.
   */
  readonly attachedClientCount: number | undefined;
}

// ---------------------------------------------------------------------------
// Seq-gap types
// ---------------------------------------------------------------------------

/**
 * Information about a detected sequence gap.
 *
 * Passed to `onResyncNeeded` handlers when a delta arrives out of order or
 * with a skipped seq number.
 *
 * `expected` — the seq the mirror was expecting (lastAppliedSeq + 1).
 * `received` — the seq carried by the out-of-order delta.
 */
export interface SeqGapInfo {
  readonly expected: number;
  readonly received: number;
}

// ---------------------------------------------------------------------------
// Empty model constructor
// ---------------------------------------------------------------------------

/** Return an empty ClientModel (no windows, panes; null focus; placeholder session). */
function emptyClientModel(): ClientModel {
  return {
    session: { sessionId: "" as SessionId, name: "" },
    windows: new Map(),
    panes: new Map(),
    focus: { paneId: null, windowId: null },
    exitCodes: new Map(),
    attachedClientCount: undefined,
  };
}

// ---------------------------------------------------------------------------
// Pure core: applySnapshot
// ---------------------------------------------------------------------------

/**
 * Initialize a `ClientModel` from a full `SnapshotMessage`.
 *
 * Replaces ALL state — any previously applied deltas are discarded. Call this
 * when connecting (first snapshot) or re-syncing after a seq gap.
 *
 * Returns both the new model and the snapshot's seq (for seq tracking).
 */
export function applySnapshot(snapshot: SnapshotMessage): {
  model: ClientModel;
  seq: number;
} {
  // v3: single session — scalar field, not an array.
  const session: ClientSession = {
    sessionId: snapshot.session.sessionId,
    name: snapshot.session.name,
  };

  const windows = new Map<WindowId, ClientWindow>();
  for (const w of snapshot.windows) {
    windows.set(w.windowId, {
      windowId: w.windowId,
      name: w.name,
      active: w.active,
      layout: w.layout,
    });
  }

  const panes = new Map<PaneId, ClientPane>();
  for (const p of snapshot.panes) {
    panes.set(p.paneId, {
      paneId: p.paneId,
      windowId: p.windowId,
      cols: p.cols,
      rows: p.rows,
      mode: "normal", // SnapshotPane has no mode field; default per spec
    });
  }

  const model: ClientModel = {
    session,
    windows,
    panes,
    focus: {
      paneId: snapshot.focus.paneId,
      windowId: snapshot.focus.windowId,
    },
    // Snapshot resets all state including exit codes — panes that exited before
    // this snapshot are gone and their exit codes are no longer relevant.
    exitCodes: new Map(),
    // tc-1elae (§11.4): propagate the attached-client count from the snapshot
    // so TmuxccSessionHandle can surface it in the status-bar tooltip.
    attachedClientCount: snapshot.attachedClientCount,
  };

  return { model, seq: snapshot.seq };
}

// ---------------------------------------------------------------------------
// Pure core: applyDelta
// ---------------------------------------------------------------------------

/**
 * Apply one delta message to an existing `ClientModel`.
 *
 * Exhaustively handles every delta type via TypeScript `never` exhaustiveness
 * check. Messages not relevant to model state (command.response, error,
 * daemon.capabilities, snapshot) are returned as-is (no model change).
 *
 * Returns the updated model (or the same model reference if no change is
 * needed for this message type).
 *
 * Mirror semantics follow the daemon's `applyDeltas` reference implementation
 * in `projection.test.ts`, so client and daemon agree on round-trip consistency.
 */
export function applyDelta(model: ClientModel, msg: DaemonMessage): ClientModel {
  switch (msg.type) {
    // ── Pane lifecycle ───────────────────────────────────────────────────────

    case "pane.opened": {
      const panes = new Map(model.panes);
      panes.set(msg.paneId, {
        paneId: msg.paneId,
        windowId: msg.windowId,
        cols: msg.cols,
        rows: msg.rows,
        mode: "normal",
      });
      return { ...model, panes };
    }

    case "pane.closed": {
      if (!model.panes.has(msg.paneId)) return model;
      const panes = new Map(model.panes);
      panes.delete(msg.paneId);
      // Record the exit code if the daemon provided one.
      if (msg.exitCode !== undefined) {
        const exitCodes = new Map(model.exitCodes);
        exitCodes.set(msg.paneId, msg.exitCode);
        return { ...model, panes, exitCodes };
      }
      return { ...model, panes };
    }

    case "pane.resized": {
      const pane = model.panes.get(msg.paneId);
      if (!pane) return model;
      const panes = new Map(model.panes);
      panes.set(msg.paneId, { ...pane, cols: msg.cols, rows: msg.rows });
      return { ...model, panes };
    }

    case "pane.mode-changed": {
      const pane = model.panes.get(msg.paneId);
      if (!pane) return model;
      const panes = new Map(model.panes);
      panes.set(msg.paneId, { ...pane, mode: msg.mode });
      return { ...model, panes };
    }

    // ── Window lifecycle ─────────────────────────────────────────────────────

    case "window.added": {
      const windows = new Map(model.windows);
      // If this window is active, clear other windows' active flags
      // (mirrors projection.test.ts applyDeltas semantics).
      if (msg.active) {
        for (const [wid, win] of windows) {
          if (win.active) {
            windows.set(wid, { ...win, active: false });
          }
        }
      }
      windows.set(msg.windowId, {
        windowId: msg.windowId,
        name: msg.name,
        active: msg.active,
        // Zero-layout placeholder — mirrors projection.ts window.added behavior.
        // A subsequent layout.updated will replace it.
        layout: {
          cols: 0,
          rows: 0,
          root: {
            kind: "pane",
            paneId: "" as PaneId,
            rect: { x: 0, y: 0, cols: 0, rows: 0 },
          },
        },
      });
      return { ...model, windows };
    }

    case "window.closed": {
      if (!model.windows.has(msg.windowId)) return model;
      const windows = new Map(model.windows);
      windows.delete(msg.windowId);
      return { ...model, windows };
    }

    case "window.renamed": {
      const win = model.windows.get(msg.windowId);
      if (!win) return model;
      const windows = new Map(model.windows);
      windows.set(msg.windowId, { ...win, name: msg.newName });
      return { ...model, windows };
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    case "layout.updated": {
      const win = model.windows.get(msg.windowId);
      if (!win) return model;
      const windows = new Map(model.windows);
      windows.set(msg.windowId, { ...win, layout: msg.layout });
      return { ...model, windows };
    }

    // ── Focus ────────────────────────────────────────────────────────────────

    case "focus.changed": {
      // Update the focus pair (v3: no sessionId).
      const focus: ClientFocus = {
        paneId: msg.paneId,
        windowId: msg.windowId,
      };
      // Also update active flags on windows to match the new focus
      // (mirrors projection.test.ts applyDeltas semantics).
      const windows = new Map(model.windows);
      for (const [wid, win] of windows) {
        const shouldBeActive = wid === msg.windowId;
        if (win.active !== shouldBeActive) {
          windows.set(wid, { ...win, active: shouldBeActive });
        }
      }
      return { ...model, windows, focus };
    }

    // ── Session lifecycle (v3: only session.renamed on daemon wire) ───────────

    case "session.renamed": {
      // v3: DaemonSessionRenamedMessage has no sessionId — updates the bound session.
      return { ...model, session: { ...model.session, name: msg.newName } };
    }

    // ── Client-count delta (tc-44wu0) ────────────────────────────────────────

    case "client-count.changed": {
      // Live update from the daemon when a client attaches or detaches.
      // Updates attachedClientCount so the status-bar tooltip reflects the
      // current count without requiring a full resync.
      return { ...model, attachedClientCount: msg.count };
    }

    // ── Non-model messages (pass through unchanged) ──────────────────────────

    case "snapshot":
      // Full snapshot — call applySnapshot() instead.
      return model;

    case "daemon.capabilities":
    case "command.response":
    case "error":
      // Not state-bearing for the mirror.
      return model;

    // ── Exhaustiveness check ─────────────────────────────────────────────────
    default: {
      // TypeScript will error here if a new DaemonMessage variant is added but
      // not handled above.
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Mirror — stateful wrapper
// ---------------------------------------------------------------------------

/** Handler for model-change notifications from the mirror. */
export type ModelChangeHandler = (model: ClientModel) => void;

/** Handler for seq-gap / resync-needed notifications from the mirror. */
export type ResyncNeededHandler = (gap: SeqGapInfo) => void;

/**
 * Stateful client-side mirror of the daemon session model.
 *
 * Usage (pure manual drive):
 * ```ts
 * const mirror = new Mirror();
 * mirror.onModelChange((m) => render(m));
 * mirror.onResyncNeeded(({ expected, received }) => {
 *   // request a fresh snapshot from the daemon
 * });
 * // On connection established — snapshot arrives first:
 * connection.onControl((msg) => {
 *   if (msg.type === "snapshot") {
 *     mirror.receiveSnapshot(msg);
 *   } else {
 *     mirror.receiveDelta(msg);
 *   }
 * });
 * ```
 *
 * Or use `Mirror.connectTo(connection)` for automatic wiring.
 */
export class Mirror {
  // ── State ─────────────────────────────────────────────────────────────────

  #model: ClientModel = emptyClientModel();
  #lastSeq: number | null = null; // null = no snapshot received yet
  #initialized = false;

  // ── Resync-request state (tc-7ml.4) ───────────────────────────────────────
  //
  // When a seq gap is detected the mirror sends `resync.request` to the daemon
  // and sets #resyncRequested = true.  On snapshot arrival the flag is cleared.
  //
  // While the flag is set, further gap signals are suppressed (dedup: only one
  // resync in flight at a time).
  //
  // After the snapshot clears the flag, #resyncDelivered is set to true.  If
  // ANOTHER gap is then detected (persistent gap — the resync did not help),
  // the mirror escalates by calling transport.close() via #closeFn.
  //
  // #clientSeq is the outbound sequence counter for resync.request messages
  // (and any other client→daemon messages the mirror may send in the future).
  // It is independent of the inbound #lastSeq counter.
  #resyncRequested = false;
  #resyncDelivered = false; // true after the first resync snapshot was received
  #clientSeq = 0;           // incremented before each send

  // Send function and close function — injected by connectTo().
  // The send function accepts a ResyncRequestMessage specifically; the type
  // is narrowed to make the intent clear (the mirror only sends one message type).
  #sendFn: ((msg: ResyncRequestMessage) => void) | null = null;
  #closeFn: (() => void) | null = null;

  // ── attach() state ────────────────────────────────────────────────────────
  //
  // Pre-wired by wireDataSources() before attach() may be called.  These are
  // set once during connectClient() setup and never changed afterwards.

  #byteSource: ByteSource | null = null;

  // Whether attach() has already been called (idempotent guard).
  #attached = false;

  // Unsubscribe functions gathered by attach() for teardown.
  readonly #attachUnsubs: Array<() => void> = [];

  // ── Handlers ──────────────────────────────────────────────────────────────

  readonly #changeHandlers: ModelChangeHandler[] = [];
  readonly #resyncHandlers: ResyncNeededHandler[] = [];

  // ── Public model access ───────────────────────────────────────────────────

  /**
   * Get the current client model.
   *
   * Returns an immutable reference; the mirror replaces the reference atomically
   * on each `receiveSnapshot` / `receiveDelta`. Callers should not cache this
   * reference across change notifications — always call `getModel()` again
   * inside an `onModelChange` handler to get the latest state.
   *
   * tc-7v9 (render hook bead) reads from this getter.
   */
  getModel(): ClientModel {
    return this.#model;
  }

  /**
   * True after the first `receiveSnapshot` has been called.
   * Renderers may gate their first render on this flag.
   */
  get initialized(): boolean {
    return this.#initialized;
  }

  // ── Change notifications ──────────────────────────────────────────────────

  /**
   * Register a handler that fires after every successful model update
   * (snapshot or delta).
   *
   * Handlers are APPENDED (multiple registrations are all called in order).
   * Returns an unsubscribe function; call it to deregister the handler.
   *
   * tc-7v9 (render hook bead) registers here to drive render updates.
   */
  onModelChange(handler: ModelChangeHandler): () => void {
    this.#changeHandlers.push(handler);
    return () => {
      const idx = this.#changeHandlers.indexOf(handler);
      if (idx !== -1) this.#changeHandlers.splice(idx, 1);
    };
  }

  /**
   * Register a handler that fires when a seq gap is detected.
   *
   * A seq gap means a delta arrived with a non-consecutive seq (skipped or
   * out-of-order). The mirror does NOT apply the offending delta. The caller
   * should request a fresh snapshot from the daemon and call `receiveSnapshot`
   * again.
   *
   * Handlers are APPENDED. Returns an unsubscribe function.
   */
  onResyncNeeded(handler: ResyncNeededHandler): () => void {
    this.#resyncHandlers.push(handler);
    return () => {
      const idx = this.#resyncHandlers.indexOf(handler);
      if (idx !== -1) this.#resyncHandlers.splice(idx, 1);
    };
  }

  // ── Receive methods ───────────────────────────────────────────────────────

  /**
   * Initialize (or re-initialize) the mirror from a full snapshot.
   *
   * Resets all state including the seq counter. Safe to call multiple times
   * (e.g. after a resync). Fires `onModelChange` handlers.
   *
   * If a `resync.request` was in flight when this snapshot arrives, the
   * in-flight flag is cleared (resync succeeded). A subsequent persistent gap
   * will escalate to transport close.
   */
  receiveSnapshot(snapshot: SnapshotMessage): void {
    const { model, seq } = applySnapshot(snapshot);
    this.#model = model;
    this.#lastSeq = seq;
    this.#initialized = true;

    // If we had an in-flight resync request, mark it as delivered.
    if (this.#resyncRequested) {
      this.#resyncRequested = false;
      this.#resyncDelivered = true;
    }

    this.#emitChange(model);
  }

  /**
   * Apply one delta message to the mirror.
   *
   * If no snapshot has been received yet, the delta is silently ignored (the
   * mirror is not yet initialized and has no baseline to apply against).
   *
   * If the delta's `seq` is not `lastSeq + 1`, a seq gap is detected:
   *   - The delta is NOT applied.
   *   - All `onResyncNeeded` handlers are called with the gap info.
   *   - The mirror stays at the last known-good state.
   *
   * If the message type is not a delta (snapshot, daemon.capabilities,
   * command.response, error), it is silently ignored.
   *
   * Fires `onModelChange` handlers on successful apply.
   */
  receiveDelta(msg: DaemonMessage): void {
    // Not yet initialized — ignore.
    if (!this.#initialized || this.#lastSeq === null) return;

    // Snapshot messages should go to receiveSnapshot, not here.
    if (msg.type === "snapshot") return;

    // Non-state-bearing messages — skip seq check and silently ignore.
    if (
      msg.type === "daemon.capabilities" ||
      msg.type === "command.response" ||
      msg.type === "error"
    ) {
      return;
    }

    // Seq-gap detection.
    const expected = this.#lastSeq + 1;
    if (msg.seq !== expected) {
      // Always fire the legacy onResyncNeeded handlers (backward-compat).
      this.#emitResync({ expected, received: msg.seq });

      if (this.#resyncRequested) {
        // A resync.request is already in flight — deduplicate; ignore this gap.
        return;
      }

      if (this.#resyncDelivered) {
        // We already received a resync snapshot but STILL get a gap — persistent
        // gap.  Escalate: close the transport so the reconnect path takes over.
        this.#closeFn?.();
        return;
      }

      // First gap: send resync.request and set the in-flight flag.
      this.#resyncRequested = true;
      if (this.#sendFn !== null) {
        const msg: ResyncRequestMessage = {
          type: "resync.request",
          seq: ++this.#clientSeq,
        };
        this.#sendFn(msg);
      }
      return;
    }

    const newModel = applyDelta(this.#model, msg);
    this.#model = newModel;
    this.#lastSeq = msg.seq;
    this.#emitChange(newModel);
  }

  // ── Connection wiring ─────────────────────────────────────────────────────

  /**
   * Wire this mirror to a `DaemonConnection`.
   *
   * Registers a single `onControl` handler that routes:
   *   - `snapshot` messages → `receiveSnapshot()`
   *   - all other messages → `receiveDelta()`
   *
   * Also injects the connection's `send` and `close` functions so that the
   * mirror can autonomously send `resync.request` on gap detect (tc-7ml.4).
   *
   * Returns an unsubscribe function that deregisters the handler (setting
   * the connection's control handler to null is not possible with the current
   * DaemonConnection API, so the unsubscribe replaces it with a no-op).
   *
   * NOTE: `DaemonConnection.onControl` is a single-slot handler (replace
   * semantics, not append). If another consumer also calls `onControl`, it
   * will replace this mirror's handler. In that case, route messages manually
   * via `receiveSnapshot` / `receiveDelta` instead.
   *
   * Call AFTER `await connection.connect()` so buffered messages are delivered.
   */
  connectTo(connection: DaemonConnection): () => void {
    // Inject the send/close capabilities for autonomous resync-request (tc-7ml.4).
    this.#sendFn = (msg: ResyncRequestMessage) => {
      // DaemonConnection.send() accepts ClientMessage; ResyncRequestMessage
      // is a member of ClientMessage, so this cast is safe.
      connection.send(msg as ClientMessage);
    };
    this.#closeFn = () => {
      connection.close();
    };

    const handler = (msg: DaemonMessage): void => {
      if (msg.type === "snapshot") {
        this.receiveSnapshot(msg);
      } else {
        this.receiveDelta(msg);
      }
    };
    connection.onControl(handler);
    // Return a no-op unsubscribe (DaemonConnection.onControl is replace-only;
    // to truly unsubscribe you'd have to install a new handler).
    return () => {
      // Replace with a no-op to stop routing to this mirror.
      connection.onControl(() => {
        /* no-op */
      });
      // Clear the injected send/close so the mirror doesn't call into a
      // disconnected connection after unsubscribe.
      this.#sendFn = null;
      this.#closeFn = null;
    };
  }

  // ── attach() API ─────────────────────────────────────────────────────────

  /**
   * Pre-wire the byte source so that `attach()` can subscribe per-pane byte
   * output.  Called once by `connectClient()` before the handle is returned.
   *
   * Must be called before `attach()`.
   */
  wireDataSources(byteSource: ByteSource): void {
    this.#byteSource = byteSource;
  }

  /**
   * Catch up a RenderHook from the current mirror state, then subscribe to
   * all future model deltas and byte output.
   *
   * Fires in order:
   *   1. onWindowAdded + onLayoutChanged for every known window.
   *   2. onPaneOpened for every known pane; subscribes byte output for each.
   *   3. onFocusChanged with current focus.
   *   4. onConnected.
   *
   * Subsequent model changes (pane/window/layout/focus) are delivered via the
   * model-diff path (same as before).
   *
   * Idempotent: a second call with any hook is a no-op (does NOT fire a second
   * snapshot replay).  The caller must not rely on attach() being callable
   * twice — construct a new Mirror for a new connection instead.
   *
   * @throws Error if wireDataSources() has not been called first.
   */
  attach(hook: RenderHook): void {
    if (this.#attached) return;
    this.#attached = true;

    if (this.#byteSource === null) {
      throw new Error("Mirror.attach(): call wireDataSources() before attach()");
    }
    const byteSource: ByteSource = this.#byteSource;

    // Track previously-seen model to diff against.
    let prevModel: {
      panes: ReadonlyMap<PaneId, { cols: number; rows: number }>;
      windows: ReadonlyMap<WindowId, { name: string; layout: WindowLayout }>;
      focus: { paneId: PaneId | null; windowId: WindowId | null };
      exitCodes: ReadonlyMap<PaneId, number>;
    } = {
      panes: new Map(),
      windows: new Map(),
      focus: { paneId: null, windowId: null },
      exitCodes: new Map(),
    };

    // Byte-source unsubscribe functions keyed by PaneId string.
    const byteUnsubs = new Map<string, () => void>();

    let detached = false;

    function subscribeBytes(paneId: PaneId): void {
      if (byteUnsubs.has(paneId)) return;
      const unsub = byteSource.onPaneOutput(paneId, (bytes) => {
        if (!detached) hook.onPaneOutput(paneId, bytes);
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

    // Model diff — called on each model change after attach().
    function applyModelDiff(curr: ClientModel): void {
      const prev = prevModel;

      // Windows: added / removed / renamed / layout changed
      for (const [wid, win] of curr.windows) {
        const prevWin = prev.windows.get(wid);
        if (prevWin === undefined) {
          hook.onWindowAdded({
            windowId: win.windowId,
            name: win.name,
            active: win.active,
            layout: win.layout,
          });
          hook.onLayoutChanged(wid, win.layout);
        } else {
          if (prevWin.name !== win.name) {
            hook.onWindowRenamed(wid, win.name);
          }
          if (prevWin.layout !== win.layout) {
            hook.onLayoutChanged(wid, win.layout);
          }
        }
      }
      for (const [wid] of prev.windows) {
        if (!curr.windows.has(wid)) {
          hook.onWindowClosed(wid);
        }
      }

      // Panes: added / removed / resized
      for (const [pid, pane] of curr.panes) {
        const prevPane = prev.panes.get(pid);
        if (prevPane === undefined) {
          hook.onPaneOpened({
            paneId: pane.paneId,
            windowId: pane.windowId,
            cols: pane.cols,
            rows: pane.rows,
            active: pane.paneId === curr.focus.paneId,
          });
          subscribeBytes(pid);
        } else if (prevPane.cols !== pane.cols || prevPane.rows !== pane.rows) {
          hook.onPaneResized(pid, pane.cols, pane.rows);
        }
      }
      for (const [pid] of prev.panes) {
        if (!curr.panes.has(pid)) {
          // Pass the exit code if the daemon provided one (carried in exitCodes).
          const exitCode = curr.exitCodes.get(pid);
          hook.onPaneClosed(pid, exitCode);
          unsubscribeBytes(pid);
        }
      }

      // Focus
      const pf = prev.focus;
      const nf = curr.focus;
      if (pf.paneId !== nf.paneId || pf.windowId !== nf.windowId) {
        hook.onFocusChanged(nf);
      }

      // Update prevModel to reflect current state.
      const newPanes = new Map<PaneId, { cols: number; rows: number }>();
      for (const [pid, p] of curr.panes) {
        newPanes.set(pid, { cols: p.cols, rows: p.rows });
      }
      const newWindows = new Map<WindowId, { name: string; layout: WindowLayout }>();
      for (const [wid, w] of curr.windows) {
        newWindows.set(wid, { name: w.name, layout: w.layout });
      }
      prevModel = {
        panes: newPanes,
        windows: newWindows,
        focus: { paneId: nf.paneId, windowId: nf.windowId },
        exitCodes: curr.exitCodes,
      };
    }

    // ── Initial catch-up from current mirror state ──────────────────────────

    const initial = this.#model;

    // Windows first (panes are children of windows).
    for (const win of initial.windows.values()) {
      hook.onWindowAdded({
        windowId: win.windowId,
        name: win.name,
        active: win.active,
        layout: win.layout,
      });
      hook.onLayoutChanged(win.windowId, win.layout);
    }

    // Panes + byte subscriptions.
    for (const [pid, pane] of initial.panes) {
      hook.onPaneOpened({
        paneId: pane.paneId,
        windowId: pane.windowId,
        cols: pane.cols,
        rows: pane.rows,
        active: pane.paneId === initial.focus.paneId,
      });
      subscribeBytes(pid);
    }

    // Focus.
    hook.onFocusChanged(initial.focus);

    // Signal connected.
    hook.onConnected();

    // Seed prevModel from initial state.
    const seedPanes = new Map<PaneId, { cols: number; rows: number }>();
    for (const [pid, p] of initial.panes) {
      seedPanes.set(pid, { cols: p.cols, rows: p.rows });
    }
    const seedWindows = new Map<WindowId, { name: string; layout: WindowLayout }>();
    for (const [wid, w] of initial.windows) {
      seedWindows.set(wid, { name: w.name, layout: w.layout });
    }
    prevModel = {
      panes: seedPanes,
      windows: seedWindows,
      focus: { paneId: initial.focus.paneId, windowId: initial.focus.windowId },
      exitCodes: initial.exitCodes,
    };

    // ── Subscribe to future model changes ────────────────────────────────────

    const unsubModel = this.onModelChange((newModel) => {
      if (detached) return;
      applyModelDiff(newModel);
    });
    this.#attachUnsubs.push(unsubModel);

    // Store byteUnsubs teardown in attachUnsubs.
    this.#attachUnsubs.push(() => {
      detached = true;
      for (const unsub of byteUnsubs.values()) {
        unsub();
      }
      byteUnsubs.clear();
      hook.onDisconnected("mirror detached");
    });
  }

  /**
   * Detach the render hook attached via `attach()`.
   *
   * Fires `hook.onDisconnected("mirror detached")`, unsubscribes all byte
   * sources, and removes the model-change listener.  Safe to call before
   * `attach()` (no-op).
   */
  detachHook(): void {
    for (const unsub of this.#attachUnsubs) {
      unsub();
    }
    this.#attachUnsubs.length = 0;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #emitChange(model: ClientModel): void {
    for (const handler of this.#changeHandlers) {
      handler(model);
    }
  }

  #emitResync(gap: SeqGapInfo): void {
    for (const handler of this.#resyncHandlers) {
      handler(gap);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a `Mirror` already wired to a `DaemonConnection`.
 *
 * Convenience wrapper around `new Mirror()` + `mirror.connectTo(connection)`.
 * Call after `await connection.connect()`.
 *
 * ```ts
 * const session = await connection.connect();
 * const mirror = createMirror(connection);
 * mirror.onModelChange((m) => render(m));
 * ```
 */
export function createMirror(connection: DaemonConnection): Mirror {
  const mirror = new Mirror();
  mirror.connectTo(connection);
  return mirror;
}
