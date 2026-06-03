/**
 * Model→wire projection for the tmuxcc daemon (tc-7gp).
 *
 * Two entry points:
 *   - `projectSnapshot(model, opts?)` — full-state snapshot for a new client.
 *   - `diffModel(prev, next)` — minimal incremental deltas between two model
 *     versions, for ongoing broadcast to connected clients.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES
 * ---------------------------------------------------------------------------
 *
 * ## SnapshotPane and pane bytes
 * `SnapshotPane` in control.ts does NOT carry pane byte content (no `contents`
 * field — only paneId, windowId, sessionId, cols, rows). Initial byte sync is
 * therefore the data-plane's responsibility (tc-2mq / tc-fbz), not the
 * projection's. `projectSnapshot` therefore takes only the `SessionModel` and
 * does not require a `PaneBufferStore`. If a future schema revision adds
 * `contents` to `SnapshotPane`, inject a `PaneBufferStore` via `opts` at that
 * point.
 *
 * ## Sequence numbers (seq)
 * `seq` is a per-connection counter owned by the SENDER (spec: MessageBase).
 * The daemon runtime (E4 / tc-dv3) maintains the counter and passes `nextSeq`
 * via `ProjectSnapshotOpts`. If not supplied, `projectSnapshot` starts at 1
 * (safe for testing; callers responsible for correct sequencing in production).
 * `diffModel` does NOT assign seq values — the returned delta array has
 * `seq: 0` placeholders. The E4 caller stamps actual seq values before sending,
 * iterating the array in order. This lets the projection stay stateless (no
 * connection state).
 *
 * ## Delta ordering rule
 * Deltas are ordered so a client can always apply them sequentially without
 * referencing an entity that hasn't been announced yet:
 *
 *   1. session.added       — new sessions first (windows/panes reference them)
 *   2. window.added        — new windows (panes reference them)
 *   3. pane.opened         — new panes
 *   4. layout.updated      — window layout changes (may ref existing panes)
 *   5. pane.resized        — size changes on existing panes
 *   6. pane.mode-changed   — mode changes on existing panes
 *   7. window.renamed      — renames (entity already exists)
 *   8. session.renamed     — renames
 *   9. session.changed     — active-session pointer change
 *  10. focus.changed       — focus (all referenced entities now exist)
 *  11. pane.closed         — removals after any focus update away from them
 *  12. window.closed       — window removals after pane removals
 *  13. session.closed      — session removals last
 *
 * Within each group, ordering is Map-iteration order (stable insertion order).
 *
 * ## Round-trip guarantee
 * The test file (projection.test.ts) proves:
 *   `applyDeltas(projectSnapshot(prev), diffModel(prev, next))`
 *   deep-equals `projectSnapshot(next)`
 * for several prev/next pairs including multi-change scenarios.
 * `applyDeltas` is a reference implementation in the test file itself.
 */

import type { SessionModel } from "./model.js";
import type {
  SnapshotMessage,
  SnapshotSession,
  SnapshotWindow,
  SnapshotPane,
  DaemonMessage,
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  PaneModeChangedMessage,
  WindowAddedMessage,
  WindowClosedMessage,
  WindowRenamedMessage,
  LayoutUpdatedMessage,
  FocusChangedMessage,
  SessionAddedMessage,
  SessionClosedMessage,
  SessionChangedMessage,
  SessionRenamedMessage,
} from "../wire/control.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for projectSnapshot.
 *
 * `seq`: the sequence number to stamp on the snapshot message. The E4 daemon
 * runtime owns the per-connection counter and passes it here. Defaults to 1
 * (safe for tests; callers must supply the correct value in production).
 *
 * `attachedClientCount`: the number of daemon-protocol clients connected at
 * snapshot time (tc-1elae, §11.4 tooltip). The serve layer (tc-dv3) passes
 * `server.clientCount()` here. Omit to leave the field absent (backwards-
 * compatible; older clients simply do not read it).
 */
export interface ProjectSnapshotOpts {
  readonly seq?: number;
  readonly attachedClientCount?: number;
}

/**
 * Project the full model state into a wire SnapshotMessage.
 *
 * Called once per new client connection, immediately after the capabilities
 * handshake. The snapshot carries flat arrays (sessions, windows, panes) plus
 * the focus triple. All ids are the model's branded ids (same types as the
 * wire uses — no conversion needed).
 *
 * SnapshotPane does NOT carry pane byte content; initial byte delivery is the
 * data-plane's responsibility (see module-level design notes).
 */
export function projectSnapshot(
  model: SessionModel,
  opts: ProjectSnapshotOpts = {},
): SnapshotMessage {
  const seq = opts.seq ?? 1;
  const attachedClientCount = opts.attachedClientCount;

  const sessions: SnapshotSession[] = [];
  for (const sess of model.sessions.values()) {
    sessions.push({
      sessionId: sess.sessionId,
      name: sess.name,
      active: model.focus.sessionId === sess.sessionId,
    });
  }

  const windows: SnapshotWindow[] = [];
  for (const win of model.windows.values()) {
    windows.push({
      windowId: win.windowId,
      sessionId: win.sessionId,
      name: win.name,
      active: model.sessions.get(win.sessionId)?.activeWindowId === win.windowId,
      // layout is required by SnapshotWindow; use a zero-pane placeholder when
      // null (bootstrap lag — layout arrives via %layout-change shortly after).
      // The wire type requires WindowLayout, not WindowLayout | null, so we
      // synthesize a minimal valid tree. paneId is set to "" (empty) because
      // the placeholder is a type-only sentinel and must be stable/predictable
      // for round-trip reconstruction (applyDeltas produces the same zero-rect
      // placeholder for window.added; no layout.updated is emitted until the
      // model has a real layout).
      layout: win.layout ?? {
        cols: 0,
        rows: 0,
        root: { kind: "pane", paneId: "" as import("../wire/ids.js").PaneId, rect: { x: 0, y: 0, cols: 0, rows: 0 } },
      },
    });
  }

  const panes: SnapshotPane[] = [];
  for (const pane of model.panes.values()) {
    panes.push({
      paneId: pane.paneId,
      windowId: pane.windowId,
      sessionId: pane.sessionId,
      cols: pane.cols,
      rows: pane.rows,
    });
  }

  const msg: SnapshotMessage = {
    type: "snapshot",
    seq,
    sessions,
    windows,
    panes,
    focus: {
      paneId: model.focus.paneId,
      windowId: model.focus.windowId,
      sessionId: model.focus.sessionId,
    },
  };
  // tc-1elae: include attachedClientCount when provided (omit to keep the
  // field absent for backwards compatibility with older consumers).
  if (attachedClientCount !== undefined) {
    return { ...msg, attachedClientCount };
  }
  return msg;
}

/**
 * Compute the minimal set of wire delta messages that transforms a client
 * holding `prev` into the state described by `next`.
 *
 * Returned messages have `seq: 0` — the E4 runtime stamps real seq values
 * before sending, iterating the array in order. Caller must NOT reorder the
 * array, as the ordering rule (see module-level notes) ensures a client can
 * apply the deltas without referencing a not-yet-announced entity.
 *
 * Returns an empty array if `prev` and `next` are observably identical.
 */
export function diffModel(prev: SessionModel, next: SessionModel): DaemonMessage[] {
  const out: DaemonMessage[] = [];

  // Placeholder seq — the E4 caller assigns real values before sending.
  const SEQ = 0;

  // -------------------------------------------------------------------------
  // 1. session.added — new sessions
  // -------------------------------------------------------------------------
  for (const [id, sess] of next.sessions) {
    if (!prev.sessions.has(id)) {
      const msg: SessionAddedMessage = {
        type: "session.added",
        seq: SEQ,
        sessionId: sess.sessionId,
        name: sess.name,
        active: next.focus.sessionId === sess.sessionId,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 2. window.added — new windows
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    if (!prev.windows.has(id)) {
      const sess = next.sessions.get(win.sessionId);
      const msg: WindowAddedMessage = {
        type: "window.added",
        seq: SEQ,
        windowId: win.windowId,
        sessionId: win.sessionId,
        name: win.name,
        active: sess?.activeWindowId === win.windowId,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 3. pane.opened — new panes
  // -------------------------------------------------------------------------
  for (const [id, pane] of next.panes) {
    if (!prev.panes.has(id)) {
      const win = next.windows.get(pane.windowId);
      const msg: PaneOpenedMessage = {
        type: "pane.opened",
        seq: SEQ,
        paneId: pane.paneId,
        windowId: pane.windowId,
        sessionId: pane.sessionId,
        cols: pane.cols,
        rows: pane.rows,
        active: win?.activePaneId === pane.paneId,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 4. layout.updated — changed window layouts (for existing windows)
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    const prevWin = prev.windows.get(id);
    if (!prevWin) continue; // already handled in window.added
    if (!layoutsEqual(prevWin.layout, win.layout) && win.layout !== null) {
      const msg: LayoutUpdatedMessage = {
        type: "layout.updated",
        seq: SEQ,
        windowId: win.windowId,
        sessionId: win.sessionId,
        layout: win.layout,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 5. pane.resized — size changes on existing panes
  // -------------------------------------------------------------------------
  for (const [id, pane] of next.panes) {
    const prevPane = prev.panes.get(id);
    if (!prevPane) continue; // already handled in pane.opened
    if (prevPane.cols !== pane.cols || prevPane.rows !== pane.rows) {
      const msg: PaneResizedMessage = {
        type: "pane.resized",
        seq: SEQ,
        paneId: pane.paneId,
        cols: pane.cols,
        rows: pane.rows,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 6. pane.mode-changed — mode changes on existing panes
  // -------------------------------------------------------------------------
  for (const [id, pane] of next.panes) {
    const prevPane = prev.panes.get(id);
    if (!prevPane) continue; // already handled in pane.opened
    if (prevPane.mode !== pane.mode) {
      const msg: PaneModeChangedMessage = {
        type: "pane.mode-changed",
        seq: SEQ,
        paneId: pane.paneId,
        mode: pane.mode,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 7. window.renamed — name changes on existing windows
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    const prevWin = prev.windows.get(id);
    if (!prevWin) continue; // already handled in window.added
    if (prevWin.name !== win.name) {
      const msg: WindowRenamedMessage = {
        type: "window.renamed",
        seq: SEQ,
        windowId: win.windowId,
        newName: win.name,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 8. session.renamed — name changes on existing sessions
  // -------------------------------------------------------------------------
  for (const [id, sess] of next.sessions) {
    const prevSess = prev.sessions.get(id);
    if (!prevSess) continue; // already handled in session.added
    if (prevSess.name !== sess.name) {
      const msg: SessionRenamedMessage = {
        type: "session.renamed",
        seq: SEQ,
        sessionId: sess.sessionId,
        newName: sess.name,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 9. session.changed — active session pointer changed
  // -------------------------------------------------------------------------
  if (
    prev.focus.sessionId !== next.focus.sessionId &&
    next.focus.sessionId !== null
  ) {
    const msg: SessionChangedMessage = {
      type: "session.changed",
      seq: SEQ,
      newActiveSessionId: next.focus.sessionId,
    };
    out.push(msg);
  }

  // -------------------------------------------------------------------------
  // 10. focus.changed — focus triple changed
  // -------------------------------------------------------------------------
  if (
    prev.focus.paneId !== next.focus.paneId ||
    prev.focus.windowId !== next.focus.windowId ||
    prev.focus.sessionId !== next.focus.sessionId
  ) {
    const msg: FocusChangedMessage = {
      type: "focus.changed",
      seq: SEQ,
      paneId: next.focus.paneId,
      windowId: next.focus.windowId,
      sessionId: next.focus.sessionId,
    };
    out.push(msg);
  }

  // -------------------------------------------------------------------------
  // 11. pane.closed — removed panes (after focus update away from them)
  // -------------------------------------------------------------------------
  for (const [id, pane] of prev.panes) {
    if (!next.panes.has(id)) {
      const msg: PaneClosedMessage = {
        type: "pane.closed",
        seq: SEQ,
        paneId: pane.paneId,
        windowId: pane.windowId,
        sessionId: pane.sessionId,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 12. window.closed — removed windows (after pane removals)
  // -------------------------------------------------------------------------
  for (const [id, win] of prev.windows) {
    if (!next.windows.has(id)) {
      const msg: WindowClosedMessage = {
        type: "window.closed",
        seq: SEQ,
        windowId: win.windowId,
        sessionId: win.sessionId,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 13. session.closed — removed sessions (last)
  // -------------------------------------------------------------------------
  for (const [id, sess] of prev.sessions) {
    if (!next.sessions.has(id)) {
      const msg: SessionClosedMessage = {
        type: "session.closed",
        seq: SEQ,
        sessionId: sess.sessionId,
      };
      out.push(msg);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Structural equality for WindowLayout (or null).
 * Compared via JSON serialization — layouts are small immutable trees.
 * Returns true if both are null or both serialize identically.
 */
function layoutsEqual(
  a: import("../wire/layout.js").WindowLayout | null,
  b: import("../wire/layout.js").WindowLayout | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
