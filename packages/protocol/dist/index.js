/**
 * Wire protocol public surface — session-proxy↔client contract.
 *
 * The wire speaks in terms of panes, bytes, deltas, input, resize, and layout.
 * It NEVER leaks:
 *   - tmux south-side vocabulary (%output, %begin/%end, tmux command numbers,
 *     octal escapes, layout-string syntax)
 *   - renderer/host vocabulary (Pseudoterminal, VS Code types, DOM)
 *
 * Two planes:
 *   - Control plane (this module): structured messages, discriminated unions.
 *   - Data plane (tc-2mq): length-prefixed raw pane byte streams; imports
 *     PaneId from ids.ts to tag frames.
 *
 * Handshake flow (tc-auj) uses the Capabilities / SessionProxyCapabilitiesMessage /
 * ClientCapabilitiesMessage types defined here; the sequence logic lives there.
 *
 * File layout (tc-j9c Stage 0):
 *   envelope.ts        — MessageBase, Capabilities, WireFeature, WIRE_PROTOCOL_VERSION, isControlMessage
 *   server-proxy-control.ts  — ServerProxy wire control messages + ServerProxyCommand union
 *   session-proxy-control.ts  — SessionProxy wire control messages + WireCommand union
 */
export { paneId, windowId, sessionId, connectionId } from "./ids.js";
// Shared envelope types — protocol version, capabilities, base types
export { WIRE_PROTOCOL_VERSION } from "./envelope.js";
// D2 (tc-4b6k.1): durable client identity + log formatter.
export { isControlMessage, describeClientIdentity } from "./envelope.js";
export { isServerProxyMessage } from "./server-proxy-control.js";
export { isSessionProxyMessage, isClientMessage } from "./session-proxy-control.js";
// Data-plane binary frame format (tc-2mq)
export { FRAME_MAGIC, MAX_FRAME, encodeFrame, decodeFrame, FrameDecoder } from "./framing.js";
export { HandshakeError, intersectFeatures, negotiateCapabilities, runServerHandshake, runSessionProxyHandshake, runClientHandshake, } from "./handshake.js";
export { CommandError, isCommandError, requiredCapability, toCommandFailure, } from "./errors.js";
export { createInMemoryTransportPair } from "./transport.js";
//# sourceMappingURL=index.js.map