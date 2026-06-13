/**
 * model-builder.ts — convert a transcript's wire-shaped `initialModel` into the
 * driver's `SessionModel`, and apply verb-driven mutations (tc-ozk.4 / W3.2).
 *
 * The transcript carries a language-neutral, wire-shaped model (ids, cols/rows,
 * layout). The daemon-side conformance runner must seed its fake pipeline with a
 * driver `SessionModel` and then mutate it as creating verbs fire, so the REAL
 * `createControlServer`/`diffModel` emits the snapshot + creation deltas the
 * transcript expects. This module is the single conversion + mutation point.
 *
 * It uses ONLY the structural model helpers re-exported from the session-proxy
 * barrel (`addSession` / `addWindow` / `addPane` / `setFocus` / `updateWindow`),
 * so it stays on the sanctioned import boundary.
 *
 * @module harness/model-builder
 */

import {
  emptyModel,
  addSession,
  addWindow,
  addPane,
  setFocus,
  updateWindow,
  updateSession,
} from "@tmuxcc/session-proxy";
import type {
  SessionModel,
  PaneId,
  WindowId,
  WindowLayout,
} from "@tmuxcc/session-proxy";

import type { TranscriptInitialModel, VerbCreates } from "./transcript.js";

/**
 * Build a driver `SessionModel` from a transcript's wire-shaped initial model.
 */
export function buildModel(init: TranscriptInitialModel): SessionModel {
  let model = emptyModel();

  const sid = init.session.sessionId;
  model = addSession(model, {
    sessionId: sid,
    name: init.session.name,
    windowIds: [],
    activeWindowId: null,
  });

  for (const w of init.windows) {
    model = addWindow(model, {
      windowId: w.windowId,
      sessionId: sid,
      name: w.name,
      paneIds: [],
      activePaneId: null,
      layout: w.layout,
      synchronizePanes: w.synchronizePanes ?? false,
      monitorActivity: w.monitorActivity ?? true,
      monitorSilence: w.monitorSilence ?? 0,
    });
  }

  for (const p of init.panes) {
    model = addPane(model, {
      paneId: p.paneId,
      windowId: p.windowId,
      sessionId: sid,
      cols: p.cols,
      rows: p.rows,
      mode: "normal",
      dead: false,
      exitCode: undefined,
      scrollbackHandle: undefined,
    });
  }

  if (init.focus.paneId !== null && init.focus.windowId !== null) {
    model = setFocus(model, {
      paneId: init.focus.paneId,
      windowId: init.focus.windowId,
      sessionId: sid,
    });
  }

  return model;
}

/**
 * Apply a creating verb's effect to the model (tc-ozk.1): add the new
 * pane/window and optionally move focus. Returns the new model. The caller is
 * responsible for recording the verb origin in its `VerbOriginRegistry` BEFORE
 * firing the model change so `diffModel` stamps the origin (tc-ozk.2).
 *
 * Supports the two creating shapes the protocol has today:
 *   - split-pane: a new pane in an EXISTING window.
 *   - open-window / break-pane: a new window AND its first pane.
 */
export function applyVerbCreate(
  model: SessionModel,
  creates: VerbCreates,
  defaults: { cols: number; rows: number; sessionId: import("@tmuxcc/session-proxy").SessionId },
): SessionModel {
  const cols = creates.cols ?? defaults.cols;
  const rows = creates.rows ?? defaults.rows;
  let next = model;

  let targetWindow: WindowId;
  const newPaneId: PaneId | undefined = creates.newPaneId;

  if (creates.newWindowId !== undefined) {
    // open-window / break-pane: new window + its first pane.
    targetWindow = creates.newWindowId;
    next = addWindow(next, {
      windowId: creates.newWindowId,
      sessionId: defaults.sessionId,
      name: creates.windowName ?? "window",
      paneIds: [],
      activePaneId: null,
      layout: paneLayout(newPaneId, cols, rows),
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });
  } else {
    // split-pane: into the focused window.
    const fw = model.focus.windowId;
    if (fw === null) {
      throw new Error("applyVerbCreate: split-pane verb but model has no focused window");
    }
    targetWindow = fw;
  }

  if (newPaneId !== undefined) {
    next = addPane(next, {
      paneId: newPaneId,
      windowId: targetWindow,
      sessionId: defaults.sessionId,
      cols,
      rows,
      mode: "normal",
      dead: false,
      exitCode: undefined,
      scrollbackHandle: undefined,
    });
  }

  if (creates.focus && newPaneId !== undefined) {
    next = setFocus(next, {
      paneId: newPaneId,
      windowId: targetWindow,
      sessionId: defaults.sessionId,
    });
    // Reflect the new active pane on the owning window so the layout/active
    // flags the daemon diffs from stay consistent.
    if (next.windows.get(targetWindow)) {
      next = updateWindow(next, targetWindow, { activePaneId: newPaneId });
    }
    // For a NEW window, make it the session's active window so the daemon's
    // window.added diff reports active=true (tc-ozk.2 golden shape). addWindow
    // keeps the prior active window; focus moving into the new window flips it.
    if (creates.newWindowId !== undefined) {
      next = updateSession(next, defaults.sessionId, { activeWindowId: targetWindow });
    }
  }

  return next;
}

/** A trivial single-pane layout for a freshly-created window. */
function paneLayout(paneId: PaneId | undefined, cols: number, rows: number): WindowLayout {
  if (paneId === undefined) {
    // A window with no pane yet (shouldn't happen for our verbs) — empty rect.
    return { cols, rows, root: { kind: "pane", paneId: "p?" as PaneId, rect: { x: 0, y: 0, cols, rows } } };
  }
  return {
    cols,
    rows,
    root: { kind: "pane", paneId, rect: { x: 0, y: 0, cols, rows } },
  };
}
