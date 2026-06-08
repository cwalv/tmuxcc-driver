/**
 * Event reducer: apply a parser NotificationEvent to the SessionModel.
 *
 * @module state/reducer
 *
 * # Design
 *
 * ## Signature
 *
 * ```ts
 * reduce(model: SessionModel, event: NotificationEvent, ctx: ReducerContext): SessionModel
 * ```
 *
 * `ctx` carries the `PaneBufferStore` (tc-fx2) so `%output` / `%extended-output`
 * events can append bytes to the store without making the store a global or
 * polluting the model struct. This keeps the model reduction pure-ish (deterministic
 * given the same model + event) while threading the one explicitly-mutable side
 * effect as an explicit dependency. The alternative (returning `{model,
 * byteAppends}` tuples) was considered but rejected: the ctx-injection approach
 * is simpler for tc-9ht integration tests, which can supply a capturing double.
 *
 * ## PaneBufferStore concurrency note
 *
 * tc-fx2 (scrollback bead) owns `src/state/scrollback.ts`, which is ABSENT in
 * this fork because tc-fx2 runs concurrently. The `PaneBufferStore` interface
 * is declared locally here matching the spec supplied in the bead brief. TL
 * wires the actual import from `./scrollback.js` at integration time.
 *
 * ## Id mapping
 *
 * tmux notification events carry raw numeric ids (`paneId: number`, `windowId:
 * number`, `sessionId: number`) without the `%`/`@`/`$` sigils. These must be
 * mapped to the daemon's branded `PaneId` / `WindowId` / `SessionId` before
 * touching the model. The reducer uses simple string-based minting:
 *   `paneId("p" + tmuxId)` / `windowId("w" + tmuxId)` / `sessionId("s" + tmuxId)`
 * This is a deterministic 1:1 mapping so the same tmux id always produces the
 * same branded id within a session (the daemon namespace is per-connection).
 * E4 bootstrap (tc-835) will own the full id registry; the reducer depends only
 * on this naming convention being consistent.
 *
 * ## layout-change handling
 *
 * `%layout-change` is NOT in the `notifications.ts` vocabulary and arrives as
 * an `UnknownNotification` with `event.keyword === "layout-change"`. The raw
 * line format is:
 *
 *   `%layout-change @<winId> <layoutString>\n`
 *
 * The reducer parses `event.rawLine` to extract `winId` and `layoutString`,
 * then calls `parseLayout(layoutString)` → `parsedLayoutToWindowLayout(...)` to
 * produce a `WindowLayout`, and sets it on the window via `updateWindow`.
 *
 * Early-layout race (skip-and-wait policy):
 *   If the window named by `%layout-change` is not yet in the model, the
 *   notification is DROPPED (model returned unchanged). The %window-add event
 *   carries authoritative session identity, cols, rows, and active-pane info;
 *   synthesizing a session id ("s0") to park the window would corrupt the model
 *   until a later session event corrects it. The layout will be applied correctly
 *   by a subsequent %layout-change (or E4 bootstrap reconciliation).
 *
 * Pane reconciliation on layout-change (policy):
 *   CONSERVATIVE ADD: any pane leaf in the new layout that is not already in the
 *   model is added to the window (cols/rows from the layout cell, mode "normal",
 *   no scrollbackHandle yet). This handles the common case where tmux emits a
 *   layout-change after a split but before an explicit pane-add notification.
 *   REMOVAL: panes are NOT removed from the model based solely on layout absence.
 *   Removal is driven by explicit `%window-close` (removes all its panes) or
 *   future explicit pane-close notifications. Layout removal is unreliable during
 *   rapid splits/closes; trusting explicit close events is safer.
 *
 * ## %output / %extended-output handling
 *
 * The raw payload (`event.rawPayload`) from notifications.ts is octal-escaped.
 * The reducer calls `decodeOutputPayload` (output-codec.ts) to get the raw bytes,
 * then calls `ctx.buffers.append(paneId, bytes)`. If the pane is in the model,
 * `scrollbackHandle` is left as-is (tc-fx2 manages the buffer lifecycle; the
 * reducer does not mint handles — that is done at pane creation time by E4
 * bootstrap or when a pane is first seen from layout-change).
 *
 * ## Exhaustiveness
 *
 * The switch in `reduce` is exhaustive: the `default` branch is typed as
 * `never` so TypeScript will error if a new `NotificationEvent` variant is
 * added to the union without a corresponding case. A runtime guard in the
 * default branch logs a warning and returns the model unchanged.
 *
 * ## Immutability
 *
 * The reducer never mutates the input model. All model helpers (addWindow,
 * removeWindow, updatePane, etc.) from `./model.js` return new `SessionModel`
 * values via structural sharing. The only mutation is `ctx.buffers.append()`
 * which is the explicitly-threaded side effect.
 */

import type { NotificationEvent } from "../parser/notifications.js";
import { decodeOutputPayload } from "../parser/output-codec.js";
import { parseLayout } from "../parser/layout-string.js";
import type { SessionModel, Pane, Window, Session } from "./model.js";
import {
  paneId,
  windowId,
  sessionId,
  parsedLayoutToWindowLayout,
  addSession,
  addWindow,
  addPane,
  removeWindow,
  updateWindow,
  updatePane,
  updateSession,
  setFocus,
  emptyModel,
} from "./model.js";
import type { PaneId, WindowId, SessionId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// PaneBufferStore interface
//
// tc-fx2 (scrollback bead) owns the implementation in src/state/scrollback.ts,
// which is absent in this fork (concurrent bead). This interface is declared
// locally to match the spec. TL wires the import from ./scrollback.js at
// integration. Test code (and E4) supplies a conforming implementation.
// ---------------------------------------------------------------------------

/**
 * Byte-buffer store for per-pane scrollback content.
 *
 * tc-fx2 supplies the actual ring-buffer implementation. The reducer treats
 * this as an opaque dependency injected via `ReducerContext`. All writes are
 * fire-and-forget (no return value); reads are for test assertions only.
 */
export interface PaneBufferStore {
  /** Append raw pane bytes to the named pane's buffer. */
  append(paneId: PaneId, bytes: Uint8Array): void;
  /** Return all bytes currently held for this pane. */
  getContents(paneId: PaneId): Uint8Array;
  /** Return the number of bytes currently held for this pane. */
  size(paneId: PaneId): number;
  /** Drop and free the buffer for this pane. */
  drop(paneId: PaneId): void;
  /** Drop all buffers. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// ReducerContext
// ---------------------------------------------------------------------------

/**
 * The outcome of a switch-client narrowing check.
 *
 * "reattach" — the bound session is still alive; the caller should silently
 *              issue `attach-session -t <bound>` on the -CC connection.
 * "unavailable" — the bound session is gone; the caller should emit
 *                 ErrorMessage{code:"session.unavailable"} and close all
 *                 client connections on this daemon.
 */
export type SwitchClientOutcome = "reattach" | "unavailable";

/**
 * Mutable context threaded through `reduce`. Keeps side effects explicit and
 * allows test doubles to be injected without global state.
 */
export interface ReducerContext {
  /** The per-pane byte buffer store (tc-fx2). */
  readonly buffers: PaneBufferStore;

  /**
   * The session id this daemon is bound to (the `-CC attach -t <session>`
   * argument). Used by the switch-client narrowing logic in the
   * `%session-changed` / `%client-session-changed` handlers.
   *
   * The value is a branded SessionId produced by mintSessionId() from the
   * tmux numeric id of the bound session. E4 bootstrap supplies this once at
   * daemon startup; it never changes for the lifetime of the daemon.
   *
   * When absent (undefined), `%session-changed` and `%client-session-changed`
   * events are no-ops (model returned unchanged). This should only occur if
   * bootstrap fails to resolve the session name to a numeric id.
   */
  readonly boundSessionId?: import("../wire/ids.js").SessionId;

  /**
   * Called by the reducer when it detects that the attached session has
   * drifted away from the bound session (switch-client narrowing, tc-j9c.2).
   *
   * The reducer calls this INSTEAD of updating the model's focus: the E4
   * runtime uses the outcome to either silently issue `attach-session -t <bound>`
   * ("reattach") or emit `ErrorMessage{code:"session.unavailable"}` and close
   * all client connections ("unavailable"). In both cases the model is returned
   * UNCHANGED by the reducer (no focus update).
   *
   * @param outcome - "reattach" if the bound session is still present in the
   *                  model; "unavailable" if it has disappeared.
   */
  readonly onSwitchClientDetected?: (outcome: SwitchClientOutcome) => void;
}

// ---------------------------------------------------------------------------
// Id minting helpers
//
// Deterministic mapping: tmux numeric id → daemon branded id.
// Convention: paneId("p" + n), windowId("w" + n), sessionId("s" + n).
// E4 bootstrap owns the full registry; the reducer relies on this convention
// being consistent across the daemon.
// ---------------------------------------------------------------------------

function mintPaneId(tmuxId: number): PaneId {
  return paneId("p" + tmuxId);
}

function mintWindowId(tmuxId: number): WindowId {
  return windowId("w" + tmuxId);
}

function mintSessionId(tmuxId: number): SessionId {
  return sessionId("s" + tmuxId);
}

// ---------------------------------------------------------------------------
// Layout-change raw line parser
//
// %layout-change @<winId> <layoutString>
// The raw line is a Uint8Array. We scan it to extract:
//   1. The window id (after "@")
//   2. The rest of the line as the layout string (after the next space)
// ---------------------------------------------------------------------------

const BYTE_AT = 0x40; // '@'
const BYTE_SPACE = 0x20; // ' '
const BYTE_LF = 0x0a; // '\n'

interface LayoutChangeFields {
  windowId: number;
  layoutString: string;
}

/**
 * Parse the rawLine of an `unknown` `%layout-change` notification.
 *
 * Returns `null` if the line is malformed (missing window id or layout string).
 */
function parseLayoutChangeLine(rawLine: Uint8Array): LayoutChangeFields | null {
  // Skip "%layout-change "
  let i = 0;
  // Skip keyword token (up to first space)
  while (i < rawLine.length && rawLine[i] !== BYTE_SPACE) i++;
  if (i >= rawLine.length) return null;
  i++; // skip space

  // Expect '@'
  if (i >= rawLine.length || rawLine[i] !== BYTE_AT) return null;
  i++; // skip '@'

  // Read decimal window id
  let winId = 0;
  let hasDigit = false;
  while (i < rawLine.length && rawLine[i]! >= 0x30 && rawLine[i]! <= 0x39) {
    winId = winId * 10 + (rawLine[i]! - 0x30);
    hasDigit = true;
    i++;
  }
  if (!hasDigit) return null;

  // Skip space between window id and layout string
  if (i >= rawLine.length || rawLine[i] !== BYTE_SPACE) return null;
  i++; // skip space

  // Extract the layout string: first whitespace-delimited token from here.
  //
  // tmux 3.4 %layout-change format (from control-notify.c):
  //   %layout-change @<winId> <layout> <layout> <flags>
  // The line contains the layout string TWICE (current and previous) followed
  // by optional flags (e.g. "*"). We must take only the FIRST token; if we
  // take rest-of-line, parseLayout will reject the trailing extra tokens.
  // Earlier tmux versions emitted only: %layout-change @<winId> <layout>
  // so we fall back to rest-of-line when there is no trailing space.
  let end = i;
  while (end < rawLine.length && rawLine[end] !== BYTE_SPACE && rawLine[end] !== BYTE_LF) {
    end++;
  }

  if (end <= i) return null; // empty layout string

  // Decode as ASCII (layout strings are all-ASCII)
  let layoutString = "";
  for (let j = i; j < end; j++) {
    layoutString += String.fromCharCode(rawLine[j]!);
  }

  return { windowId: winId, layoutString };
}

// ---------------------------------------------------------------------------
// Layout-change reconciliation
//
// After converting ParsedLayout → WindowLayout, reconcile the window's pane set
// with the leaf pane ids in the layout. Policy: CONSERVATIVE ADD only.
// ---------------------------------------------------------------------------

/**
 * Collect all tmux pane ids from the leaf cells of a layout.
 * Returns an array of { tmuxId, cols, rows } for each leaf.
 */
function collectLayoutLeaves(
  cell: import("../parser/layout-string.js").LayoutCell,
): Array<{ tmuxId: number; cols: number; rows: number }> {
  if (cell.type === "leaf") {
    if (cell.paneId === null) return [];
    return [{ tmuxId: cell.paneId, cols: cell.width, rows: cell.height }];
  }
  return cell.children.flatMap(collectLayoutLeaves);
}

// ---------------------------------------------------------------------------
// Ensure-session helper
//
// Several notifications reference a session that may not yet exist in the model
// (e.g., session-changed is often the first notification about a session).
// This helper adds a minimal Session if needed so subsequent operations don't
// silently fail due to a missing parent.
// ---------------------------------------------------------------------------

function ensureSession(
  model: SessionModel,
  tmuxSessionId: number,
  name: string,
): SessionModel {
  const sid = mintSessionId(tmuxSessionId);
  if (model.sessions.has(sid)) return model;
  const session: Session = {
    sessionId: sid,
    name,
    windowIds: [],
    activeWindowId: null,
  };
  return addSession(model, session);
}

// ---------------------------------------------------------------------------
// Core reducer
// ---------------------------------------------------------------------------

/**
 * Apply a single `NotificationEvent` to `model`, returning an updated model.
 *
 * The switch is exhaustive: the `default` branch captures `never`, so TypeScript
 * will error at compile time if a new `NotificationEvent` variant is not handled.
 *
 * Side effect: `%output` / `%extended-output` events invoke `ctx.buffers.append`
 * — the only mutation allowed by the reducer contract.
 *
 * @param model - The current session model (never mutated).
 * @param event - The parser event to apply.
 * @param ctx   - Mutable context carrying the byte-buffer store.
 * @returns A new `SessionModel` reflecting the event (structural sharing).
 */
export function reduce(
  model: SessionModel,
  event: NotificationEvent,
  ctx: ReducerContext,
): SessionModel {
  switch (event.kind) {
    // -------------------------------------------------------------------------
    // %output %<pane> <payload>
    // -------------------------------------------------------------------------
    case "output": {
      const pid = mintPaneId(event.paneId);
      const bytes = decodeOutputPayload(event.rawPayload);
      ctx.buffers.append(pid, bytes);
      // No structural model change; the pane exists or will be added later.
      return model;
    }

    // -------------------------------------------------------------------------
    // %extended-output %<pane> <age_ms> : <payload>
    // -------------------------------------------------------------------------
    case "extended-output": {
      const pid = mintPaneId(event.paneId);
      const bytes = decodeOutputPayload(event.rawPayload);
      ctx.buffers.append(pid, bytes);
      return model;
    }

    // -------------------------------------------------------------------------
    // %window-add @<win>
    // %unlinked-window-add @<win>
    //
    // Create a new Window under the active session (or a synthetic one if no
    // sessions exist yet). Layout and panes arrive via layout-change.
    // -------------------------------------------------------------------------
    case "window-add": {
      const wid = mintWindowId(event.windowId);
      if (model.windows.has(wid)) return model; // idempotent

      // Find the session to attach to: prefer the globally active session
      // (from a prior session-changed event), else the first known session,
      // else create a synthetic placeholder.
      // NOTE: we check model.sessions for the active session rather than
      // model.focus.sessionId because focus may be all-null (no panes yet)
      // and we must not create a partial-null focus triple.
      let sid: SessionId;
      const activeSessId = model.focus.sessionId;
      if (activeSessId !== null && model.sessions.has(activeSessId)) {
        sid = activeSessId;
      } else {
        const first = model.sessions.keys().next().value as SessionId | undefined;
        if (first !== undefined) {
          sid = first;
        } else {
          // No sessions yet — create a synthetic placeholder.
          const syntheticSessId = 0;
          sid = mintSessionId(syntheticSessId);
          model = ensureSession(model, syntheticSessId, "");
        }
      }

      const win: Window = {
        windowId: wid,
        sessionId: sid,
        name: "",
        paneIds: [],
        activePaneId: null,
        layout: null,
        synchronizePanes: false,
        monitorActivity: true,  // inherits global default (set-option -wg monitor-activity on)
        monitorSilence: 0,      // off by default (HANDOFF §4.7)
      };
      return addWindow(model, win);
    }

    // -------------------------------------------------------------------------
    // %window-close @<win>
    // %unlinked-window-close @<win>
    //
    // Remove the window and all its panes from the model.
    // -------------------------------------------------------------------------
    case "window-close": {
      return removeWindow(model, mintWindowId(event.windowId));
    }

    // -------------------------------------------------------------------------
    // %window-renamed @<win> <name>
    // -------------------------------------------------------------------------
    case "window-renamed": {
      return updateWindow(model, mintWindowId(event.windowId), { name: event.name });
    }

    // -------------------------------------------------------------------------
    // %window-pane-changed @<win> %<pane>
    //
    // The active pane within the window changed. Update the window's activePaneId
    // and attempt to keep the global focus triple consistent.
    // -------------------------------------------------------------------------
    case "window-pane-changed": {
      const wid = mintWindowId(event.windowId);
      const pid = mintPaneId(event.paneId);

      // Update the window's activePaneId (only if the pane is registered).
      const win = model.windows.get(wid);
      if (win === undefined) return model;
      if (!win.paneIds.includes(pid)) {
        // Pane not yet in the model — skip activePaneId update to preserve invariants.
        return model;
      }

      model = updateWindow(model, wid, { activePaneId: pid });

      // If this window is the globally focused window, update the focus triple.
      if (model.focus.windowId === wid) {
        const sess = win.sessionId;
        model = setFocus(model, { paneId: pid, windowId: wid, sessionId: sess });
      }

      return model;
    }

    // -------------------------------------------------------------------------
    // %session-changed $<sess> <name>
    //
    // Apply switch-client narrowing (tc-j9c.2):
    //   1. If the new session is the bound session: update name + focus.
    //   2. If the new session differs from the bound session: check whether the
    //      bound session is still in the model.
    //      - Still present → call ctx.onSwitchClientDetected("reattach"), return
    //        model unchanged (E4 will issue attach-session silently).
    //      - Gone → call ctx.onSwitchClientDetected("unavailable"), return model
    //        unchanged (E4 will emit session.unavailable and close connections).
    //   3. If ctx.boundSessionId is absent (bootstrap did not resolve session):
    //      return model unchanged (safe no-op).
    // -------------------------------------------------------------------------
    case "session-changed": {
      const sid = mintSessionId(event.sessionId);

      if (ctx.boundSessionId !== undefined) {
        // Single-session narrowing (tc-j9c.2).
        if (sid === ctx.boundSessionId) {
          // Still on the bound session — update name in case it changed, update focus.
          model = ensureSession(model, event.sessionId, event.name);
          model = updateSession(model, sid, { name: event.name });
          const sess = model.sessions.get(sid)!;
          const activeWid = sess.activeWindowId;
          if (activeWid !== null) {
            const win = model.windows.get(activeWid);
            const activePid = win?.activePaneId ?? null;
            if (activePid !== null) {
              model = setFocus(model, { paneId: activePid, windowId: activeWid, sessionId: sid });
            }
          }
          return model;
        }
        // Drifted to a different session — determine outcome.
        const outcome: SwitchClientOutcome = model.sessions.has(ctx.boundSessionId)
          ? "reattach"
          : "unavailable";
        ctx.onSwitchClientDetected?.(outcome);
        return model; // model unchanged — E4 handles the wire-level response
      }

      // boundSessionId absent: safe no-op (bootstrap did not resolve session name).
      return model;
    }

    // -------------------------------------------------------------------------
    // %client-session-changed <client> $<sess> <name>
    //
    // Applies the same switch-client narrowing as %session-changed (tc-j9c.2).
    // See session-changed case for the full logic description.
    // -------------------------------------------------------------------------
    case "client-session-changed": {
      const sid = mintSessionId(event.sessionId);

      if (ctx.boundSessionId !== undefined) {
        if (sid === ctx.boundSessionId) {
          model = ensureSession(model, event.sessionId, event.name);
          model = updateSession(model, sid, { name: event.name });
          const sess = model.sessions.get(sid)!;
          const activeWid = sess.activeWindowId;
          if (activeWid !== null) {
            const win = model.windows.get(activeWid);
            const activePid = win?.activePaneId ?? null;
            if (activePid !== null) {
              model = setFocus(model, { paneId: activePid, windowId: activeWid, sessionId: sid });
            }
          }
          return model;
        }
        const outcome: SwitchClientOutcome = model.sessions.has(ctx.boundSessionId)
          ? "reattach"
          : "unavailable";
        ctx.onSwitchClientDetected?.(outcome);
        return model;
      }

      // boundSessionId absent: safe no-op.
      return model;
    }

    // -------------------------------------------------------------------------
    // %session-renamed $<sess> <name>
    //
    // Rename an existing session. If sessionId is null (older tmux format with no
    // $id prefix), rename the focused session as the best-effort fallback.
    // -------------------------------------------------------------------------
    case "session-renamed": {
      if (event.sessionId !== null) {
        const sid = mintSessionId(event.sessionId);
        return updateSession(model, sid, { name: event.name });
      }
      // Older tmux: no $id — rename the active session if there is one.
      if (model.focus.sessionId !== null) {
        return updateSession(model, model.focus.sessionId, { name: event.name });
      }
      return model;
    }

    // -------------------------------------------------------------------------
    // %sessions-changed
    //
    // Signals that the session list changed in some unspecified way. The reducer
    // cannot enumerate sessions without an explicit list (that's E4 bootstrap's
    // job via list-sessions). No model update; document for E4: on receiving this
    // event in the runtime, issue a list-sessions command to re-sync.
    // -------------------------------------------------------------------------
    case "sessions-changed": {
      // No-op at the model level. E4 runtime should issue list-sessions on this.
      return model;
    }

    // -------------------------------------------------------------------------
    // %session-window-changed $<sess> @<win>
    //
    // The active window within a session changed. Update the session's
    // activeWindowId. If this session is the focused session, also update focus.
    // -------------------------------------------------------------------------
    case "session-window-changed": {
      const sid = mintSessionId(event.sessionId);
      const wid = mintWindowId(event.windowId);

      const sess = model.sessions.get(sid);
      if (sess === undefined) return model;

      if (!sess.windowIds.includes(wid)) {
        // Window not yet registered in this session — skip to preserve invariants.
        return model;
      }

      model = updateSession(model, sid, { activeWindowId: wid });

      // Update focus triple if this is the active session.
      if (model.focus.sessionId === sid) {
        const win = model.windows.get(wid);
        const activePid = win?.activePaneId ?? null;
        if (activePid !== null) {
          model = setFocus(model, { paneId: activePid, windowId: wid, sessionId: sid });
        } else {
          model = setFocus(model, { paneId: null, windowId: null, sessionId: null });
        }
      }

      return model;
    }

    // -------------------------------------------------------------------------
    // %pane-mode-changed %<pane>
    //
    // The pane's mode changed (e.g. entered copy mode). The notification does not
    // carry the new mode value — the actual mode must be queried via `display-message
    // -p "#{pane_mode}"`. Here we record that a mode change occurred; E4 can issue
    // the query. We preserve the existing mode in the model (don't reset to "normal"
    // since we don't know the new value). E4 should issue a follow-up query.
    //
    // NOTE: if E4 supplies the actual mode via a separate path, it can call
    // updatePane directly. This event is a signal, not a value.
    // -------------------------------------------------------------------------
    case "pane-mode-changed": {
      // No-op: we don't know the new mode from the notification alone.
      // E4 runtime should query and call updatePane with the resolved mode.
      // The pane remains in its last-known mode until E4 updates it.
      return model;
    }

    // -------------------------------------------------------------------------
    // %subscription-changed …
    //
    // Subscription value delivery. Not a model-structure event; the value is
    // application-level data. No model update. E4 may dispatch to registered
    // subscription handlers outside the model.
    // -------------------------------------------------------------------------
    case "subscription-changed": {
      return model;
    }

    // -------------------------------------------------------------------------
    // %pause %<pane>
    //
    // tmux is pausing output to this pane (flow control). The model has no
    // "paused" flag on Pane (control.ts PaneMode doesn't include a flow-control
    // state). E4 runtime should track pause/continue state externally (e.g. a
    // Set<PaneId>) and stop consuming that pane's output channel. No model update.
    // -------------------------------------------------------------------------
    case "pause": {
      // No-op at model level. E4 tracks pause state out-of-band.
      return model;
    }

    // -------------------------------------------------------------------------
    // %continue %<pane>
    //
    // tmux is resuming output to this pane. Symmetric to pause: E4 runtime
    // clears the pane from its pause set. No model update.
    // -------------------------------------------------------------------------
    case "continue": {
      // No-op at model level. E4 tracks pause state out-of-band.
      return model;
    }

    // -------------------------------------------------------------------------
    // %exit [reason]
    //
    // tmux daemon is exiting. The model is left as-is (snapshot of last state).
    // E4 runtime should treat this as a signal to tear down the connection,
    // notify clients via ErrorMessage("session.unavailable"), and stop the
    // reducer loop. The reason string (if present) can be logged by E4.
    // -------------------------------------------------------------------------
    case "exit": {
      // No model update. E4 runtime handles shutdown on receiving this event.
      return model;
    }

    // -------------------------------------------------------------------------
    // %unknown (all unrecognized %-keywords, and %layout-change)
    //
    // %layout-change @<win> <layoutString> arrives here because it is not in the
    // notifications.ts vocabulary (confirmed by golden tests). We detect it by
    // keyword and process it inline.
    //
    // All other unknown keywords: no-op (graceful degradation).
    // -------------------------------------------------------------------------
    case "unknown": {
      if (event.keyword === "layout-change") {
        return handleLayoutChange(model, event.rawLine);
      }
      // Truly unknown keyword — no-op, don't crash.
      return model;
    }

    // -------------------------------------------------------------------------
    // internal:set-window-sync — optimistic model update for synchronize-panes
    //
    // Synthetic event injected by input-path.ts after sending
    // `set-option -wt @N synchronize-panes on|off` to tmux (tc-7xv.12).
    //
    // If tmux rejects the command, input-path observes the %error via the
    // correlator and dispatches a compensating `internal:set-window-sync`
    // with the captured before-value to roll the model back (tc-7xv.37).
    // -------------------------------------------------------------------------
    case "internal:set-window-sync": {
      const win = model.windows.get(event.windowId);
      if (!win) return model; // window not in model — drop
      if (win.synchronizePanes === event.on) return model; // no change
      return updateWindow(model, event.windowId, { synchronizePanes: event.on });
    }

    // ── tc-7xv.15 ──────────────────────────────────────────────────────────────

    // -------------------------------------------------------------------------
    // internal:set-window-monitor-activity — optimistic model update (tc-7xv.15)
    //
    // Synthetic event injected by input-path.ts after sending
    // `set-option -wt @N monitor-activity on|off` to tmux.  On tmux %error,
    // input-path dispatches a compensating event with the captured before-value
    // to roll the model back (tc-7xv.37).
    // -------------------------------------------------------------------------
    case "internal:set-window-monitor-activity": {
      const win = model.windows.get(event.windowId);
      if (!win) return model; // window not in model — drop
      if (win.monitorActivity === event.on) return model; // no change
      return updateWindow(model, event.windowId, { monitorActivity: event.on });
    }

    // -------------------------------------------------------------------------
    // internal:set-window-monitor-silence — optimistic model update (tc-7xv.15)
    //
    // Synthetic event injected by input-path.ts after sending
    // `set-option -wt @N monitor-silence <seconds|0>` to tmux.
    //
    // `seconds === 0` means disabled (tmux interprets `monitor-silence 0` as off).
    //
    // On tmux %error, input-path dispatches a compensating event with the
    // captured before-value to roll the model back (tc-7xv.37).
    // -------------------------------------------------------------------------
    case "internal:set-window-monitor-silence": {
      const win = model.windows.get(event.windowId);
      if (!win) return model; // window not in model — drop
      if (win.monitorSilence === event.seconds) return model; // no change
      return updateWindow(model, event.windowId, { monitorSilence: event.seconds });
    }

    // ── end tc-7xv.15 ─────────────────────────────────────────────────────────

    // -------------------------------------------------------------------------
    // Exhaustiveness check
    // If TypeScript reports an error here, a new NotificationEvent variant was
    // added to notifications.ts and must be handled above.
    // -------------------------------------------------------------------------
    default: {
      const _exhaustive: never = event;
      // Runtime guard (should never fire in well-typed code):
      console.warn(
        "[reducer] unhandled NotificationEvent kind:",
        (_exhaustive as { kind: string }).kind,
      );
      return model;
    }
  }
}

// ---------------------------------------------------------------------------
// layout-change handler (extracted for clarity)
// ---------------------------------------------------------------------------

/**
 * Process a `%layout-change @<win> <layoutString>` raw line.
 *
 * Steps:
 *   1. Parse the raw line to extract windowId and layoutString.
 *   2. Parse the layout string via `parseLayout`.
 *   3. Convert to `WindowLayout` via `parsedLayoutToWindowLayout`, mapping
 *      tmux leaf pane ids to daemon `PaneId`s via `mintPaneId`.
 *   4. Reconcile the window's pane set: ADD any pane from the layout that is
 *      not yet in the model (conservative add policy).
 *   5. Set the window's layout to the new `WindowLayout`.
 *
 * Returns the input model unchanged if the line is malformed, if the window
 * is not yet in the model (skip-and-wait: a %layout-change before %window-add
 * must not synthesize a session id — the layout will be applied once the window
 * is properly registered), or if the layout string cannot be parsed.
 */
function handleLayoutChange(model: SessionModel, rawLine: Uint8Array): SessionModel {
  const fields = parseLayoutChangeLine(rawLine);
  if (fields === null) return model;

  const { windowId: tmuxWinId, layoutString } = fields;
  const wid = mintWindowId(tmuxWinId);

  // If the window is not in the model yet, skip-and-wait.
  //
  // A %layout-change that names a window the model has not seen yet is an
  // early-layout race: the %window-add (which carries authoritative session
  // identity, cols, rows, and active-pane info) has not arrived yet. Creating
  // a synthetic session here ("s0") would mis-parent the window and corrupt
  // the model until a later session event corrects it.
  //
  // The correct response is to drop this layout notification. The layout will
  // be re-applied correctly once %window-add registers the window under its
  // real session, and any subsequent %layout-change (or the bootstrap
  // reconciliation in E4) will carry the authoritative geometry.
  if (!model.windows.has(wid)) {
    return model;
  }

  // Parse the layout string.
  let parsedLayout: import("../parser/layout-string.js").ParsedLayout;
  try {
    parsedLayout = parseLayout(layoutString);
  } catch {
    // Malformed layout string — leave the window's current layout unchanged.
    return model;
  }

  // Convert ParsedLayout → WindowLayout (branged PaneId mapping via mintPaneId).
  let windowLayout: import("../wire/layout.js").WindowLayout;
  try {
    windowLayout = parsedLayoutToWindowLayout(parsedLayout, mintPaneId);
  } catch {
    // Mapping error (e.g. unassigned leaf) — leave layout unchanged.
    return model;
  }

  // Reconcile pane set: add any pane from the layout that is missing in the
  // model, AND refresh the geometry of panes that already exist. %layout-change
  // carries the authoritative per-pane cols/rows, so a resize (refresh-client
  // -C → tmux reflow → %layout-change) round-trips all the way to
  // model.panes.get(id).cols/rows — which in turn lets diffModel emit a
  // pane.resized delta on the wire.
  const leaves = collectLayoutLeaves(parsedLayout.root);
  const win = model.windows.get(wid)!;

  for (const leaf of leaves) {
    const pid = mintPaneId(leaf.tmuxId);
    const existing = model.panes.get(pid);
    if (existing === undefined) {
      const pane: Pane = {
        paneId: pid,
        windowId: wid,
        sessionId: win.sessionId,
        cols: leaf.cols,
        rows: leaf.rows,
        mode: "normal",
        scrollbackHandle: undefined,
      };
      model = addPane(model, pane);
    } else if (existing.cols !== leaf.cols || existing.rows !== leaf.rows) {
      model = updatePane(model, pid, { cols: leaf.cols, rows: leaf.rows });
    }
  }

  // Set the window's layout.
  model = updateWindow(model, wid, { layout: windowLayout });

  return model;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { emptyModel } from "./model.js";
