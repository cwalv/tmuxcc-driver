/**
 * Model→wire projection for the tmuxcc daemon (tc-7gp, updated tc-j9c.2).
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
 * ## Single-session (v3)
 * The daemon wire is single-session. `projectSnapshot` takes the first session
 * from the model as the bound session. `diffModel` emits only
 * `DaemonSessionRenamedMessage` for session renames (no session.added,
 * session.closed, session.changed). The `sessionId` field is absent from
 * all pane/window/layout/focus deltas.
 *
 * ## SnapshotPane and pane bytes
 * `SnapshotPane` in daemon-control.ts does NOT carry pane byte content.
 * Initial byte sync is therefore the data-plane's responsibility (tc-2mq /
 * tc-fbz), not the projection's.
 *
 * ## Sequence numbers (seq)
 * `seq` is a per-connection counter owned by the SENDER (spec: MessageBase).
 * The daemon runtime (E4 / tc-dv3) maintains the counter and passes `nextSeq`
 * via `ProjectSnapshotOpts`. If not supplied, `projectSnapshot` starts at 2
 * (the snapshot is always the second message after capabilities at seq=1).
 * `diffModel` does NOT assign seq values — the returned delta array has
 * `seq: 0` placeholders. The E4 caller stamps actual seq values before sending,
 * iterating the array in order. This lets the projection stay stateless (no
 * connection state).
 *
 * ## Delta ordering rule
 * Deltas are ordered so a client can always apply them sequentially without
 * referencing an entity that hasn't been announced yet:
 *
 *   1. window.added        — new windows (panes reference them)
 *   2. pane.opened         — new panes
 *   3. layout.updated      — window layout changes (may ref existing panes)
 *   4. pane.resized        — size changes on existing panes
 *   5. pane.mode-changed   — mode changes on existing panes
 *   6. window.renamed      — renames (entity already exists)
 *   7. session.renamed     — session rename
 *   8. focus.changed       — focus (all referenced entities now exist)
 *   9. pane.closed         — removals after any focus update away from them
 *  10. window.closed       — window removals after pane removals
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
  WindowSyncChangedMessage,
  LayoutUpdatedMessage,
  FocusChangedMessage,
  DaemonSessionRenamedMessage,
} from "../wire/daemon-control.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for projectSnapshot.
 *
 * `seq`: the sequence number to stamp on the snapshot message. The E4 daemon
 * runtime owns the per-connection counter and passes it here. Defaults to 2
 * (snapshot is always the second daemon→client message after capabilities
 * at seq=1).
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
 * handshake. The snapshot carries the bound session, flat arrays
 * (windows, panes), and the focus pair. All ids are the model's branded ids
 * (same types as the wire uses — no conversion needed).
 *
 * Assumes the model has exactly one session (the daemon's bound session).
 * If the model is empty (no sessions), returns a snapshot with a placeholder
 * session identity.
 *
 * SnapshotPane does NOT carry pane byte content; initial byte delivery is the
 * data-plane's responsibility (see module-level design notes).
 */
export function projectSnapshot(
  model: SessionModel,
  opts: ProjectSnapshotOpts = {},
): SnapshotMessage {
  const seq = opts.seq ?? 2;
  const attachedClientCount = opts.attachedClientCount;

  // Take the first (and only) session as the bound session.
  const sessEntry = model.sessions.values().next().value;
  const session: SnapshotSession = sessEntry
    ? { sessionId: sessEntry.sessionId, name: sessEntry.name }
    : { sessionId: "" as import("../wire/ids.js").SessionId, name: "" };

  const windows: SnapshotWindow[] = [];
  for (const win of model.windows.values()) {
    windows.push({
      windowId: win.windowId,
      name: win.name,
      active: model.sessions.get(win.sessionId)?.activeWindowId === win.windowId,
      // layout is required by SnapshotWindow; use a zero-pane placeholder when
      // null (bootstrap lag — layout arrives via %layout-change shortly after).
      layout: win.layout ?? {
        cols: 0,
        rows: 0,
        root: { kind: "pane", paneId: "" as import("../wire/ids.js").PaneId, rect: { x: 0, y: 0, cols: 0, rows: 0 } },
      },
      // tc-7xv.12: synchronize-panes state at snapshot time.
      synchronizePanes: win.synchronizePanes,
    });
  }

  const panes: SnapshotPane[] = [];
  for (const pane of model.panes.values()) {
    panes.push({
      paneId: pane.paneId,
      windowId: pane.windowId,
      cols: pane.cols,
      rows: pane.rows,
    });
  }

  const msg: SnapshotMessage = {
    type: "snapshot",
    seq,
    session,
    windows,
    panes,
    focus: {
      paneId: model.focus.paneId,
      windowId: model.focus.windowId,
    },
  };
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
  // 1. window.added — new windows
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    if (!prev.windows.has(id)) {
      // Determine active flag: is this the activeWindowId in its owning session?
      const sess = next.sessions.get(win.sessionId);
      const msg: WindowAddedMessage = {
        type: "window.added",
        seq: SEQ,
        windowId: win.windowId,
        name: win.name,
        active: sess?.activeWindowId === win.windowId,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 2. pane.opened — new panes
  // -------------------------------------------------------------------------
  for (const [id, pane] of next.panes) {
    if (!prev.panes.has(id)) {
      const win = next.windows.get(pane.windowId);
      const msg: PaneOpenedMessage = {
        type: "pane.opened",
        seq: SEQ,
        paneId: pane.paneId,
        windowId: pane.windowId,
        cols: pane.cols,
        rows: pane.rows,
        active: win?.activePaneId === pane.paneId,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 3. layout.updated — changed window layouts (for existing windows)
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    const prevWin = prev.windows.get(id);
    if (!prevWin) continue; // already handled in window.added
    if (!layoutsEqual(prevWin.layout, win.layout) && win.layout !== null) {
      const msg: LayoutUpdatedMessage = {
        type: "layout.updated",
        seq: SEQ,
        windowId: win.windowId,
        layout: win.layout,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 4. pane.resized — size changes on existing panes
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
  // 5. pane.mode-changed — mode changes on existing panes
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
  // 6. window.renamed — name changes on existing windows
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
  // 6b. window.sync.changed — synchronize-panes toggle on existing windows (tc-7xv.12)
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    const prevWin = prev.windows.get(id);
    if (!prevWin) continue; // new windows handled above
    if (prevWin.synchronizePanes !== win.synchronizePanes) {
      const msg: WindowSyncChangedMessage = {
        type: "window.sync.changed",
        seq: SEQ,
        windowId: win.windowId,
        on: win.synchronizePanes,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 7. session.renamed — name change on the bound session
  // -------------------------------------------------------------------------
  const prevSess = prev.sessions.values().next().value;
  const nextSess = next.sessions.values().next().value;
  if (prevSess && nextSess && prevSess.name !== nextSess.name) {
    const msg: DaemonSessionRenamedMessage = {
      type: "session.renamed",
      seq: SEQ,
      newName: nextSess.name,
    };
    out.push(msg);
  }

  // -------------------------------------------------------------------------
  // 8. focus.changed — focus pair changed
  // -------------------------------------------------------------------------
  if (
    prev.focus.paneId !== next.focus.paneId ||
    prev.focus.windowId !== next.focus.windowId
  ) {
    const msg: FocusChangedMessage = {
      type: "focus.changed",
      seq: SEQ,
      paneId: next.focus.paneId,
      windowId: next.focus.windowId,
    };
    out.push(msg);
  }

  // -------------------------------------------------------------------------
  // 9. pane.closed — removed panes (after focus update away from them)
  // -------------------------------------------------------------------------
  for (const [id, pane] of prev.panes) {
    if (!next.panes.has(id)) {
      const msg: PaneClosedMessage = {
        type: "pane.closed",
        seq: SEQ,
        paneId: pane.paneId,
        windowId: pane.windowId,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 10. window.closed — removed windows (after pane removals)
  // -------------------------------------------------------------------------
  for (const [id, win] of prev.windows) {
    if (!next.windows.has(id)) {
      const msg: WindowClosedMessage = {
        type: "window.closed",
        seq: SEQ,
        windowId: win.windowId,
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
