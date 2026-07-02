/**
 * Handshake sequence — capability negotiation shared by session-proxy and server-proxy wires.
 *
 * # Sequence (server-initiates pattern, used by both wires)
 *
 * The server (session-proxy or serverProxy) sends capabilities first; the client waits
 * for the server's advertisement, then responds with its own. This mirrors
 * the convention used by other server-first protocols (SSH, SMTP, FTP): the
 * server speaks first so the client can react to what the server supports
 * before committing any state.
 *
 * ```
 * Server (session-proxy or serverProxy)       Client
 *   |                               |
 *   |-- <server>.capabilities ----->|   (1) server advertises version + features
 *   |<-- client.capabilities -------|   (2) client responds with its own
 *   |                               |
 *   |  both sides compute:          |
 *   |    agreedVersion = v (if equal, else error)
 *   |    features = intersection(serverFeatures, clientFeatures)
 * ```
 *
 * # SessionProxy wire
 *
 * ```
 * SessionProxy                          Client
 *   |-- session-proxy.capabilities ------->|
 *   |<-- client.capabilities -------|
 *   |-- snapshot ------------------>|   (normal data flow)
 * ```
 *
 * # ServerProxy wire
 *
 * ```
 * ServerProxy                          Client
 *   |-- server-proxy.capabilities ------->|
 *   |<-- client.capabilities -------|
 *   |-- sessions.snapshot ---------->|  (initial session list)
 * ```
 *
 * # Version policy (v1 — alpha)
 *
 * For protocol version 1, both sides MUST advertise the same
 * `WIRE_PROTOCOL_VERSION`.  If they differ the handshake FAILS immediately
 * with `HandshakeError` (code `"protocol.version-mismatch"`).  There is no
 * negotiation or downgrade: this is alpha software and back-compat bookkeeping
 * would hide real breaking changes.  Increment `WIRE_PROTOCOL_VERSION` in
 * envelope.ts for any breaking change; bump both sides in lockstep.
 *
 * # Feature negotiation
 *
 * Features are forward-compatible: unknown feature strings in a remote's
 * advertisement are silently ignored (they are for a future peer to use).
 * The effective feature set after a successful handshake is the SET
 * INTERSECTION of the two sides' advertised feature arrays.  Only features
 * that both endpoints understand and advertise are considered active.
 *
 * # Failure modes
 *
 * - Version mismatch → `HandshakeError` with code `"protocol.version-mismatch"`.
 * - Unexpected message type (not the expected capabilities message) →
 *   `HandshakeError` with code `"protocol.unexpected-message"`.
 * - Transport closed before handshake completes →
 *   `HandshakeError` with code `"transport.closed"`.
 *
 * In all failure cases the caller is expected to close the transport.
 *
 * # Parameterization for server-proxy vs session-proxy
 *
 * `runServerHandshake` and `runClientHandshake` accept the server-side
 * capabilities message type discriminant as a parameter (`serverCapabilitiesType`).
 * This lets both the session-proxy wire (`"session-proxy.capabilities"`) and the future server-proxy
 * wire (`"server-proxy.capabilities"`) share the same handshake logic.
 *
 * The convenience wrappers `runSessionProxyHandshake` / `runSessionProxyClientHandshake`
 * fix the discriminants for the session-proxy wire.
 */
import { WIRE_PROTOCOL_VERSION } from "./envelope.js";
import type { Capabilities, ClientIdentity, WireFeature } from "./envelope.js";
import type { Transport } from "./transport.js";
/**
 * The result of a successful handshake.  Both sides arrive at the same
 * `NegotiatedSession` after the exchange completes.
 */
export interface NegotiatedSession {
    /** Agreed wire protocol version.  Equal to WIRE_PROTOCOL_VERSION for v1. */
    readonly protocolVersion: typeof WIRE_PROTOCOL_VERSION;
    /**
     * Intersection of the features advertised by both sides.  Only features in
     * this set are guaranteed to be understood by both endpoints.
     */
    readonly features: readonly WireFeature[];
    /**
     * The durable identity the CLIENT advertised on `client.capabilities`
     * (D2, tc-4b6k.1). Symmetric: both sides know it after the handshake — on the
     * client side it is the identity it advertised; on the server side it is the
     * identity it received (and stores + logs). Absent when the client did not
     * advertise one (older client, or a diagnostic connection). Carried and
     * logged only in this revision — no behavior depends on it yet.
     */
    readonly clientIdentity?: ClientIdentity;
}
/** Error codes produced by the handshake. */
export type HandshakeErrorCode = "protocol.version-mismatch" | "protocol.unexpected-message" | "transport.closed";
/** Thrown (or returned) when the handshake cannot be completed. */
export declare class HandshakeError extends Error {
    readonly code: HandshakeErrorCode;
    constructor(code: HandshakeErrorCode, message: string);
}
/**
 * Compute the intersection of two feature lists.
 * Order is preserved from `a`; duplicates are not introduced.
 */
export declare function intersectFeatures(a: readonly WireFeature[], b: readonly WireFeature[]): WireFeature[];
/**
 * Negotiate a `NegotiatedSession` from the two sides' capabilities.
 * Throws `HandshakeError` if versions differ.
 */
export declare function negotiateCapabilities(local: Capabilities, remote: Capabilities): NegotiatedSession;
/**
 * Run the server side of the handshake over `transport`.
 *
 * This is the shared implementation used by both the session-proxy wire and the
 * server-proxy wire. The `serverCapabilitiesType` parameter controls which message
 * type discriminant is sent in step (1):
 *   - SessionProxy wire: `"session-proxy.capabilities"`
 *   - ServerProxy wire: `"server-proxy.capabilities"`
 *
 * Steps:
 *   1. Send `<serverCapabilitiesType>` (seq=1) advertising `serverCapabilities`.
 *   2. Wait for the client to send `client.capabilities`.
 *   3. Negotiate the session (version check + feature intersection).
 *
 * Resolves with `NegotiatedSession` on success.
 * Rejects with `HandshakeError` on version mismatch, unexpected message type,
 * or transport closure before the client responds.
 */
export declare function runServerHandshake(transport: Transport, serverCapabilities: Capabilities, serverCapabilitiesType: string): Promise<NegotiatedSession>;
/**
 * Run the client side of the handshake over `transport`.
 *
 * This is the shared implementation used by both the session-proxy wire and the
 * server-proxy wire. The `serverCapabilitiesType` parameter controls which message
 * type discriminant is expected from the server in step (1):
 *   - SessionProxy wire: `"session-proxy.capabilities"`
 *   - ServerProxy wire: `"server-proxy.capabilities"`
 *
 * Steps:
 *   1. Wait for the server to send `<serverCapabilitiesType>`.
 *   2. Send `client.capabilities` (seq=1) advertising `clientCapabilities`.
 *   3. Negotiate the session (version check + feature intersection).
 *
 * Resolves with `NegotiatedSession` on success.
 * Rejects with `HandshakeError` on version mismatch, unexpected message type,
 * or transport closure before the server advertises.
 */
export declare function runClientHandshake(transport: Transport, clientCapabilities: Capabilities, serverCapabilitiesType?: string, clientIdentity?: ClientIdentity): Promise<NegotiatedSession>;
/**
 * Run the session-proxy side of the handshake over `transport`.
 *
 * Convenience wrapper over `runServerHandshake` fixing the discriminant to
 * `"session-proxy.capabilities"`.
 *
 * Steps:
 *   1. Send `session-proxy.capabilities` (seq=1) advertising `sessionProxyCapabilities`.
 *   2. Wait for the client to send `client.capabilities`.
 *   3. Negotiate the session (version check + feature intersection).
 *
 * Resolves with `NegotiatedSession` on success.
 * Rejects with `HandshakeError` on version mismatch, unexpected message type,
 * or transport closure before the client responds.
 */
export declare function runSessionProxyHandshake(transport: Transport, sessionProxyCapabilities: Capabilities): Promise<NegotiatedSession>;
//# sourceMappingURL=handshake.d.ts.map