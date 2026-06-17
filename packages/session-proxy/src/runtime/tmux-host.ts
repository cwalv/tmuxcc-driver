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
import type { IPty } from "node-pty";

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

// ---------------------------------------------------------------------------
// join/dirname for trace file path
// ---------------------------------------------------------------------------
import { join } from "node:path";

class TmuxHostImpl implements TmuxHost {
  private readonly opts: Required<TmuxHostOptions>;

  /** Wire-trace file path, or null when TMUXCC_WIRE_TRACE is unset. */
  private _traceFile: string | null = null;

  private _pty: IPty | null = null;
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
      const { socketName, sessionName, attach, tmuxPath, args, cwd, env, cols, rows } =
        this.opts;

      // Build the tmux subcommand args
      const tmuxArgs: string[] = ["-L", socketName, "-CC"];
      if (attach) {
        tmuxArgs.push("attach-session", "-t", sessionName);
      } else {
        tmuxArgs.push("new-session", "-s", sessionName);
      }
      tmuxArgs.push(...args);

      const mergedEnv: Record<string, string> = {
        ...process.env,
        // Provide a TERM so tmux doesn't complain about unknown terminal
        TERM: "xterm-256color",
        // Override with user env
        ...env,
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

      if (WIRE_TRACE_DIR !== undefined && WIRE_TRACE_DIR !== "") {
        this._traceFile = join(
          WIRE_TRACE_DIR,
          `tmux-wire-${process.pid}-${sessionName.replace(/[^\w.-]/g, "_")}.log`,
        );
      }

      let term: IPty;
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
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this._emitError(e);
        reject(e);
        return;
      }

      this._pty = term;
      this._pid = term.pid;

      // node-pty's spawn is synchronous (forkpty + exec in-process).
      // By the time pty.spawn() returns without throwing, the process exists.
      resolve();

      term.onData((chunk: string | Buffer) => {
        // With encoding: null, chunk arrives as a Buffer.
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, "utf8");
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        if (this._traceFile !== null) wireTrace(this._traceFile, "<<<", bytes);
        for (const handler of this._dataHandlers) {
          try {
            handler(bytes);
          } catch {
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
          } catch {
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
    const term = this._pty;
    if (!term) {
      throw new Error("TmuxHost: pty not available");
    }

    if (this._traceFile !== null) wireTrace(this._traceFile, ">>>", data);

    if (typeof data === "string") {
      term.write(data);
    } else {
      // node-pty write() accepts string | Buffer
      term.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
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
    // On Unix, node-pty merges stderr into the PTY stream; there is no
    // separate stderr fd. Register the handler for interface compatibility
    // but it will never fire (tmux -CC emits nothing to stderr on a clean run).
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
    if (!this._pty) {
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

      // Send Ctrl-D (EOF) to the PTY master — tmux receives it on its stdin
      // and exits cleanly (%exit). This mirrors the python bridge's stdin.end().
      try {
        this._pty?.write("\x04");
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
    if (this._exited || !this._pty) {
      return;
    }
    try {
      this._pty.kill(signal);
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
export function createTmuxHost(opts: TmuxHostOptions): TmuxHost {
  return new TmuxHostImpl(opts);
}
