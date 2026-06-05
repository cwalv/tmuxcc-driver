/**
 * Outbound tmux command serializer (tc-zb6).
 *
 * Pure functions that produce tmux command strings — one command per line —
 * suitable for writing verbatim to a tmux -CC control-mode stdin.  No I/O
 * here; callers write the returned strings.
 *
 * When the daemon sends one of these commands tmux responds with a
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
 * daemon manages multiple windows at different sizes (e.g. iTerm2 per-tab
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
 * Tab-separated fields that capture the data the daemon needs for window
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

/**
 * Serialize a `list-panes` command.
 *
 * Emits `list-panes -F '<format>'`.  When `target` is provided it is passed
 * as `-t <target>` (e.g. `%5` for a pane, `@2` for a window).
 *
 * @param target  Optional target (window or pane ID string, e.g. `@2`).
 * @param format  Format string (default: LIST_PANES_DEFAULT_FORMAT).
 * @returns       e.g. `list-panes -t @2 -F '<format>'`
 */
export function listPanes(target?: string, format?: string): string {
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
   */
  startLine?: number;
  /**
   * Last line to capture (inclusive).
   * Passed as `-E <endLine>`.  Omitted when undefined.
   */
  endLine?: number;
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
}

/**
 * Serialize a `new-window` command.
 *
 * Flags used: `-n <name>` for window name, `-c <dir>` for start directory.
 * Trailing unquoted arguments are treated as a shell command by tmux.
 *
 * @param opts  Optional window creation options.
 * @returns     e.g. `new-window -n 'my window'`
 */
export function newWindow(opts?: NewWindowOptions): string {
  const parts: string[] = ["new-window"];
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
