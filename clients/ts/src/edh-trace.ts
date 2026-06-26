// ---------------------------------------------------------------------------
// EDH-side instrument trace (tc-jlyi.7)
//
// The @tmuxcc/client modules (mirror, input, connection) run INSIDE the VS Code
// extension host (EDH) process, where they have NO VS Code OutputChannel. Like
// the broker's tc-is5w `phaseLog`, this writes one structured line per hop to
// `process.stderr`, tagged `[tc-jlyi.7]`, gated by the SAME `TMUXCC_PHASE_TIMING`
// env var. When the var is unset the helper is a no-op — a single boolean check,
// no allocation, no clock read, no write — so the default build is byte-identical.
//
// Channel: these lines land in the EDH PROCESS stderr (capturable by the repro
// harness), the EDH-side companion to the broker's server-proxy.log. They are
// deliberately NOT on the extension's "tmuxcc" OutputChannel: the client library
// has no handle to it, and threading one through `connectClient` → `Mirror` /
// `createInputApi` would be an invasive DI seam for a dev-only instrument. The
// higher EDH hops that DO sit in the vscode extension (verb dispatch / result /
// model-apply / tree-fire) use the OutputChannel; these wire/mirror hops use
// stderr. Correlation is by the wire `correlationId` (verb hops) and the
// per-connection control `seq` (mirror hops), which both channels carry.
//
// FILE SINK (tc-jlyi.9): when TMUXCC_PHASE_TIMING=1, the EDH also writes these
// lines to a file (`<runtimeDir>/<socketName>/edh-trace.log`) so the reaper's
// secondary *.log sweep preserves them alongside the broker log. The file sink
// is opened by the VS Code extension host via `openEdhTraceLog(path)` at
// activation time; the client lib's `edhTrace` appends to it transparently.
// When the flag is unset the file is never opened and no I/O occurs (the
// `_edhTraceLogFd === null` guard is a single null-check, no allocation).
// ---------------------------------------------------------------------------

import * as fs from "node:fs";

/** True when TMUXCC_PHASE_TIMING is set to a non-empty value. Read once. */
export const EDH_TRACE_ENABLED: boolean =
  (process.env["TMUXCC_PHASE_TIMING"] ?? "") !== "";

/** A field value for a trace line. `undefined` keys are omitted. */
export type EdhTraceFields = Record<string, string | number | boolean | undefined>;

// ---------------------------------------------------------------------------
// File sink (tc-jlyi.9) — opened by the VS Code extension host on activation
// ---------------------------------------------------------------------------

/** Module-level file descriptor for the EDH trace log. null = not open. */
let _edhTraceLogFd: number | null = null;

/**
 * Open (or create) the EDH trace log for appending.
 *
 * Called once from the VS Code extension host when TMUXCC_PHASE_TIMING=1,
 * with the path `<runtimeDir>/<socketName>/edh-trace.log`. No-op when phase
 * timing is disabled (EDH_TRACE_ENABLED=false) — guarantees no file I/O when
 * the flag is unset. Never throws.
 */
export function openEdhTraceLog(filePath: string): void {
  if (!EDH_TRACE_ENABLED) return;
  try {
    _edhTraceLogFd = fs.openSync(filePath, "a");
  } catch {
    // Fail-soft: if the file cannot be opened (permissions, path missing),
    // the trace continues on stderr only. Never perturb the host.
  }
}

/**
 * Close the EDH trace log file descriptor opened by `openEdhTraceLog`.
 *
 * Called on extension deactivation (via `context.subscriptions`). No-op when
 * the file was never opened. Never throws.
 */
export function closeEdhTraceLog(): void {
  if (_edhTraceLogFd === null) return;
  try {
    fs.closeSync(_edhTraceLogFd);
  } catch {
    // Fail-soft.
  }
  _edhTraceLogFd = null;
}

/**
 * Append a single line to the EDH trace log file (no-op when not open).
 *
 * Used by both the client-lib `edhTrace` path (mirror hops) and the extension
 * host's verb/tree-fire/lag hops (which build the same `[tc-jlyi.7]` line and
 * call this directly). Never throws — instrumentation must not perturb the host.
 */
export function edhFileAppend(line: string): void {
  if (_edhTraceLogFd === null) return;
  try {
    fs.writeSync(_edhTraceLogFd, `${line}\n`);
  } catch {
    // Fail-soft.
  }
}

/**
 * Emit one `[tc-jlyi.7]` hop line to the EDH process stderr. No-op when phase
 * timing is disabled. Never throws — instrumentation must not perturb the host.
 *
 * Also appends to the EDH trace log file when it has been opened via
 * `openEdhTraceLog` (tc-jlyi.9), so the reaper preserves these lines
 * alongside the broker log in `test/e2e/trace/`.
 */
export function edhTrace(fields: EdhTraceFields): void {
  if (!EDH_TRACE_ENABLED) return;
  try {
    let line = "[tc-jlyi.7]";
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      line += ` ${key}=${value}`;
    }
    process.stderr.write(`${line}\n`);
    edhFileAppend(line);
  } catch {
    // Instrumentation must never interfere with the client.
  }
}
