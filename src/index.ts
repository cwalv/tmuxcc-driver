// tmuxcc-daemon — package entry point.
// Real logic lives in parser/, state/, runtime/, wire/.

export const DAEMON_PLACEHOLDER = true;

/** Stub type: will be replaced by the real daemon interface. */
export interface DaemonHandle {
  readonly pid: number;
  stop(): Promise<void>;
}

// Wire protocol public surface — re-exported so that @tmuxcc/daemon is the
// single import path for all wire types and utilities. Client packages import:
//   import { encodeFrame, decodeFrame, ... } from "@tmuxcc/daemon";
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

// Runtime — createDaemon and supporting types (tc-93a).
// Re-exported from src/index so consumers can import from "@tmuxcc/daemon"
// without reaching into internal sub-paths.
export { createDaemon } from "./runtime/daemon.js";
export type { Daemon, DaemonOptions } from "./runtime/daemon.js";
export type { TmuxHost, TmuxHostOptions } from "./runtime/tmux-host.js";

// Die-with-parent watchdog (tc-2c5) — daemon entry points (e.g. @tmuxcc/broker's
// daemon-entry.ts) install this at startup to enforce ext-a §6.3: daemons die
// with the broker; there is no orphan-and-reclaim path.
export { installDieWithParent } from "./runtime/die-with-parent.js";
export type { DieWithParentOptions } from "./runtime/die-with-parent.js";

// Flow-control + output-demux primitives — exported so tc-7xv.6/tc-7xv.24
// regression tests in @tmuxcc/broker can drive a real SocketTransport through
// the same daemon-side wiring without booting a full Daemon.
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

// Control server — re-exported so Layer A tests in @tmuxcc/client can
// instantiate ControlServer without reaching into internal sub-paths.
// tc-1elae (§11.4): tests verify attachedClientCount stamping.
export { createControlServer } from "./runtime/serve.js";
export type {
  ControlServer,
  ControlServerOptions,
} from "./runtime/serve.js";
export type { RuntimePipeline } from "./runtime/pipeline.js";
