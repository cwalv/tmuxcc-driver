// tmuxcc-daemon — package entry point.
// Real logic lives in parser/, state/, runtime/, wire/.

export const SESSION_PROXY_PLACEHOLDER = true;

/** Stub type: will be replaced by the real session-proxy interface. */
export interface SessionProxyHandle {
  readonly pid: number;
  stop(): Promise<void>;
}

// Wire protocol public surface — re-exported so that @tmuxcc/session-proxy is the
// single import path for all wire types and utilities. Client packages import:
//   import { encodeFrame, decodeFrame, ... } from "@tmuxcc/session-proxy";
export * from "./wire/index.js";

// State model + projection — exported so client tests can run round-trip proofs
// (applySnapshot(prev) + diffModel(prev, next) == applySnapshot(next)).
// State model types and helpers:
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
export type { ProjectSnapshotOpts, OriginLookup, CloseCauseLookup } from "./state/projection.js";

// Verb-origin registry (tc-ozk.2) — re-exported so the SDK test harness
// (clients/ts, tc-ozk.4) can seed origin attribution when replaying conformance
// transcripts against the REAL session-proxy (createControlServer + originLookup).
// The barrel is the only sanctioned import path from clients/ts (its
// dependency-cruiser boundary forbids @tmuxcc/session-proxy/src/* sub-paths).
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
// Re-exported from src/index so consumers can import from "@tmuxcc/session-proxy"
// without reaching into internal sub-paths.
export { createSessionProxy } from "./runtime/session-proxy.js";
export type { SessionProxy, SessionProxyOptions, SessionProxyHostView } from "./runtime/session-proxy.js";
// createTmuxHost is exported for @tmuxcc/server-proxy (tc-3iv): the server-proxy's thin
// `-CC` watcher must hold a LIVE control-mode connection (its EOF is the
// server-proxy's tmux-death exit trigger, §6.2), and tmux's client calls tcgetattr()
// on stdin even in control mode — so the watcher needs the same PTY bridge
// the session-proxy uses. The barrel is the only sanctioned import path for the
// serverProxy (see tmuxcc-broker/.dependency-cruiser.cjs server-proxy-no-session-proxy-runtime).
export { createTmuxHost } from "./runtime/tmux-host.js";
export type { TmuxHost, TmuxHostOptions } from "./runtime/tmux-host.js";

// tc-2x3.3: die-with-parent (tc-2c5) is gone — Stage 2 collapsed the per-session
// session-proxy child processes into the server-proxy's own event loop, so there
// is no child process to be reparented and nothing to enforce die-with-parent
// against.  Recovery from server-proxy death is unchanged: a fresh server-proxy
// re-attaches `-CC` to the surviving tmux sessions (tmux is the persistence layer).

// Flow-control + output-demux primitives — exported so tc-7xv.6/tc-7xv.24
// regression tests in @tmuxcc/server-proxy can drive a real SocketTransport through
// the same session-proxy-side wiring without booting a full SessionProxy.
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
// Re-exported so server-proxy regression tests can declare the `send`
// callback's Promise return type without reaching into internal sub-paths
// (tc-3si.1).
export type { CommandResult } from "./parser/correlator.js";

// Control server — re-exported so Layer A tests in @tmuxcc/client can
// instantiate ControlServer without reaching into internal sub-paths.
// tc-1elae (§11.4): tests verify attachedClientCount stamping.
export { createControlServer } from "./runtime/serve.js";
export type {
  ControlServer,
  ControlServerOptions,
} from "./runtime/serve.js";
export type { RuntimePipeline } from "./runtime/pipeline.js";

// tc-is5w: dev-gated phase-split activation timing. Shared so the broker
// (server-proxy._doClaimSession) and the session-proxy legs emit a uniform
// `[tc-is5w]` line under TMUXCC_PHASE_TIMING. Inert when the var is unset.
export { phaseLog, phaseNow, PHASE_TIMING_ENABLED } from "./runtime/phase-timing.js";
export type { PhaseFields } from "./runtime/phase-timing.js";

// tc-x6l: metrics + storm alarm — re-exported so consumers can import
// from "@tmuxcc/session-proxy" without reaching into internal sub-paths.
export { createSessionProxyRegistry, createStormAlarm } from "./metrics/index.js";
export type {
  SessionProxyRegistry,
  StormAlarm,
  StormAlarmOptions,
  KindBreakdown,
} from "./metrics/index.js";
