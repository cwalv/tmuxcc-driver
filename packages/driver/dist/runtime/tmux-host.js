/**
 * tmux -CC subprocess host (tc-kyp).
 *
 * Spawns and owns a `tmux -CC` child process via node-pty (tc-2x3.1).
 * node-pty allocates a real POSIX PTY pair via forkpty(3) and executes the
 * target process with the slave end — satisfying tmux's tcgetattr() requirement
 * without a Python runtime dependency.
 *
 * # Why a PTY?
 *
 * tmux's control-mode client calls tcgetattr() on its stdin/stdout at startup.
 * When those fds are plain pipes (as they would be from Node's child_process.spawn),
 * tcgetattr fails with ENXIO and tmux exits immediately with:
 *   "tcgetattr failed: Inappropriate ioctl for device"
 *
 * node-pty solves this in-process: it calls forkpty(), gives the slave fd to
 * tmux as its stdio, and exposes the master fd as a readable/writable stream.
 * Result: tmux sees a tty; we see a stream — no Python bridge needed.
 *
 * # Spawn invocation defaults
 *
 * Spawn invocation:
 *   - Socket: `-L <socketName>` (required; callers MUST supply a hermetic,
 *     workspace-unique name — there is no default to prevent accidental
 *     attachment to the user's interactive tmux server at `-L default`).
 *   - Session: starts a new session (`new-session`) named by `sessionName`
 *     (required); does NOT detach (`-d`) so the control client IS the session
 *     client.
 *   - Attach mode: if `attach: true`, runs `attach-session -t <sessionName>`
 *     instead (requires a server already running on the named socket).
 *
 * # API seam for sibling beads
 *
 *   tc-y6t (pipeline):   `onData(handler)`  — raw Uint8Array stdout chunks
 *   tc-fos (input):      `write(data)`      — stdin bytes/commands
 *   tc-mwf (pty/resize): `write(data)`      — resize escape sequences
 *   tc-1ho (flow ctrl):  `write` + lifecycle
 *   All beads:           `onExit`, `onError`, `stop`, `kill`, `pid`
 */
import { appendFileSync } from "node:fs";
// node-pty 1.1.0 — current stable release (2024-11-xx).
// Vendored for linux-x64: build/Release/pty.node (compiled from source;
// no linux prebuild in the 1.1.0 tarball — darwin/win32 only).
// tc-2x3.2 handles the full cross-platform prebuild matrix.
// Must be marked external in esbuild — the native .node module is loaded via
// relative paths from node-pty/lib/utils.js and cannot be bundled.
import * as pty from "node-pty";
// ---------------------------------------------------------------------------
// Wire trace (tc-3y8.9 forensics aid)
//
// When TMUXCC_WIRE_TRACE is set to a directory path, every byte written to
// tmux stdin (`>>>`) and every stdout chunk received (`<<<`) is appended to
//   <dir>/tmux-wire-<pid>-<session>.log
// with a millisecond timestamp.  This is the ground truth for command/reply/
// notification interleaving on the -CC stream — exactly the evidence needed
// for correlator-pairing investigations.  Zero cost when the env var is
// unset.  Chunks are JSON-escaped and capped so %output floods stay readable.
// ---------------------------------------------------------------------------
const WIRE_TRACE_DIR = process.env["TMUXCC_WIRE_TRACE"];
const WIRE_TRACE_CAP = 4_000;
function wireTrace(file, dir, data) {
    try {
        let text;
        if (typeof data === "string") {
            text = data;
        }
        else {
            text = new TextDecoder("utf8", { fatal: false }).decode(data);
        }
        let escaped = JSON.stringify(text);
        if (escaped.length > WIRE_TRACE_CAP) {
            escaped = `${escaped.slice(0, WIRE_TRACE_CAP)}…(+${escaped.length - WIRE_TRACE_CAP} chars)`;
        }
        appendFileSync(file, `${new Date().toISOString()} ${dir} ${escaped}\n`);
    }
    catch {
        // Tracing must never interfere with the host.
    }
}
// ---------------------------------------------------------------------------
// join/dirname for trace file path
// ---------------------------------------------------------------------------
import { join } from "node:path";
class TmuxHostImpl {
    opts;
    /** Wire-trace file path, or null when TMUXCC_WIRE_TRACE is unset. */
    _traceFile = null;
    _pty = null;
    _pid = undefined;
    _exited = false;
    _exitCode = null;
    _exitSignal = null;
    _started = false;
    _stopPromise = null;
    _dataHandlers = new Set();
    _exitHandlers = new Set();
    _errorHandlers = new Set();
    _stderrHandlers = new Set();
    constructor(opts) {
        this.opts = {
            socketName: opts.socketName,
            sessionName: opts.sessionName,
            attach: opts.attach ?? false,
            cwd: opts.cwd ?? process.cwd(),
            env: opts.env ?? {},
            tmuxPath: opts.tmuxPath ?? "tmux",
            args: opts.args ?? [],
            cols: opts.cols ?? 220,
            rows: opts.rows ?? 50,
        };
    }
    get pid() {
        return this._pid;
    }
    get exited() {
        return this._exited;
    }
    start() {
        if (this._started) {
            return Promise.resolve();
        }
        this._started = true;
        return new Promise((resolve, reject) => {
            const { socketName, sessionName, attach, tmuxPath, args, cwd, env, cols, rows } = this.opts;
            // Build the tmux subcommand args
            const tmuxArgs = ["-L", socketName, "-CC"];
            if (attach) {
                tmuxArgs.push("attach-session", "-t", sessionName);
            }
            else {
                tmuxArgs.push("new-session", "-s", sessionName);
            }
            tmuxArgs.push(...args);
            const mergedEnv = {
                ...process.env,
                // Provide a TERM so tmux doesn't complain about unknown terminal
                TERM: "xterm-256color",
                // Override with user env
                ...env,
            };
            // tc-4bv2: a control-mode client MUST NOT inherit an outer $TMUX /
            // $TMUX_PANE. tmuxcc always drives its own server on a private `-L`
            // socket, so an inherited $TMUX (e.g. the extension host itself running
            // inside a tmux session — common in CI/e2e and for tmux-native users)
            // makes `attach-session -CC` refuse with `%error … sessions should be
            // nested with care, unset $TMUX to force` followed immediately by
            // `%exit`. During bootstrap that `%exit` leaves the requery's in-flight
            // `list-*` slots unresolved, so `start()` never resolves and the
            // supervisor's READY wait times out (the "did not signal READY within
            // 30s" symptom for any pre-existing session — all-dead-pane sessions
            // are simply the case where the operator most often hits it). Stripping
            // these two vars makes the nested attach behave like a top-level one.
            delete mergedEnv["TMUX"];
            delete mergedEnv["TMUX_PANE"];
            if (WIRE_TRACE_DIR !== undefined && WIRE_TRACE_DIR !== "") {
                this._traceFile = join(WIRE_TRACE_DIR, `tmux-wire-${process.pid}-${sessionName.replace(/[^\w.-]/g, "_")}.log`);
            }
            let term;
            try {
                // node-pty spawns tmux with a real PTY via forkpty(3), satisfying
                // tmux's tcgetattr() requirement without a Python bridge.
                // encoding: null → onData fires with Buffer (raw bytes); we convert
                // to Uint8Array for the existing API contract.
                term = pty.spawn(tmuxPath, tmuxArgs, {
                    cols,
                    rows,
                    cwd,
                    env: mergedEnv,
                    encoding: null,
                });
            }
            catch (err) {
                const e = err instanceof Error ? err : new Error(String(err));
                this._emitError(e);
                reject(e);
                return;
            }
            this._pty = term;
            this._pid = term.pid;
            // ── tc-crnt.14 ── pty read-socket 'error' listener ──────────────────────
            //
            // node-pty's UnixTerminal installs ONE 'error' listener on the pty read
            // socket (its `_socket`).  That handler ignores EAGAIN and EIO (the benign
            // pty-close codes) but for ANY OTHER socket error it RE-THROWS unless a
            // SECOND 'error' listener exists:
            //
            //   if (this.listeners('error').length < 2) { throw err; }
            //   (node-pty/lib/unixTerminal.js)
            //
            // Because we wire `onData`/`onExit` (node-pty's EventEmitter2 façades) but
            // never registered a raw `'error'` listener, that count was always 1, so a
            // non-EAGAIN/non-EIO read fault during a teardown race under rapid
            // split/open churn (e.g. EBADF on the read fd as the tmux -CC child exits)
            // was RE-THROWN as an uncaughtException — and in the tc-2x3.3 collapsed
            // topology that exits the WHOLE server-proxy (one fault kills every
            // session it serves), surfacing as the intermittent
            // "server-proxy process crashed (exit code signal)" (tc-crnt.14).
            //
            // Registering a real `'error'` listener here (a) makes `listeners('error')`
            // ≥ 2 so node-pty stops re-throwing and (b) routes the fault into our
            // existing fail-loud `_emitError`/`onError` boundary, where the session's
            // error boundary reaps just THIS session and the server-proxy survives.
            // Same fault-isolation class as tc-9xf1 (EPIPE-proof stderr) and
            // tc-295a.21 (per-connection rejection catch): a single-pty fault must
            // never take the collapsed broker down.
            //
            // `IPty` does not type the legacy EventEmitter surface (`on`), but the
            // underlying node-pty Terminal forwards `on`/`listeners` to its socket
            // (node-pty/lib/terminal.js) — so this is sound at runtime.
            const ptyEmitter = term;
            ptyEmitter.on("error", (err) => {
                // Mirror node-pty's OWN benign-code classification: EAGAIN is a transient
                // read hiccup and EIO is the normal "child closed the pty" read error
                // (the `onExit` path already owns that transition).  Neither is a host
                // FAULT — surfacing them through onError would spuriously fire on every
                // clean close.  We ignore them here exactly as node-pty does; the value
                // of THIS listener for those codes is purely making `listeners('error')`
                // ≥ 2 so node-pty's handler does not re-throw a *different* error that
                // arrives while a benign one is in flight (the `< 2` guard is evaluated
                // per-emit).
                const code = err.code ?? "";
                if (code.includes("EAGAIN") || code.includes("EIO"))
                    return;
                // Any OTHER pty read-socket fault (e.g. EBADF during a teardown race
                // under rapid churn) is host-fatal: the -CC client's pty is unusable.
                // Mark exited (so a racing write() throws the friendly "after exit"
                // error instead of touching a dead fd) and surface through the error
                // boundary, where the session's onError handler reaps just THIS session.
                this._exited = true;
                this._emitError(err instanceof Error ? err : new Error(String(err)));
            });
            // node-pty's spawn is synchronous (forkpty + exec in-process).
            // By the time pty.spawn() returns without throwing, the process exists.
            resolve();
            term.onData((chunk) => {
                // With encoding: null, chunk arrives as a Buffer.
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
                const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
                if (this._traceFile !== null)
                    wireTrace(this._traceFile, "<<<", bytes);
                for (const handler of this._dataHandlers) {
                    try {
                        handler(bytes);
                    }
                    catch {
                        // Don't let handler errors crash the host
                    }
                }
            });
            term.onExit(({ exitCode, signal }) => {
                this._exited = true;
                this._exitCode = exitCode ?? null;
                // node-pty onExit gives signal as a number; convert to NodeJS signal name
                // format by mapping 0/undefined → null and letting the code stand otherwise.
                // Callers compare against null (no signal) or a non-null value.
                this._exitSignal = (signal !== undefined && signal !== 0) ? String(signal) : null;
                for (const handler of this._exitHandlers) {
                    try {
                        handler(this._exitCode, this._exitSignal);
                    }
                    catch {
                        // ignore
                    }
                }
            });
        });
    }
    write(data) {
        if (!this._started) {
            throw new Error("TmuxHost: write() called before start()");
        }
        if (this._exited) {
            throw new Error("TmuxHost: write() called after process has exited");
        }
        const term = this._pty;
        if (!term) {
            throw new Error("TmuxHost: pty not available");
        }
        if (this._traceFile !== null)
            wireTrace(this._traceFile, ">>>", data);
        if (typeof data === "string") {
            term.write(data);
        }
        else {
            // node-pty write() accepts string | Buffer
            term.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
        }
    }
    onData(handler) {
        this._dataHandlers.add(handler);
        return () => {
            this._dataHandlers.delete(handler);
        };
    }
    onExit(handler) {
        if (this._exited) {
            // Already exited — fire on next tick
            process.nextTick(() => handler(this._exitCode, this._exitSignal));
            return () => { };
        }
        this._exitHandlers.add(handler);
        return () => {
            this._exitHandlers.delete(handler);
        };
    }
    onError(handler) {
        this._errorHandlers.add(handler);
        return () => {
            this._errorHandlers.delete(handler);
        };
    }
    onStderr(handler) {
        // On Unix, node-pty merges stderr into the PTY stream; there is no
        // separate stderr fd. Register the handler for interface compatibility
        // but it will never fire (tmux -CC emits nothing to stderr on a clean run).
        this._stderrHandlers.add(handler);
        return () => {
            this._stderrHandlers.delete(handler);
        };
    }
    stop() {
        if (this._stopPromise) {
            return this._stopPromise;
        }
        if (this._exited) {
            return Promise.resolve();
        }
        if (!this._pty) {
            return Promise.resolve();
        }
        this._stopPromise = new Promise((resolve) => {
            if (this._exited) {
                resolve();
                return;
            }
            // Register exit listener before sending the command so we never miss the
            // exit event if tmux responds faster than the JS event loop tick.
            const onExited = () => {
                clearTimeout(timer);
                resolve();
            };
            this._exitHandlers.add(onExited);
            // Send `detach-client` as a proper -CC control command.  In control mode,
            // tmux reads lines from the PTY as commands; `detach-client` tells the
            // -CC client to detach gracefully, which produces `%exit` followed by a
            // clean exit(0).
            //
            // Why NOT Ctrl-D (\x04): tmux opens the PTY in RAW mode (no ICRNL, no
            // ISIG, no special-char processing), so \x04 is a literal data byte, not
            // an EOF signal.  The PTY master can never half-close either (POSIX does
            // not support half-close on PTY master fds), so there is no "stdin.end()"
            // equivalent here.  Writing \x04 causes tmux to ignore it silently, the
            // graceful path never completes, and EVERY stop() falls through the 3s
            // SIGKILL fallback below.
            try {
                this._pty?.write("detach-client\n");
            }
            catch {
                // already closed — fall through to SIGKILL
            }
            // 3 s SIGKILL is a genuine last-resort fallback (e.g. tmux is hung or
            // crashed before it can process the command).  The happy path exits in
            // tens of milliseconds and clears the timer via onExited above.
            const timer = setTimeout(() => {
                this._exitHandlers.delete(onExited);
                this.kill("SIGKILL");
                // Wait for the kill to land
                const killWait = () => resolve();
                this._exitHandlers.add(killWait);
                setTimeout(() => {
                    this._exitHandlers.delete(killWait);
                    resolve();
                }, 1000);
            }, 3000);
        });
        return this._stopPromise;
    }
    kill(signal = "SIGKILL") {
        if (this._exited || !this._pty) {
            return;
        }
        try {
            this._pty.kill(signal);
        }
        catch {
            // process may have already exited
        }
    }
    _emitError(err) {
        if (this._errorHandlers.size === 0) {
            // No handler registered — don't swallow, but don't crash either.
            // Emit as unhandled only if truly unhandled at the next tick.
            process.nextTick(() => {
                if (this._errorHandlers.size === 0) {
                    // Still no handler — emit to process
                    process.emit("uncaughtException", err);
                }
            });
            return;
        }
        for (const handler of this._errorHandlers) {
            try {
                handler(err);
            }
            catch {
                // ignore
            }
        }
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create a new TmuxHost.
 *
 * The host is NOT yet started. Call `host.start()` to spawn the process.
 *
 * Default spawn invocation:
 *   tmux -L <socketName> -CC new-session -s <sessionName>
 *
 * Spawned via node-pty (forkpty + exec), which gives tmux a real PTY fd on
 * its stdin/stdout — satisfying tmux's tcgetattr() requirement (tc-2x3.1).
 *
 * @example
 * ```ts
 * const host = createTmuxHost({ socketName: "myapp", sessionName: "main" });
 * host.onData(chunk => parser.push(chunk));
 * host.onExit((code, signal) => console.log("tmux exited", code, signal));
 * host.onError(err => console.error("tmux error", err));
 * await host.start();
 * host.write("list-sessions\n");
 * // ... later ...
 * await host.stop();
 * ```
 */
export function createTmuxHost(opts) {
    return new TmuxHostImpl(opts);
}
//# sourceMappingURL=tmux-host.js.map