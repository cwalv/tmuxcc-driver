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

export { SessionProxyConnection } from "./connection.js";
export type {
  ConnectionState,
  SessionProxyConnectionOptions,
  SessionProxyMessageHandler,
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
  CommandResponseHandler,
} from "./mirror.js";

// ---------------------------------------------------------------------------
// Pane byte-stream consumer (tc-ekd) — per-pane ordered delivery
// ---------------------------------------------------------------------------

export * from "./pane-stream.js";

// ---------------------------------------------------------------------------
// Input/resize API (tc-6jf) — client→session-proxy wire messages
// ---------------------------------------------------------------------------

export * from "./input.js";

// ---------------------------------------------------------------------------
// Render-hook interface (tc-y8d) — the renderer seam (E6 implements)
// ---------------------------------------------------------------------------

export * from "./render-hook.js";

// WireCommand is re-exported from render-hook.js (imported from @tmuxcc/session-proxy).
// Consumers can also import it directly from @tmuxcc/session-proxy if they need the
// full command type union (OpenWindowCommand, SplitPaneCommand, etc.).

// ---------------------------------------------------------------------------
// connectClient (tc-cox.1) — top-level integration: wires all E5 modules together
// ---------------------------------------------------------------------------

export { connectClient } from "./client.js";
export type { ConnectClientOptions, ClientHandle } from "./client.js";
