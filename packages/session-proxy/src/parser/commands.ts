/**
 * Outbound tmux command serializer (tc-zb6).
 *
 * Pure functions that produce tmux command strings — one command per line —
 * suitable for writing verbatim to a tmux -CC control-mode stdin.  No I/O
 * here; callers write the returned strings.
 *
 * When the session-proxy sends one of these commands tmux responds with a
 * %begin … %end block (or %error).  The correlator (tc-82a) matches those
 * blocks to the original requests; this module is decoupled from that
 * correlation — each function returns a single complete command line.
 *
 * # Argument quoting
 *
 * tmux command-line parsing follows POSIX shell quoting rules as implemented
 * in cmd-parse.y.  The safe rule applied here: wrap any argument whose value
 * contains a space, a single-quote, a double-quote, or any shell metacharacter
 * in single quotes and escape embedded single-quotes by ending the quote,
 * emitting a backslash-single-quote, then restarting the quote.
 *
 * Pane targets of the form `%<N>` (numeric only, produced by tmux) never
 * require quoting.  Window names and format strings may contain spaces so they
 * are always quoted.
 *
 * # Version notes
 *
 * - send-keys -H: available since tmux 3.0a.  Each space-separated argument
 *   is injected as ONE literal byte, bypassing tmux's key-name dispatch and
 *   modifyOtherKeys rewriting.  This is the only lossless path for arbitrary
 *   bytes (including NUL, 0xFF, C0 controls).
 *
 * - refresh-client -C: accepts both `WxH` and `W,H` (tmux parses both;
 *   the usage string in cmd-refresh-client.c documents `XxY` as the canonical
 *   form).  We emit `WxH`.  Since tmux 3.4 the window-specific form
 *   `@<window>:<W>x<H>` is also accepted (refreshClientWindowSize below).
 *
 * - refresh-client -A: the argument is `%<paneId>:<state>` where state is
 *   one of `on`, `off`, `continue`, `pause` (from cmd-refresh-client.c
 *   cmd_refresh_client_update_offset).
 *
 * - split-window: `-h` creates a horizontal split (left/right panes, the new
 *   pane appears to the right); `-v` creates a vertical split (top/bottom,
 *   new pane appears below).  This matches tmux's own usage string.
 *
 * - effect-id printing (tc-ozk.1): the pane/window-CREATING verbs accept a
 *   `-P -F '#{pane_id} #{window_id}'` pair.  `-P` tells tmux to PRINT
 *   information about the created entity into the command-reply block (the
 *   `%begin … %end` body), and `-F` selects exactly which fields.  Available on
 *   split-window, new-window and break-pane since tmux 1.8/2.4 respectively —
 *   well within the supported floor.  The session-proxy parses the printed line
 *   with `parseEffectIds` to recover the created ids and returns them in the
 *   VerbResult, replacing the old fire-and-observe correlation.
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Single-quote an argument for tmux's command parser.
 *
 * If the argument contains no characters that need quoting (spaces, quotes,
 * shell metacharacters, or is empty) it is returned unchanged.  Otherwise it
 * is wrapped in single quotes with any embedded single-quotes escaped via
 * the `'\''` idiom.
 */
function quoteArg(arg: string): string {
  // No quoting needed for simple tokens: word chars, colons, %, @, #, {, }, ., -, =, *, /
  if (/^[A-Za-z0-9%@#{}.:_\-=*,/]+$/.test(arg)) {
    return arg;
  }
  // Single-quote the whole value; escape embedded single quotes.
  const escaped = arg.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

// ---------------------------------------------------------------------------
// Effect-id printing (tc-ozk.1)
//
// The pane/window-creating verbs (split-window, new-window, break-pane) can be
// told to PRINT the created entity's ids into their command-reply block via
// `-P -F <format>`.  We use a single canonical format — tmux pane id first,
// then window id — and parse it back with `parseEffectIds`.  This is what lets
// the daemon RETURN the created ids in the VerbResult instead of inferring them
// from a later %window-add / %layout-change notification.
// ---------------------------------------------------------------------------

/**
 * Canonical `-F` format for the created-entity ids of a creating verb.
 *
 * Emits `<pane_id> <window_id>` — e.g. `%5 @2` — into the command-reply body.
 * Both are always present for split-window / new-window / break-pane (each
 * yields exactly one new pane that lives in exactly one window).
 *
 * Space-separated (not tab): tmux's `#{pane_id}` / `#{window_id}` never contain
 * spaces (`%<n>` / `@<n>`), so a single space is an unambiguous separator and
 * keeps the parser trivial.
 */
export const EFFECT_IDS_FORMAT = "#{pane_id} #{window_id}";

/**
 * The created-entity ids recovered from a `-P -F EFFECT_IDS_FORMAT` reply body.
 *
 * Both are tmux-internal numeric ids (the N in `%N` / `@N`) — NOT the wire
 * `p<N>` / `w<N>` form.  Callers mint the wire ids from these.
 */
export interface EffectIds {
  /** Numeric tmux pane id (the N in `%N`) of the newly-created pane. */
  readonly paneNum: number;
  /** Numeric tmux window id (the N in `@N`) the new pane lives in. */
  readonly windowNum: number;
}

/**
 * Parse a `-P -F EFFECT_IDS_FORMAT` reply body into its numeric tmux ids.
 *
 * Accepts the raw reply body (e.g. `"%5 @2"`, possibly with surrounding
 * whitespace or a trailing newline).  Returns `null` when the body does not
 * match the expected `%<n> @<n>` shape — callers MUST treat null as a loud
 * failure (the verb said it succeeded but we could not recover its effect),
 * not as "no ids".
 *
 * Robust to extra body lines (takes the first non-empty line) because some
 * tmux builds prepend an empty line before the `-P` output.
 */
export function parseEffectIds(body: string): EffectIds | null {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const m = /^%(\d+)\s+@(\d+)$/.exec(line);
    if (m === null) return null;
    return { paneNum: parseInt(m[1]!, 10), windowNum: parseInt(m[2]!, 10) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// send-keys -H
// ---------------------------------------------------------------------------

/**
 * Serialize arbitrary bytes for a pane using `send-keys -H`.
 *
 * `send-keys -H` treats each space-separated argument as a single literal
 * byte value (one argument = one byte injected into the pane's input).  This
 * bypasses tmux's key-name dispatch and modifyOtherKeys rewriting, making it
 * the only lossless path for arbitrary byte sequences including NUL (0x00),
 * 0xFF, and ASCII C0 control characters.
 *
 * Each byte is encoded as a two-digit lowercase hex string (e.g. `0a`, `ff`).
 * This matches tmux's strtol(s, &endptr, 16) parser (cmd-send-keys.c
 * cmd_send_keys_inject_string) which accepts plain hex without a `0x` prefix,
 * and the iTerm2 reference implementation (numbersAsLiteralByteHexArguments
 * in TmuxGateway.m: `%02x` format, space-separated).
 *
 * Available since tmux 3.0a.
 *
 * @param paneId  Numeric pane ID (the N in `%N`).
 * @param bytes   Arbitrary byte sequence to inject.
 * @returns       Complete command line, e.g.
 *                `send-keys -H -t %3 68 65 6c 6c 6f`
 */
export function sendKeysHex(paneId: number, bytes: Uint8Array): string {
  if (bytes.length === 0) {
    // An empty send-keys -H is a no-op but still valid syntax; emit without
    // trailing space.
    return `send-keys -H -t %${paneId}`;
  }
  const hexTokens = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `send-keys -H -t %${paneId} ${hexTokens.join(" ")}`;
}

// ---------------------------------------------------------------------------
// refresh-client
// ---------------------------------------------------------------------------

/**
 * Set the control-mode client's terminal size.
 *
 * Emits `refresh-client -C <cols>x<rows>`.  tmux accepts both `WxH` and
 * `W,H`; we use `WxH` which matches the documented usage in
 * cmd-refresh-client.c (`[-C XxY]`).
 *
 * @param cols  Terminal width in columns.
 * @param rows  Terminal height in rows.
 * @returns     e.g. `refresh-client -C 220x50`
 */
export function refreshClientSize(cols: number, rows: number): string {
  return `refresh-client -C ${cols}x${rows}`;
}

/**
 * Set the control-mode client's size for a specific window (tmux >= 3.4).
 *
 * Emits `refresh-client -C @<windowId>:<cols>x<rows>`.  Useful when the
 * session-proxy manages multiple windows at different sizes (e.g. iTerm2 per-tab
 * sizing).
 *
 * @param windowId  Numeric window ID (the N in `@N`).
 * @param cols      Width in columns.
 * @param rows      Height in rows.
 * @returns         e.g. `refresh-client -C @2:220x50`
 */
export function refreshClientWindowSize(
  windowId: number,
  cols: number,
  rows: number,
): string {
  return `refresh-client -C @${windowId}:${cols}x${rows}`;
}

/** Flow-control state for a pane, paired with %pause / %continue notifications. */
export type PaneFlowState = "on" | "off" | "pause" | "continue";

/**
 * Adjust per-pane flow control.
 *
 * Emits `refresh-client -A '%<paneId>:<state>'`.
 *
 * States (from cmd-refresh-client.c cmd_refresh_client_update_offset):
 *   - `on`       — allow output from this pane (resume if paused)
 *   - `off`      — disable output from this pane
 *   - `pause`    — pause output (pairs with `%pause` notification)
 *   - `continue` — resume after pause (pairs with `%continue` notification)
 *
 * The argument is always single-quoted because it contains a `%` and a `:`.
 * iTerm2 reference: `refresh-client -A '%<pane>:<state>'` (TmuxController.m).
 *
 * @param paneId  Numeric pane ID.
 * @param state   Desired flow state.
 * @returns       e.g. `refresh-client -A '%5:pause'`
 */
export function refreshClientFlow(
  paneId: number,
  state: PaneFlowState,
): string {
  return `refresh-client -A '%${paneId}:${state}'`;
}

// ---------------------------------------------------------------------------
// list-windows
// ---------------------------------------------------------------------------

/**
 * Default format string for list-windows.
 *
 * Tab-separated fields that capture the data the session-proxy needs for window
 * state tracking.  Modeled on iTerm2's listWindowsDetailedFormat
 * (TmuxController.m): session_name, window_id, window_name, dimensions,
 * layout, flags, active flag, visible layout.
 */
export const LIST_WINDOWS_DEFAULT_FORMAT =
  "#{session_name}\t#{window_id}\t#{window_name}\t#{window_width}\t#{window_height}\t#{window_layout}\t#{window_flags}\t#{?window_active,1,0}\t#{window_visible_layout}";

/**
 * Serialize a `list-windows` command.
 *
 * Emits `list-windows -F '<format>'` for the current session, or with a
 * target session (`-t '$<sessionId>'`) when provided.
 *
 * The format string is single-quoted so spaces and `#` characters inside it
 * are safe.  The response is one line per window, each field separated by
 * the delimiter embedded in the format string (tab by default).
 *
 * @param format     Format string (default: LIST_WINDOWS_DEFAULT_FORMAT).
 * @param sessionId  Optional numeric session ID (the N in `$N`).
 * @returns          e.g. `list-windows -F '<format>'`
 */
export function listWindows(format?: string, sessionId?: number): string {
  const fmt = quoteArg(format ?? LIST_WINDOWS_DEFAULT_FORMAT);
  const target = sessionId !== undefined ? ` -t $${sessionId}` : "";
  return `list-windows -F ${fmt}${target}`;
}

// ---------------------------------------------------------------------------
// list-panes
// ---------------------------------------------------------------------------

/**
 * Default format string for list-panes.
 *
 * Tab-separated fields capturing pane identity and geometry.
 */
export const LIST_PANES_DEFAULT_FORMAT =
  "#{pane_id}\t#{window_id}\t#{pane_index}\t#{pane_width}\t#{pane_height}\t#{pane_top}\t#{pane_left}\t#{?pane_active,1,0}\t#{pane_pid}\t#{pane_current_command}";

/** Options for the session-scoped form of {@link listPanes}. */
export interface ListPanesSessionOptions {
  /**
   * Numeric session ID (the N in `$N`).  Emits the session-scoped form
   * `list-panes -s -t $<id> -F '<format>'`, which lists every pane in the
   * session across all its windows.  Targeting by the IMMUTABLE session id
   * (rather than a mutable session name) keeps the requery engine pointed at
   * the right session across a `rename-session` (tc-0v59).
   */
  readonly sessionId: number;
  /** Format string (default: LIST_PANES_DEFAULT_FORMAT). */
  readonly format?: string;
}

/**
 * Serialize a `list-panes` command.
 *
 * Emits `list-panes -F '<format>'`.  When `target` is provided it is passed
 * as `-t <target>` (e.g. `%5` for a pane, `@2` for a window).
 *
 * Pass a {@link ListPanesSessionOptions} object instead of a string target to
 * get the session-scoped form `list-panes -s -t $<id> -F '<format>'` — every
 * pane in the session, addressed by its immutable session id.
 *
 * @param target  Optional target: a window/pane id string (e.g. `@2`), or a
 *                {@link ListPanesSessionOptions} for the session-scoped form.
 * @param format  Format string (default: LIST_PANES_DEFAULT_FORMAT).  Ignored
 *                when `target` is a {@link ListPanesSessionOptions} (use its
 *                `format` field instead).
 * @returns       e.g. `list-panes -t @2 -F '<format>'`
 *                or   `list-panes -s -t $0 -F '<format>'`
 */
export function listPanes(
  target?: string | ListPanesSessionOptions,
  format?: string,
): string {
  if (typeof target === "object") {
    const fmt = quoteArg(target.format ?? LIST_PANES_DEFAULT_FORMAT);
    return `list-panes -s -t $${target.sessionId} -F ${fmt}`;
  }
  const fmt = quoteArg(format ?? LIST_PANES_DEFAULT_FORMAT);
  const t = target !== undefined ? ` -t ${target}` : "";
  return `list-panes${t} -F ${fmt}`;
}

// ---------------------------------------------------------------------------
// capture-pane
// ---------------------------------------------------------------------------

/** Options for capturePane. */
export interface CapturePaneOptions {
  /**
   * Include terminal escape sequences in the output (`-e` flag).
   * Default: false.
   */
  escapes?: boolean;
  /**
   * First line to capture (inclusive, may be negative for scrollback).
   * Passed as `-S <startLine>`.  Omitted when undefined.
   *
   * Use the literal string `"-"` for tmux's "start of the retained history"
   * sentinel (the canonical "give me everything I've kept" knob; capped by
   * the pane's `history-limit`).  Numeric values are emitted verbatim.
   */
  startLine?: number | "-";
  /**
   * Last line to capture (inclusive).
   * Passed as `-E <endLine>`.  Omitted when undefined.
   *
   * Use the literal string `"-"` for tmux's "end of the visible region"
   * sentinel (the bottom of the current viewport, i.e. the live cursor row).
   * Numeric values are emitted verbatim.
   */
  endLine?: number | "-";
}

/**
 * Serialize a `capture-pane` command.
 *
 * Common form: `capture-pane -t %<pane> -p` (print to stdout / response
 * block).  Add `-e` for escape sequences, `-S` / `-E` for line ranges.
 *
 * Flags confirmed in cmd-capture-pane.c: `-p` (print), `-e` (escape
 * sequences), `-S <start-line>`, `-E <end-line>`, `-t <target-pane>`.
 *
 * For full-history rehydration (tc-5quo) the canonical form is
 * `capture-pane -t %N -p -e -S - -E -`.
 *
 * @param paneId  Numeric pane ID.
 * @param opts    Optional capture options.
 * @returns       e.g. `capture-pane -t %3 -p -e -S -100`
 */
export function capturePane(paneId: number, opts?: CapturePaneOptions): string {
  const parts: string[] = [`capture-pane -t %${paneId} -p`];
  if (opts?.escapes) {
    parts.push("-e");
  }
  if (opts?.startLine !== undefined) {
    parts.push(`-S ${opts.startLine}`);
  }
  if (opts?.endLine !== undefined) {
    parts.push(`-E ${opts.endLine}`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// new-window
// ---------------------------------------------------------------------------

/** Options for newWindow. */
export interface NewWindowOptions {
  /**
   * Window name (`-n <name>`).  Quoted when it contains spaces or special
   * characters.
   */
  name?: string;
  /**
   * Shell command to run in the new window.  Passed as a trailing argument.
   * Quoted when it contains spaces.
   */
  shellCommand?: string;
  /**
   * Starting directory (`-c <dir>`).
   */
  startDirectory?: string;
  /**
   * Print the created pane/window ids into the command-reply body via
   * `-P -F EFFECT_IDS_FORMAT` (tc-ozk.1).  When true the caller can recover the
   * created ids with `parseEffectIds(result.body)` instead of correlating a
   * later notification.  Default: false (preserves the legacy fire-and-observe
   * call sites that don't need the ids).
   */
  printIds?: boolean;
}

/**
 * Serialize a `new-window` command.
 *
 * Flags used: `-n <name>` for window name, `-c <dir>` for start directory,
 * `-P -F EFFECT_IDS_FORMAT` to print the created ids (tc-ozk.1).
 * Trailing unquoted arguments are treated as a shell command by tmux.
 *
 * @param opts  Optional window creation options.
 * @returns     e.g. `new-window -n 'my window'`
 *              or   `new-window -P -F '#{pane_id} #{window_id}'`
 */
export function newWindow(opts?: NewWindowOptions): string {
  const parts: string[] = ["new-window"];
  if (opts?.printIds === true) {
    parts.push(`-P -F ${quoteArg(EFFECT_IDS_FORMAT)}`);
  }
  if (opts?.name !== undefined) {
    parts.push(`-n ${quoteArg(opts.name)}`);
  }
  if (opts?.startDirectory !== undefined) {
    parts.push(`-c ${quoteArg(opts.startDirectory)}`);
  }
  if (opts?.shellCommand !== undefined) {
    parts.push(quoteArg(opts.shellCommand));
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// set-option
// ---------------------------------------------------------------------------

/**
 * Scope for `set-option` / `set-window-option` commands.
 *
 *   "session" — `-s` flag (session-level option)
 *   "window"  — `-w` flag (window-level option)
 *   "global"  — combined with scope via `-g` flag (sets the global default)
 */
export type SetOptionScope = "session" | "window" | "session-global" | "window-global";

/**
 * Serialize a `set-option` command.
 *
 * Scope mapping:
 *   "session"        → `set-option`         (current session)
 *   "window"         → `set-option -w`      (current window)
 *   "session-global" → `set-option -g`      (global session default)
 *   "window-global"  → `set-option -wg`     (global window default)
 *
 * The option name and value are quoted when they contain special characters.
 *
 * Used by the pipeline to issue `set-option -wg monitor-activity on` after
 * bootstrap (tc-95lue: activity indicators §3.4).
 *
 * @param scope   Scope of the option (see `SetOptionScope`).
 * @param option  Option name (e.g. `monitor-activity`, `@tmuxcc`).
 * @param value   Option value (e.g. `on`, `1`).
 * @returns       e.g. `set-option -wg monitor-activity on`
 */
export function setOption(
  scope: SetOptionScope,
  option: string,
  value: string,
): string {
  let flags: string;
  switch (scope) {
    case "session":
      flags = "";
      break;
    case "window":
      flags = " -w";
      break;
    case "session-global":
      flags = " -g";
      break;
    case "window-global":
      flags = " -wg";
      break;
  }
  return `set-option${flags} ${quoteArg(option)} ${quoteArg(value)}`;
}

/**
 * Serialize a `set-option -wt @<windowId>` command targeting a specific window.
 *
 * Emits `set-option -wt @<windowId> <option> <value>`.
 *
 * Used for window-scoped options that must target a specific window rather
 * than the current window. Primary consumer: `synchronize-panes` (tc-7xv.12).
 *
 * @param windowId  Numeric window ID (the N in `@N`).
 * @param option    Window option name (e.g. `synchronize-panes`).
 * @param value     Option value (e.g. `on`, `off`).
 * @returns         e.g. `set-option -wt @3 synchronize-panes on`
 */
export function setOptionForWindow(
  windowId: number,
  option: string,
  value: string,
): string {
  return `set-option -wt @${windowId} ${quoteArg(option)} ${quoteArg(value)}`;
}

/**
 * Serialize a `show-options -wvt @<windowId> <option>` command.
 *
 * Emits `show-options -wvt @<windowId> <option>`.
 *
 * The `-v` flag (value-only) makes the response body contain just the option
 * value with no name prefix, which is easier to parse.  The `-w` flag selects
 * window options.
 *
 * Used by the synchronize-panes observable (tc-7xv.12) to read the current
 * value for a specific window after a hook fires.
 *
 * @param windowId  Numeric window ID (the N in `@N`).
 * @param option    Window option name (e.g. `synchronize-panes`).
 * @returns         e.g. `show-options -wvt @3 synchronize-panes`
 */
export function showOptionsForWindow(windowId: number, option: string): string {
  return `show-options -wvt @${windowId} ${quoteArg(option)}`;
}

// ---------------------------------------------------------------------------
// split-window
// ---------------------------------------------------------------------------

/** Split orientation: horizontal = left/right panes; vertical = top/bottom. */
export type SplitOrientation = "horizontal" | "vertical";

/** Options for splitWindow. */
export interface SplitWindowOptions {
  /**
   * Shell command to run in the new pane.  Passed as a trailing argument.
   */
  shellCommand?: string;
  /**
   * Starting directory for the new pane (`-c <dir>`).
   */
  startDirectory?: string;
  /**
   * Size of the new pane as a percentage of the parent (`-p <percent>`).
   */
  percent?: number;
  /**
   * Print the created pane/window ids into the command-reply body via
   * `-P -F EFFECT_IDS_FORMAT` (tc-ozk.1).  See NewWindowOptions.printIds.
   */
  printIds?: boolean;
}

/**
 * Serialize a `split-window` command.
 *
 * `-h` creates a horizontal split — the existing pane stays on the left and
 * the new pane appears on the right (left/right layout).
 * `-v` creates a vertical split — the existing pane stays on top and the new
 * pane appears below (top/bottom layout).
 *
 * This matches the tmux cmd-split-window.c usage string:
 *   `[-bdefhIklPvZ] ... [-t target-pane]`
 *
 * @param paneId       Numeric ID of the pane to split, or `undefined` to
 *                     split the current pane (tmux's implicit target —
 *                     used by tc-cr4dz when the new window's first pane ID
 *                     is not yet known).
 * @param orientation  `"horizontal"` → `-h` (left/right);
 *                     `"vertical"`   → `-v` (top/bottom).
 * @param opts         Optional split options.
 * @returns            e.g. `split-window -h -t %3`
 *                     or   `split-window -v -t %3 -p 30`
 *                     or   `split-window -h` (paneId undefined)
 */
export function splitWindow(
  paneId: number | undefined,
  orientation: SplitOrientation,
  opts?: SplitWindowOptions,
): string {
  const flag = orientation === "horizontal" ? "-h" : "-v";
  const head = paneId !== undefined ? `split-window ${flag} -t %${paneId}` : `split-window ${flag}`;
  const parts: string[] = [head];
  if (opts?.printIds === true) {
    parts.push(`-P -F ${quoteArg(EFFECT_IDS_FORMAT)}`);
  }
  if (opts?.percent !== undefined) {
    parts.push(`-p ${opts.percent}`);
  }
  if (opts?.startDirectory !== undefined) {
    parts.push(`-c ${quoteArg(opts.startDirectory)}`);
  }
  if (opts?.shellCommand !== undefined) {
    parts.push(quoteArg(opts.shellCommand));
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// break-pane
// ---------------------------------------------------------------------------

/** Options for breakPane. */
export interface BreakPaneOptions {
  /**
   * Print the created window/pane ids into the command-reply body via
   * `-P -F EFFECT_IDS_FORMAT` (tc-ozk.1).  See NewWindowOptions.printIds.
   */
  printIds?: boolean;
}

/**
 * Serialize a `break-pane` command.
 *
 * Emits `break-pane -d -t %<paneId>`.  The `-d` flag keeps the new window in
 * the background so a host tab strip doesn't jump focus.  With `printIds` the
 * created pane/window ids are printed into the reply body (`-P -F`), which is
 * how the daemon returns them in the VerbResult (tc-ozk.1).
 *
 * Note on field ordering: tmux's `#{pane_id}` for a broken-out pane is the
 * SAME pane id that previously lived in the source window (break-pane moves the
 * pane, it does not create a new pane); `#{window_id}` is the NEW window the
 * pane now lives in.  So for break-pane the returned `newWindowId` is the
 * structurally-new entity and `newPaneId` is the (re-homed) existing pane.
 *
 * @param paneId  Numeric pane id (the N in `%N`) to break out.
 * @param opts    Optional break options.
 * @returns       e.g. `break-pane -d -t %3`
 *                or   `break-pane -d -P -F '#{pane_id} #{window_id}' -t %3`
 */
export function breakPane(paneId: number, opts?: BreakPaneOptions): string {
  const parts: string[] = ["break-pane -d"];
  if (opts?.printIds === true) {
    parts.push(`-P -F ${quoteArg(EFFECT_IDS_FORMAT)}`);
  }
  parts.push(`-t %${paneId}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// resize-window / resize-pane / window-size manual — managed-window sizing
//
// tc-zna.3: the VS Code factory is authoritative for the geometry of "managed"
// windows (the panes form a 1-D split strip mirrored 1:1 onto VS Code tabs).
// The managed-window resize transaction is a batch of three command families:
//
//   1. `set-window-option -t @<wid> window-size manual`
//      Switches the window out of "follow the smallest client" sizing into
//      client-authoritative mode.  tmux's default `window-size` is `latest`
//      (or `largest` historically); under those modes any control-mode client
//      with smaller dimensions will clamp the window down.  `manual` lets
//      `resize-window` actually stick.  Idempotent — safe to send every time.
//
//   2. `resize-window -t @<wid> -x <cols> -y <rows>`
//      Sets the window's overall dimensions to the strip total (sum of pane
//      dims on the shared axis, plus N-1 separators).
//
//   3. `resize-pane -t %<paneId> -x <cols> -y <rows>` (per pane)
//      Pins each pane's dimensions exactly.  Without this tmux distributes
//      the new window dims proportionally — close enough most of the time,
//      but the VS Code sash positions are pixel-exact and we want pane dims
//      to match the VS Code group split precisely.
//
// Available since tmux 3.0 (window-size option, resize-window -x/-y);
// resize-pane -x/-y available since tmux 2.1.  All within the bead's
// supported-tmux floor.
// ---------------------------------------------------------------------------

/**
 * Serialize `set-window-option -t @<windowId> window-size manual`.
 *
 * Switches the window's sizing policy to manual (VS-Code-authoritative),
 * which is the prerequisite for `resize-window -x -y` to actually stick under
 * tmux's default `window-size latest` policy.
 *
 * Idempotent: setting `window-size manual` on a manual window is a no-op.
 */
export function setWindowSizeManual(windowId: number): string {
  return `set-window-option -t @${windowId} window-size manual`;
}

/**
 * Serialize `set-window-option -u -t @<windowId> window-size`.
 *
 * Resets the window's sizing policy to the global default (typically `latest`
 * or `largest`), releasing VS-Code-managed `manual` sizing so the surviving
 * pane resumes tracking its tmux client's dimensions normally.
 *
 * Called after a managed strip tears down to a single pane (tc-pizl.9).
 * Idempotent: unsetting an already-defaulted option is a no-op.
 */
export function setWindowSizeDefault(windowId: number): string {
  return `set-window-option -u -t @${windowId} window-size`;
}

/**
 * Serialize `resize-window -t @<windowId> -x <cols> -y <rows>`.
 *
 * Sets the window's overall dimensions.  Pairs with `setWindowSizeManual`
 * (which must be applied at least once so tmux honors the explicit size).
 */
export function resizeWindow(
  windowId: number,
  cols: number,
  rows: number,
): string {
  return `resize-window -t @${windowId} -x ${cols} -y ${rows}`;
}

/**
 * Serialize `resize-pane -t %<paneId> -x <cols> -y <rows>`.
 *
 * Pins one pane's dimensions exactly.  Used inside the managed-window
 * transaction after `resizeWindow` to make tmux's per-pane geometry match
 * the VS Code group split precisely (rather than tmux's default proportional
 * distribution).
 */
export function resizePane(
  paneId: number,
  cols: number,
  rows: number,
): string {
  return `resize-pane -t %${paneId} -x ${cols} -y ${rows}`;
}

// ---------------------------------------------------------------------------
// refresh-client -B (subscription)
// ---------------------------------------------------------------------------

/**
 * Register a tmux control-mode subscription that polls a format string for
 * each window every ~1 second and delivers `%subscription-changed` only when
 * the value changes.
 *
 * Emits: `refresh-client -B 'name:@*:format'`
 *
 * The `@*` scope means one notification per window. tmux fires the check on a
 * 1-second internal timer (control.c control_check_subs_timer). Notifications
 * arrive as:
 *   `%subscription-changed <name> $<sess> @<win> <idx> - : <value>`
 *
 * The parsed `SubscriptionChangedNotification.windowId` carries the numeric
 * window id; `.value` carries the expanded format string for that window.
 *
 * Verified against tmux 3.4 (empirically — tc-7xv.28 investigation):
 *   `refresh-client -B 'sync-watch:@*:#{?synchronize-panes,1,0}'`
 *   → initial `%subscription-changed sync-watch $0 @0 0 - : 0`
 *   → after external `tmux set-option -wt @0 synchronize-panes on`:
 *     `%subscription-changed sync-watch $0 @0 0 - : 1` (within ~1 s)
 *
 * @param name    Subscription name (used as the `name` field in %subscription-changed).
 * @param format  tmux format string evaluated per window (e.g. `#{?synchronize-panes,1,0}`).
 * @returns       e.g. `refresh-client -B 'sync-watch:@*:#{?synchronize-panes,1,0}'`
 */
export function refreshClientSubscribeWindows(name: string, format: string): string {
  // The argument to -B is `name:@*:format`. Single-quote the entire argument
  // so #{ } and ? are not interpreted by the shell. Escape any embedded
  // single-quotes in name or format via the `'\''` idiom.
  const arg = `${name}:@*:${format}`;
  return `refresh-client -B '${arg.replace(/'/g, "'\\''")}'`;
}
