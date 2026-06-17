/**
 * Bootstrap reply parsing + initial-model builder (tc-835, retained tc-128.4).
 *
 * @module state/bootstrap
 *
 * # What this used to be
 *
 * In the per-event-reducer architecture (tc-5dd) this module also hosted a
 * `BootstrapCoordinator` class that drove an attach-time list-windows /
 * list-panes exchange, BUFFERED live notifications during the round-trip,
 * REPLAYED them through `reduce()` on completion, and then transitioned to
 * "live" reducer mode.
 *
 * # What it is now (tc-128.4)
 *
 * The §6 requery-on-event design (state-model.md) retired the reducer's
 * per-event interpretation; `RequeryEngine` (state/requery.ts) now owns the
 * bootstrap path end-to-end. Bootstrap is just `engine.requery()` with the
 * empty model as the previous: the diff against empty yields a full snapshot
 * of deltas, and there's no separate "live vs bootstrapping" phase to
 * coordinate. Notifications that arrive during the round-trip are demoted to
 * a dirty bit by the coalescer, which schedules the next requery — no
 * separate buffer-and-replay path is needed.
 *
 * This module survives because the WIRE-LEVEL pieces are still used:
 *
 *   - `BOOTSTRAP_WINDOWS_FORMAT` / `BOOTSTRAP_PANES_FORMAT` — the
 *     `display-message -F` format strings.
 *   - `bootstrapCommands(sessionName?)` — builds the two `list-*` command
 *     lines (engine calls this on every cycle).
 *   - `parseWindowsReply` / `parsePanesReply` — turn the command-reply
 *     bodies into typed rows.
 *   - `buildInitialModel` — folds the rows into a complete `SessionModel`.
 *
 * The engine composes these in `requeryDiff` (state/requery.ts).
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
 * ## BOOTSTRAP_PANES_FORMAT
 *
 *   `#{pane_id}\t#{window_id}\t#{session_id}\t#{pane_index}\t` +
 *   `#{pane_width}\t#{pane_height}\t#{pane_top}\t#{pane_left}\t` +
 *   `#{?pane_active,1,0}\t#{pane_pid}\t#{pane_current_command}\t` +
 *   `#{?pane_dead,1,0}\t#{pane_dead_status}\t#{@tmuxcc_label}`
 *
 * Fields (tab-separated, 14 per line). Fields [11]/[12] are the dead-pane state
 * (tc-4bv2 / tc-295a.10 shared shape); [13] is the durable pane name (tc-1a8z):
 *   [11] pane_dead        — "1" if the pane's process has exited but the slot
 *                           survives (remain-on-exit corpse), "0" otherwise.
 *   [12] pane_dead_status — the exited process's status code; empty string when
 *                           the pane is alive or tmux has no status to report.
 *   [13] @tmuxcc_label    — the durable, driver-owned pane name (the per-pane
 *                           user-option set by the `rename-pane` verb); empty
 *                           string when no durable name is set.  Re-read on
 *                           every requery so the name survives a driver restart.
 *
 * # Id mapping convention
 *
 *   paneId("p" + N)    for tmux `%N`
 *   windowId("w" + N)  for tmux `@N`
 *   sessionId("s" + N) for tmux `$N`
 */

import { parseLayout } from "../parser/layout-string.js";
import { listWindows, listPanes } from "../parser/commands.js";
import type { SessionModel, Session, Window, Pane } from "./model.js";
import {
  emptyModel,
  addSession,
  addWindow,
  addPane,
  updateSession,
  setFocus,
  parsedLayoutToWindowLayout,
  paneId,
  windowId,
  sessionId,
} from "./model.js";
import type { PaneId, WindowId, SessionId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Pane user-options
// ---------------------------------------------------------------------------

/**
 * The per-pane tmux user-option that stores the durable, driver-owned pane
 * name (tc-1a8z).
 *
 * Single source of truth for the option NAME, shared by the WRITE side
 * (input-path's `rename-pane` verb → `set-option -pt %N @tmuxcc_label <name>`)
 * and the READ side (BOOTSTRAP_PANES_FORMAT below → `#{@tmuxcc_label}`).  It
 * mirrors the session-ownership marker `@tmuxcc` (tc-w61): canonical state
 * lives WITH the pane in tmux, so it survives a driver restart for free and is
 * natively introspectable.
 *
 * This is the DURABLE channel — never set via a title escape, so the shell
 * cannot clobber it.  Distinct from the live pane_title (tc-2mn8).
 */
export const TMUXCC_LABEL_OPTION = "@tmuxcc_label";

// ---------------------------------------------------------------------------
// Cold-start durable policy/intent user-options (tc-i9aq.1, cold-start.md §4.A)
// ---------------------------------------------------------------------------

/**
 * Per-pane binding-intent marker (cold-start.md §4.A).  `1` means "the user
 * wants a VS Code terminal recreated for this pane on attach" (durable binding
 * intent); unset/empty means no intent.  Written by the `set-object-policy`
 * verb at PANE scope (`set-option -pt %N @tmuxcc-bound 1` / `-u` to clear) and
 * re-read on every requery.  Lives WITH the pane in tmux, so it survives a VS
 * Code restart and vanishes with the pane — staleness is structurally
 * impossible (it cannot outlive its referent).
 */
export const TMUXCC_BOUND_OPTION = "@tmuxcc-bound";

/**
 * Detach-on-close policy (cold-start.md §4.A).  Value is `detach` or `kill`;
 * unset/empty means "inherit" (defer to the next scope in the cascade).  Set at
 * PANE, WINDOW, or SESSION scope by the `set-object-policy` verb.
 *
 * tmux does NOT inherit user-options across scopes for `show-options`, but a
 * `#{@tmuxcc-detach}` FORMAT reference DOES walk pane→window→session (verified
 * tmux 3.4).  The requery reads this through `list-panes -F`, so the pane row
 * carries the RESOLVED (effective) close policy — pane override, else window
 * default, else session default — which is exactly the first-wins cascade the
 * host's close decision consumes.  Per-scope-OWN values (for the toggle UI's
 * "current setting" display) are tracked optimistically in the extension's
 * in-memory policy cache (bucket B), written through this verb; the durable
 * truth is the tmux object.
 */
export const TMUXCC_DETACH_OPTION = "@tmuxcc-detach";

/**
 * Per-pane icon policy (cold-start.md §4.A).  Opaque string (a VS Code
 * ThemeIcon id or icon-policy token); unset/empty means "no durable icon
 * policy".  Written at PANE scope by the `set-object-policy` verb and re-read
 * on every requery.
 */
export const TMUXCC_ICON_OPTION = "@tmuxcc-icon";

// ---------------------------------------------------------------------------
// Format strings
// ---------------------------------------------------------------------------

/**
 * Format string for `list-windows` during bootstrap.
 *
 * Includes `session_id` and `session_name` so the engine can build Session
 * entities from the windows reply alone (no separate `list-sessions` needed).
 */
export const BOOTSTRAP_WINDOWS_FORMAT =
  "#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t" +
  "#{window_width}\t#{window_height}\t#{window_layout}\t" +
  "#{window_flags}\t#{?window_active,1,0}";

/**
 * Format string for `list-panes` during bootstrap.
 */
export const BOOTSTRAP_PANES_FORMAT =
  "#{pane_id}\t#{window_id}\t#{session_id}\t#{pane_index}\t" +
  "#{pane_width}\t#{pane_height}\t#{pane_top}\t#{pane_left}\t" +
  "#{?pane_active,1,0}\t#{pane_pid}\t#{pane_current_command}\t" +
  "#{?pane_dead,1,0}\t#{pane_dead_status}\t#{@tmuxcc_label}\t" +
  // tc-i9aq.1 (cold-start.md §4.A): durable per-pane policy/intent.
  //   [14] @tmuxcc-bound  — "1" if the pane carries binding intent, else empty.
  //   [15] @tmuxcc-detach — RESOLVED close policy ("detach"|"kill"); empty =
  //                         inherit. `#{@}` format walks pane→window→session,
  //                         so this is the effective first-wins cascade value.
  //   [16] @tmuxcc-icon   — durable icon policy string, else empty.
  // Unset → empty string (no error; verified tmux 3.4, cold-start.md §9.3).
  "#{@tmuxcc-bound}\t#{@tmuxcc-detach}\t#{@tmuxcc-icon}";

// ---------------------------------------------------------------------------
// Bootstrap command set
// ---------------------------------------------------------------------------

/**
 * How the requery engine scopes its `list-windows` / `list-panes` cycle to a
 * single session.
 *
 *   - `{ kind: "id", sessionId }` — target by the IMMUTABLE tmux session id
 *     (`$N`). This is the steady-state target: it survives a `rename-session`
 *     (the id never changes), so the requery keeps observing the right session
 *     after a rename and can emit the `session.renamed` delta (tc-0v59).
 *   - `{ kind: "name", sessionName }` — target by the (mutable) session name
 *     (`=<name>`). Used ONLY for the very first cold cycle, before any reply
 *     has revealed the immutable id. The name is correct at bootstrap; the
 *     engine captures the id from the first successful reply and switches to
 *     id-targeting forever after.
 *   - `undefined` — no scope: fall back to `-a` (all sessions), the legacy
 *     behaviour for bootstrap shapes that know neither the id nor the name.
 */
export type SessionTarget =
  | { readonly kind: "id"; readonly sessionId: number }
  | { readonly kind: "name"; readonly sessionName: string };

/**
 * Return the two tmux commands the requery engine issues on every cycle.
 *
 * When `target` is provided the commands are scoped to that one session
 * (avoiding cross-session contamination in multi-session environments). The
 * `"id"` form targets by the immutable session id `$N` (rename-safe); the
 * `"name"` form targets by `=<name>` (used only before the id is known).
 * When `target` is absent, falls back to `-a` (all sessions).
 *
 * Returns: `[listWindowsCommand, listPanesCommand]`
 */
export function bootstrapCommands(target?: SessionTarget): [string, string] {
  if (target !== undefined && target.kind === "id") {
    // Steady-state: scope by the IMMUTABLE session id ($N). listWindows emits
    // `-t $<id>`; listPanes emits the session-scoped `-s -t $<id>` form. This
    // survives a rename-session (tc-0v59) because the id never changes.
    const winCmd = listWindows(BOOTSTRAP_WINDOWS_FORMAT, target.sessionId);
    const paneCmd = listPanes({
      sessionId: target.sessionId,
      format: BOOTSTRAP_PANES_FORMAT,
    });
    return [winCmd, paneCmd];
  }
  if (target !== undefined && target.kind === "name" && target.sessionName.length > 0) {
    // Cold-bootstrap only: scope by the mutable session name (tc-tfv.3: avoid
    // cross-session pane/focus contamination when multiple sessions share a
    // tmux server). Used until the first reply reveals the immutable id.
    const nameTarget = `=${target.sessionName}`;
    const winCmd = listWindows(BOOTSTRAP_WINDOWS_FORMAT) + ` -t ${nameTarget}`;
    // list-panes -s scopes to all panes in the session; -t targets the session.
    const paneCmd = listPanes(undefined, BOOTSTRAP_PANES_FORMAT) + ` -s -t ${nameTarget}`;
    return [winCmd, paneCmd];
  }
  // Fallback: all sessions (legacy behaviour).
  const winCmd = listWindows(BOOTSTRAP_WINDOWS_FORMAT) + " -a";
  const paneCmd = listPanes(undefined, BOOTSTRAP_PANES_FORMAT) + " -a";
  return [winCmd, paneCmd];
}

// ---------------------------------------------------------------------------
// Id minting (SAME CONVENTION used elsewhere — keep aligned)
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
 * Parsed record from one line of a `list-windows` reply.
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
 * Parsed record from one line of a `list-panes` reply.
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
  /** True when `pane_dead=1` (remain-on-exit corpse). Defaults false on legacy
   *  replies that don't carry the field. */
  readonly dead: boolean;
  /** Exit status from `pane_dead_status` when dead and known, else undefined. */
  readonly exitCode: number | undefined;
  /**
   * Durable, driver-owned pane name from the `@tmuxcc_label` pane user-option
   * (tc-1a8z), or undefined when the option is unset/empty.  Re-read on every
   * requery so the durable name survives a driver restart.
   */
  readonly label: string | undefined;
  /**
   * Durable binding intent from the `@tmuxcc-bound` pane user-option
   * (tc-i9aq.1, cold-start.md §4.A).  True when the option is `1`; false when
   * unset/empty.  Re-read on every requery so binding intent survives a VS
   * Code restart for free.
   */
  readonly bound: boolean;
  /**
   * RESOLVED detach-on-close policy from the `@tmuxcc-detach` user-option
   * (tc-i9aq.1, cold-start.md §4.A), read via a `#{@tmuxcc-detach}` format that
   * walks pane→window→session, so this is the effective first-wins cascade
   * value.  `"detach"` or `"kill"` when set at any scope; undefined when unset
   * at every scope (the extension applies its default).
   */
  readonly detach: "detach" | "kill" | undefined;
  /**
   * Durable icon policy from the `@tmuxcc-icon` pane user-option (tc-i9aq.1,
   * cold-start.md §4.A), or undefined when unset/empty.
   */
  readonly icon: string | undefined;
}

/**
 * Parse the body of a `list-windows` command reply.
 *
 * Each non-empty line is one window, tab-separated in BOOTSTRAP_WINDOWS_FORMAT
 * order. Lines with wrong field count are silently skipped (defensive).
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
 * Parse the body of a `list-panes` command reply.
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

    // Dead-pane fields (tc-4bv2 / tc-295a.10). Read defensively: legacy replies
    // (or tmux builds that drop the trailing empty field) may have fewer parts.
    // pane_dead is at index 11; pane_dead_status at index 12. A dead pane's
    // status may be an empty string (tmux reports no code), which yields an
    // undefined exitCode while dead stays true.
    const dead = (parts[11] ?? "").trim() === "1";
    let exitCode: number | undefined;
    if (dead) {
      const statusStr = (parts[12] ?? "").trim();
      if (statusStr !== "") {
        const parsed = parseInt(statusStr, 10);
        if (!isNaN(parsed)) exitCode = parsed;
      }
    }

    // Durable pane name (tc-1a8z): the `@tmuxcc_label` user-option at field
    // [13]. Read defensively — legacy replies (or panes that never had the
    // option set) carry an empty string here, which maps to "no durable name"
    // (undefined). We trim to drop the trailing line whitespace but otherwise
    // preserve the value the user set.
    const labelRaw = (parts[13] ?? "").trim();
    const label = labelRaw === "" ? undefined : labelRaw;

    // Durable per-pane policy/intent (tc-i9aq.1, cold-start.md §4.A). Read
    // defensively — legacy replies (or unset options) carry empty strings.
    //   [14] @tmuxcc-bound  → binding intent ("1" = bound).
    //   [15] @tmuxcc-detach → RESOLVED close policy (format walk gives the
    //                         pane→window→session first-wins value).
    //   [16] @tmuxcc-icon   → durable icon policy.
    const bound = (parts[14] ?? "").trim() === "1";
    const detachRaw = (parts[15] ?? "").trim();
    const detach: "detach" | "kill" | undefined =
      detachRaw === "detach" || detachRaw === "kill" ? detachRaw : undefined;
    const iconRaw = (parts[16] ?? "").trim();
    const icon = iconRaw === "" ? undefined : iconRaw;

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
      dead,
      exitCode,
      label,
      bound,
      detach,
      icon,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

/**
 * Build a fresh `SessionModel` from parsed windows + panes rows.
 *
 * The requery engine calls this on every cycle: the model is the diff
 * baseline that `diffModel(prev, next)` turns into wire deltas.
 *
 * @param windowRows - Output of `parseWindowsReply`.
 * @param paneRows   - Output of `parsePanesReply`.
 */
export function buildInitialModel(
  windowRows: WindowsReplyRow[],
  paneRows: PanesReplyRow[],
): SessionModel {
  let model = emptyModel();

  // ---- Step 1: collect sessions ----------------------------------------
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

    let layout: import("../wire/layout.js").WindowLayout | null = null;
    try {
      const parsed = parseLayout(row.layoutString);
      layout = parsedLayoutToWindowLayout(parsed, mintPaneId);
    } catch {
      // Malformed or unrecognized layout string — leave null.
    }

    const winPanes = panesByWindow.get(row.tmuxWindowId) ?? [];
    const activePaneRow = winPanes.find((p) => p.active);
    const activePaneId = activePaneRow !== undefined ? mintPaneId(activePaneRow.tmuxPaneId) : null;

    const win: Window = {
      windowId: wid,
      sessionId: sid,
      name: row.windowName,
      paneIds: [], // filled in step 4
      activePaneId,
      layout,
      synchronizePanes: false, // optimistic-update path patches this; first sync-watch tick overrides
      monitorActivity: true,
      monitorSilence: 0,
    };

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

    if (!model.windows.has(wid)) continue;
    if (model.panes.has(pid)) continue;

    const p: Pane = {
      paneId: pid,
      windowId: wid,
      sessionId: sid,
      cols: row.width,
      rows: row.height,
      mode: "normal",
      // Dead-pane state from the requery (tc-4bv2 / tc-295a.10 shared shape).
      dead: row.dead,
      exitCode: row.exitCode,
      // Durable pane name from the @tmuxcc_label user-option (tc-1a8z).
      // Re-read on every requery → survives a driver restart for free.
      label: row.label,
      // Durable binding-intent / close-policy / icon-policy from the
      // @tmuxcc-* user-options (tc-i9aq.1, cold-start.md §4.A). Re-read on
      // every requery → survive a VS Code restart, vanish with the pane.
      bound: row.bound,
      detach: row.detach,
      icon: row.icon,
      // scrollbackHandle and paneTitle are absent (optional) — tc-fx2 and
      // tc-2mn8 populate them respectively via updatePane after creation.
    };
    model = addPane(model, p);
  }

  // ---- Step 5: compute global focus triple -----------------------------
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
    break;
  }
  if (!focusSet) {
    model = setFocus(model, { paneId: null, windowId: null, sessionId: null });
  }

  return model;
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
