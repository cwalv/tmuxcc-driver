/**
 * Model→wire projection for the tmuxcc sessionProxy (tc-7gp, updated tc-j9c.2).
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
 * The session-proxy wire is single-session. `projectSnapshot` takes the first session
 * from the model as the bound session. `diffModel` emits only
 * `SessionProxySessionRenamedMessage` for session renames (no session.added,
 * session.closed, session.changed). The `sessionId` field is absent from
 * all pane/window/layout/focus deltas.
 *
 * ## SnapshotPane and pane bytes
 * `SnapshotPane` in session-proxy-control.ts does NOT carry pane byte content.
 * Initial byte sync is therefore the data-plane's responsibility (tc-2mq /
 * tc-fbz), not the projection's.
 *
 * ## Sequence numbers (seq)
 * `seq` is a per-connection counter owned by the SENDER (spec: MessageBase).
 * The session-proxy runtime (E4 / tc-dv3) maintains the counter and passes `nextSeq`
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
 *   5a2. pane.label-changed — durable pane-name changes on existing panes (tc-1a8z)
 *   5b. pane.dead-changed  — dead-state flip on existing panes (tc-4bv2/tc-295a.10)
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
import type { PaneId, WindowId } from "../wire/ids.js";
import type {
  SnapshotMessage,
  SnapshotSession,
  SnapshotWindow,
  SnapshotPane,
  SessionProxyMessage,
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  PaneModeChangedMessage,
  PaneLabelChangedMessage,
  PaneDeadChangedMessage,
  PaneTitleChangedMessage,
  WindowAddedMessage,
  WindowClosedMessage,
  WindowRenamedMessage,
  WindowSyncChangedMessage,
  WindowMonitorActivityChangedMessage,
  WindowMonitorSilenceChangedMessage,
  LayoutUpdatedMessage,
  FocusChangedMessage,
  SessionProxySessionRenamedMessage,
  Origin,
} from "../wire/session-proxy-control.js";

// ---------------------------------------------------------------------------
// Origin attribution (tc-ozk.2)
// ---------------------------------------------------------------------------

/**
 * Lookup the causality {@link Origin} for a newly-created pane or window
 * (tc-ozk.2).
 *
 * Threaded into {@link diffModel} so the SINGLE place that emits
 * `pane.opened` / `window.added` — used by BOTH the event path (serve.ts
 * per-client `onModelChange`) AND the diff path (requery.ts `requeryDiff`) —
 * can stamp the origin uniformly. Called once per newly-appearing pane id and
 * once per newly-appearing window id.
 *
 * Returns the verb's `{connectionId, requestId}` when the id matches a recent
 * wire verb's returned effect ids (the daemon recorded the correlation when
 * the verb replied, tc-ozk.1), or `undefined` for a FOREIGN creation (no
 * matching verb — native client, script). An `undefined` result leaves the
 * delta untagged.
 */
export type OriginLookup = (id: PaneId | WindowId) => Origin | undefined;

// ---------------------------------------------------------------------------
// Close-cause attribution (tc-u7cu.6)
// ---------------------------------------------------------------------------

/**
 * Consume the close cause for a pane that is about to be closed (tc-u7cu.6).
 *
 * Threaded into {@link diffModel} so the SINGLE place that emits `pane.closed`
 * can stamp the cause uniformly. Called once per disappearing pane id.
 *
 * Returns `{connectionId, requestId}` when the id was killed by a wire verb
 * (close-pane / kill-window), or `undefined` when the close was unsolicited
 * (shell exit, external kill-pane). ONE-SHOT: the registry removes the entry
 * on consume (each pane id closes exactly once; diffModel is not called
 * per-client for close deltas so idempotency is not needed here).
 *
 * Omitting `closeCauseLookup` leaves all close deltas untagged — the correct
 * default for callers without close-verb-correlation state (tests).
 */
export type CloseCauseLookup = (id: PaneId) => Origin | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for projectSnapshot.
 *
 * `seq`: the sequence number to stamp on the snapshot message. The E4 session-proxy
 * runtime owns the per-connection counter and passes it here. Defaults to 2
 * (snapshot is always the second session-proxy→client message after capabilities
 * at seq=1).
 *
 * `attachedClientCount`: the number of session-proxy-protocol clients connected at
 * snapshot time (tc-1elae, §11.4 tooltip). The serve layer (tc-dv3) passes
 * `server.clientCount()` here. Omit to leave the field absent (backwards-
 * compatible; older clients simply do not read it).
 */
export interface ProjectSnapshotOpts {
  readonly seq?: number;
  readonly attachedClientCount?: number;
  /**
   * tc-ozk.2: THIS client's own connectionId, stamped into the snapshot so the
   * client can compare it against `origin.connectionId` on creation deltas to
   * decide whether a creation is its own. Omit to leave the field absent
   * (callers without per-connection identity — tests).
   */
  readonly connectionId?: import("../wire/ids.js").ConnectionId;
}

/**
 * Project the full model state into a wire SnapshotMessage.
 *
 * Called once per new client connection, immediately after the capabilities
 * handshake. The snapshot carries the bound session, flat arrays
 * (windows, panes), and the focus pair. All ids are the model's branded ids
 * (same types as the wire uses — no conversion needed).
 *
 * Assumes the model has exactly one session (the session-proxy's bound session).
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
      // tc-7xv.15: monitor-activity / monitor-silence state at snapshot time.
      monitorActivity: win.monitorActivity,
      monitorSilence: win.monitorSilence,
    });
  }

  const panes: SnapshotPane[] = [];
  for (const pane of model.panes.values()) {
    // tc-4bv2 / tc-295a.10: surface dead-pane state in the snapshot so an
    // all-dead-pane session renders (and is reapable). Keep `dead`/`exitCode`
    // off the wire when the pane is alive — additive optional fields, absent
    // means false/unknown (matches the conformance default).
    // tc-1a8z: surface the durable, driver-owned pane name when set. Additive
    // optional field — kept off the wire when unset (undefined). Distinct from
    // the live pane_title (tc-2mn8).
    // tc-2mn8: carry paneTitle when known (absent means no title seen yet).
    const base: SnapshotPane = {
      paneId: pane.paneId,
      windowId: pane.windowId,
      cols: pane.cols,
      rows: pane.rows,
      ...(pane.label !== undefined ? { label: pane.label } : {}),
      ...(pane.paneTitle !== undefined ? { paneTitle: pane.paneTitle } : {}),
    };
    if (pane.dead) {
      panes.push(
        pane.exitCode !== undefined
          ? { ...base, dead: true, exitCode: pane.exitCode }
          : { ...base, dead: true },
      );
    } else {
      panes.push(base);
    }
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
    // tc-1elae: attached-client count (additive optional).
    ...(attachedClientCount !== undefined ? { attachedClientCount } : {}),
    // tc-ozk.2: this client's own connectionId (additive optional) so it can
    // compare against origin.connectionId on creation deltas.
    ...(opts.connectionId !== undefined ? { connectionId: opts.connectionId } : {}),
  };
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
 *
 * `originLookup` (tc-ozk.2): optional causality resolver. When supplied, each
 * newly-appearing pane / window has its id passed to the lookup; a non-undefined
 * result is stamped as the `origin` field on the emitted `pane.opened` /
 * `window.added` (verb-caused), and `undefined` leaves it untagged (foreign).
 * Omitting `originLookup` leaves every creation untagged — the correct default
 * for callers without verb-correlation state (tests, the metrics-only patch
 * path). This is the SINGLE choke point that both the event path (serve.ts) and
 * the diff/requery path (requery.ts) pass the lookup through, so attribution is
 * uniform across both.
 *
 * `closeCauseLookup` (tc-u7cu.6): optional close-cause resolver. When supplied,
 * each disappearing pane has its id passed to the lookup (consume, one-shot);
 * a non-undefined result is stamped as the `cause` field on the emitted
 * `pane.closed` (verb-caused), and `undefined` leaves it untagged (unsolicited).
 */
export function diffModel(
  prev: SessionModel,
  next: SessionModel,
  originLookup?: OriginLookup,
  closeCauseLookup?: CloseCauseLookup,
): SessionProxyMessage[] {
  const out: SessionProxyMessage[] = [];

  // Placeholder seq — the E4 caller assigns real values before sending.
  const SEQ = 0;

  // -------------------------------------------------------------------------
  // 1. window.added — new windows
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    if (!prev.windows.has(id)) {
      // Determine active flag: is this the activeWindowId in its owning session?
      const sess = next.sessions.get(win.sessionId);
      // tc-ozk.2: stamp origin when this window was created by a wire verb.
      const origin = originLookup?.(win.windowId);
      const msg: WindowAddedMessage = {
        type: "window.added",
        seq: SEQ,
        windowId: win.windowId,
        name: win.name,
        active: sess?.activeWindowId === win.windowId,
        ...(origin !== undefined ? { origin } : {}),
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
      // tc-4bv2 / tc-295a.10: a pane can be observed already-dead on first
      // sight (cold attach / reconnect to a remain-on-exit corpse). Carry the
      // dead flag + exitCode so the client renders it dead without waiting for
      // a follow-up delta. Keep the fields off when alive (additive optional).
      // tc-ozk.2: stamp origin when this pane was created by a wire verb.
      const origin = originLookup?.(pane.paneId);
      const msg: PaneOpenedMessage = {
        type: "pane.opened",
        seq: SEQ,
        paneId: pane.paneId,
        windowId: pane.windowId,
        cols: pane.cols,
        rows: pane.rows,
        active: win?.activePaneId === pane.paneId,
        ...(pane.dead ? { dead: true } : {}),
        ...(pane.dead && pane.exitCode !== undefined ? { exitCode: pane.exitCode } : {}),
        // tc-1a8z: born already carrying a durable name (e.g. cold attach to a
        // previously-renamed pane). Off when unset (additive optional).
        ...(pane.label !== undefined ? { label: pane.label } : {}),
        ...(origin !== undefined ? { origin } : {}),
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
  // 5a2. pane.label-changed — durable pane-name changes on existing panes (tc-1a8z)
  //
  // The durable name lives in the `@tmuxcc_label` pane user-option. It changes
  // either optimistically (the input-path injects internal:set-pane-label right
  // after a rename-pane command) or when a later requery re-reads the option's
  // new value. A pane present in BOTH prev and next whose `label` differs gets
  // a delta; `label` is omitted when the name was cleared (returned to unset).
  // -------------------------------------------------------------------------
  for (const [id, pane] of next.panes) {
    const prevPane = prev.panes.get(id);
    if (!prevPane) continue; // new panes carry their label in pane.opened
    if (prevPane.label !== pane.label) {
      const msg: PaneLabelChangedMessage = {
        type: "pane.label-changed",
        seq: SEQ,
        paneId: pane.paneId,
        ...(pane.label !== undefined ? { label: pane.label } : {}),
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 5b. pane.dead-changed — dead-state flip on existing panes (tc-4bv2 / tc-295a.10)
  //
  // A pane present in BOTH prev and next whose `dead` flag changed: it became a
  // remain-on-exit corpse (or, defensively, respawned back to live) WITHOUT
  // leaving list-panes. This is the live transition signal; a pane that LEFT
  // list-panes is handled by pane.closed below (the strong contract). We also
  // emit when only the exitCode became known while dead stays true (a corpse
  // whose status tmux reported on a later requery).
  // -------------------------------------------------------------------------
  for (const [id, pane] of next.panes) {
    const prevPane = prev.panes.get(id);
    if (!prevPane) continue; // new panes handled in pane.opened (carry dead there)
    const deadFlipped = prevPane.dead !== pane.dead;
    const exitCodeAppeared =
      pane.dead && prevPane.dead && prevPane.exitCode !== pane.exitCode;
    if (deadFlipped || exitCodeAppeared) {
      const msg: PaneDeadChangedMessage = {
        type: "pane.dead-changed",
        seq: SEQ,
        paneId: pane.paneId,
        dead: pane.dead,
        ...(pane.dead && pane.exitCode !== undefined ? { exitCode: pane.exitCode } : {}),
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 5c. pane.title-changed — live shell title change on existing panes (tc-2mn8)
  // -------------------------------------------------------------------------
  for (const [id, pane] of next.panes) {
    const prevPane = prev.panes.get(id);
    if (!prevPane) continue; // new panes handled in pane.opened
    if (prevPane.paneTitle !== pane.paneTitle && pane.paneTitle !== undefined) {
      const msg: PaneTitleChangedMessage = {
        type: "pane.title-changed",
        seq: SEQ,
        paneId: pane.paneId,
        title: pane.paneTitle,
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
  // 6c. window.monitor.activity.changed — monitor-activity toggle (tc-7xv.15)
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    const prevWin = prev.windows.get(id);
    if (!prevWin) continue; // new windows handled above
    if (prevWin.monitorActivity !== win.monitorActivity) {
      const msg: WindowMonitorActivityChangedMessage = {
        type: "window.monitor.activity.changed",
        seq: SEQ,
        windowId: win.windowId,
        on: win.monitorActivity,
      };
      out.push(msg);
    }
  }

  // -------------------------------------------------------------------------
  // 6d. window.monitor.silence.changed — monitor-silence toggle (tc-7xv.15)
  // -------------------------------------------------------------------------
  for (const [id, win] of next.windows) {
    const prevWin = prev.windows.get(id);
    if (!prevWin) continue; // new windows handled above
    if (prevWin.monitorSilence !== win.monitorSilence) {
      const msg: WindowMonitorSilenceChangedMessage = {
        type: "window.monitor.silence.changed",
        seq: SEQ,
        windowId: win.windowId,
        seconds: win.monitorSilence,
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
    const msg: SessionProxySessionRenamedMessage = {
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
      // tc-295a.10 strong contract: exactly one pane.closed per removed slot.
      // Carry the exit code through when the pane we are closing was a dead
      // corpse with a known pane_dead_status (the shell-exit + remain-on-exit
      // path reaps a corpse whose code we already read). Otherwise the code is
      // unknowable (slot vanished without a corpse phase) and stays absent.
      //
      // tc-u7cu.6: stamp the cause when this close was caused by a wire verb
      // (close-pane / kill-window). The lookup is ONE-SHOT (consume): each
      // pane id closes exactly once, and diffModel is called once per model
      // transition (not once per client), so the consume semantics are safe.
      const cause = closeCauseLookup?.(pane.paneId);
      const msg: PaneClosedMessage = {
        type: "pane.closed",
        seq: SEQ,
        paneId: pane.paneId,
        windowId: pane.windowId,
        ...(pane.dead && pane.exitCode !== undefined ? { exitCode: pane.exitCode } : {}),
        ...(cause !== undefined ? { cause } : {}),
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
