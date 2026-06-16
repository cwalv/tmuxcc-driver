/**
 * Client-side model mirror — tc-eots
 *
 * Maintains a client-side mirror of the session-proxy's session model by consuming
 * a SnapshotMessage (full-state baseline) followed by incremental delta
 * messages from the SessionProxyConnection.onControl stream.
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
 *      SessionProxyConnection to the mirror automatically.
 *
 * # Client model shape
 *
 * The `ClientModel` is intentionally simpler than the session-proxy's `SessionModel`:
 *   - No scrollback handles (session-proxy-internal).
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
  SessionProxyMessage,
  SessionProxyCommandResponseMessage,
  ClientMessage,
  ResyncRequestMessage,
  PaneId,
  WindowId,
  SessionId,
  ConnectionId,
  WindowLayout,
  PaneMode,
  Origin,
} from "@tmuxcc/session-proxy";
import type { SessionProxyConnection } from "./connection.js";
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
 * v3: sessionId is absent — the session-proxy wire is single-session and does not
 * carry sessionId on pane messages.
 */
export interface ClientPane {
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  readonly cols: number;
  readonly rows: number;
  /** Current pane mode. Defaults to "normal" after a snapshot. */
  readonly mode: PaneMode;
  /**
   * True when the pane is dead — a `remain-on-exit` corpse whose process has
   * exited but whose slot survives in tmux (tc-4bv2 / tc-295a.10 shared
   * pane-state shape). A dead pane stays in `panes` (it is reapable, not
   * gone); a pane whose slot left tmux is removed from `panes` and surfaces a
   * `pane.closed`. Defaults false. Driven by SnapshotPane.dead /
   * PaneOpenedMessage.dead / PaneDeadChangedMessage.
   */
  readonly dead: boolean;
  /**
   * Exit code when `dead` is true and known (tmux `pane_dead_status`); else
   * undefined.
   */
  readonly exitCode: number | undefined;
  /**
   * Durable, driver-owned pane name (tc-1a8z) — the canonical user rename
   * channel, stored in the per-pane `@tmuxcc_label` tmux user-option. Set ONLY
   * via the `rename-pane` command (never a title escape), so the shell cannot
   * clobber it, and it survives a driver restart. `undefined` means no durable
   * name is set.
   *
   * DISTINCT from the live shell title (tc-2mn8). Render precedence (durable
   * label > live title > paneId) is the consumer's concern (tc-asyq.6). Driven
   * by SnapshotPane.label / PaneOpenedMessage.label / PaneLabelChangedMessage.
   */
  readonly label: string | undefined;
  /**
   * tc-ozk.2: causality tag, set from the `pane.opened` delta that introduced
   * this pane. PRESENT when a wire verb caused the creation (carries the
   * verb's `{connectionId, requestId}`); ABSENT for foreign panes and for
   * panes that entered via the initial snapshot replay (the snapshot carries
   * no per-pane origin — a snapshot pane is, from this client's perspective,
   * pre-existing rather than freshly created). Read by the diff path to pass
   * `origin` through to `onPaneOpened`. Supersedes the bare `created` flag.
   */
  readonly origin: Origin | undefined;
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
 * v3: sessionId is absent — the session-proxy wire is single-session and does not
 * carry sessionId on window messages.
 */
export interface ClientWindow {
  readonly windowId: WindowId;
  readonly name: string;
  readonly active: boolean;
  readonly layout: WindowLayout;
  /**
   * True when synchronize-panes is on for this window (HANDOFF §4.5, tc-7xv.12).
   * Updated by `window.sync.changed` deltas; populated from snapshot.
   * tc-7xv.17 (b2b) reads this to render the amber pill.
   */
  readonly synchronizePanes: boolean;
  /**
   * True when monitor-activity is on for this window (tc-7xv.15).
   * Updated by `window.monitor.activity.changed` deltas; populated from snapshot.
   * Defaults to true (inherits the global `-wg monitor-activity on` default).
   */
  readonly monitorActivity: boolean;
  /**
   * Current monitor-silence threshold in seconds, or 0 when disabled (tc-7xv.15).
   * Updated by `window.monitor.silence.changed` deltas; populated from snapshot.
   * 0 = disabled (tmux `monitor-silence 0`); positive = threshold in seconds.
   */
  readonly monitorSilence: number;
}

/**
 * A session as tracked by the client mirror.
 *
 * v3: the session-proxy wire is single-session. `ClientModel.session` holds this
 * scalar directly (not a map).
 */
export interface ClientSession {
  readonly sessionId: SessionId;
  readonly name: string;
}

/**
 * Global focus pair. Both are null when no pane is focused.
 *
 * v3: sessionId is absent from focus — the session-proxy wire is single-session.
 */
export interface ClientFocus {
  readonly paneId: PaneId | null;
  readonly windowId: WindowId | null;
}

/**
 * The client-side model — a flat, normalized view of the session-proxy's session state.
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
   * Close causes for panes that have closed, keyed by paneId (tc-u7cu.6).
   *
   * Populated when a `pane.closed` delta arrives carrying a `cause` (stamped
   * by the session-proxy when a wire verb — close-pane / kill-window — caused the
   * close). Absent when the close was unsolicited (shell exit, external kill-pane).
   * The entry persists after the pane is removed from `panes` so the mirror's
   * diff path can pass the cause to `onPaneClosed`.
   * Entries are removed when the next snapshot arrives or the mirror is detached.
   */
  readonly closeCauses: ReadonlyMap<PaneId, Origin>;
  /**
   * Number of session-proxy-protocol clients currently connected to this session.
   *
   * tc-1elae (Phase 2 — §11.4): initially populated from
   * `SnapshotMessage.attachedClientCount` (static baseline at connect time).
   *
   * tc-44wu0 (Phase 4): subsequently kept live by `client-count.changed`
   * delta messages, which the session-proxy broadcasts whenever a client connects
   * or disconnects. After tc-44wu0 lands this value reflects the real-time
   * count, not merely the snapshot-time count.
   *
   * Absent (undefined) when the snapshot did not carry this field (older session-proxy
   * predating Phase 2) or before the first snapshot arrives. The status bar
   * falls back to 1 when absent.
   */
  readonly attachedClientCount: number | undefined;
  /**
   * tc-ozk.2: THIS client's own connectionId, learned from the snapshot's
   * `connectionId` field. Renderers compare it against `PaneInfo.origin?.
   * connectionId` to decide whether a creation is their own (`===` ⇒ mine).
   *
   * Absent (undefined) before the first snapshot or when the session-proxy
   * predates tc-ozk.2 (no connectionId in the snapshot). A renderer that does
   * not know its own connectionId treats every pane as foreign-by-default and
   * relies on the tc-ozk.1 `sendVerb`-returned id to bind its own panes.
   */
  readonly ownConnectionId: ConnectionId | undefined;
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
    closeCauses: new Map(),
    attachedClientCount: undefined,
    ownConnectionId: undefined,
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
      // tc-7xv.12: snapshot carries synchronizePanes; default false for older session-proxies.
      synchronizePanes: w.synchronizePanes ?? false,
      // tc-7xv.15: snapshot carries monitor state; defaults for older session-proxies.
      monitorActivity: w.monitorActivity ?? true,
      monitorSilence: w.monitorSilence ?? 0,
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
      // tc-4bv2 / tc-295a.10: a dead pane is part of the snapshot (reapable
      // corpse). Additive optional fields; absent means alive / unknown.
      dead: p.dead ?? false,
      exitCode: p.dead ? p.exitCode : undefined,
      // tc-1a8z: durable, driver-owned pane name. Absent ⇒ no name set.
      label: p.label,
      // tc-ozk.2: snapshot panes carry no per-pane origin — they are
      // pre-existing from this client's perspective, not freshly created.
      origin: undefined,
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
    // Snapshot resets all state including exit codes and close causes — panes
    // that exited before this snapshot are gone and their metadata is no longer relevant.
    exitCodes: new Map(),
    // tc-u7cu.6: snapshot resets close causes alongside exit codes.
    closeCauses: new Map(),
    // tc-1elae (§11.4): propagate the attached-client count from the snapshot
    // so TmuxccSessionHandle can surface it in the status-bar tooltip.
    attachedClientCount: snapshot.attachedClientCount,
    // tc-ozk.2: learn this client's own connectionId so the renderer can do the
    // bind-on-provenance field check (origin.connectionId === ownConnectionId).
    ownConnectionId: snapshot.connectionId,
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
 * session-proxy.capabilities, snapshot) are returned as-is (no model change).
 *
 * Returns the updated model (or the same model reference if no change is
 * needed for this message type).
 *
 * Mirror semantics follow the session-proxy's `applyDeltas` reference implementation
 * in `projection.test.ts`, so client and session-proxy agree on round-trip consistency.
 */
export function applyDelta(model: ClientModel, msg: SessionProxyMessage): ClientModel {
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
        // tc-4bv2 / tc-295a.10: a pane can be born already-dead (corpse seen
        // for the first time on requery / reconnect).
        dead: msg.dead ?? false,
        exitCode: msg.dead ? msg.exitCode : undefined,
        // tc-1a8z: born already carrying a durable name (e.g. cold attach to a
        // previously-renamed pane). Absent on the wire ⇒ no name set.
        label: msg.label,
        // tc-ozk.2: carry the verb-origin tag through to the diff path so
        // onPaneOpened reports it. Absent on the wire ⇒ foreign creation.
        origin: msg.origin,
      });
      return { ...model, panes };
    }

    // tc-4bv2 / tc-295a.10: live ↔ dead transition in place (remain-on-exit
    // corpse). The pane stays in the model; only its dead flag flips.
    case "pane.dead-changed": {
      const pane = model.panes.get(msg.paneId);
      if (!pane) return model;
      if (pane.dead === msg.dead && pane.exitCode === (msg.dead ? msg.exitCode : undefined)) {
        return model; // no observable change
      }
      const panes = new Map(model.panes);
      panes.set(msg.paneId, {
        ...pane,
        dead: msg.dead,
        exitCode: msg.dead ? msg.exitCode : undefined,
      });
      return { ...model, panes };
    }

    case "pane.closed": {
      if (!model.panes.has(msg.paneId)) return model;
      const panes = new Map(model.panes);
      panes.delete(msg.paneId);
      // Record the exit code if the session-proxy provided one.
      const exitCodes =
        msg.exitCode !== undefined
          ? (() => { const m = new Map(model.exitCodes); m.set(msg.paneId, msg.exitCode!); return m; })()
          : model.exitCodes;
      // tc-u7cu.6: record the close cause if the session-proxy provided one.
      const closeCauses =
        msg.cause !== undefined
          ? (() => { const m = new Map(model.closeCauses); m.set(msg.paneId, msg.cause!); return m; })()
          : model.closeCauses;
      return { ...model, panes, exitCodes, closeCauses };
    }

    case "pane.resized": {
      const pane = model.panes.get(msg.paneId);
      if (!pane) return model;
      const panes = new Map(model.panes);
      panes.set(msg.paneId, { ...pane, cols: msg.cols, rows: msg.rows });
      return { ...model, panes };
    }

    // tc-1a8z: the durable, driver-owned pane name changed. `label` absent on
    // the wire ⇒ the name was cleared (back to undefined).
    case "pane.label-changed": {
      const pane = model.panes.get(msg.paneId);
      if (!pane) return model;
      if (pane.label === msg.label) return model; // no observable change
      const panes = new Map(model.panes);
      panes.set(msg.paneId, { ...pane, label: msg.label });
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
        // New windows default to synchronize-panes off.
        synchronizePanes: false,
        // New windows inherit the global monitor-activity default (on).
        // tc-7xv.15: the global `-wg monitor-activity on` is set at bootstrap.
        monitorActivity: true,
        monitorSilence: 0,
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

    // tc-7xv.12: synchronize-panes toggle
    case "window.sync.changed": {
      const win = model.windows.get(msg.windowId);
      if (!win) return model;
      if (win.synchronizePanes === msg.on) return model; // no change
      const windows = new Map(model.windows);
      windows.set(msg.windowId, { ...win, synchronizePanes: msg.on });
      return { ...model, windows };
    }

    // ── Monitor state (tc-7xv.15) ────────────────────────────────────────────

    // tc-7xv.15: monitor-activity toggle
    case "window.monitor.activity.changed": {
      const win = model.windows.get(msg.windowId);
      if (!win) return model;
      if (win.monitorActivity === msg.on) return model; // no change
      const windows = new Map(model.windows);
      windows.set(msg.windowId, { ...win, monitorActivity: msg.on });
      return { ...model, windows };
    }

    // tc-7xv.15: monitor-silence toggle
    case "window.monitor.silence.changed": {
      const win = model.windows.get(msg.windowId);
      if (!win) return model;
      if (win.monitorSilence === msg.seconds) return model; // no change
      const windows = new Map(model.windows);
      windows.set(msg.windowId, { ...win, monitorSilence: msg.seconds });
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

    // ── Session lifecycle (v3: only session.renamed on session-proxy wire) ───────────

    case "session.renamed": {
      // v3: SessionProxySessionRenamedMessage has no sessionId — updates the bound session.
      return { ...model, session: { ...model.session, name: msg.newName } };
    }

    // ── Client-count delta (tc-44wu0) ────────────────────────────────────────

    case "client-count.changed": {
      // Live update from the session-proxy when a client attaches or detaches.
      // Updates attachedClientCount so the status-bar tooltip reflects the
      // current count without requiring a full resync.
      return { ...model, attachedClientCount: msg.count };
    }

    // ── Non-model messages (pass through unchanged) ──────────────────────────

    case "snapshot":
      // Full snapshot — call applySnapshot() instead.
      return model;

    case "session-proxy.capabilities":
    case "command.response":
    case "error":
      // Not state-bearing for the mirror.
      return model;

    // ── Per-pane attach + hydration protocol (tc-295a.8 / tc-295a.9) ──────────
    //
    // These do not change the topology model — hydration is a data-plane event
    // and pane.attach.failed is an error surface. They are seq-tracked (see
    // receiveDelta) so they do not create false gaps, and surfaced to renderers
    // via Mirror.onHydrationEvent. The model is returned unchanged.
    case "pane.attach.failed":
    case "pane.hydration.begin":
    case "pane.hydration.end":
      return model;

    // ── Exhaustiveness check ─────────────────────────────────────────────────
    default: {
      // TypeScript will error here if a new SessionProxyMessage variant is added but
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
 * Handler for `command.response` messages observed on the control stream
 * (tc-ozk.1).  The mirror itself is not state-bearing for these, but it owns
 * the single-slot `onControl` handler, so it forwards each response here.
 * connectClient routes this to the InputApi so awaited `sendVerb` promises
 * resolve with the returned effect ids.
 */
export type CommandResponseHandler = (msg: SessionProxyCommandResponseMessage) => void;

/**
 * A per-pane attach / hydration protocol event surfaced by the mirror
 * (tc-295a.8 / tc-295a.9).
 *
 *   "begin"      — pane.hydration.begin: the session-proxy is about to deliver
 *                  the clear-then-replay frame for `paneId`. Live bytes for the
 *                  pane during the window are queued by the DRIVER, so a renderer
 *                  need not act — but MAY (e.g. show a "loading scrollback" hint).
 *   "end"        — pane.hydration.end: hydration done; live output resumes.
 *   "not-found"  — pane.attach.failed{pane.not-found}: the attach targeted a pane
 *                  the session-proxy does not know about. Fail-loud: renderers
 *                  should surface this (the user's bindNew hit a vanished pane).
 *
 * Ordering is a driver guarantee; the data-plane bytes are correct regardless of
 * whether the renderer consumes these. The hook exists for UI affordances and to
 * close the §1.4 bindNew flow's loud-failure path.
 */
export interface HydrationEvent {
  readonly kind: "begin" | "end" | "not-found";
  readonly paneId: PaneId;
  /** Present only for "not-found": the named error code and message. */
  readonly code?: string;
  readonly message?: string;
}

/** Handler for hydration / attach protocol events from the mirror. */
export type HydrationEventHandler = (event: HydrationEvent) => void;

/**
 * Stateful client-side mirror of the session-proxy session model.
 *
 * Usage (pure manual drive):
 * ```ts
 * const mirror = new Mirror();
 * mirror.onModelChange((m) => render(m));
 * mirror.onResyncNeeded(({ expected, received }) => {
 *   // request a fresh snapshot from the session-proxy
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
  // When a seq gap is detected the mirror sends `resync.request` to the session-proxy
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
  // (and any other client→session-proxy messages the mirror may send in the future).
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
  // tc-ozk.1: forwarders for command.response messages (not state-bearing for
  // the mirror, but the mirror owns the single-slot onControl handler).
  readonly #commandResponseHandlers: CommandResponseHandler[] = [];
  readonly #hydrationHandlers: HydrationEventHandler[] = [];

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
   * should request a fresh snapshot from the session-proxy and call `receiveSnapshot`
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

  /**
   * Register a handler that fires for every `command.response` seen on the
   * control stream (tc-ozk.1).
   *
   * The mirror forwards these unchanged — it does not interpret them.
   * connectClient wires this to `InputApi.handleCommandResponse` so awaited
   * `sendVerb` promises resolve with the returned effect ids.  Handlers are
   * APPENDED; returns an unsubscribe function.
   */
  onCommandResponse(handler: CommandResponseHandler): () => void {
    this.#commandResponseHandlers.push(handler);
    return () => {
      const idx = this.#commandResponseHandlers.indexOf(handler);
      if (idx !== -1) this.#commandResponseHandlers.splice(idx, 1);
    };
  }

  /**
   * Register a handler for per-pane attach / hydration protocol events
   * (tc-295a.8 / tc-295a.9): pane.hydration.begin/end and pane.attach.failed.
   *
   * Handlers are APPENDED. Returns an unsubscribe function.
   *
   * The render hook (E6) registers here to surface the §1.4 bindNew loud
   * failure (pane.not-found) and any hydration-boundary UI affordances.
   */
  onHydrationEvent(handler: HydrationEventHandler): () => void {
    this.#hydrationHandlers.push(handler);
    return () => {
      const idx = this.#hydrationHandlers.indexOf(handler);
      if (idx !== -1) this.#hydrationHandlers.splice(idx, 1);
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
   * If the message type is not a delta (snapshot, session-proxy.capabilities,
   * command.response, error), it is silently ignored.
   *
   * Fires `onModelChange` handlers on successful apply.
   */
  receiveDelta(msg: SessionProxyMessage): void {
    // command.response is non-state-bearing for the topology model, but it
    // still must reach the sendVerb-correlation handlers (tc-ozk.1) — and it
    // may legitimately arrive BEFORE the mirror is initialized (a verb issued
    // on a connection whose snapshot is still in flight). Forward it to the
    // handlers up front, regardless of init/seq state, so awaited sendVerb
    // promises resolve. Seq accounting (below) is still applied once
    // initialized — see the non-state-bearing seq-tracking block.
    if (msg.type === "command.response") {
      for (const handler of this.#commandResponseHandlers) {
        handler(msg);
      }
    }

    // Not yet initialized — ignore (command.response handlers already fired).
    if (!this.#initialized || this.#lastSeq === null) return;

    // Snapshot messages should go to receiveSnapshot, not here.
    if (msg.type === "snapshot") return;

    // Seq-gap detection.
    //
    // tc-295a.31: EVERY server-sent control message consumes a seq slot from
    // the per-connection monotonic counter (envelope.ts MessageBase) — incl.
    // the non-state-bearing command.response / error / capabilities. The server
    // (serve.ts sendCommandResponse / broadcastError) stamps and increments
    // `state.nextSeq` for them, so the mirror MUST account for their seq too.
    // Pre-fix, command.response/error/capabilities were early-returned without
    // advancing #lastSeq; once W2.1 (tc-ozk.1) started emitting a seq-stamped
    // command.response on every creating verb, the next real delta read as a
    // false gap → resync → the split's pane.opened was dropped (the regression).
    // The fix: run gap detection on these too, then advance #lastSeq without
    // applying any model change (same shape as the pane.hydration.* handling
    // below, which W2.2 already seq-tracks for the identical reason).
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

    // tc-295a.31: non-state-bearing server messages (command.response / error /
    // capabilities) are seq-tracked — advance #lastSeq so they don't create a
    // false gap on the NEXT real delta — but they carry no topology change, so
    // no applyDelta / onModelChange. command.response handlers already fired at
    // the top of this method; here we only consume its seq slot.
    if (
      msg.type === "command.response" ||
      msg.type === "error" ||
      msg.type === "session-proxy.capabilities"
    ) {
      this.#lastSeq = msg.seq;
      return;
    }

    // tc-295a.8 / tc-295a.9: per-pane attach + hydration protocol messages are
    // seq-tracked (advance #lastSeq so they don't create false gaps) but do not
    // change the topology model. Surface them on the hydration-event hook
    // instead of firing onModelChange.
    if (
      msg.type === "pane.attach.failed" ||
      msg.type === "pane.hydration.begin" ||
      msg.type === "pane.hydration.end"
    ) {
      this.#lastSeq = msg.seq;
      if (msg.type === "pane.hydration.begin") {
        this.#emitHydration({ kind: "begin", paneId: msg.paneId });
      } else if (msg.type === "pane.hydration.end") {
        this.#emitHydration({ kind: "end", paneId: msg.paneId });
      } else {
        this.#emitHydration({
          kind: "not-found",
          paneId: msg.paneId,
          code: msg.code,
          message: msg.message,
        });
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
   * Wire this mirror to a `SessionProxyConnection`.
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
   * SessionProxyConnection API, so the unsubscribe replaces it with a no-op).
   *
   * NOTE: `SessionProxyConnection.onControl` is a single-slot handler (replace
   * semantics, not append). If another consumer also calls `onControl`, it
   * will replace this mirror's handler. In that case, route messages manually
   * via `receiveSnapshot` / `receiveDelta` instead.
   *
   * Call AFTER `await connection.connect()` so buffered messages are delivered.
   */
  connectTo(connection: SessionProxyConnection): () => void {
    // Inject the send/close capabilities for autonomous resync-request (tc-7ml.4).
    this.#sendFn = (msg: ResyncRequestMessage) => {
      // SessionProxyConnection.send() accepts ClientMessage; ResyncRequestMessage
      // is a member of ClientMessage, so this cast is safe.
      connection.send(msg as ClientMessage);
    };
    this.#closeFn = () => {
      connection.close();
    };

    const handler = (msg: SessionProxyMessage): void => {
      if (msg.type === "snapshot") {
        this.receiveSnapshot(msg);
      } else {
        this.receiveDelta(msg);
      }
    };
    connection.onControl(handler);
    // Return a no-op unsubscribe (SessionProxyConnection.onControl is replace-only;
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
      panes: ReadonlyMap<PaneId, { cols: number; rows: number; dead: boolean; exitCode: number | undefined; label: string | undefined }>;
      windows: ReadonlyMap<WindowId, { name: string; layout: WindowLayout }>;
      focus: { paneId: PaneId | null; windowId: WindowId | null };
      exitCodes: ReadonlyMap<PaneId, number>;
      closeCauses: ReadonlyMap<PaneId, Origin>;
    } = {
      panes: new Map(),
      windows: new Map(),
      focus: { paneId: null, windowId: null },
      exitCodes: new Map(),
      closeCauses: new Map(),
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

      // Panes: added / removed / resized / dead-state changed
      for (const [pid, pane] of curr.panes) {
        const prevPane = prev.panes.get(pid);
        if (prevPane === undefined) {
          hook.onPaneOpened({
            paneId: pane.paneId,
            windowId: pane.windowId,
            cols: pane.cols,
            rows: pane.rows,
            active: pane.paneId === curr.focus.paneId,
            // tc-ozk.2: pass the verb-origin tag through (PRESENT ⇒ caused by a
            // wire verb; ABSENT ⇒ foreign). Supersedes the bare `created` flag.
            ...(pane.origin !== undefined ? { origin: pane.origin } : {}),
            // tc-4bv2 / tc-295a.10: carry born-dead state so the renderer can
            // mark the corpse without waiting for a separate event.
            ...(pane.dead ? { dead: true } : {}),
            ...(pane.dead && pane.exitCode !== undefined ? { exitCode: pane.exitCode } : {}),
            // tc-1a8z: carry a durable name so the renderer composes it on open.
            ...(pane.label !== undefined ? { label: pane.label } : {}),
          });
          subscribeBytes(pid);
        } else {
          if (prevPane.cols !== pane.cols || prevPane.rows !== pane.rows) {
            hook.onPaneResized(pid, pane.cols, pane.rows);
          }
          // tc-4bv2 / tc-295a.10: dead-state flip on an existing pane.
          if (prevPane.dead !== pane.dead || prevPane.exitCode !== pane.exitCode) {
            hook.onPaneDeadChanged(pid, pane.dead, pane.dead ? pane.exitCode : undefined);
          }
          // tc-1a8z: durable pane-name change on an existing pane.
          if (prevPane.label !== pane.label) {
            hook.onPaneLabelChanged(pid, pane.label);
          }
        }
      }
      for (const [pid] of prev.panes) {
        if (!curr.panes.has(pid)) {
          // Pass the exit code if the session-proxy provided one (carried in exitCodes).
          const exitCode = curr.exitCodes.get(pid);
          // tc-u7cu.6: pass the close cause if the session-proxy provided one.
          const cause = curr.closeCauses.get(pid);
          hook.onPaneClosed(pid, exitCode, cause);
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
      const newPanes = new Map<PaneId, { cols: number; rows: number; dead: boolean; exitCode: number | undefined; label: string | undefined }>();
      for (const [pid, p] of curr.panes) {
        newPanes.set(pid, { cols: p.cols, rows: p.rows, dead: p.dead, exitCode: p.exitCode, label: p.label });
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
        closeCauses: curr.closeCauses,
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
        // tc-ozk.2: initial-snapshot replay panes carry no origin (the snapshot
        // has no per-pane origin; from this client's perspective they are
        // pre-existing, not freshly created). The bind-on-provenance gate sees
        // an absent origin and treats them as foreign — except the factory's
        // first-snapshot-pane / target-pane claims, which are independent of
        // origin (they intentionally bind a replay). Supersedes `created`.
        ...(pane.origin !== undefined ? { origin: pane.origin } : {}),
        // tc-4bv2 / tc-295a.10: a pre-existing dead corpse replays into the
        // renderer already-dead. This is the all-dead-pane-session path: the
        // session is in the snapshot and its panes are dead on first render.
        ...(pane.dead ? { dead: true } : {}),
        ...(pane.dead && pane.exitCode !== undefined ? { exitCode: pane.exitCode } : {}),
        // tc-1a8z: replay a pre-existing durable name so the renderer composes
        // it on first paint.
        ...(pane.label !== undefined ? { label: pane.label } : {}),
      });
      subscribeBytes(pid);
    }

    // Focus.
    hook.onFocusChanged(initial.focus);

    // Signal connected.
    hook.onConnected();

    // Seed prevModel from initial state.
    const seedPanes = new Map<PaneId, { cols: number; rows: number; dead: boolean; exitCode: number | undefined; label: string | undefined }>();
    for (const [pid, p] of initial.panes) {
      seedPanes.set(pid, { cols: p.cols, rows: p.rows, dead: p.dead, exitCode: p.exitCode, label: p.label });
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
      closeCauses: initial.closeCauses,
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

  #emitHydration(event: HydrationEvent): void {
    for (const handler of this.#hydrationHandlers) {
      handler(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a `Mirror` already wired to a `SessionProxyConnection`.
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
export function createMirror(connection: SessionProxyConnection): Mirror {
  const mirror = new Mirror();
  mirror.connectTo(connection);
  return mirror;
}
