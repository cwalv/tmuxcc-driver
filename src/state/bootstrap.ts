/**
 * Bootstrap coordinator — attach-time snapshot then live-delta handoff (tc-835).
 *
 * @module state/bootstrap
 *
 * # Problem
 *
 * When the daemon attaches to a `tmux -CC` session that ALREADY has
 * windows/panes, tmux does NOT replay their creation as notifications — they
 * already exist. A pure notification reducer (tc-8hy) starts from `emptyModel()`
 * and never learns about pre-existing structure. This module solves that by:
 *
 *   1. Issuing `list-windows` + `list-panes` queries on attach to enumerate
 *      the current state.
 *   2. Parsing the command-reply bodies into a complete initial `SessionModel`.
 *   3. While waiting for replies, BUFFERING any live notifications that arrive
 *      in the gap (tmux interleaves async notifications with command-reply blocks).
 *   4. Once all replies are processed, replaying the buffered notifications
 *      through `reduce()` in order, then transitioning to live-delta mode.
 *
 * # Bootstrap command set
 *
 * Two commands are issued on attach, in this order:
 *
 *   1. `list-windows -a -F <BOOTSTRAP_WINDOWS_FORMAT>`
 *      (-a = across all sessions; without it, tmux uses the current session
 *      only, and at attach time there may be no "current" session yet)
 *
 *   2. `list-panes -a -F <BOOTSTRAP_PANES_FORMAT>`
 *      (-a = all panes across all sessions + windows)
 *
 * The replies come back in FIFO order (tmux guarantees this). The coordinator
 * waits for BOTH before building the initial model.
 *
 * Scrollback bootstrap (per-pane `capture-pane`) is explicitly OUT OF SCOPE
 * here: it requires one round-trip per pane and the byte content is the data
 * plane's responsibility (tc-fbz / tc-2mq). The structural snapshot (windows /
 * panes / layout / focus) is complete after the two queries above.
 *
 * # Format strings (validated against real tmux 3.4 output)
 *
 * ## BOOTSTRAP_WINDOWS_FORMAT
 *
 *   `#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t` +
 *   `#{window_width}\t#{window_height}\t#{window_layout}\t` +
 *   `#{window_flags}\t#{?window_active,1,0}`
 *
 * Fields (tab-separated, 9 per line):
 *   [0] session_id    — `$N`  (e.g. "$0")
 *   [1] session_name  — human name
 *   [2] window_id     — `@N`  (e.g. "@1")
 *   [3] window_name   — human name
 *   [4] window_width  — integer columns
 *   [5] window_height — integer rows
 *   [6] window_layout — layout string (e.g. "b25d,80x24,0,0,0")
 *   [7] window_flags  — flag chars (e.g. "*", "-", "!")
 *   [8] window_active — "1" if this is the session's active window, "0" otherwise
 *
 * Note: we use `window_layout` (not `window_visible_layout`) — both carry pane
 * IDs in tmux 3.x, but `window_layout` is canonical and always present.
 *
 * ## BOOTSTRAP_PANES_FORMAT
 *
 *   `#{pane_id}\t#{window_id}\t#{session_id}\t#{pane_index}\t` +
 *   `#{pane_width}\t#{pane_height}\t#{pane_top}\t#{pane_left}\t` +
 *   `#{?pane_active,1,0}\t#{pane_pid}\t#{pane_current_command}`
 *
 * Fields (tab-separated, 11 per line):
 *   [0] pane_id           — `%N` (e.g. "%2")
 *   [1] window_id         — `@N`
 *   [2] session_id        — `$N`
 *   [3] pane_index        — integer (0-based index in window)
 *   [4] pane_width        — integer columns
 *   [5] pane_height       — integer rows
 *   [6] pane_top          — integer y offset (for geometry cross-check)
 *   [7] pane_left         — integer x offset
 *   [8] pane_active       — "1" if active pane in its window, "0" otherwise
 *   [9] pane_pid          — integer (unused in model; logged only)
 *   [10] pane_current_command — human name of running process
 *
 * # Id mapping convention
 *
 * Same as the reducer (tc-8hy): tmux numeric ids map to daemon branded ids via:
 *   paneId("p" + N)    for tmux `%N`
 *   windowId("w" + N)  for tmux `@N`
 *   sessionId("s" + N) for tmux `$N`
 * This is the SAME deterministic convention used by `reduce()` so that
 * buffered live notifications (which arrive as numeric ids) map to the same
 * branded ids the bootstrap model has already registered.
 *
 * # Handoff state machine
 *
 * States:
 *   "bootstrapping" — queries issued; replies pending. Live notifications are
 *                     buffered in `_pendingEvents`.
 *   "live"          — both replies processed; initial model built; buffered
 *                     events replayed; `reduce()` called directly for new events.
 *
 * Transition:
 *   The coordinator is constructed with `_phase = "bootstrapping"`.
 *   `onWindowsResult(result)` stores the windows reply.
 *   `onPanesResult(result)` stores the panes reply.
 *   When BOTH are stored, `_tryFinishBootstrap()` builds the model and replays
 *   buffered events, setting `_phase = "live"`.
 *
 * # Idempotency policy
 *
 * During replay, a buffered notification may be redundant with the bootstrap
 * snapshot (e.g. a `%window-add @0` for a window that `list-windows` already
 * returned). `reduce()` handles this gracefully:
 *   - `window-add` for an existing window: `addWindow` is guarded by
 *     `if (!model.windows.has(wid)) return model` — no-op.
 *   - `session-changed` for an existing session: `ensureSession` is a no-op,
 *     and `updateSession` + `setFocus` are idempotent.
 * So we do NOT need to de-duplicate the buffered queue before replay; we rely
 * on the reducer's own idempotency guards. The final model will be consistent.
 *
 * # E4 integration contract
 *
 * E4 (daemon runtime, tc-aum) drives the coordinator:
 *
 * ```ts
 * // On attach:
 * const coord = new BootstrapCoordinator({ buffers: myBufferStore });
 * const [winCmd, paneCmd] = coord.bootstrapCommands();
 * // send winCmd then paneCmd to tmux over the control-mode socket
 * // register two expectCommand() slots in the correlator
 *
 * // As tokens arrive from the tokenizer, via the correlator:
 * correlator.onNotification = (token) => {
 *   const event = parseNotification(token);
 *   coord.onNotification(event);
 * };
 * const winResult = await correlator.expectCommand();
 * coord.onWindowsResult(winResult);
 * const paneResult = await correlator.expectCommand();
 * coord.onPanesResult(paneResult);
 *
 * // After both replies, coord is live:
 * // coord.isLive() === true
 * // coord.getModel() is the complete initial model
 *
 * // Ongoing notifications:
 * correlator.onNotification = (token) => {
 *   const event = parseNotification(token);
 *   coord.onNotification(event);  // delegates to reduce() directly
 * };
 * ```
 *
 * NOTE: E4 should register the two `expectCommand()` slots BEFORE sending the
 * commands to tmux (the correlator FIFO guarantee). The coordinator's
 * `bootstrapCommands()` method returns the command strings to send.
 *
 * The coordinator is single-threaded (Node.js event loop). All calls to
 * `onNotification`, `onWindowsResult`, and `onPanesResult` happen on the same
 * tick or in microtask callbacks — no locking needed.
 */

import { parseLayout } from "../parser/layout-string.js";
import type { CommandResult } from "../parser/correlator.js";
import type { NotificationEvent } from "../parser/notifications.js";
import { listWindows, listPanes } from "../parser/commands.js";
import type { SessionModel, Session, Window, Pane } from "./model.js";
import {
  emptyModel,
  addSession,
  addWindow,
  addPane,
  updateWindow,
  updateSession,
  setFocus,
  parsedLayoutToWindowLayout,
  paneId,
  windowId,
  sessionId,
} from "./model.js";
import type { PaneId, WindowId, SessionId } from "../wire/ids.js";
import { reduce, type ReducerContext, type SwitchClientOutcome } from "./reducer.js";

// ---------------------------------------------------------------------------
// Format strings
// ---------------------------------------------------------------------------

/**
 * Format string for `list-windows -a` during bootstrap.
 *
 * Includes `session_id` and `session_name` so we can build Session entities
 * from the windows reply alone (no separate `list-sessions` needed).
 * Uses `window_layout` (not `window_visible_layout`) — canonical, always set.
 */
export const BOOTSTRAP_WINDOWS_FORMAT =
  "#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t" +
  "#{window_width}\t#{window_height}\t#{window_layout}\t" +
  "#{window_flags}\t#{?window_active,1,0}";

/**
 * Format string for `list-panes -a` during bootstrap.
 *
 * Includes `session_id` for cross-referencing, and both `pane_active` and
 * dimensional fields (`pane_width`, `pane_height`) to populate the Pane struct.
 */
export const BOOTSTRAP_PANES_FORMAT =
  "#{pane_id}\t#{window_id}\t#{session_id}\t#{pane_index}\t" +
  "#{pane_width}\t#{pane_height}\t#{pane_top}\t#{pane_left}\t" +
  "#{?pane_active,1,0}\t#{pane_pid}\t#{pane_current_command}";

// ---------------------------------------------------------------------------
// Bootstrap command set
// ---------------------------------------------------------------------------

/**
 * Return the two tmux commands to issue on attach.
 *
 * The daemon sends these in order; the correlator pairs the replies in FIFO
 * order. E4 must call `expectCommand()` TWICE on the correlator before (or
 * immediately after) sending, so that the reply blocks are matched in order.
 *
 * Returns: `[listWindowsCommand, listPanesCommand]`
 */
export function bootstrapCommands(): [string, string] {
  const winCmd = listWindows(BOOTSTRAP_WINDOWS_FORMAT) + " -a";
  const paneCmd = listPanes(undefined, BOOTSTRAP_PANES_FORMAT) + " -a";
  return [winCmd, paneCmd];
}

// ---------------------------------------------------------------------------
// Id minting (same convention as reducer.ts — MUST match)
// ---------------------------------------------------------------------------

function mintPaneId(n: number): PaneId {
  return paneId("p" + n);
}

function mintWindowId(n: number): WindowId {
  return windowId("w" + n);
}

function mintSessionId(n: number): SessionId {
  return sessionId("s" + n);
}

// ---------------------------------------------------------------------------
// Reply parsers
// ---------------------------------------------------------------------------

/**
 * Parsed record from one line of a `list-windows -a` reply.
 * @internal
 */
export interface WindowsReplyRow {
  readonly tmuxSessionId: number;
  readonly sessionName: string;
  readonly tmuxWindowId: number;
  readonly windowName: string;
  readonly width: number;
  readonly height: number;
  readonly layoutString: string;
  readonly flags: string;
  readonly active: boolean;
}

/**
 * Parsed record from one line of a `list-panes -a` reply.
 * @internal
 */
export interface PanesReplyRow {
  readonly tmuxPaneId: number;
  readonly tmuxWindowId: number;
  readonly tmuxSessionId: number;
  readonly paneIndex: number;
  readonly width: number;
  readonly height: number;
  readonly paneTop: number;
  readonly paneLeft: number;
  readonly active: boolean;
}

/**
 * Parse the body of a `list-windows -a` command reply.
 *
 * Each non-empty line is one window, tab-separated in BOOTSTRAP_WINDOWS_FORMAT
 * order. Lines with wrong field count are silently skipped (defensive).
 *
 * @param body - The raw `CommandResult.body` (UTF-8 encoded text).
 * @returns Array of parsed window rows.
 */
export function parseWindowsReply(body: Uint8Array): WindowsReplyRow[] {
  const text = new TextDecoder().decode(body);
  const rows: WindowsReplyRow[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const parts = trimmed.split("\t");
    if (parts.length < 9) continue; // defensive: skip malformed lines

    const sessIdStr = parts[0]!; // e.g. "$0"
    const sessName = parts[1]!;
    const winIdStr = parts[2]!;  // e.g. "@1"
    const winName = parts[3]!;
    const width = parseInt(parts[4]!, 10);
    const height = parseInt(parts[5]!, 10);
    const layoutStr = parts[6]!;
    const flags = parts[7]!;
    const active = parts[8]!.trim() === "1";

    // Parse tmux sigil ids: $N → N, @N → N
    const tmuxSessionId = parseSigilId(sessIdStr, "$");
    const tmuxWindowId = parseSigilId(winIdStr, "@");
    if (tmuxSessionId === null || tmuxWindowId === null) continue;
    if (isNaN(width) || isNaN(height)) continue;

    rows.push({
      tmuxSessionId,
      sessionName: sessName,
      tmuxWindowId,
      windowName: winName,
      width,
      height,
      layoutString: layoutStr,
      flags,
      active,
    });
  }

  return rows;
}

/**
 * Parse the body of a `list-panes -a` command reply.
 *
 * Each non-empty line is one pane, tab-separated in BOOTSTRAP_PANES_FORMAT
 * order. Lines with wrong field count are silently skipped.
 *
 * @param body - The raw `CommandResult.body` (UTF-8 encoded text).
 * @returns Array of parsed pane rows.
 */
export function parsePanesReply(body: Uint8Array): PanesReplyRow[] {
  const text = new TextDecoder().decode(body);
  const rows: PanesReplyRow[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const parts = trimmed.split("\t");
    if (parts.length < 9) continue; // need at least through pane_active

    const paneIdStr = parts[0]!;   // e.g. "%2"
    const winIdStr = parts[1]!;    // e.g. "@1"
    const sessIdStr = parts[2]!;   // e.g. "$0"
    const paneIndex = parseInt(parts[3]!, 10);
    const width = parseInt(parts[4]!, 10);
    const height = parseInt(parts[5]!, 10);
    const paneTop = parseInt(parts[6]!, 10);
    const paneLeft = parseInt(parts[7]!, 10);
    const active = parts[8]!.trim() === "1";

    const tmuxPaneId = parseSigilId(paneIdStr, "%");
    const tmuxWindowId = parseSigilId(winIdStr, "@");
    const tmuxSessionId = parseSigilId(sessIdStr, "$");
    if (tmuxPaneId === null || tmuxWindowId === null || tmuxSessionId === null) continue;
    if (isNaN(width) || isNaN(height)) continue;

    rows.push({
      tmuxPaneId,
      tmuxWindowId,
      tmuxSessionId,
      paneIndex,
      width,
      height,
      paneTop,
      paneLeft,
      active,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

/**
 * Build an initial `SessionModel` from parsed windows + panes rows.
 *
 * Algorithm:
 *   1. Collect sessions from windows rows (unique by tmuxSessionId); mark the
 *      session whose window with `active=true` forms the focus triple.
 *   2. Add sessions to the model (windowIds starts empty; filled in step 3).
 *   3. Add windows (with layout parsed from layoutString; paneIds filled in
 *      step 4). Mark each session's active window.
 *   4. Add panes from the panes rows. Mark each window's active pane.
 *   5. Compute the global focus triple (active session → its active window →
 *      that window's active pane). Invariant I7 requires all-or-nothing.
 *
 * Layout parsing: `window_layout` from list-windows carries the canonical
 * layout string (e.g. `b25d,80x24,0,0,0` or `020a,80x24,0,0{…}`). Leaf pane
 * ids in the layout are integer tmux ids. `parsedLayoutToWindowLayout` is
 * called with `mintPaneId` so the tree carries the correct branded ids.
 * If `parseLayout` throws (malformed string), the window's layout is set to
 * `null` (will be corrected on the first `%layout-change` delta).
 *
 * @param windowRows - Output of `parseWindowsReply`.
 * @param paneRows   - Output of `parsePanesReply`.
 * @returns A complete `SessionModel`.
 */
export function buildInitialModel(
  windowRows: WindowsReplyRow[],
  paneRows: PanesReplyRow[],
): SessionModel {
  let model = emptyModel();

  // ---- Step 1: collect sessions ----------------------------------------
  // Keyed by tmuxSessionId. We also track which session is the "active"
  // session (has an active window). In practice, the daemon attaches to one
  // session; but we enumerate all to support multi-session setups.
  const sessionNames = new Map<number, string>();
  const sessionActiveWindowId = new Map<number, number>(); // tmux ids

  for (const row of windowRows) {
    if (!sessionNames.has(row.tmuxSessionId)) {
      sessionNames.set(row.tmuxSessionId, row.sessionName);
    }
    if (row.active) {
      sessionActiveWindowId.set(row.tmuxSessionId, row.tmuxWindowId);
    }
  }

  // ---- Step 2: add sessions (empty windowIds for now) ------------------
  for (const [tmuxSessId, name] of sessionNames) {
    const sid = mintSessionId(tmuxSessId);
    const session: Session = {
      sessionId: sid,
      name,
      windowIds: [],
      activeWindowId: null, // filled in step 3
    };
    model = addSession(model, session);
  }

  // ---- Step 3: add windows with layout ---------------------------------
  // Group panes by window for active-pane detection (step 4 preview).
  const panesByWindow = new Map<number, PanesReplyRow[]>();
  for (const row of paneRows) {
    let list = panesByWindow.get(row.tmuxWindowId);
    if (list === undefined) {
      list = [];
      panesByWindow.set(row.tmuxWindowId, list);
    }
    list.push(row);
  }

  for (const row of windowRows) {
    const wid = mintWindowId(row.tmuxWindowId);
    const sid = mintSessionId(row.tmuxSessionId);

    // Parse layout — null on failure (fixed by first %layout-change delta).
    let layout: import("../wire/layout.js").WindowLayout | null = null;
    try {
      const parsed = parseLayout(row.layoutString);
      layout = parsedLayoutToWindowLayout(parsed, mintPaneId);
    } catch {
      // Malformed or unrecognized layout string — leave null.
    }

    // Determine active pane from panes rows (if available).
    const winPanes = panesByWindow.get(row.tmuxWindowId) ?? [];
    const activePaneRow = winPanes.find((p) => p.active);
    const activePaneId = activePaneRow !== undefined ? mintPaneId(activePaneRow.tmuxPaneId) : null;

    const win: Window = {
      windowId: wid,
      sessionId: sid,
      name: row.windowName,
      paneIds: [], // filled in step 4
      activePaneId, // we know the active pane from panes reply
      layout,
      synchronizePanes: false, // default; updated by hook if already on (tc-7xv.12)
      monitorActivity: true,   // ── tc-7xv.15 ── default; updated by hook if off
      monitorSilence: 0,       // ── tc-7xv.15 ── default; updated by hook if on
    };

    // addWindow appends to session.windowIds and sets session.activeWindowId
    // to the first window seen (its `activeWindowId ?? win.windowId` guard).
    // We'll fix activeWindowId in step 3b below.
    model = addWindow(model, win);
  }

  // Step 3b: fix each session's activeWindowId to the correct one.
  for (const [tmuxSessId, tmuxActiveWinId] of sessionActiveWindowId) {
    const sid = mintSessionId(tmuxSessId);
    model = updateSession(model, sid, { activeWindowId: mintWindowId(tmuxActiveWinId) });
  }

  // ---- Step 4: add panes -----------------------------------------------
  for (const row of paneRows) {
    const pid = mintPaneId(row.tmuxPaneId);
    const wid = mintWindowId(row.tmuxWindowId);
    const sid = mintSessionId(row.tmuxSessionId);

    // Guard: skip if the parent window isn't in the model (shouldn't happen
    // with correct tmux output, but be defensive).
    if (!model.windows.has(wid)) continue;
    // Idempotent: skip if already added (e.g. layout-change reconciliation
    // during a later delta pre-added this pane).
    if (model.panes.has(pid)) continue;

    const p: Pane = {
      paneId: pid,
      windowId: wid,
      sessionId: sid,
      cols: row.width,
      rows: row.height,
      mode: "normal",
      scrollbackHandle: undefined,
    };
    // addPane appends to window.paneIds and sets activePaneId if null.
    // Our Window was created with activePaneId already set from the panes
    // rows, but addPane's guard is `activePaneId ?? pane.paneId` — it only
    // overwrites null. So the first addPane to a window with a pre-set
    // activePaneId leaves it intact. Good.
    model = addPane(model, p);
  }

  // ---- Step 5: compute global focus triple -----------------------------
  // Find the session with the most recently-active indicator. In a typical
  // single-session daemon attach, there's one session. For multi-session,
  // we pick the session whose active window flag was set (arbitrary tie-break:
  // first such session in iteration order).
  //
  // Focus is set only if we have a session → window → pane triple. If any
  // leg is missing (session has no windows, window has no active pane), we
  // leave focus null-null-null (checkInvariants I7 all-null is valid).
  let focusSet = false;
  for (const [tmuxSessId] of sessionActiveWindowId) {
    const sid = mintSessionId(tmuxSessId);
    const sess = model.sessions.get(sid);
    if (sess === undefined) continue;
    const activeWid = sess.activeWindowId;
    if (activeWid === null) continue;
    const win = model.windows.get(activeWid);
    if (win === undefined) continue;
    const activePid = win.activePaneId;
    if (activePid === null) continue;
    model = setFocus(model, { paneId: activePid, windowId: activeWid, sessionId: sid });
    focusSet = true;
    break; // first active session wins
  }
  if (!focusSet) {
    // No active-window info or no panes: focus stays null-null-null.
    model = setFocus(model, { paneId: null, windowId: null, sessionId: null });
  }

  return model;
}

// ---------------------------------------------------------------------------
// BootstrapCoordinator
// ---------------------------------------------------------------------------

/** Options for constructing a `BootstrapCoordinator`. */
export interface BootstrapCoordinatorOptions {
  /**
   * The per-pane byte buffer store (tc-fx2).
   * Passed through to `reduce()` for `%output` / `%extended-output` events.
   */
  readonly buffers: ReducerContext["buffers"];

  /**
   * The tmux session name this daemon is attached to (the `-t <name>` argument
   * from TmuxHostOptions). Used to resolve `boundSessionId` from the initial
   * model after bootstrap: the coordinator finds the session whose name matches
   * `sessionName` and wires the resulting `SessionId` into the ReducerContext
   * so that switch-client narrowing fires correctly on live notifications.
   *
   * When absent, `boundSessionId` is left undefined in the ReducerContext and
   * `%session-changed` / `%client-session-changed` events are no-ops.
   */
  readonly sessionName?: string;

  /**
   * Called by the reducer when a switch-client drift is detected (tc-j9c.7).
   * Forwarded into the ReducerContext after bootstrap resolves `boundSessionId`.
   *
   * "reattach"   — bound session still present; caller should issue
   *                `attach-session -t <bound>` silently.
   * "unavailable" — bound session gone; caller should broadcast
   *                 ErrorMessage{code:"session.unavailable"} and close clients.
   */
  readonly onSwitchClientDetected?: (outcome: SwitchClientOutcome) => void;
}

/**
 * Bootstrap lifecycle state.
 *   "bootstrapping" — waiting for command replies; notifications are buffered.
 *   "live"          — initial model built; notifications go directly to reduce().
 */
export type BootstrapPhase = "bootstrapping" | "live";

/**
 * Stateful coordinator for the attach-time bootstrap → live-delta handoff.
 *
 * Lifecycle:
 *   1. Construct `new BootstrapCoordinator(opts)`.
 *   2. Call `bootstrapCommands()` and send those commands to tmux.
 *   3. Feed all incoming notifications to `onNotification()` — even before
 *      replies arrive (they will be buffered).
 *   4. When the `list-windows` reply block completes, call `onWindowsResult(result)`.
 *   5. When the `list-panes` reply block completes, call `onPanesResult(result)`.
 *   6. After step 5, `isLive()` returns true and `getModel()` is the complete
 *      initial model with all buffered events already replayed.
 *   7. Subsequent `onNotification()` calls go directly to `reduce()`.
 *
 * Thread safety: single-threaded (Node.js event loop). No locking needed.
 */
export class BootstrapCoordinator {
  private _phase: BootstrapPhase = "bootstrapping";
  private _model: SessionModel = emptyModel();
  private _ctx: ReducerContext;

  /** The tmux session name to resolve boundSessionId from the initial model. */
  private readonly _sessionName: string | undefined;

  /** Callback forwarded into ReducerContext once boundSessionId is resolved. */
  private readonly _onSwitchClientDetected: ((outcome: SwitchClientOutcome) => void) | undefined;

  /** Buffered live notifications that arrived during bootstrapping. */
  private _pendingEvents: NotificationEvent[] = [];

  /** Stored windows reply (set by onWindowsResult). */
  private _windowsResult: CommandResult | null = null;
  /** Stored panes reply (set by onPanesResult). */
  private _panesResult: CommandResult | null = null;

  constructor(opts: BootstrapCoordinatorOptions) {
    this._ctx = { buffers: opts.buffers };
    this._sessionName = opts.sessionName;
    this._onSwitchClientDetected = opts.onSwitchClientDetected;
  }

  // ---- Query ---------------------------------------------------------------

  /** Current lifecycle phase. */
  phase(): BootstrapPhase {
    return this._phase;
  }

  /** True once the initial model is built and buffered events replayed. */
  isLive(): boolean {
    return this._phase === "live";
  }

  /**
   * The current session model.
   *
   * During "bootstrapping": the empty initial model (not yet populated).
   * During/after "live": the model built from bootstrap replies + all replayed
   * and subsequent live notifications.
   */
  getModel(): SessionModel {
    return this._model;
  }

  // ---- Commands ------------------------------------------------------------

  /**
   * Return the two bootstrap commands to send to tmux on attach.
   *
   * E4 must send these in order and register two `expectCommand()` slots on
   * the correlator (in the same order) before sending, so FIFO matching works.
   *
   * Returns: `[listWindowsCmd, listPanesCmd]`
   */
  bootstrapCommands(): [string, string] {
    return bootstrapCommands();
  }

  // ---- Event ingestion -----------------------------------------------------

  /**
   * Feed a live notification event to the coordinator.
   *
   * During "bootstrapping": the event is appended to `_pendingEvents` for
   * replay after the bootstrap replies are processed.
   *
   * During "live": the event is applied directly to the model via `reduce()`.
   *
   * This method should be called for EVERY notification that arrives from the
   * tokenizer, regardless of phase. The coordinator handles the buffering
   * transparently so E4 does not need to track phase separately for routing.
   */
  onNotification(event: NotificationEvent): void {
    if (this._phase === "bootstrapping") {
      this._pendingEvents.push(event);
    } else {
      this._model = reduce(this._model, event, this._ctx);
    }
  }

  /**
   * Deliver the `list-windows -a` command reply.
   *
   * Call this when the correlator resolves the first `expectCommand()` promise
   * (the one registered for the list-windows command). If `result.ok` is false
   * (tmux returned `%error`), the coordinator logs a warning and falls back to
   * an empty windows set — the model will have no windows/sessions, but the
   * handoff still completes and replayed notifications may partially populate it.
   */
  onWindowsResult(result: CommandResult): void {
    this._windowsResult = result;
    this._tryFinishBootstrap();
  }

  /**
   * Deliver the `list-panes -a` command reply.
   *
   * Call this when the correlator resolves the second `expectCommand()` promise
   * (the one registered for the list-panes command). Same fallback logic as
   * `onWindowsResult` for `%error` replies.
   */
  onPanesResult(result: CommandResult): void {
    this._panesResult = result;
    this._tryFinishBootstrap();
  }

  // ---- Internal ------------------------------------------------------------

  /**
   * If both replies have arrived, build the initial model and replay buffered
   * events. Called after each `onWindowsResult` / `onPanesResult` call.
   */
  private _tryFinishBootstrap(): void {
    if (this._windowsResult === null || this._panesResult === null) {
      return; // still waiting for the other reply
    }

    // Parse the command-reply bodies.
    const windowRows = this._windowsResult.ok
      ? parseWindowsReply(this._windowsResult.body)
      : [];
    const paneRows = this._panesResult.ok
      ? parsePanesReply(this._panesResult.body)
      : [];

    if (!this._windowsResult.ok) {
      console.warn("[bootstrap] list-windows returned %error — starting from empty model");
    }
    if (!this._panesResult.ok) {
      console.warn("[bootstrap] list-panes returned %error — no panes in initial model");
    }

    // Build the initial model from the parsed rows.
    this._model = buildInitialModel(windowRows, paneRows);

    // Resolve boundSessionId from the initial model by name (tc-j9c.7).
    // We must do this BEFORE replaying buffered events so that any
    // %session-changed / %client-session-changed in the buffer is handled
    // with the correct narrowing context rather than being a no-op.
    //
    // Fallback: if the session is not in the initial model (e.g. bootstrap
    // command replies were in unexpected format), scan the pending notification
    // buffer for a %session-changed or %client-session-changed event whose
    // name matches sessionName.  This handles the case where the bootstrap
    // model is empty but a live notification carries the session id.
    if (this._sessionName !== undefined) {
      let foundId: SessionId | undefined;

      // Primary: look in the initial model.
      for (const [sid, sess] of this._model.sessions) {
        if (sess.name === this._sessionName) {
          foundId = sid;
          break;
        }
      }

      // Fallback: scan buffered notifications.
      if (foundId === undefined) {
        for (const event of this._pendingEvents) {
          if (
            (event.kind === "session-changed" || event.kind === "client-session-changed") &&
            event.name === this._sessionName
          ) {
            foundId = sessionId("s" + event.sessionId);
            break;
          }
        }
      }

      if (foundId !== undefined) {
        this._ctx = {
          buffers: this._ctx.buffers,
          boundSessionId: foundId,
          ...(this._onSwitchClientDetected !== undefined
            ? { onSwitchClientDetected: this._onSwitchClientDetected }
            : {}),
        };
      } else {
        console.warn(
          `[bootstrap] session name "${this._sessionName}" not found in initial model or` +
            " buffered notifications — boundSessionId not set; switch-client narrowing disabled.",
        );
      }
    }

    // Transition to live BEFORE replaying buffered events so that any event
    // that triggers onNotification() re-entrantly (pathological but safe) goes
    // to reduce() directly.
    this._phase = "live";

    // Replay all buffered notifications in arrival order.
    // Idempotency: redundant events (e.g. window-add for an already-present
    // window) are no-ops in reduce() — see idempotency policy in module doc.
    const pending = this._pendingEvents;
    this._pendingEvents = []; // clear before replay to avoid double-replay on re-entry
    for (const event of pending) {
      this._model = reduce(this._model, event, this._ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a tmux sigil-prefixed id string into a numeric id.
 *
 * @param s      - The raw field value (e.g. "$0", "@1", "%2").
 * @param sigil  - Expected leading character ("$", "@", or "%").
 * @returns The numeric id, or null if the string doesn't start with `sigil`
 *          or the remainder is not a valid non-negative integer.
 */
function parseSigilId(s: string, sigil: string): number | null {
  if (!s.startsWith(sigil)) return null;
  const rest = s.slice(sigil.length);
  if (rest === "" || !/^\d+$/.test(rest)) return null;
  return parseInt(rest, 10);
}
