/**
 * @tmuxcc/client — headless client for tmuxcc.
 *
 * No DOM, no host API, no tmux vocabulary.
 * Safe to import in Node, bundled for the browser, or run in a worker.
 */

/** Placeholder export — replaced as domain modules land in later epics. */
export const CLIENT_PLACEHOLDER = true;

// ---------------------------------------------------------------------------
// Connection + handshake (tc-ahh — E5 serial head)
// ---------------------------------------------------------------------------

export { DaemonConnection } from "./connection.js";
export type {
  ConnectionState,
  DaemonConnectionOptions,
  DaemonMessageHandler,
  DataFrameHandler,
  StateChangeHandler,
} from "./connection.js";

// ---------------------------------------------------------------------------
// Model mirror (tc-eots) — client-side snapshot + delta apply, seq-gap detect
// ---------------------------------------------------------------------------

export { Mirror, createMirror, applySnapshot, applyDelta } from "./mirror.js";
export type {
  ClientPane,
  ClientWindow,
  ClientSession,
  ClientFocus,
  ClientModel,
  SeqGapInfo,
  ModelChangeHandler,
  ResyncNeededHandler,
} from "./mirror.js";
