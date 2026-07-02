/**
 * @tmuxcc/driver — public API.
 *
 * The driver is the Node-only tmux control-mode runtime: the per-socket
 * server-proxy (discovery + lifecycle) plus the per-session session-proxy
 * (parser → state → wire) that it hosts in-process.
 *
 * Wire types and framing live in @tmuxcc/protocol and are NOT re-exported here —
 * consumers import wire types from @tmuxcc/protocol directly and runtime from
 * @tmuxcc/driver.
 */

// Placeholder export retained so the historical index.test.ts compiles.
export const SESSION_PROXY_PLACEHOLDER = true;

/** Stub type: minimal session-proxy handle shape. */
export interface SessionProxyHandle {
  readonly pid: number;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Session-proxy runtime (parser → state → wire)
// ---------------------------------------------------------------------------

// State model + projection — exported so client tests can run round-trip proofs
// (applySnapshot(prev) + diffModel(prev, next) == applySnapshot(next)).
export type {
  SessionModel,
  Session,
  Window,
  Pane,
  FocusState,
  PaneMode,
  WindowLayout,
  ScrollbackHandle,
  InvariantViolation,
  CheckInvariantsOptions,
} from "./state/index.js";
export {
  emptyModel,
  addSession,
  removeSession,
  updateSession,
  addWindow,
  removeWindow,
  updateWindow,
  addPane,
  removePane,
  updatePane,
  setFocus,
  checkInvariants,
  scrollbackHandle,
} from "./state/index.js";
// Projection functions for client round-trip tests:
export { projectSnapshot, diffModel } from "./state/projection.js";
export type { ProjectSnapshotOpts, DiffOptions, OriginLookup, CloseCauseLookup } from "./state/projection.js";
// tc-4b6k.2 (D3): per-(pane,client) binding-intent option-name derivation —
// used by the server-proxy's observed-session topology read (tmux-south.ts) to
// resolve the requesting client's own binding slot.
export { paneBoundOptionName, TMUXCC_BOUND_OPTION } from "./state/bootstrap.js";

// Verb-origin registry (tc-ozk.2) — re-exported so the SDK test harness
// (clients/ts, tc-ozk.4) can seed origin attribution when replaying conformance
// transcripts against the REAL session-proxy (createControlServer + originLookup).
export { createVerbOriginRegistry } from "./runtime/verb-origin.js";
export type {
  VerbOriginRegistry,
  VerbOriginRegistryOptions,
} from "./runtime/verb-origin.js";

// Close-cause registry (tc-u7cu.6) — re-exported so tests can seed close-cause
// attribution when testing pane.closed cause stamping.
export { createCloseCauseRegistry } from "./runtime/close-cause.js";
export type {
  CloseCauseRegistry,
  CloseCauseRegistryOptions,
} from "./runtime/close-cause.js";

// Runtime — createSessionProxy and supporting types (tc-93a).
export { createSessionProxy } from "./runtime/session-proxy.js";
export type { SessionProxy, SessionProxyOptions, SessionProxyHostView, SessionProxyAddClientOptions } from "./runtime/session-proxy.js";
// createTmuxHost — the server-proxy's thin `-CC` watcher must hold a LIVE
// control-mode connection; tmux's client calls tcgetattr() on stdin even in
// control mode, so the watcher needs the same PTY bridge the session-proxy uses.
export { createTmuxHost } from "./runtime/tmux-host.js";
export type { TmuxHost, TmuxHostOptions } from "./runtime/tmux-host.js";

// Flow-control + output-demux primitives — exported so tc-7xv.6/tc-7xv.24
// regression tests can drive a real SocketTransport through the same
// session-proxy-side wiring without booting a full SessionProxy.
export {
  createOutputDemux,
} from "./runtime/output-demux.js";
export type { OutputDemux, OutputDemuxOptions } from "./runtime/output-demux.js";
export {
  createFlowController,
  DEFAULT_HIGH_WATER_BYTES,
  DEFAULT_LOW_WATER_BYTES,
} from "./runtime/flow-control.js";
export type { FlowController, FlowControllerOptions } from "./runtime/flow-control.js";
// CommandResult is the resolved shape of `pipeline.send` / `correlator.send`.
export type { CommandResult } from "./parser/correlator.js";

// Control server — re-exported so Layer A tests in @tmuxcc/client can
// instantiate ControlServer without reaching into internal sub-paths.
export { createControlServer } from "./runtime/serve.js";
export type {
  ControlServer,
  ControlServerOptions,
} from "./runtime/serve.js";
export type { RuntimePipeline, PaneNotifyEmission, PaneNotifyHandler } from "./runtime/pipeline.js";

// tc-is5w: dev-gated phase-split activation timing. Shared so the server-proxy
// (server-proxy._doClaimSession) and the session-proxy legs emit a uniform
// `[tc-is5w]` line under TMUXCC_PHASE_TIMING. Inert when the var is unset.
export { phaseLog, phaseNow, PHASE_TIMING_ENABLED } from "./runtime/phase-timing.js";
export type { PhaseFields } from "./runtime/phase-timing.js";

// tc-x6l: metrics + storm alarm.
export { createSessionProxyRegistry, createStormAlarm } from "./metrics/index.js";
export type {
  SessionProxyRegistry,
  StormAlarm,
  StormAlarmOptions,
  KindBreakdown,
} from "./metrics/index.js";

// ---------------------------------------------------------------------------
// Server-proxy runtime (per-socket discovery + lifecycle)
// ---------------------------------------------------------------------------

// Primary entry point: `createServerProxy({ socketName, runtimeDir? })`.
export { createServerProxy, ServerProxyAlreadyRunningError } from "./server-proxy.js";
export type { ServerProxyHandle, ServerProxyOptions, ServerProxySelfExitReason } from "./server-proxy.js";

// Socket transport utilities (useful for clients / tests)
export { createSocketTransport, connectSocketTransport, createSocketServer } from "./socket-transport.js";

// Runtime directory helpers (useful for clients that need to compute socket paths)
export { serverProxySocketPath, serverProxyLogPath, edhTraceLogPath, resolveBaseRuntimeDir, gcStaleRuntimeDirs, probeLiveSocket, classifySocketOwner } from "./runtime-dir.js";

// tmux-liveness probe (`tmux -L <socketName> ls`, hard-timeout). The broker
// uses `probeTmuxAlive` for watcher-EOF disambiguation; the extension's
// broker-exit classifier reuses the SAME spawn via the three-way
// `probeTmuxLiveness`.
export { probeTmuxAlive, probeTmuxLiveness, type TmuxLiveness } from "./tmux-south.js";
