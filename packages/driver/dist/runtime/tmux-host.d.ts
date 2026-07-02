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
/** Options for creating a TmuxHost. */
export interface TmuxHostOptions {
    /**
     * Private tmux socket name. tmux will be launched with `-L <socketName>`,
     * isolating it from the user's existing tmux servers.
     *
     * Required — no default. Callers MUST supply a hermetic, workspace-unique
     * socket name (e.g. via `tmuxccSocketName(workspaceId)`). There is no
     * fallback; omitting this field is a compile error.
     */
    socketName: string;
    /**
     * tmux session name. Used as `-s <sessionName>` for new-session or
     * `-t <sessionName>` for attach.
     *
     * Required — no default. Callers MUST supply an explicit session name.
     */
    sessionName: string;
    /**
     * If true, attach to an existing session instead of creating a new one.
     * Requires a server to already be running on the named socket.
     * Default: false (creates a new session)
     */
    attach?: boolean;
    /**
     * Working directory for the tmux process.
     * Default: process.cwd()
     */
    cwd?: string;
    /**
     * Environment variables for tmux. Merged with (and overrides) process.env.
     * Default: process.env
     */
    env?: Record<string, string>;
    /**
     * Path to the tmux binary.
     * Default: "tmux" (resolved via PATH)
     */
    tmuxPath?: string;
    /**
     * Extra arguments appended after the tmux subcommand (new-session or attach).
     * Rarely needed — use for custom session configs.
     */
    args?: string[];
    /**
     * Dimensions reported to the PTY. tmux may use these for layout.
     * Defaults: cols=220, rows=50 (wide default to avoid wrap in control output)
     */
    cols?: number;
    rows?: number;
}
/** Handler type for stdout data. Returns an unsubscribe function. */
export type DataHandler = (chunk: Uint8Array) => void;
/** Handler type for process exit. Returns an unsubscribe function. */
export type ExitHandler = (code: number | null, signal: string | null) => void;
/** Handler type for errors. Returns an unsubscribe function. */
export type ErrorHandler = (err: Error) => void;
/**
 * TmuxHost — manages the lifecycle and I/O of a `tmux -CC` child process.
 *
 * Lifecycle:
 *   createTmuxHost(opts) → TmuxHost (not yet started)
 *   host.start()         → spawns the process; resolves when spawn succeeds
 *   host.write(data)     → sends bytes to tmux stdin (commands, keystrokes)
 *   host.stop()          → graceful shutdown (close stdin, wait for exit)
 *   host.kill(signal)    → forceful termination
 *
 * Events (register before or after start()):
 *   host.onData(fn)      → called with each raw Uint8Array chunk from stdout
 *   host.onExit(fn)      → called once when the process exits
 *   host.onError(fn)     → called on spawn error or stream error
 *   host.onStderr(fn)    → called with each stderr chunk (diagnostics)
 */
export interface TmuxHost {
    /** Spawn the tmux process. Resolves when the child has been started. */
    start(): Promise<void>;
    /**
     * Write bytes or a string command to tmux's stdin.
     * String commands are UTF-8 encoded. Typically a tmux command followed by \n.
     * Throws if the host has not been started or has already exited.
     */
    write(data: string | Uint8Array | Buffer): void;
    /**
     * Register a handler for raw stdout bytes from tmux.
     * Chunks are Uint8Array (raw, not decoded to string — may contain non-UTF-8).
     * Returns an unsubscribe function.
     * Safe to call before start().
     */
    onData(handler: DataHandler): () => void;
    /**
     * Register a handler for process exit.
     * Returns an unsubscribe function.
     * If the process has already exited, the handler is called synchronously
     * on the next tick with the stored exit code/signal.
     */
    onExit(handler: ExitHandler): () => void;
    /**
     * Register a handler for errors (spawn failure, stream errors).
     * Returns an unsubscribe function.
     */
    onError(handler: ErrorHandler): () => void;
    /**
     * Register a handler for stderr output from tmux.
     * Returns an unsubscribe function. Mostly for diagnostics.
     * Note: node-pty merges stderr into the PTY stream on Unix; this handler
     * fires for stderr-like content embedded in the PTY output when discernible.
     * In practice tmux -CC writes nothing to stderr on a clean run.
     */
    onStderr(handler: DataHandler): () => void;
    /**
     * Graceful stop: sends `detach-client` as a -CC control command, which
     * causes tmux to emit `%exit` and exit cleanly with code 0.
     * Falls back to SIGKILL after 3 seconds if tmux does not respond.
     * Idempotent — safe to call multiple times.
     */
    stop(): Promise<void>;
    /**
     * Forceful kill. Sends the given signal (default: SIGKILL) to the process.
     * Idempotent — no-ops if already exited.
     */
    kill(signal?: NodeJS.Signals): void;
    /**
     * PID of the tmux process.
     * Undefined before start() resolves.
     */
    readonly pid: number | undefined;
    /**
     * True if the process has exited (or was never started).
     * False while running.
     */
    readonly exited: boolean;
}
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
export declare function createTmuxHost(opts: TmuxHostOptions): TmuxHost;
//# sourceMappingURL=tmux-host.d.ts.map