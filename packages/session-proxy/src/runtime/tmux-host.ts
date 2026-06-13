/**
 * tmux -CC subprocess host (tc-kyp).
 *
 * Spawns and owns a `tmux -CC` child process via a Python PTY bridge that
 * satisfies tmux's tcgetattr() requirement without adding a native Node addon.
 *
 * # Why a PTY bridge?
 *
 * tmux's control-mode client calls tcgetattr() on its stdin/stdout at startup.
 * When those fds are plain pipes (as they would be from Node's child_process.spawn),
 * tcgetattr fails with ENXIO and tmux exits immediately with:
 *   "tcgetattr failed: Inappropriate ioctl for device"
 *
 * The bridge script (tmux-pty-bridge.py, a sibling of this file) allocates a
 * POSIX PTY pair, spawns tmux with the slave end, and bridges the master end
 * to its own stdin/stdout — which ARE plain pipes to our Node process.
 * Result: tmux sees a tty; we see a pipe.
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

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
   * Path to the Python interpreter used for the PTY bridge.
   * Default: "python3"
   */
  pythonPath?: string;

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
   * Register a handler for stderr output from tmux or the bridge.
   * Returns an unsubscribe function. Mostly for diagnostics.
   */
  onStderr(handler: DataHandler): () => void;

  /**
   * Graceful stop: close stdin (sends EOF to tmux, triggering %exit),
   * then wait for the process to exit.
   * Idempotent — safe to call multiple times.
   */
  stop(): Promise<void>;

  /**
   * Forceful kill. Sends the given signal (default: SIGKILL) to the process.
   * Idempotent — no-ops if already exited.
   */
  kill(signal?: NodeJS.Signals): void;

  /**
   * PID of the bridge process (not the inner tmux pid).
   * Undefined before start() resolves.
   */
  readonly pid: number | undefined;

  /**
   * True if the process has exited (or was never started).
   * False while running.
   */
  readonly exited: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// tmux-pty-bridge.py lives in src/runtime/ — a direct sibling of this module —
// NOT under fixtures/ (it is production runtime code on the hot path of every
// keystroke, not a test artifact; tc-nkz). Sibling placement is load-bearing:
// the script is resolved relative to the module that spawns it, and that
// resolution must hold in BOTH dist layouts —
//   - session-proxy standalone: dist/runtime/tmux-host.js → dist/runtime/tmux-pty-bridge.py
//     (the build step copies it there),
//   - vscode bundle: import.meta.url collapses to the single bundle file
//     (dist/extension.cjs / dist/session-proxy-entry.js) → dist/tmux-pty-bridge.py
//     (the extension's esbuild step copies it there).
// A separate src/bridge/ home would need a `../bridge` hop that escapes dist/
// in the flattened bundle, so the flat sibling is the cleaner invariant.
const BRIDGE_SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "tmux-pty-bridge.py",
);

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

function wireTrace(file: string, dir: ">>>" | "<<<", data: string | Uint8Array | Buffer): void {
  try {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else {
      text = new TextDecoder("utf8", { fatal: false }).decode(data);
    }
    let escaped = JSON.stringify(text);
    if (escaped.length > WIRE_TRACE_CAP) {
      escaped = `${escaped.slice(0, WIRE_TRACE_CAP)}…(+${escaped.length - WIRE_TRACE_CAP} chars)`;
    }
    appendFileSync(file, `${new Date().toISOString()} ${dir} ${escaped}\n`);
  } catch {
    // Tracing must never interfere with the host.
  }
}

class TmuxHostImpl implements TmuxHost {
  private readonly opts: Required<TmuxHostOptions>;

  /** Wire-trace file path, or null when TMUXCC_WIRE_TRACE is unset. */
  private _traceFile: string | null = null;

  private _proc: ChildProcess | null = null;
  private _pid: number | undefined = undefined;
  private _exited = false;
  private _exitCode: number | null = null;
  private _exitSignal: string | null = null;
  private _started = false;
  private _stopPromise: Promise<void> | null = null;

  private readonly _dataHandlers = new Set<DataHandler>();
  private readonly _exitHandlers = new Set<ExitHandler>();
  private readonly _errorHandlers = new Set<ErrorHandler>();
  private readonly _stderrHandlers = new Set<DataHandler>();

  constructor(opts: TmuxHostOptions) {
    this.opts = {
      socketName: opts.socketName,
      sessionName: opts.sessionName,
      attach: opts.attach ?? false,
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? {},
      tmuxPath: opts.tmuxPath ?? "tmux",
      args: opts.args ?? [],
      pythonPath: opts.pythonPath ?? "python3",
      cols: opts.cols ?? 220,
      rows: opts.rows ?? 50,
    };
  }

  get pid(): number | undefined {
    return this._pid;
  }

  get exited(): boolean {
    return this._exited;
  }

  start(): Promise<void> {
    if (this._started) {
      return Promise.resolve();
    }
    this._started = true;

    return new Promise<void>((resolve, reject) => {
      const { socketName, sessionName, attach, tmuxPath, pythonPath, args, cwd, env, cols, rows } =
        this.opts;

      // Build the tmux subcommand args
      const tmuxArgs: string[] = [tmuxPath, "-L", socketName, "-CC"];
      if (attach) {
        tmuxArgs.push("attach-session", "-t", sessionName);
      } else {
        tmuxArgs.push("new-session", "-s", sessionName);
      }
      tmuxArgs.push(...args);

      // Bridge invocation: python3 <bridge_script> <tmux-args...>
      const bridgeArgs = [BRIDGE_SCRIPT_PATH, ...tmuxArgs];

      const mergedEnv: Record<string, string> = {
        ...process.env,
        // Provide a TERM so tmux doesn't complain about unknown terminal
        TERM: "xterm-256color",
        // Override with user env
        ...env,
        // PTY dimensions as env vars that the bridge can set via stty
        COLUMNS: String(cols),
        LINES: String(rows),
      } as Record<string, string>;

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

      const proc = spawn(pythonPath, bridgeArgs, {
        cwd,
        env: mergedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this._proc = proc;

      let spawned = false;

      proc.on("spawn", () => {
        spawned = true;
        this._pid = proc.pid;
        resolve();
      });

      proc.on("error", (err) => {
        if (!spawned) {
          // Spawn failed — reject start() and fire error handlers
          reject(err);
        }
        this._emitError(err);
      });

      if (WIRE_TRACE_DIR !== undefined && WIRE_TRACE_DIR !== "") {
        this._traceFile = join(
          WIRE_TRACE_DIR,
          `tmux-wire-${process.pid}-${sessionName.replace(/[^\w.-]/g, "_")}.log`,
        );
      }

      proc.stdout!.on("data", (chunk: Buffer) => {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (this._traceFile !== null) wireTrace(this._traceFile, "<<<", bytes);
        for (const handler of this._dataHandlers) {
          try {
            handler(bytes);
          } catch (e) {
            // Don't let handler errors crash the host
          }
        }
      });

      proc.stdout!.on("error", (err) => {
        this._emitError(err);
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        if (this._stderrHandlers.size > 0) {
          const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          for (const handler of this._stderrHandlers) {
            try {
              handler(bytes);
            } catch (e) {
              // ignore
            }
          }
        }
      });

      proc.stderr!.on("error", (err) => {
        this._emitError(err);
      });

      proc.on("close", (code, signal) => {
        this._exited = true;
        this._exitCode = code;
        this._exitSignal = signal;
        for (const handler of this._exitHandlers) {
          try {
            handler(code, signal);
          } catch (e) {
            // ignore
          }
        }
      });
    });
  }

  write(data: string | Uint8Array | Buffer): void {
    if (!this._started) {
      throw new Error("TmuxHost: write() called before start()");
    }
    if (this._exited) {
      throw new Error("TmuxHost: write() called after process has exited");
    }
    const proc = this._proc;
    if (!proc || !proc.stdin) {
      throw new Error("TmuxHost: stdin not available");
    }

    if (this._traceFile !== null) wireTrace(this._traceFile, ">>>", data);

    if (typeof data === "string") {
      proc.stdin.write(data, "utf8");
    } else {
      proc.stdin.write(data);
    }
  }

  onData(handler: DataHandler): () => void {
    this._dataHandlers.add(handler);
    return () => {
      this._dataHandlers.delete(handler);
    };
  }

  onExit(handler: ExitHandler): () => void {
    if (this._exited) {
      // Already exited — fire on next tick
      process.nextTick(() => handler(this._exitCode, this._exitSignal));
      return () => {};
    }
    this._exitHandlers.add(handler);
    return () => {
      this._exitHandlers.delete(handler);
    };
  }

  onError(handler: ErrorHandler): () => void {
    this._errorHandlers.add(handler);
    return () => {
      this._errorHandlers.delete(handler);
    };
  }

  onStderr(handler: DataHandler): () => void {
    this._stderrHandlers.add(handler);
    return () => {
      this._stderrHandlers.delete(handler);
    };
  }

  stop(): Promise<void> {
    if (this._stopPromise) {
      return this._stopPromise;
    }
    if (this._exited) {
      return Promise.resolve();
    }
    if (!this._proc) {
      return Promise.resolve();
    }

    this._stopPromise = new Promise<void>((resolve) => {
      if (this._exited) {
        resolve();
        return;
      }

      // Listen for exit
      const cleanup = () => resolve();
      this._exitHandlers.add(cleanup);

      // Close stdin to signal EOF to the bridge → tmux gets SIGHUP/detach
      try {
        this._proc?.stdin?.end();
      } catch {
        // already closed
      }

      // Give it 3 seconds to exit gracefully, then SIGKILL
      const timer = setTimeout(() => {
        this._exitHandlers.delete(cleanup);
        this.kill("SIGKILL");
        // Wait for the kill to land
        const killWait = () => resolve();
        this._exitHandlers.add(killWait);
        setTimeout(() => {
          this._exitHandlers.delete(killWait);
          resolve();
        }, 1000);
      }, 3000);

      // If it exits before the timer, cancel the timer
      const origCleanup = cleanup;
      this._exitHandlers.delete(cleanup);
      this._exitHandlers.add(() => {
        clearTimeout(timer);
        origCleanup();
      });
    });

    return this._stopPromise;
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (this._exited || !this._proc) {
      return;
    }
    try {
      this._proc.kill(signal);
    } catch {
      // process may have already exited
    }
  }

  private _emitError(err: Error): void {
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
      } catch {
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
 *   python3 <bridge> tmux -L <socketName> -CC new-session -s <sessionName>
 *
 * where <bridge> is tmux-pty-bridge.py (bundled alongside this file).
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
export function createTmuxHost(opts: TmuxHostOptions): TmuxHost {
  return new TmuxHostImpl(opts);
}

// ---------------------------------------------------------------------------
// Convenience: path to the bridge script (for tests that want to bundle it)
// ---------------------------------------------------------------------------
export { BRIDGE_SCRIPT_PATH };
