/**
 * @tmuxcc/driver-admin — Node-only diagnostics/admin surface for a running
 * tmuxcc driver (tc-44u4.3).
 *
 * Sits ABOVE @tmuxcc/{server-proxy,session-proxy,client}: it connects to the
 * EXISTING 0600 driver unix sockets via the EXISTING handshake and correlates a
 * `*.info` request, so non-VSCode consumers (ad-hoc diagnostics, the tc-44u4
 * investigation, the bin shim below) no longer hand-roll connect + handshake +
 * correlationId matching.
 *
 * Security: connects to existing sockets via the existing handshake only — no
 * new listener, no weaker auth, no broadened access.  The payloads carry
 * sensitive runtime metrics; treat them as the operator's.
 */

export {
  fetchServerProxyInfo,
  fetchSessionProxyInfo,
  runServerProxyCommand,
} from "./info.js";

// Re-export the structured payload shapes so consumers get the typed surface
// from one import path (they may also import them from @tmuxcc/session-proxy).
export type { ServerProxyInfoPayload, SessionProxyInfoPayload } from "@tmuxcc/protocol";
