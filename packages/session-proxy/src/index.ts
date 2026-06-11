// tmuxcc-daemon — package entry point.
// Real logic lives in parser/, state/, runtime/, wire/.

export const SESSION_PROXY_PLACEHOLDER = true;

/** Stub type: will be replaced by the real session-proxy interface. */
export interface SessionProxyHandle {
  readonly pid: number;
  stop(): Promise<void>;
}

// Wire protocol public surface — re-exported so that @remux/session-proxy is the
// single import path for all wire types and utilities. Client packages import:
//   import { encodeFrame, decodeFrame, ... } from "@remux/session-proxy";
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
export type { ProjectSnapshotOpts } from "./state/projection.js";

// Runtime — createSessionProxy and supporting types (tc-93a).
// Re-exported from src/index so consumers can import from "@remux/session-proxy"
// without reaching into internal sub-paths.
export { createSessionProxy } from "./runtime/session-proxy.js";
export type { SessionProxy, SessionProxyOptions } from "./runtime/session-proxy.js";
// createTmuxHost is exported for @remux/server-proxy (tc-3iv): the server-proxy's thin
// `-CC` watcher must hold a LIVE control-mode connection (its EOF is the
// server-proxy's tmux-death exit trigger, §6.2), and tmux's client calls tcgetattr()
// on stdin even in control mode — so the watcher needs the same PTY bridge
// the session-proxy uses. The barrel is the only sanctioned import path for the
// serverProxy (see tmuxcc-broker/.dependency-cruiser.cjs server-proxy-no-session-proxy-runtime).
export { createTmuxHost } from "./runtime/tmux-host.js";
export type { TmuxHost, TmuxHostOptions } from "./runtime/tmux-host.js";

// Die-with-parent watchdog (tc-2c5) — session-proxy entry points (e.g. @remux/server-proxy's
// session-proxy-entry.ts) install this at startup to enforce ext-a §6.3: session-proxies die
// with the serverProxy; there is no orphan-and-reclaim path.
export { installDieWithParent } from "./runtime/die-with-parent.js";
export type { DieWithParentOptions } from "./runtime/die-with-parent.js";

// Flow-control + output-demux primitives — exported so tc-7xv.6/tc-7xv.24
// regression tests in @remux/server-proxy can drive a real SocketTransport through
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

// Control server — re-exported so Layer A tests in @remux/client can
// instantiate ControlServer without reaching into internal sub-paths.
// tc-1elae (§11.4): tests verify attachedClientCount stamping.
export { createControlServer } from "./runtime/serve.js";
export type {
  ControlServer,
  ControlServerOptions,
} from "./runtime/serve.js";
export type { RuntimePipeline } from "./runtime/pipeline.js";

// tc-x6l: metrics + storm alarm — re-exported so consumers can import
// from "@remux/session-proxy" without reaching into internal sub-paths.
export { createSessionProxyRegistry, createStormAlarm } from "./metrics/index.js";
export type {
  SessionProxyRegistry,
  StormAlarm,
  StormAlarmOptions,
  KindBreakdown,
} from "./metrics/index.js";
