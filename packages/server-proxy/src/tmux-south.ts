/**
 * tmux south-side — server-proxy's thin connection to the tmux server.
 *
 * # Design
 *
 * The server-proxy holds ONE thin `tmux -L <socketName> -CC attach` connection
 * purely to receive `%sessions-changed` notifications. Per SCHEMA.md:
 *   "Hold one thin `tmux -L <socketName> -CC attach` connection purely to
 *    receive `%sessions-changed` notifications. Do NOT process pane events."
 *
 * For state reads the server-proxy shells out to `tmux list-sessions` etc.
 *
 * # Watcher lifecycle (tc-3iv, ext-a-design-context.md §6.2)
 *
 * A watcher instance is single-flight:
 *
 *   1. Pre-attach: while no session exists, poll `list-sessions` with
 *      exponential backoff (250 ms doubling up to 8 s) until a session
 *      appears, then attach.  `tmux -CC attach` requires at least one
 *      session — with `exit-empty on` (the modern default) "no sessions"
 *      also means "no server", so there is nothing to attach to yet.
 *   2. Attached: invoke `onChanged` for each `%sessions-changed` line.
 *   3. EOF: when the attached `-CC` process exits for ANY reason, invoke
 *      `onEof` exactly once and go inert.  The watcher does NOT reconnect
 *      on its own — the owner (the serverProxy) disambiguates via
 *      `probeTmuxAlive` and either re-spawns a fresh watcher (watcher died,
 *      tmux alive) or self-exits (tmux genuinely gone).
 *
 * `onEof` is never invoked after `stop()` (e.g. for the SIGTERM that
 * `stop()` itself delivers to the `-CC` child).
 *
 * # Why the watcher runs through the PTY bridge
 *
 * tmux's client calls tcgetattr() on stdin even in `-CC` control mode; with
 * stdin on a plain pipe (or /dev/null) it exits immediately with "tcgetattr
 * failed: Inappropriate ioctl for device".  A direct `child_process.spawn`
 * watcher therefore dies instantly and silently degrades into a poller.
 * The watcher reuses the session-proxy's `createTmuxHost` (node-pty bridge) so the
 * `-CC` connection is genuinely live — required for process exit to be a
 * meaningful tmux-death signal.  It attaches with client flags `no-output,ignore-size`:
 * the thin watcher must not receive pane output (§6.2 "do NOT process pane
 * events") and must not influence session sizing for real clients.
 *
 * @module tmux-south
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createTmuxHost } from "@tmuxcc/session-proxy";
import type { TmuxHost } from "@tmuxcc/session-proxy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Handler invoked when session state may have changed. */
export type SessionsChangedHandler = () => void;

/**
 * Handler invoked exactly once when an attached `-CC` watcher process EOFs
 * (exits).  Not invoked for pre-attach poll retries, and not after `stop()`.
 */
export type WatcherEofHandler = () => void;

/** Returned by createTmuxWatcher — call stop() to close. */
export interface TmuxWatcher {
  /** Stop the watcher and kill the tmux -CC child process. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Session list query
// ---------------------------------------------------------------------------

/** A row from `tmux list-sessions`. */
export interface TmuxSessionRow {
  /** tmux session id, e.g. "$1" */
  tmuxId: string;
  /** session name */
  name: string;
  /** number of windows */
  windowCount: number;
  /** number of attached clients */
  attachedCount: number;
  /**
   * Whether this session carries the `@tmuxcc 1` user option (tc-295a.4 /
   * W1.3).  True iff the session was created or claimed by tmuxcc; false for
   * foreign sessions that tmuxcc has never touched.
   */
  tmuxccMarked: boolean;
  /**
   * Total number of panes across all windows in this session (tc-295a.4 /
   * W1.3).  Sourced from a companion `list-panes -a` call inside
   * `listSessions`; 0 when the server has no panes for this session.
   */
  paneCount: number;
  /**
   * Unix epoch (seconds) of the most-recent activity in this session
   * (tc-295a.4 / W1.3).  Sourced from tmux's `#{session_activity}` format
   * variable.  0 when tmux cannot report an activity time (should not
   * happen in practice).
   */
  lastActivity: number;
}

/**
 * Optional out-parameter for {@link listSessions} reporting whether the tmux
 * BINARY itself is present (tc-295a.35).
 *
 * `listSessions` collapses every spawn-level failure (timeout, ENOENT, …) to
 * `null` so its session-table callers (`_refreshSessions`, the watcher) treat
 * all of them identically as "transient — leave the cache alone".  But ONE of
 * those spawn failures — `ENOENT` on the `tmux` binary — is NOT transient: it
 * means tmux is not installed, which the broker reports as canonical state
 * (`tmuxAvailable: false` in its snapshot) so the extension can surface the
 * actionable "tmuxcc requires tmux." message.  This out-param lets a caller
 * that cares (the broker's `_refreshSessions`) read that distinction WITHOUT a
 * second shell-out and WITHOUT changing the `null`/`[]` contract every other
 * caller depends on.
 *
 * `binaryMissing` is set on EVERY call:
 *   - `true`  iff the spawn failed with ENOENT (tmux not on PATH).
 *   - `false` for every other outcome (success, no-server, timeout, other
 *     spawn errors) — i.e. tmux ran (or could have run), so it IS installed.
 */
export interface TmuxAvailabilityOut {
  binaryMissing: boolean;
}

/**
 * Run `tmux -L <socketName> list-sessions -F '...'` synchronously and
 * return the parsed rows.
 *
 * tc-295a.4 (W1.3): the format string now also fetches `#{@tmuxcc}` (the
 * Phase-2 marker) and `#{session_activity}` (Unix epoch of last activity).
 * `paneCount` is sourced from a companion `list-panes -a` call so that a
 * single `listSessions` call provides all enriched fields the broker needs.
 *
 * Returns an empty array if the tmux server is not running or has no sessions
 * (status 0 with empty stdout, OR stderr says "no server running").
 *
 * Returns `null` for ANY other failure (timeout, spawn error, unexpected
 * non-zero status with stderr).  tc-zcqr: callers (e.g. `_refreshSessions`)
 * MUST distinguish "no sessions" (clear the cache) from "transient failure"
 * (leave the cache alone).  The previous behaviour conflated both as `[]`,
 * which silently dropped the just-created session out of `_byName` and
 * surfaced as the "Session not found after creation" claim race.
 *
 * tc-295a.35: pass an optional {@link TmuxAvailabilityOut} to additionally
 * learn whether the `null` (or any) return was caused by the tmux binary being
 * absent (`out.binaryMissing`).  The broker uses this to report
 * `tmuxAvailable` as canonical state in its snapshot — see
 * {@link TmuxAvailabilityOut}.  Callers that don't pass `out` see no behaviour
 * change (the `null`/`[]` contract is unchanged).
 */
export function listSessions(
  socketName: string,
  out?: TmuxAvailabilityOut,
): TmuxSessionRow[] | null {
  // Fields: session_id  session_name  session_windows  session_attached
  //         @tmuxcc  session_activity
  // Delimiter: tab (\t) avoids accidental splits on spaces in session names.
  const FORMAT = "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{@tmuxcc}\t#{session_activity}";
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "list-sessions", "-F", FORMAT],
    { encoding: "utf8", timeout: 5_000 },
  );

  // tc-295a.35: classify the binary-missing case.  `spawnSync` sets
  // `result.error.code === "ENOENT"` iff the `tmux` executable could not be
  // found on PATH.  Every other outcome (it ran, or failed for a different
  // reason) means the binary IS present.  Reported via the out-param only;
  // the session-table return value is unchanged.
  if (out) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    out.binaryMissing = code === "ENOENT";
  }

  // Spawn-level failure (timeout, ENOENT on tmux binary, etc.) — transient,
  // do NOT degrade to "empty session list".
  if (result.error) {
    return null;
  }

  if (result.status !== 0) {
    // tmux 3.x: server-not-running prints "no server running on /tmp/tmux-.../<socket>"
    // to stderr with status 1.  Treat that as "no sessions" (empty).  Any other
    // non-zero exit is a transient failure (null) — same caller semantics.
    const stderr = (result.stderr ?? "").toLowerCase();
    if (stderr.includes("no server running") || stderr.includes("no sessions") || stderr.includes("error connecting")) {
      return [];
    }
    return null;
  }

  // Pane counts per session id, used to enrich each row.
  const paneCounts = countPanesBySession(socketName);

  return (result.stdout ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tmuxId, name, windows, attached, marker, activity] = line.split("\t");
      const id = tmuxId ?? "";
      return {
        tmuxId: id,
        name: name ?? "",
        windowCount: parseInt(windows ?? "0", 10) || 0,
        attachedCount: parseInt(attached ?? "0", 10) || 0,
        tmuxccMarked: (marker ?? "").trim() === "1",
        paneCount: paneCounts.get(id) ?? 0,
        lastActivity: parseInt(activity ?? "0", 10) || 0,
      };
    });
}

/**
 * PID of the tmux server on `socketName`, or `null` when the server is not
 * running (tc-k6v `server-proxy.info`).
 *
 * Uses `list-sessions -F '#{pid}'` rather than `display-message -p`: the
 * format variable `#{pid}` is the server pid in any format context, and
 * `list-sessions` needs no attached client or target.  A server with zero
 * sessions effectively does not exist under the modern `exit-empty on`
 * default, so "no rows" ⇒ `null` is the right degradation.
 */
export function getTmuxServerPid(socketName: string): number | null {
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "list-sessions", "-F", "#{pid}"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0 || result.error) return null;
  const first = (result.stdout ?? "").trim().split("\n")[0] ?? "";
  const pid = parseInt(first, 10);
  return Number.isNaN(pid) ? null : pid;
}

/**
 * Pane counts per session (tc-k6v `server-proxy.info`): maps tmux session id
 * (e.g. `"$1"`) → number of panes across all of the session's windows.
 *
 * Runs `tmux -L <socketName> list-panes -a -F '#{session_id}'` and tallies
 * rows.  Returns an empty map when the server is not running.
 */
export function countPanesBySession(socketName: string): Map<string, number> {
  const counts = new Map<string, number>();
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "list-panes", "-a", "-F", "#{session_id}"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0 || result.error) return counts;
  for (const line of (result.stdout ?? "").trim().split("\n")) {
    if (!line) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * Count tmuxcc-owned `-CC` clients per session (tc-3y8.7).
 *
 * tmuxcc attaches its own control-mode clients to every claimed session:
 *
 *   - **SessionProxy** (`-CC attach -t <session>`): flags include `control-mode`
 *     but NOT `no-output` or `ignore-size`.  One per claimed session.
 *   - **Watcher** (`-CC attach -f no-output,ignore-size`): flags include
 *     `control-mode`, `no-output`, AND `ignore-size`.  One per server-proxy.
 *
 * Both are distinguishable from real human clients by the presence of
 * `control-mode` in their `client_flags` — a tmux control-mode connection
 * is never opened by a regular terminal user.
 *
 * Empirical evidence (tmux 3.4, tmuxcc test socket):
 *   session-proxy client: `attached,focused,control-mode,UTF-8`
 *   watcher client: `attached,focused,control-mode,ignore-size,no-output,UTF-8`
 *
 * Returns a map of tmux session id (e.g. `"$1"`) → count of tmuxcc-owned
 * clients attached to that session.  An empty map is returned when the
 * server is not running or has no clients.
 */
export function countTmuxccClientsBySession(socketName: string): Map<string, number> {
  const counts = new Map<string, number>();
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "list-clients", "-F", "#{client_flags} #{session_id}"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0 || result.error) return counts;
  for (const line of (result.stdout ?? "").trim().split("\n")) {
    if (!line) continue;
    const spaceIdx = line.lastIndexOf(" ");
    if (spaceIdx < 0) continue;
    const flags = line.slice(0, spaceIdx);
    const sessionId = line.slice(spaceIdx + 1);
    // `control-mode` is present on ALL tmuxcc-owned clients (session-proxy + watcher).
    // Regular terminal users never open a control-mode connection.
    if (flags.includes("control-mode")) {
      counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Session topology query (tc-i9aq.2 — S1 lazy list for discovered sessions)
// ---------------------------------------------------------------------------

/**
 * A single window row from `tmux list-windows`.
 */
export interface TmuxWindowRow {
  /** tmux window id, e.g. "@1" */
  windowId: string;
  /** Window name */
  name: string;
  /** True when this is the active window in its session */
  active: boolean;
}

/**
 * A single pane row from `tmux list-panes` with `@tmuxcc-*` user-options.
 */
export interface TmuxPaneRow {
  /** tmux pane id, e.g. "%1" */
  paneId: string;
  /** tmux window id this pane belongs to, e.g. "@1" */
  windowId: string;
  /**
   * Durable binding intent (`@tmuxcc-bound`).  True when the pane has the
   * option set to "1"; false otherwise.
   */
  bound: boolean;
  /**
   * RESOLVED detach-on-close policy (`@tmuxcc-detach`, format-walked so the
   * first-wins pane→window→session value is returned directly).
   * `undefined` when no scope has set the option.
   */
  detach: "detach" | "kill" | undefined;
  /**
   * Durable icon policy (`@tmuxcc-icon`).
   * `undefined` when no option is set.
   */
  icon: string | undefined;
}

/**
 * Full topology result for a single session: windows + panes with
 * `@tmuxcc-*` fields.  Returned by {@link listSessionTopology}.
 */
export interface SessionTopologyResult {
  readonly windows: TmuxWindowRow[];
  readonly panes: TmuxPaneRow[];
}

/**
 * Run `tmux list-windows` + `tmux list-panes` for a named session and return
 * the full window/pane topology with `@tmuxcc-*` user-option fields.
 *
 * tc-i9aq.2 (A1 mechanism): called by the server-proxy's `session.topology`
 * command handler for discovered-but-unclaimed sessions.  The query is
 * read-only — no claim, no session-proxy spawn, no side effects.
 *
 * The `@tmuxcc-detach` pane format variable format-walks pane→window→session
 * and yields the effective first-wins close policy directly (tc-i9aq.1 /
 * cold-start.md §4 — same verified tmux 3.4 behaviour as the session-proxy's
 * BOOTSTRAP_PANES_FORMAT).
 *
 * Returns `null` if the session cannot be found or the commands fail.
 */
export function listSessionTopology(
  socketName: string,
  sessionName: string,
): SessionTopologyResult | null {
  // list-windows: window_id, window_name, window_active
  const WIN_FORMAT = "#{window_id}\t#{window_name}\t#{window_active}";
  const winResult = spawnSync(
    "tmux",
    ["-L", socketName, "list-windows", "-t", sessionName, "-F", WIN_FORMAT],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (winResult.status !== 0 || winResult.error) return null;

  const windows: TmuxWindowRow[] = [];
  for (const line of (winResult.stdout ?? "").trim().split("\n")) {
    if (!line) continue;
    const [windowId, name, active] = line.split("\t");
    if (!windowId || !name) continue;
    windows.push({
      windowId,
      name,
      active: (active ?? "").trim() === "1",
    });
  }

  // list-panes: pane_id, window_id, @tmuxcc-bound, @tmuxcc-detach (resolved),
  // @tmuxcc-icon.  The -a flag lists all panes across all windows; -t filters
  // to the target session.
  const PANE_FORMAT =
    "#{pane_id}\t#{window_id}\t#{@tmuxcc-bound}\t#{@tmuxcc-detach}\t#{@tmuxcc-icon}";
  const paneResult = spawnSync(
    "tmux",
    ["-L", socketName, "list-panes", "-t", sessionName, "-a", "-F", PANE_FORMAT],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (paneResult.status !== 0 || paneResult.error) return null;

  const panes: TmuxPaneRow[] = [];
  for (const line of (paneResult.stdout ?? "").trim().split("\n")) {
    if (!line) continue;
    const [paneId, windowId, boundRaw, detachRaw, iconRaw] = line.split("\t");
    if (!paneId || !windowId) continue;
    const detachTrimmed = (detachRaw ?? "").trim();
    panes.push({
      paneId,
      windowId,
      bound: (boundRaw ?? "").trim() === "1",
      detach: detachTrimmed === "detach" || detachTrimmed === "kill"
        ? (detachTrimmed as "detach" | "kill")
        : undefined,
      icon: (iconRaw ?? "").trim() || undefined,
    });
  }

  return { windows, panes };
}

/**
 * Run `tmux -L <socketName> new-session -d -s <name> -P -F '#{session_id}'`
 * to create a detached session and authoritatively return its newly-minted
 * tmux session id (`"$N"`) in the same round-trip.  Throws if the command
 * fails (including name-already-taken).
 *
 * tc-zcqr: returning the session id from `new-session` itself avoids a
 * post-create `list-sessions` query.  The previous code shape was
 *
 *     createSession(...)            // tmux new-session (status 0)
 *     setSessionMarker(...)         // tmux set-option (best-effort)
 *     _refreshSessions()            // tmux list-sessions  <-- race window
 *     entry = _byName.get(name)     // sometimes undefined => "not found after creation"
 *
 * The race was a transient `list-sessions` failure being silently coerced to
 * "no sessions" by `listSessions`.  Now `createSession` is the authority and
 * `_doClaimSession` can synchronously inject the new row into its cache.
 *
 * After a successful `new-session`, immediately sets the Phase 2 marker
 * `@tmuxcc 1` on the session (tc-w61) so that `listTmuxccSessions` can
 * surface it.  The `set-option` failure is intentionally non-fatal — if the
 * marker cannot be set (extremely unusual), the session still exists and the
 * session-proxy will start; the session just won't appear in the attach-picker until
 * the marker is applied on the next claim.
 */
export function createSession(socketName: string, name: string): { tmuxId: string } {
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "new-session", "-d", "-s", name, "-P", "-F", "#{session_id}"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `tmux new-session failed: ${result.stderr?.trim() ?? result.error?.message ?? "unknown error"}`,
    );
  }

  const tmuxId = (result.stdout ?? "").trim();
  if (!tmuxId.startsWith("$")) {
    // tmux's `-P -F '#{session_id}'` always emits a `$N` id on success.  Empty
    // or malformed stdout means we cannot trust the create — surface it as
    // an error rather than fabricating an id.
    throw new Error(
      `tmux new-session returned no session id (stdout: ${JSON.stringify(result.stdout ?? "")})`,
    );
  }

  // Set the @tmuxcc 1 marker so the Phase 2 probe can discover this session.
  setSessionMarker(socketName, name);

  return { tmuxId };
}

/**
 * Set the Phase 2 `@tmuxcc 1` user option on an existing tmux session.
 *
 * Used both immediately after `createSession` (new sessions) and on
 * mark-on-attach (existing sessions that are being claimed by tmuxcc for
 * the first time).  The `set-option` call is idempotent — re-setting
 * `@tmuxcc 1` on an already-marked session is a no-op.
 *
 * Non-fatal: if `set-option` fails (e.g. the session was killed between
 * `new-session` and this call), the error is silently ignored.  The caller
 * can detect the missing marker via `listTmuxccSessions` if needed.
 *
 * Note: `set-option -t` does not support the `=<name>` literal-match prefix;
 * we pass the session name directly.  tmuxcc session names are
 * workspace-derived (stable, unique per workspace) so ambiguity is not a
 * concern in practice.
 */
export function setSessionMarker(socketName: string, name: string): void {
  spawnSync(
    "tmux",
    ["-L", socketName, "set-option", "-t", name, "@tmuxcc", "1"],
    { encoding: "utf8", timeout: 3_000 },
  );
}

/**
 * Set `synchronize-panes` for a specific tmux window.
 *
 * Runs `tmux -L <socketName> set-option -wt @<windowNum> synchronize-panes on|off`.
 *
 * `windowNum` is the numeric tmux window id (the N in `@N`).
 * `on` specifies the desired state.
 *
 * Throws if the command fails (tmux server unavailable or invalid window target).
 *
 * tc-7xv.12: server-proxy-side surface for `setSynchronizePanes`.  Routes through
 * a connected session-proxy's `set-synchronize-panes` WireCommand when a session-proxy
 * is available; falls back to this direct-tmux path otherwise.
 */
export function setWindowSynchronizePanes(
  socketName: string,
  windowNum: number,
  on: boolean,
): void {
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "set-option", "-wt", `@${windowNum}`, "synchronize-panes", on ? "on" : "off"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `tmux set-option synchronize-panes failed: ${result.stderr?.trim() ?? result.error?.message ?? "unknown error"}`,
    );
  }
}

/**
 * Set `monitor-activity` for a specific tmux window.
 *
 * Runs `tmux -L <socketName> set-option -wt @<windowNum> monitor-activity on|off`.
 *
 * `windowNum` is the numeric tmux window id (the N in `@N`).
 * `on` specifies the desired state.
 *
 * Throws if the command fails (tmux server unavailable or invalid window target).
 *
 * tc-7xv.15: server-proxy-side surface for `setMonitorActivity`.
 */
export function setWindowMonitorActivity(
  socketName: string,
  windowNum: number,
  on: boolean,
): void {
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "set-option", "-wt", `@${windowNum}`, "monitor-activity", on ? "on" : "off"],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `tmux set-option monitor-activity failed: ${result.stderr?.trim() ?? result.error?.message ?? "unknown error"}`,
    );
  }
}

/**
 * Set `monitor-silence` for a specific tmux window.
 *
 * Runs `tmux -L <socketName> set-option -wt @<windowNum> monitor-silence <seconds>`.
 * Pass `seconds = 0` to disable (tmux interprets `monitor-silence 0` as off).
 *
 * `windowNum` is the numeric tmux window id (the N in `@N`).
 *
 * Throws if the command fails (tmux server unavailable or invalid window target).
 *
 * tc-7xv.15: server-proxy-side surface for `setMonitorSilence`.
 */
export function setWindowMonitorSilence(
  socketName: string,
  windowNum: number,
  seconds: number,
): void {
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "set-option", "-wt", `@${windowNum}`, "monitor-silence", String(seconds)],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `tmux set-option monitor-silence failed: ${result.stderr?.trim() ?? result.error?.message ?? "unknown error"}`,
    );
  }
}

/**
 * Run `tmux -L <socketName> kill-session -t <id>` to destroy a session.
 * `id` can be a session name or tmux `$N` id.
 * Throws if the command fails.
 */
export function killSession(socketName: string, id: string): void {
  const result = spawnSync(
    "tmux",
    ["-L", socketName, "kill-session", "-t", id],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `tmux kill-session failed: ${result.stderr?.trim() ?? result.error?.message ?? "unknown error"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// tmux liveness probe (tc-3iv)
// ---------------------------------------------------------------------------

/**
 * Probe whether the tmux server on `socketName` is alive by running
 * `tmux -L <socketName> ls` with a hard timeout (§6.2 watcher-EOF
 * disambiguation).
 *
 * Resolves `true` iff the command exits with status 0 within `timeoutMs`.
 * Any other outcome — non-zero exit ("no server running on …"), spawn
 * failure, or timeout — resolves `false`.
 *
 * Async (unlike the other helpers in this module) so the server-proxy stays
 * responsive to connected clients during the probe window.
 */
export function probeTmuxAlive(socketName: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(alive);
    };

    let proc: ChildProcess;
    try {
      proc = spawn("tmux", ["-L", socketName, "ls"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle(false);
    }, timeoutMs);
    timer.unref();

    proc.on("exit", (code) => {
      settle(code === 0);
    });
    proc.on("error", () => {
      settle(false);
    });
  });
}

// ---------------------------------------------------------------------------
// %sessions-changed watcher
// ---------------------------------------------------------------------------

/** Pre-attach poll backoff configuration. */
const POLL_INIT_MS = 250;
const POLL_MAX_MS = 8_000;
const POLL_FACTOR = 2;

/**
 * Start a single-flight `tmux -L <socketName> -CC attach` watcher (see the
 * module doc's "Watcher lifecycle" section).
 *
 * - `onChanged` fires for each `%sessions-changed` line, and once per
 *   pre-attach poll tick (to force a full refresh — sessions may have been
 *   created externally while we had nothing to attach to).
 * - `onEof` fires exactly once when the attached `-CC` process exits, after
 *   which the watcher is inert.  The owner decides whether to re-spawn a
 *   fresh watcher or self-exit (probe disambiguation, §6.2).
 *
 * Returns a `TmuxWatcher` handle whose `stop()` method terminates the watcher
 * (and suppresses `onEof` for the resulting child exit).
 */
export function createTmuxWatcher(
  socketName: string,
  onChanged: SessionsChangedHandler,
  onEof: WatcherEofHandler,
): TmuxWatcher {
  let stopped = false;
  /** Set after onEof fired — the instance is inert from then on. */
  let done = false;
  let currentHost: TmuxHost | null = null;
  let pollMs = POLL_INIT_MS;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (stopped || done) return;

    // Check if the server is actually running before attaching.
    // `tmux -CC attach` without sessions exits immediately; we defer until
    // there's at least one session or until the server is reachable.
    //
    // tc-zcqr: listSessions returns null on transient failure; treat that
    // the same as "no sessions yet" — schedule a retry.
    const rows = listSessions(socketName);
    if (rows === null || rows.length === 0) {
      // Nothing to attach to yet — schedule a retry
      schedulePoll();
      return;
    }

    // Use the first available session name as the attach target so tmux
    // doesn't try to attach to the most-recently-used session interactively.
    const target = rows[0]?.name ?? "";

    // Attach via the PTY bridge (see module doc): tmux's client requires a
    // TTY on stdin even in control mode.  Client flags:
    //   no-output   — suppress %output blocks; the watcher only consumes
    //                 session-lifecycle notifications (§6.2)
    //   ignore-size — a thin 220x50 watcher must not drive session resizing
    //                 for session-proxies / real clients attached to the same session
    // Note: no `-d` — detaching other clients would disrupt session-proxy attaches.
    const host = createTmuxHost({
      socketName,
      sessionName: target,
      attach: true,
      args: ["-f", "no-output,ignore-size"],
    });
    currentHost = host;

    let lineBuf = "";
    let eofFired = false;

    // The host can report exit and (spawn) error; fire onEof at most once.
    const fireEof = (): void => {
      if (eofFired) return;
      eofFired = true;
      currentHost = null;
      done = true;
      if (!stopped) onEof();
    };

    host.onData((chunk: Uint8Array) => {
      lineBuf += Buffer.from(chunk).toString("utf8");
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trimStart().startsWith("%sessions-changed")) {
          onChanged();
        }
      }
    });

    host.onExit(() => {
      fireEof();
    });
    // Register an error handler so stream errors are not re-emitted as
    // uncaughtException by the host; lifecycle is handled via onExit/catch.
    host.onError(() => {});

    void host.start().catch(() => {
      fireEof();
    });
  }

  function schedulePoll(): void {
    if (stopped || done) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      // Notify on each poll tick so the server-proxy does a full refresh
      onChanged();
      connect();
      pollMs = Math.min(pollMs * POLL_FACTOR, POLL_MAX_MS);
    }, pollMs);
    // Don't let a pending pre-attach poll keep the event loop alive.
    pollTimer.unref();
  }

  // Start immediately
  connect();

  return {
    stop(): void {
      stopped = true;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (currentHost) {
        // Fire-and-forget: TmuxHost.stop() escalates to SIGKILL internally.
        void currentHost.stop();
        currentHost = null;
      }
    },
  };
}
