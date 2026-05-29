/**
 * Handshake sequence — daemon↔client capability negotiation.
 *
 * # Sequence
 *
 * The daemon initiates the handshake immediately after a transport connection
 * is established.  The client waits for the daemon's advertisement, then
 * responds with its own.  This mirrors the convention used by other
 * server-first protocols (SSH, SMTP, FTP): the server speaks first so the
 * client can react to what the server actually supports before committing any
 * state.
 *
 * ```
 * Daemon                          Client
 *   |                               |
 *   |-- daemon.capabilities ------->|   (1) daemon advertises version + features
 *   |<-- client.capabilities -------|   (2) client responds with its own
 *   |                               |
 *   |  both sides compute:          |
 *   |    agreedVersion = v (if equal, else error)
 *   |    features = intersection(daemonFeatures, clientFeatures)
 *   |                               |
 *   |-- snapshot ------------------>|   (3) normal data flow begins
 * ```
 *
 * # Version policy (v1 — alpha)
 *
 * For protocol version 1, both sides MUST advertise the same
 * `WIRE_PROTOCOL_VERSION`.  If they differ the handshake FAILS immediately
 * with `HandshakeError` (code `"protocol.version-mismatch"`).  There is no
 * negotiation or downgrade: this is alpha software and back-compat bookkeeping
 * would hide real breaking changes.  Increment `WIRE_PROTOCOL_VERSION` in
 * control.ts for any breaking change; bump both sides in lockstep.
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
 */

import { WIRE_PROTOCOL_VERSION } from "./control.js";
import type {
  Capabilities,
  WireFeature,
  DaemonCapabilitiesMessage,
  ClientCapabilitiesMessage,
} from "./control.js";
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
// Daemon-side handshake
// ---------------------------------------------------------------------------

/**
 * Run the daemon side of the handshake over `transport`.
 *
 * Steps:
 *   1. Send `daemon.capabilities` (seq=1) advertising `daemonCapabilities`.
 *   2. Wait for the client to send `client.capabilities`.
 *   3. Negotiate the session (version check + feature intersection).
 *
 * Resolves with `NegotiatedSession` on success.
 * Rejects with `HandshakeError` on version mismatch, unexpected message type,
 * or transport closure before the client responds.
 */
export function runDaemonHandshake(
  transport: Transport,
  daemonCapabilities: Capabilities,
): Promise<NegotiatedSession> {
  return new Promise<NegotiatedSession>((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      // Unregister our temporary handlers before resolving/rejecting so that
      // the caller can install its own handlers without seeing handshake traffic.
      transport.onControl(() => {});
      transport.onClose(() => {});
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
      const clientMsg = msg as ClientCapabilitiesMessage;
      try {
        const session = negotiateCapabilities(
          daemonCapabilities,
          clientMsg.capabilities,
        );
        settle(() => resolve(session));
      } catch (err) {
        settle(() => reject(err));
      }
    });

    // Handle transport closure before client responds
    transport.onClose(() => {
      settle(() =>
        reject(
          new HandshakeError(
            "transport.closed",
            "Transport closed before client sent capabilities",
          ),
        ),
      );
    });

    // (1) Advertise daemon capabilities.
    // Defer the send by one microtask so that callers who construct both
    // sides in the same synchronous turn (e.g. Promise.all([
    //   runDaemonHandshake(...), runClientHandshake(...)
    // ])) have a chance to register their onControl handlers before the
    // first message lands.  The in-memory transport delivers synchronously,
    // so without this deferral the client-side handler would not yet be
    // registered when daemon.sendControl fires.
    const daemonMsg: DaemonCapabilitiesMessage = {
      type: "daemon.capabilities",
      seq: HANDSHAKE_SEQ,
      capabilities: daemonCapabilities,
    };
    Promise.resolve().then(() => {
      if (!settled) transport.sendControl(daemonMsg);
    });
  });
}

// ---------------------------------------------------------------------------
// Client-side handshake
// ---------------------------------------------------------------------------

/**
 * Run the client side of the handshake over `transport`.
 *
 * Steps:
 *   1. Wait for the daemon to send `daemon.capabilities`.
 *   2. Send `client.capabilities` (seq=1) advertising `clientCapabilities`.
 *   3. Negotiate the session (version check + feature intersection).
 *
 * Resolves with `NegotiatedSession` on success.
 * Rejects with `HandshakeError` on version mismatch, unexpected message type,
 * or transport closure before the daemon advertises.
 */
export function runClientHandshake(
  transport: Transport,
  clientCapabilities: Capabilities,
): Promise<NegotiatedSession> {
  return new Promise<NegotiatedSession>((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      transport.onControl(() => {});
      transport.onClose(() => {});
      fn();
    };

    // (1) Wait for daemon.capabilities
    transport.onControl((msg) => {
      if (msg.type !== "daemon.capabilities") {
        settle(() =>
          reject(
            new HandshakeError(
              "protocol.unexpected-message",
              `Expected "daemon.capabilities" but received "${msg.type}"`,
            ),
          ),
        );
        return;
      }
      const daemonMsg = msg as DaemonCapabilitiesMessage;

      // (2) Respond with client capabilities
      const clientMsg: ClientCapabilitiesMessage = {
        type: "client.capabilities",
        seq: HANDSHAKE_SEQ,
        capabilities: clientCapabilities,
      };
      transport.sendControl(clientMsg);

      // (3) Negotiate
      try {
        const session = negotiateCapabilities(
          clientCapabilities,
          daemonMsg.capabilities,
        );
        settle(() => resolve(session));
      } catch (err) {
        settle(() => reject(err));
      }
    });

    // Handle transport closure before daemon advertises
    transport.onClose(() => {
      settle(() =>
        reject(
          new HandshakeError(
            "transport.closed",
            "Transport closed before daemon sent capabilities",
          ),
        ),
      );
    });
  });
}
