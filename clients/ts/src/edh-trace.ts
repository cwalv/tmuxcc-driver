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
// ---------------------------------------------------------------------------

/** True when TMUXCC_PHASE_TIMING is set to a non-empty value. Read once. */
export const EDH_TRACE_ENABLED: boolean =
  (process.env["TMUXCC_PHASE_TIMING"] ?? "") !== "";

/** A field value for a trace line. `undefined` keys are omitted. */
export type EdhTraceFields = Record<string, string | number | boolean | undefined>;

/**
 * Emit one `[tc-jlyi.7]` hop line to the EDH process stderr. No-op when phase
 * timing is disabled. Never throws — instrumentation must not perturb the host.
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
  } catch {
    // Instrumentation must never interfere with the client.
  }
}
