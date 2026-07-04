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
 *      `probeTmuxLiveness` and either re-spawns a fresh watcher (watcher died
 *      with tmux alive, OR the probe was inconclusive — conservative retry) or
 *      self-exits (tmux probed CONCLUSIVELY gone).
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
import { spawn } from "node:child_process";
import { createTmuxHost } from "./runtime/tmux-host.js";
import { paneBoundOptionName } from "./state/bootstrap.js";
/**
 * Run a one-shot `tmux` command asynchronously and resolve its collected
 * output — the async replacement for this module's former `spawnSync` calls
 * (D6 / tc-4b6k.6).  Removing `spawnSync` from the broker's south side is the
 * whole point: every reconcile / claim / info previously blocked the SHARED
 * event loop (the broker plus every in-process session-proxy, tc-2x3.3) for the
 * entire subprocess round-trip — up to `timeoutMs` under host load — stalling
 * every session's delta pipeline.  With an async spawn the loop stays free
 * while tmux runs.
 *
 * Never rejects: a spawn failure / timeout is reported via `error` (mirroring
 * `spawnSync`'s `result.error`), so callers keep their existing
 * `result.error` / `result.status` branching unchanged.  On timeout the child
 * is SIGKILLed and `error.code` is `"ETIMEDOUT"` (matching `spawnSync`'s
 * `timeout` contract).
 *
 * One-shot tmux commands (`list-sessions`, `has-session`, `set-option`, …) need
 * no controlling TTY, so a plain pipe spawn suffices — unlike the `-CC attach`
 * watcher, which requires the node-pty bridge (see the module doc).
 */
function runTmux(args, timeoutMs) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
        }
        catch (err) {
            // Synchronous spawn throw (extremely rare) — report like an error result.
            resolve({ status: null, stdout: "", stderr: "", error: err });
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(r);
        };
        const timer = setTimeout(() => {
            try {
                proc.kill("SIGKILL");
            }
            catch {
                // already gone
            }
            settle({
                status: null,
                stdout,
                stderr,
                error: Object.assign(new Error(`tmux command timed out after ${timeoutMs}ms`), {
                    code: "ETIMEDOUT",
                }),
            });
        }, timeoutMs);
        timer.unref();
        proc.stdout?.on("data", (d) => {
            stdout += d.toString("utf8");
        });
        proc.stderr?.on("data", (d) => {
            stderr += d.toString("utf8");
        });
        // Spawn-level failure (e.g. ENOENT: tmux not on PATH).  `close` does not
        // fire in this case, so the once-guard `settle` is safe.
        proc.on("error", (err) => {
            settle({ status: null, stdout, stderr, error: err });
        });
        // `close` (not `exit`) so stdout/stderr are fully drained before we read.
        proc.on("close", (code) => {
            settle({ status: code, stdout, stderr, error: null });
        });
    });
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
export async function listSessions(socketName, out) {
    // Fields: session_id  session_name  session_windows  session_attached
    //         @tmuxcc  session_activity  @tmuxcc-workspace  @tmuxcc-template
    // Delimiter: tab (\t) avoids accidental splits on spaces in session names.
    // @tmuxcc-workspace values are URIs / "|"-joined URIs — never contain tabs.
    // @tmuxcc-template is a template config-key name — never contains tabs.
    const FORMAT = "#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{@tmuxcc}\t#{session_activity}\t#{@tmuxcc-workspace}\t#{@tmuxcc-template}";
    const result = await runTmux(["-L", socketName, "list-sessions", "-F", FORMAT], 5_000);
    // tc-295a.35: classify the binary-missing case.  `runTmux` sets
    // `result.error.code === "ENOENT"` iff the `tmux` executable could not be
    // found on PATH.  Every other outcome (it ran, or failed for a different
    // reason) means the binary IS present.  Reported via the out-param only;
    // the session-table return value is unchanged.
    if (out) {
        out.binaryMissing = result.error?.code === "ENOENT";
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
    const paneCounts = await countPanesBySession(socketName);
    return (result.stdout ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
        const [tmuxId, name, windows, attached, marker, activity, workspaceUri, template] = line.split("\t");
        const id = tmuxId ?? "";
        const ws = (workspaceUri ?? "").trim();
        const tmpl = (template ?? "").trim();
        return {
            tmuxId: id,
            name: name ?? "",
            windowCount: parseInt(windows ?? "0", 10) || 0,
            attachedCount: parseInt(attached ?? "0", 10) || 0,
            tmuxccMarked: (marker ?? "").trim() === "1",
            paneCount: paneCounts.get(id) ?? 0,
            lastActivity: parseInt(activity ?? "0", 10) || 0,
            ...(ws.length > 0 ? { workspaceUri: ws } : {}),
            ...(tmpl.length > 0 ? { template: tmpl } : {}),
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
export async function getTmuxServerPid(socketName) {
    const result = await runTmux(["-L", socketName, "list-sessions", "-F", "#{pid}"], 5_000);
    if (result.status !== 0 || result.error)
        return null;
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
export async function countPanesBySession(socketName) {
    const counts = new Map();
    const result = await runTmux(["-L", socketName, "list-panes", "-a", "-F", "#{session_id}"], 5_000);
    if (result.status !== 0 || result.error)
        return counts;
    for (const line of (result.stdout ?? "").trim().split("\n")) {
        if (!line)
            continue;
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
export async function countTmuxccClientsBySession(socketName) {
    const counts = new Map();
    const result = await runTmux(["-L", socketName, "list-clients", "-F", "#{client_flags} #{session_id}"], 5_000);
    if (result.status !== 0 || result.error)
        return counts;
    for (const line of (result.stdout ?? "").trim().split("\n")) {
        if (!line)
            continue;
        const spaceIdx = line.lastIndexOf(" ");
        if (spaceIdx < 0)
            continue;
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
 * `clientId` (D3, tc-4b6k.2) is the requesting client's durable identity id.
 * Binding intent is per-client, so the pane's `bound` is read from that client's
 * own `@tmuxcc-bound-<key>` option (an undefined id — anonymous — falls back to
 * the legacy shared `@tmuxcc-bound` slot; see `paneBoundOptionName`).
 *
 * Returns `null` if the session cannot be found or the commands fail.
 */
export async function listSessionTopology(socketName, sessionName, clientId) {
    // list-windows: window_id, window_name, window_active
    const WIN_FORMAT = "#{window_id}\t#{window_name}\t#{window_active}";
    const winResult = await runTmux(["-L", socketName, "list-windows", "-t", sessionName, "-F", WIN_FORMAT], 5_000);
    if (winResult.status !== 0 || winResult.error)
        return null;
    const windows = [];
    for (const line of (winResult.stdout ?? "").trim().split("\n")) {
        if (!line)
            continue;
        const [windowId, name, active] = line.split("\t");
        if (!windowId || !name)
            continue;
        windows.push({
            windowId,
            name,
            active: (active ?? "").trim() === "1",
        });
    }
    // list-panes: pane_id, window_id, @tmuxcc-bound, @tmuxcc-detach (resolved),
    // @tmuxcc-icon.  `-s -t <session>` lists every pane in the target session
    // (across its windows).  NOT `-a`, which would list all panes on the server
    // regardless of -t and leak other sessions' panes into this query.
    // tc-4b6k.2 (D3): read the REQUESTING client's per-client binding slot.
    const PANE_FORMAT = `#{pane_id}\t#{window_id}\t#{${paneBoundOptionName(clientId)}}\t#{@tmuxcc-detach}\t#{@tmuxcc-icon}`;
    const paneResult = await runTmux(["-L", socketName, "list-panes", "-s", "-t", sessionName, "-F", PANE_FORMAT], 5_000);
    if (paneResult.status !== 0 || paneResult.error)
        return null;
    const panes = [];
    for (const line of (paneResult.stdout ?? "").trim().split("\n")) {
        if (!line)
            continue;
        const [paneId, windowId, boundRaw, detachRaw, iconRaw] = line.split("\t");
        if (!paneId || !windowId)
            continue;
        const detachTrimmed = (detachRaw ?? "").trim();
        panes.push({
            paneId,
            windowId,
            bound: (boundRaw ?? "").trim() === "1",
            detach: detachTrimmed === "detach" || detachTrimmed === "kill"
                ? detachTrimmed
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
export async function createSession(socketName, name, capabilities, env) {
    // tc-gjdx.2: gate -e on new-session at 3.2 (CHANGES FROM 3.1c TO 3.2).
    // This flag is NOT available in the 3.0 base where new-window/split-window's
    // -e flag landed. An env-carrying create against tmux < 3.2 is an error.
    if (env !== undefined && Object.keys(env).length > 0) {
        if (capabilities !== undefined && !capabilities.newSessionEnvFlag) {
            throw Object.assign(new Error(`new-session -e (capability newSessionEnvFlag) requires tmux >= 3.2. ` +
                `The probed tmux version does not support this flag. ` +
                `Upgrade tmux to >= 3.2 or omit env from session.create.`), { code: "tmux.capability-required", capability: "newSessionEnvFlag" });
        }
    }
    // Build the env flags for the new-session command.
    const envFlags = [];
    if (env !== undefined) {
        for (const [k, v] of Object.entries(env)) {
            envFlags.push("-e", `${k}=${v}`);
        }
    }
    const result = await runTmux(["-L", socketName, "new-session", "-d", "-s", name, ...envFlags, "-P", "-F", "#{session_id}"], 10_000);
    if (result.status !== 0 || result.error) {
        throw new Error(`tmux new-session failed: ${result.stderr?.trim() ?? result.error?.message ?? "unknown error"}`);
    }
    const tmuxId = (result.stdout ?? "").trim();
    if (!tmuxId.startsWith("$")) {
        // tmux's `-P -F '#{session_id}'` always emits a `$N` id on success.  Empty
        // or malformed stdout means we cannot trust the create — surface it as
        // an error rather than fabricating an id.
        throw new Error(`tmux new-session returned no session id (stdout: ${JSON.stringify(result.stdout ?? "")})`);
    }
    // Set the @tmuxcc 1 marker so the Phase 2 probe can discover this session.
    await setSessionMarker(socketName, name);
    // tc-w3ir.1: apply the tmuxcc driver default `scroll-on-clear off` as a
    // server-global window option at session/server birth. `new-session` above
    // is the point at which the (dedicated `-L <socketName>`) tmux server is
    // guaranteed to exist, and `-wg` makes every window — this session's and any
    // later ones on the same server — inherit it. This stops tmux from scrolling
    // cleared-screen content into history, which is what `capture-pane -S -`
    // otherwise resurrects as the reattach phantom for our remote renderers
    // (tc-kyq4.5). See setGlobalScrollOnClear for the full rationale.
    // tc-4b6k.12: pass capabilities so the call is skipped on tmux < 3.3 where
    // scroll-on-clear is absent; when capabilities is undefined the old
    // best-effort behaviour (try and silently swallow) is preserved.
    await setGlobalScrollOnClear(socketName, false, capabilities);
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
export async function setSessionMarker(socketName, name) {
    await runTmux(["-L", socketName, "set-option", "-t", name, "@tmuxcc", "1"], 3_000);
}
/**
 * Set the `@tmuxcc-workspace` user-option on a session (S4 / tc-76m8.6).
 *
 * This is the session's stable workspace IDENTITY (the canonical workspace URI),
 * matched at reopen/arrival so a human-named session still reattaches to the
 * right workspace.  Set once at session birth by `session.createUnique` when the
 * creating extension supplied a workspace URI (folderless windows carry no
 * identity, so this is skipped for them).
 *
 * Mirrors {@link setSessionMarker}: the `set-option` failure is intentionally
 * non-fatal — a session that briefly lacks the option still exists and functions;
 * it just falls back to legacy name-matching until the option lands.  Passing the
 * session name directly (no `=<name>` literal-match prefix) matches
 * {@link setSessionMarker}'s note.
 */
export async function setSessionWorkspace(socketName, name, workspaceUri) {
    await runTmux(["-L", socketName, "set-option", "-t", name, "@tmuxcc-workspace", workspaceUri], 3_000);
}
/**
 * Set the server-global `scroll-on-clear` window option as a tmuxcc driver
 * default (tc-w3ir.1).
 *
 * Runs `tmux -L <socketName> set-option -wg scroll-on-clear <on|off>`. The
 * `-wg` form sets the *global* window option, which every window on this
 * (dedicated `-L <socketName>`) server inherits unless it overrides it
 * locally — so a single call at session/server birth covers every managed
 * pane without per-pane re-application.
 *
 * Why `off` is the tmuxcc default: tmux's `scroll-on-clear` (default on)
 * preserves the erased screen into scrollback on `clear`, so a tmux-NATIVE
 * client can scroll up afterwards (screen-write.c
 * `screen_write_clearscreen` → `grid_view_clear_history`). tmuxcc's clients
 * are REMOTE RENDERERS (xterm.js etc.) that self-manage their own scrollback
 * from the live `%output` stream and discard on clear; they never benefit
 * from this preservation live. It only ever surfaces as the reattach phantom
 * (tc-kyq4.5) when `capture-pane -S -` resurrects the cleared screen into the
 * hydration snapshot. `off` is therefore correct for the entire
 * proxied-renderer client model, not an xterm.js-specific quirk.
 *
 * tc-4b6k.12: the optional `capabilities` parameter gates the call on
 * `capabilities.scrollOnClear`. When capabilities are provided and the flag
 * is false, this is a no-op — the capability absence is model state, not an
 * error to swallow. When `capabilities` is omitted, the legacy best-effort
 * behaviour (try and silently discard any error) is preserved for callers that
 * do not yet have access to the capability state.
 */
export async function setGlobalScrollOnClear(socketName, on, capabilities) {
    // scroll-on-clear was added in tmux 3.3 (CHANGES FROM 3.2a TO 3.3).
    // When the caller supplies capabilities, skip silently if the feature is absent.
    if (capabilities !== undefined && !capabilities.scrollOnClear)
        return;
    await runTmux(["-L", socketName, "set-option", "-wg", "scroll-on-clear", on ? "on" : "off"], 3_000);
}
/**
 * Run `tmux -L <socketName> kill-session -t <id>` to destroy a session.
 * `id` can be a session name or tmux `$N` id.
 * Throws if the command fails.
 */
export async function killSession(socketName, id) {
    const result = await runTmux(["-L", socketName, "kill-session", "-t", id], 10_000);
    if (result.status !== 0 || result.error) {
        throw new Error(`tmux kill-session failed: ${result.stderr?.trim() ?? result.error?.message ?? "unknown error"}`);
    }
}
export async function checkSessionPresence(socketName, id) {
    const result = await runTmux(["-L", socketName, "has-session", "-t", id], 5_000);
    if (result.error) {
        // Spawn-level failure (timeout, ENOENT) — no information about the session.
        return "inconclusive";
    }
    if (result.status === 0) {
        return "present";
    }
    // Non-zero: distinguish CONCLUSIVE absence from a transient unreachable socket.
    //   - "can't find session"  → server UP, session gone   → absent.
    //   - "no server running"   → server DOWN (no sessions) → absent (tc-hfxb.19).
    //   - "error connecting" / "no such file" / other       → socket missing /
    //                                                          unreachable → inconclusive.
    const stderr = (result.stderr ?? "").toLowerCase();
    if (stderr.includes("can't find session") ||
        stderr.includes("can’t find session") ||
        stderr.includes("no server running")) {
        return "absent";
    }
    return "inconclusive";
}
/**
 * Probe the tmux server on `socketName` by running `tmux -L <socketName> ls`
 * with a hard timeout (§6.2 watcher-EOF disambiguation), distinguishing all
 * three outcomes (see `TmuxLiveness`).
 *
 * Unlike `probeTmuxAlive`, this does NOT collapse "ran and found no server"
 * (`"gone"` — positive evidence) into the same bucket as "could not run the
 * probe" (`"inconclusive"` — spawn failure / timeout).  Callers that must only
 * act on POSITIVE evidence of a dead server (the broker-exit classifier) use
 * this; callers for which "presume gone on any indeterminate outcome" is the
 * correct conservative answer (the broker's own watcher-EOF disambiguation)
 * use `probeTmuxAlive`.
 *
 * Async (unlike the other helpers in this module) so the server-proxy stays
 * responsive to connected clients during the probe window.
 */
export function probeTmuxLiveness(socketName, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (liveness) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(liveness);
        };
        let proc;
        try {
            proc = spawn("tmux", ["-L", socketName, "ls"], { stdio: "ignore" });
        }
        catch {
            // The subprocess never started — we have no information about tmux.
            resolve("inconclusive");
            return;
        }
        const timer = setTimeout(() => {
            try {
                proc.kill("SIGKILL");
            }
            catch {
                // ignore
            }
            // The probe did not finish in budget — under host load the spawn/exec
            // itself can lose this race.  That is INCONCLUSIVE, never "gone".
            settle("inconclusive");
        }, timeoutMs);
        timer.unref();
        proc.on("exit", (code) => {
            // The command RAN to completion: exit 0 ⇒ alive, anything else
            // ("no server running on …") ⇒ POSITIVE evidence the server is gone.
            settle(code === 0 ? "alive" : "gone");
        });
        proc.on("error", () => {
            // Spawn-level failure (e.g. tmux not on PATH): inconclusive, not gone.
            settle("inconclusive");
        });
    });
}
/**
 * Probe whether the tmux server on `socketName` is alive by running
 * `tmux -L <socketName> ls` with a hard timeout (§6.2 watcher-EOF
 * disambiguation).
 *
 * Resolves `true` iff the command exits with status 0 within `timeoutMs`.
 * Any other outcome — non-zero exit ("no server running on …"), spawn
 * failure, or timeout — resolves `false` ("presume gone").  Callers that must
 * distinguish "ran and found no server" from "could not run the probe" should
 * use `probeTmuxLiveness` instead.
 *
 * Async (unlike the other helpers in this module) so the server-proxy stays
 * responsive to connected clients during the probe window.
 */
export function probeTmuxAlive(socketName, timeoutMs) {
    return probeTmuxLiveness(socketName, timeoutMs).then((l) => l === "alive");
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
export function createTmuxWatcher(socketName, onChanged, onEof) {
    let stopped = false;
    /** Set after onEof fired — the instance is inert from then on. */
    let done = false;
    let currentHost = null;
    let pollMs = POLL_INIT_MS;
    let pollTimer = null;
    async function connect() {
        if (stopped || done)
            return;
        // Check if the server is actually running before attaching.
        // `tmux -CC attach` without sessions exits immediately; we defer until
        // there's at least one session or until the server is reachable.
        //
        // tc-zcqr: listSessions returns null on transient failure; treat that
        // the same as "no sessions yet" — schedule a retry.
        const rows = await listSessions(socketName);
        // The watcher may have been stopped/EOFed while the async list ran.
        if (stopped || done)
            return;
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
        const fireEof = () => {
            if (eofFired)
                return;
            eofFired = true;
            currentHost = null;
            done = true;
            if (!stopped)
                onEof();
        };
        host.onData((chunk) => {
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
        host.onError(() => { });
        void host.start().catch(() => {
            fireEof();
        });
    }
    function schedulePoll() {
        if (stopped || done)
            return;
        pollTimer = setTimeout(() => {
            pollTimer = null;
            // Notify on each poll tick so the server-proxy does a full refresh
            onChanged();
            void connect();
            pollMs = Math.min(pollMs * POLL_FACTOR, POLL_MAX_MS);
        }, pollMs);
        // Don't let a pending pre-attach poll keep the event loop alive.
        pollTimer.unref();
    }
    // Start immediately
    void connect();
    return {
        stop() {
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
//# sourceMappingURL=tmux-south.js.map