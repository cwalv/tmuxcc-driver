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
