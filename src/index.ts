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
export type { TmuxHostOptions } from "./runtime/tmux-host.js";
