/**
 * Die-with-parent enforcement for the session-proxy (sessionProxy) process (tc-2c5).
 *
 * # Why explicit enforcement
 *
 * The session-proxy is spawned as a regular (non-detached) child of the serverProxy, but
 * process-group mechanics alone do NOT guarantee it dies with the serverProxy: when
 * a parent is SIGKILLed, its children are silently reparented to init (or the
 * nearest subreaper) and receive NO signal.  The orphan session-proxy-entry processes
 * found in the 2026-06-08 debug session are evidence of exactly this gap.
 *
 * Per the component-lifetime model (ext-a-design-context.md §6.3) there is no
 * orphan-and-reclaim path: tmux is the only persistence layer and the session-proxy
 * holds no state worth preserving.  Recovery from server-proxy death is: client
 * launcher respawns a fresh server-proxy → fresh server-proxy spawns fresh session-proxies on the
 * next `session.claim` → fresh `-CC attach` to the surviving tmux sessions.
 *
 * # Mechanism: getppid() poll (both platforms)
 *
 * The spec'd Linux mechanism is `prctl(PR_SET_PDEATHSIG, SIGTERM)`, but Node
 * has no prctl primitive and adding a native addon for one syscall is heavier
 * than the bug it fixes.  tc-2c5 explicitly blesses the dependency-free
 * fallback on Linux too: poll `getppid()` every second and treat reparenting
 * as parent death.  Detection latency is bounded by one poll interval (≤ 1 s
 * with defaults), comfortably inside the 3 s budget asserted by the tests.
 *
 * Reparenting is detected as "ppid changed since install", not "ppid == 1":
 * a process's parent pid cannot change while the parent is alive, and the
 * orphan's new parent is init (pid 1) on a classic system but may be a
 * subreaper (systemd user manager, container init) elsewhere.  Comparing
 * against the initial ppid covers both; checking for 1 would miss subreapers
 * and recreate the orphan bug in containers.
 *
 * # Default action on parent death
 *
 * Mirror PDEATHSIG semantics: send SIGTERM to ourselves so the entry point's
 * existing graceful-shutdown handler runs (detach `-CC` client, close the
 * unix socket, remove the socket file).  An unref'd hard-exit backstop timer
 * guarantees the process exits even if graceful shutdown stalls; with default
 * timings worst-case total is poll (≤ 1 s) + grace (1.5 s) < 3 s.
 *
 * @module runtime/die-with-parent
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for installDieWithParent. */
export interface DieWithParentOptions {
  /**
   * Poll interval for the getppid() check, in milliseconds.
   * Default: 1000 (the §6.3-specified 1 s cadence).
   */
  pollIntervalMs?: number;

  /**
   * In default mode (no `onParentDeath`): how long after self-SIGTERM to wait
   * before hard-exiting via process.exit(0), in milliseconds.  This bounds the
   * session-proxy's lifetime even if the graceful SIGTERM path stalls (e.g. a hung
   * tmux client).  Default: 1500.
   */
  graceMs?: number;

  /**
   * Custom action on parent death.  When provided, it REPLACES the default
   * self-SIGTERM + hard-exit backstop entirely — the caller owns process exit.
   * Intended for tests; production entry points should rely on the default.
   */
  onParentDeath?: () => void;

  /**
   * Testing seam: how to read the current parent pid.
   * Default: `() => process.ppid`.
   */
  getPpid?: () => number;
}

// ---------------------------------------------------------------------------
// installDieWithParent
// ---------------------------------------------------------------------------

/**
 * Install the die-with-parent watchdog.  Call once, at process startup,
 * BEFORE any long-running work (the entry point's first statement is ideal —
 * a session-proxy that crashes later still had the watchdog from t=0).
 *
 * The poll timer is unref'd so the watchdog never keeps an otherwise-finished
 * process alive.
 *
 * @returns an uninstall function that stops the watchdog (no-op after parent
 *   death has already been detected — at that point exit is already in
 *   flight in default mode).
 */
export function installDieWithParent(opts: DieWithParentOptions = {}): () => void {
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const graceMs = opts.graceMs ?? 1500;
  const getPpid = opts.getPpid ?? (() => process.ppid);

  const initialPpid = getPpid();
  let fired = false;

  const timer = setInterval(() => {
    if (fired) return;
    if (getPpid() === initialPpid) return;

    // Parent is gone (we were reparented to init/launchd/a subreaper).
    fired = true;
    clearInterval(timer);

    if (opts.onParentDeath !== undefined) {
      // Custom handler owns exit semantics (test seam).
      opts.onParentDeath();
      return;
    }

    // Default: mirror PDEATHSIG — deliver SIGTERM to ourselves so the entry
    // point's graceful-shutdown handler runs...
    const backstop = setTimeout(() => {
      process.exit(0);
    }, graceMs);
    backstop.unref(); // ...but never let a stalled handler keep us alive.
    process.kill(process.pid, "SIGTERM");
  }, pollIntervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
