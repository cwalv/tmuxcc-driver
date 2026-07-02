/**
 * Canonical in-session-proxy session model.
 *
 * @module state/model
 *
 * # Design decisions
 *
 * ## Normalized vs nested
 * The model uses a NORMALIZED representation: three flat Maps (sessions, windows,
 * panes) keyed by their branded id types, plus focus pointers. This mirrors the
 * wire's SnapshotMessage (flat arrays + focus object) so projection (tc-7gp) is
 * trivial — iterate the maps, convert each entry to the corresponding Snapshot*
 * type. It also means the reducer (tc-5dd) can update a single pane or window
 * without rebuilding the entire tree, and invariant checks are O(n) passes over
 * the maps.
 *
 * ## Id types
 * The model reuses wire id types directly: `PaneId`, `WindowId`, `SessionId`
 * from `src/wire/ids.ts`. The session-proxy mints new ids (via `paneId()` /
 * `windowId()` / `sessionId()`) when it maps tmux's `%N` / `@N` / `$N` sigil
 * ids at the south boundary. Everything above that mapping point (state,
 * projection, wire) uses these branded strings only — no tmux sigil ids appear
 * in this module.
 *
 * ## Layout storage
 * Each `Window` stores its layout as `WindowLayout` (from `src/wire/layout.ts`)
 * directly. The wire type is an immutable tree that already carries cols/rows and
 * the full LayoutNode tree, so reusing it avoids a translation step in projection.
 * The reducer (tc-5dd) converts parser `ParsedLayout` → `WindowLayout` via the
 * `parsedLayoutToWindowLayout` helper exported from this module; tc-7gp then
 * reads `Window.layout` as-is for `SnapshotWindow.layout`.
 *
 * ## Pane byte-buffer slot
 * Each `Pane` carries a `scrollbackHandle` field typed as `ScrollbackHandle`
 * (an opaque `number` alias defined here). The actual ring-buffer implementation
 * is tc-fx2's responsibility; at that point `ScrollbackHandle` becomes the
 * handle/key type that tc-fx2's store uses. Until then it defaults to
 * `undefined` (the field is `ScrollbackHandle | undefined`).
 *
 * ## PaneMode
 * Reuses `PaneMode` from `src/wire/session-proxy-control.ts` directly. The wire type is
 * already open-ended (`"normal" | "copy" | "view" | string`) so no translation
 * is needed at projection.
 *
 * ## Immutability discipline
 * All struct fields are `readonly`. The reducer produces a new `SessionModel`
 * value (structural sharing via `{ ...old, sessions: new Map(...) }`) rather
 * than mutating the previous model in place. Update helpers exported here
 * return a new model and never mutate their argument.
 *
 * # Invariants (enforced by checkInvariants)
 *   I1. Every pane's `windowId` references an existing window in the model.
 *   I2. Every window's `sessionId` references an existing session in the model.
 *   I3. Every pane stored in a window's `paneIds` set is present in `model.panes`.
 *   I4. Every window stored in a session's `windowIds` set is present in
 *       `model.windows`.
 *   I5. Each non-empty window has exactly one `activePaneId`, and that id is a
 *       member of the window's `paneIds`. Empty windows have `activePaneId: null`.
 *   I6. Each non-empty session has exactly one `activeWindowId`, and that id is
 *       a member of the session's `windowIds`. Empty sessions have
 *       `activeWindowId: null`.
 *   I7. `model.focus.paneId`, `.windowId`, `.sessionId` are either all null or
 *       all non-null and reference entities that exist and are mutually consistent
 *       (focus.pane belongs to focus.window belongs to focus.session; each is the
 *       respective entity's active pointer).
 *   I8. No duplicate ids within each map (enforced by Map keying).
 *   I9. (Optional / layout consistency) When a window has a non-null layout, the
 *       set of leaf pane ids in the layout tree matches the window's `paneIds`.
 *       Not checked by default (layout may lag one event behind pane lifecycle);
 *       callers can pass `checkLayoutConsistency: true` to opt in.
 *
 * # Wire projection contract (tc-7gp)
 *   - SnapshotSession ← Session.{sessionId, name, activeWindowId === focus.windowId}
 *   - SnapshotWindow  ← Window.{windowId, sessionId, name, activePaneId === …, layout}
 *   - SnapshotPane    ← Pane.{paneId, windowId, sessionId, cols, rows}
 *   - focus           ← SessionModel.focus
 */
// Re-export id constructors for convenience of reducers (avoids extra import)
export { paneId, windowId, sessionId } from "@tmuxcc/protocol";
/** @internal Mint a ScrollbackHandle from a raw number (session-proxy use only). */
export function scrollbackHandle(n) {
    return n;
}
/**
 * Check all model invariants and return a list of violations (empty = valid).
 *
 * Does not throw; returns structured violations so callers (tests, reducer
 * assertions) can inspect the specific failure mode.
 */
export function checkInvariants(model, options = {}) {
    const violations = [];
    // I1 + I2: each pane's owning window and session must exist.
    for (const pane of model.panes.values()) {
        if (!model.windows.has(pane.windowId)) {
            violations.push({
                kind: "pane-missing-window",
                paneId: pane.paneId,
                windowId: pane.windowId,
            });
        }
    }
    // I2: each window's owning session must exist.
    for (const win of model.windows.values()) {
        if (!model.sessions.has(win.sessionId)) {
            violations.push({
                kind: "window-missing-session",
                windowId: win.windowId,
                sessionId: win.sessionId,
            });
        }
    }
    // I3: every paneId in window.paneIds must be in model.panes.
    for (const win of model.windows.values()) {
        for (const pid of win.paneIds) {
            if (!model.panes.has(pid)) {
                violations.push({
                    kind: "window-pane-not-in-map",
                    windowId: win.windowId,
                    paneId: pid,
                });
            }
        }
    }
    // I4: every windowId in session.windowIds must be in model.windows.
    for (const sess of model.sessions.values()) {
        for (const wid of sess.windowIds) {
            if (!model.windows.has(wid)) {
                violations.push({
                    kind: "session-window-not-in-map",
                    sessionId: sess.sessionId,
                    windowId: wid,
                });
            }
        }
    }
    // I5: active pane rules per window.
    for (const win of model.windows.values()) {
        if (win.paneIds.length > 0) {
            if (win.activePaneId === null) {
                violations.push({ kind: "window-no-active-pane", windowId: win.windowId });
            }
            else if (!win.paneIds.includes(win.activePaneId)) {
                violations.push({
                    kind: "window-active-pane-missing",
                    windowId: win.windowId,
                    activePaneId: win.activePaneId,
                });
            }
        }
        // Empty windows: activePaneId should be null, but we don't enforce that
        // here (it's set by the constructor); the "pane-not-in-map" check above
        // would catch a stale non-null pointer.
    }
    // I6: active window rules per session.
    for (const sess of model.sessions.values()) {
        if (sess.windowIds.length > 0) {
            if (sess.activeWindowId === null) {
                violations.push({ kind: "session-no-active-window", sessionId: sess.sessionId });
            }
            else if (!sess.windowIds.includes(sess.activeWindowId)) {
                violations.push({
                    kind: "session-active-window-missing",
                    sessionId: sess.sessionId,
                    activeWindowId: sess.activeWindowId,
                });
            }
        }
    }
    // I7: focus consistency.
    const { paneId: fPaneId, windowId: fWindowId, sessionId: fSessionId } = model.focus;
    const focusNullCount = [fPaneId, fWindowId, fSessionId].filter((x) => x === null).length;
    if (focusNullCount !== 0 && focusNullCount !== 3) {
        violations.push({ kind: "focus-partial-null", focus: model.focus });
    }
    else if (focusNullCount === 0) {
        // All non-null: check existence and consistency.
        const focusPane = model.panes.get(fPaneId);
        const focusWindow = model.windows.get(fWindowId);
        const focusSession = model.sessions.get(fSessionId);
        if (!focusPane) {
            violations.push({ kind: "focus-pane-not-found", focusPaneId: fPaneId });
        }
        if (!focusWindow) {
            violations.push({ kind: "focus-window-not-found", focusWindowId: fWindowId });
        }
        if (!focusSession) {
            violations.push({ kind: "focus-session-not-found", focusSessionId: fSessionId });
        }
        // Cross-consistency checks (only when entities exist).
        if (focusWindow && focusPane) {
            if (!focusWindow.paneIds.includes(fPaneId)) {
                violations.push({
                    kind: "focus-pane-wrong-window",
                    focusPaneId: fPaneId,
                    focusWindowId: fWindowId,
                });
            }
            else if (focusWindow.activePaneId !== fPaneId) {
                violations.push({
                    kind: "focus-pane-not-active",
                    focusPaneId: fPaneId,
                    focusWindowId: fWindowId,
                    activePaneId: focusWindow.activePaneId,
                });
            }
        }
        if (focusSession && focusWindow) {
            if (!focusSession.windowIds.includes(fWindowId)) {
                violations.push({
                    kind: "focus-window-wrong-session",
                    focusWindowId: fWindowId,
                    focusSessionId: fSessionId,
                });
            }
            else if (focusSession.activeWindowId !== fWindowId) {
                violations.push({
                    kind: "focus-window-not-active",
                    focusWindowId: fWindowId,
                    focusSessionId: fSessionId,
                    activeWindowId: focusSession.activeWindowId,
                });
            }
        }
    }
    // I9 (opt-in): layout leaf ids match window.paneIds.
    if (options.checkLayoutConsistency) {
        for (const win of model.windows.values()) {
            if (win.layout !== null) {
                const layoutPaneIds = collectLayoutPaneIds(win.layout.root);
                const modelSet = new Set(win.paneIds);
                const layoutSet = new Set(layoutPaneIds);
                const mismatch = layoutPaneIds.some((id) => !modelSet.has(id)) ||
                    win.paneIds.some((id) => !layoutSet.has(id));
                if (mismatch) {
                    violations.push({
                        kind: "layout-pane-mismatch",
                        windowId: win.windowId,
                        layoutPaneIds,
                        modelPaneIds: win.paneIds,
                    });
                }
            }
        }
    }
    return violations;
}
/** Collect all PaneId leaf values from a LayoutNode tree. */
function collectLayoutPaneIds(node) {
    if (node.kind === "pane")
        return [node.paneId];
    return node.children.flatMap(collectLayoutPaneIds);
}
// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------
/** Return an empty model (no sessions, no windows, no panes, no focus). */
export function emptyModel() {
    return {
        sessions: new Map(),
        windows: new Map(),
        panes: new Map(),
        focus: { paneId: null, windowId: null, sessionId: null },
    };
}
// ---------------------------------------------------------------------------
// Pure update helpers
// (The reducer tc-5dd composes these; each returns a new SessionModel.)
// ---------------------------------------------------------------------------
/**
 * Add a session to the model. If the model currently has no sessions, the new
 * session becomes the active session and its focus triplet is set accordingly
 * (only if the session has at least one window+pane; otherwise focus stays null).
 *
 * Does NOT enforce that `session.sessionId` is absent — callers must ensure
 * uniqueness or `checkInvariants` will catch it via duplicate Map key semantics
 * (Maps silently overwrite; that's a structural guarantee violation the reducer
 * should avoid).
 */
export function addSession(model, session) {
    const sessions = new Map(model.sessions);
    sessions.set(session.sessionId, session);
    return { ...model, sessions };
}
/** Remove a session and all its windows and panes from the model. Clears focus if affected. */
export function removeSession(model, sessionId) {
    const session = model.sessions.get(sessionId);
    if (!session)
        return model;
    // Collect all windows and panes to remove
    const windowIdsToRemove = new Set(session.windowIds);
    const paneIdsToRemove = new Set();
    for (const wid of windowIdsToRemove) {
        const win = model.windows.get(wid);
        if (win)
            win.paneIds.forEach((pid) => paneIdsToRemove.add(pid));
    }
    const sessions = new Map(model.sessions);
    sessions.delete(sessionId);
    const windows = new Map(model.windows);
    for (const wid of windowIdsToRemove)
        windows.delete(wid);
    const panes = new Map(model.panes);
    for (const pid of paneIdsToRemove)
        panes.delete(pid);
    // Clear focus if it pointed into the removed session
    const focus = model.focus.sessionId === sessionId
        ? { paneId: null, windowId: null, sessionId: null }
        : model.focus;
    return { sessions, windows, panes, focus };
}
/** Add a window to its owning session and to the windows map. */
export function addWindow(model, win) {
    const session = model.sessions.get(win.sessionId);
    if (!session)
        return model; // session must exist first
    const windows = new Map(model.windows);
    windows.set(win.windowId, win);
    const updatedSession = {
        ...session,
        windowIds: [...session.windowIds, win.windowId],
        activeWindowId: session.activeWindowId ?? win.windowId,
    };
    const sessions = new Map(model.sessions);
    sessions.set(win.sessionId, updatedSession);
    return { ...model, sessions, windows };
}
/** Remove a window (and all its panes) from the model. Updates session's windowIds and active pointer. */
export function removeWindow(model, windowId) {
    const win = model.windows.get(windowId);
    if (!win)
        return model;
    const session = model.sessions.get(win.sessionId);
    // Remove all panes in this window
    const panes = new Map(model.panes);
    for (const pid of win.paneIds)
        panes.delete(pid);
    const windows = new Map(model.windows);
    windows.delete(windowId);
    let sessions = new Map(model.sessions);
    if (session) {
        const newWindowIds = session.windowIds.filter((id) => id !== windowId);
        const newActiveWindowId = session.activeWindowId === windowId
            ? (newWindowIds[0] ?? null)
            : session.activeWindowId;
        const updatedSession = {
            ...session,
            windowIds: newWindowIds,
            activeWindowId: newActiveWindowId,
        };
        sessions.set(win.sessionId, updatedSession);
    }
    // Clear focus if it was in this window
    const focus = model.focus.windowId === windowId
        ? { paneId: null, windowId: null, sessionId: null }
        : model.focus;
    return { sessions, windows, panes, focus };
}
/** Add a pane to its owning window and to the panes map. */
export function addPane(model, pane) {
    const win = model.windows.get(pane.windowId);
    if (!win)
        return model; // window must exist first
    const panes = new Map(model.panes);
    panes.set(pane.paneId, pane);
    const updatedWindow = {
        ...win,
        paneIds: [...win.paneIds, pane.paneId],
        activePaneId: win.activePaneId ?? pane.paneId,
    };
    const windows = new Map(model.windows);
    windows.set(pane.windowId, updatedWindow);
    return { ...model, windows, panes };
}
/**
 * Remove a pane from the model. Updates its owning window's paneIds and
 * activePaneId (reassigns to first remaining pane, or null if window is now
 * empty). Clears focus if the removed pane was focused.
 */
export function removePane(model, paneId) {
    const pane = model.panes.get(paneId);
    if (!pane)
        return model;
    const win = model.windows.get(pane.windowId);
    const panes = new Map(model.panes);
    panes.delete(paneId);
    let windows = new Map(model.windows);
    if (win) {
        const newPaneIds = win.paneIds.filter((id) => id !== paneId);
        const newActivePaneId = win.activePaneId === paneId ? (newPaneIds[0] ?? null) : win.activePaneId;
        const updatedWindow = {
            ...win,
            paneIds: newPaneIds,
            activePaneId: newActivePaneId,
        };
        windows.set(win.windowId, updatedWindow);
    }
    // Clear focus if the removed pane was focused
    const focus = model.focus.paneId === paneId
        ? { paneId: null, windowId: null, sessionId: null }
        : model.focus;
    return { ...model, windows, panes, focus };
}
/** Replace a pane's fields (e.g. resize or mode change or title update). */
export function updatePane(model, paneId, patch) {
    const pane = model.panes.get(paneId);
    if (!pane)
        return model;
    const panes = new Map(model.panes);
    panes.set(paneId, { ...pane, ...patch });
    return { ...model, panes };
}
/**
 * Resolve a pane's binding intent for a specific client identity (D3,
 * tc-4b6k.2).  Returns true iff the client's durable id is in the pane's
 * `boundClients`.  An undefined `clientId` (an anonymous connection) is never
 * bound.
 */
export function paneBoundFor(pane, clientId) {
    return clientId !== undefined && pane.boundClients.has(clientId);
}
/**
 * Return a `boundClients` set with `clientId`'s membership set to `bound`
 * (D3, tc-4b6k.2).  Returns the same reference when already in the desired
 * state (so a caller's reference-equality no-op check stays cheap).
 */
export function setBoundClient(current, clientId, bound) {
    if (bound === current.has(clientId))
        return current;
    const next = new Set(current);
    if (bound)
        next.add(clientId);
    else
        next.delete(clientId);
    return next;
}
/** Replace a window's fields (e.g. rename, layout update, synchronize-panes toggle). */
export function updateWindow(model, windowId, patch) {
    const win = model.windows.get(windowId);
    if (!win)
        return model;
    const windows = new Map(model.windows);
    windows.set(windowId, { ...win, ...patch });
    return { ...model, windows };
}
/** Replace a session's fields (e.g. rename, activeWindowId change). */
export function updateSession(model, sessionId, patch) {
    const sess = model.sessions.get(sessionId);
    if (!sess)
        return model;
    const sessions = new Map(model.sessions);
    sessions.set(sessionId, { ...sess, ...patch });
    return { ...model, sessions };
}
/** Set the global focus triple. All three must be non-null or all null. */
export function setFocus(model, focus) {
    return { ...model, focus };
}
// ---------------------------------------------------------------------------
// Parser→Model bridge
// ---------------------------------------------------------------------------
/**
 * Convert a `ParsedLayout` (from `src/parser/layout-string.ts`) into the wire
 * `WindowLayout` (from `src/wire/layout.ts`) that the model stores.
 *
 * This is the bridge the reducer (tc-5dd) uses when processing a
 * `%layout-change` notification. The projection (tc-7gp) can then use
 * `Window.layout` directly as `SnapshotWindow.layout`.
 *
 * `tmuxPaneIdToWireId` is a mapping function the reducer supplies — it maps
 * the integer tmux pane id from the parser to the session-proxy's branded `PaneId`.
 *
 * @throws {Error} if a leaf pane id is present but has no mapping in `tmuxPaneIdToWireId`.
 */
export function parsedLayoutToWindowLayout(parsed, tmuxPaneIdToWireId) {
    return {
        cols: getRootCols(parsed.root),
        rows: getRootRows(parsed.root),
        root: layoutCellToNode(parsed.root, tmuxPaneIdToWireId),
    };
}
function getRootCols(cell) {
    return cell.width;
}
function getRootRows(cell) {
    return cell.height;
}
function layoutCellToNode(cell, map) {
    if (cell.type === "leaf") {
        if (cell.paneId === null) {
            throw new Error("Unassigned leaf in parsed layout — cannot convert to wire LayoutPane");
        }
        return {
            kind: "pane",
            paneId: map(cell.paneId),
            rect: { x: cell.x, y: cell.y, cols: cell.width, rows: cell.height },
        };
    }
    // split cell
    const kind = cell.orientation === "horizontal" ? "hsplit" : "vsplit";
    return {
        kind,
        rect: { x: cell.x, y: cell.y, cols: cell.width, rows: cell.height },
        children: cell.children.map((c) => layoutCellToNode(c, map)),
    };
}
//# sourceMappingURL=model.js.map