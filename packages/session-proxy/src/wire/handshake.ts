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
import type {
  Capabilities,
  WireFeature,
  MessageBase,
} from "./envelope.js";
import type { Transport } from "./transport.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

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
}

/** Error codes produced by the handshake. */
export type HandshakeErrorCode =
  | "protocol.version-mismatch" // versions differ between the two sides
  | "protocol.unexpected-message" // wrong message type received during handshake
  | "transport.closed"; // transport closed before handshake completed

/** Thrown (or returned) when the handshake cannot be completed. */
export class HandshakeError extends Error {
  readonly code: HandshakeErrorCode;

  constructor(code: HandshakeErrorCode, message: string) {
    super(message);
    this.name = "HandshakeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the intersection of two feature lists.
 * Order is preserved from `a`; duplicates are not introduced.
 */
export function intersectFeatures(
  a: readonly WireFeature[],
  b: readonly WireFeature[],
): WireFeature[] {
  const setB = new Set<string>(b);
  return a.filter((f) => setB.has(f));
}

/**
 * Negotiate a `NegotiatedSession` from the two sides' capabilities.
 * Throws `HandshakeError` if versions differ.
 */
export function negotiateCapabilities(
  local: Capabilities,
  remote: Capabilities,
): NegotiatedSession {
  if (local.protocolVersion !== remote.protocolVersion) {
    throw new HandshakeError(
      "protocol.version-mismatch",
      `Protocol version mismatch: local=${local.protocolVersion} remote=${remote.protocolVersion}`,
    );
  }
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features: intersectFeatures(local.features, remote.features),
  };
}

// ---------------------------------------------------------------------------
// Sequence numbers for handshake messages
// ---------------------------------------------------------------------------

// The handshake messages are the first messages on their respective sender's
// counter, so both start at seq=1.
const HANDSHAKE_SEQ = 1 as const;

// ---------------------------------------------------------------------------
// Generic server-side handshake (shared by session-proxy and server-proxy wires)
// ---------------------------------------------------------------------------

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
export function runServerHandshake(
  transport: Transport,
  serverCapabilities: Capabilities,
  serverCapabilitiesType: string,
): Promise<NegotiatedSession> {
  return new Promise<NegotiatedSession>((resolve, reject) => {
    let settled = false;

    // Capture unsubscribe so settle() can remove the handshake close handler
    // without affecting other onClose subscribers on the same transport.
    let unsubClose: (() => void) | null = null;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      // Unregister our temporary handlers before resolving/rejecting so that
      // the caller can install its own handlers without seeing handshake traffic.
      transport.onControl(() => {});
      unsubClose?.();
      fn();
    };

    // (2) Wait for client.capabilities
    transport.onControl((msg) => {
      if (msg.type !== "client.capabilities") {
        settle(() =>
          reject(
            new HandshakeError(
              "protocol.unexpected-message",
              `Expected "client.capabilities" but received "${msg.type}"`,
            ),
          ),
        );
        return;
      }
      const clientMsg = msg as MessageBase & { capabilities: Capabilities };
      try {
        const session = negotiateCapabilities(
          serverCapabilities,
          clientMsg.capabilities,
        );
        settle(() => resolve(session));
      } catch (err) {
        settle(() => reject(err));
      }
    });

    // Handle transport closure before client responds
    unsubClose = transport.onClose(() => {
      settle(() =>
        reject(
          new HandshakeError(
            "transport.closed",
            "Transport closed before client sent capabilities",
          ),
        ),
      );
    });

    // (1) Advertise server capabilities.
    // Defer the send by one microtask so that callers who construct both
    // sides in the same synchronous turn (e.g. Promise.all([
    //   runServerHandshake(...), runClientHandshake(...)
    // ])) have a chance to register their onControl handlers before the
    // first message lands.  The in-memory transport delivers synchronously,
    // so without this deferral the client-side handler would not yet be
    // registered when server.sendControl fires.
    const serverMsg: MessageBase & { capabilities: Capabilities } = {
      type: serverCapabilitiesType,
      seq: HANDSHAKE_SEQ,
      capabilities: serverCapabilities,
    };
    Promise.resolve().then(() => {
      if (!settled) transport.sendControl(serverMsg as Parameters<typeof transport.sendControl>[0]);
    });
  });
}

// ---------------------------------------------------------------------------
// Generic client-side handshake (shared by session-proxy and server-proxy wires)
// ---------------------------------------------------------------------------

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
export function runClientHandshake(
  transport: Transport,
  clientCapabilities: Capabilities,
  serverCapabilitiesType: string = "session-proxy.capabilities",
): Promise<NegotiatedSession> {
  return new Promise<NegotiatedSession>((resolve, reject) => {
    let settled = false;

    // Capture unsubscribe so settle() can remove the handshake close handler
    // without affecting other onClose subscribers on the same transport.
    let unsubClose: (() => void) | null = null;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      transport.onControl(() => {});
      unsubClose?.();
      fn();
    };

    // (1) Wait for <serverCapabilitiesType>
    transport.onControl((msg) => {
      if (msg.type !== serverCapabilitiesType) {
        settle(() =>
          reject(
            new HandshakeError(
              "protocol.unexpected-message",
              `Expected "${serverCapabilitiesType}" but received "${msg.type}"`,
            ),
          ),
        );
        return;
      }
      const serverMsg = msg as MessageBase & { capabilities: Capabilities };

      // (2) Respond with client capabilities
      const clientMsg: MessageBase & { capabilities: Capabilities } = {
        type: "client.capabilities",
        seq: HANDSHAKE_SEQ,
        capabilities: clientCapabilities,
      };
      transport.sendControl(clientMsg as Parameters<typeof transport.sendControl>[0]);

      // (3) Negotiate
      try {
        const session = negotiateCapabilities(
          clientCapabilities,
          serverMsg.capabilities,
        );
        settle(() => resolve(session));
      } catch (err) {
        settle(() => reject(err));
      }
    });

    // Handle transport closure before server advertises
    unsubClose = transport.onClose(() => {
      settle(() =>
        reject(
          new HandshakeError(
            "transport.closed",
            "Transport closed before server sent capabilities",
          ),
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// SessionProxy wire convenience wrappers
// ---------------------------------------------------------------------------

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
export function runSessionProxyHandshake(
  transport: Transport,
  sessionProxyCapabilities: Capabilities,
): Promise<NegotiatedSession> {
  return runServerHandshake(transport, sessionProxyCapabilities, "session-proxy.capabilities");
}

// Note: runClientHandshake already defaults serverCapabilitiesType to
// "session-proxy.capabilities", so it serves as the session-proxy-wire client handshake
// without any additional wrapper needed.
