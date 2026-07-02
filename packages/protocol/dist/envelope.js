/**
 * Shared wire envelope types and type guards.
 *
 * This module contains the envelope primitives shared by BOTH the server-proxy wire
 * and the session-proxy wire:
 *   - MessageBase: the discriminant + seq envelope every control-plane message carries.
 *   - Capabilities / WireFeature: the handshake data shape (content differs per wire).
 *   - WIRE_PROTOCOL_VERSION: the monotonically-increasing schema revision integer.
 *   - isControlMessage: shallow structural guard (type: string, seq: number).
 *   - isServerProxyMessage / isSessionProxyMessage / isClientMessage: direction guards whose
 *     concrete narrowings are filled in by server-proxy-control.ts and session-proxy-control.ts
 *     (they re-export the full implementations from those modules).
 *
 * ---------------------------------------------------------------------------
 * VERSIONING
 * ---------------------------------------------------------------------------
 *
 * The protocol version is a single monotonically-increasing integer.
 * It appears in the Capabilities of every handshake message on both wires.
 * Increment this constant for any breaking schema change. Additive changes
 * (new optional fields, new message kinds) are non-breaking.
 *
 * The version is NOT repeated in every message envelope to keep messages
 * compact. Version negotiation happens once at handshake time.
 *
 * v1 → v2 (tc-7ml.4): Added ResyncRequestMessage (type: "resync.request") to
 * the session-proxy wire ClientMessage union.
 * v2 → v3 (tc-j9c): ServerProxy wire introduced; session-proxy wire becomes single-session.
 * WIRE_PROTOCOL_VERSION stays at 2 in Stage 0 (the bump to 3 happens with
 * Stage 1 + Stage 2 schema rebuilds).
 */
// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------
/**
 * Monotonically-increasing integer identifying this schema revision.
 * Increment on any breaking schema change. Non-breaking additions do not
 * require a bump. Version negotiation flow is defined by bead tc-auj.
 */
export const WIRE_PROTOCOL_VERSION = 3;
/**
 * Format a {@link ClientIdentity} for a one-line log (D2, tc-4b6k.1).
 *
 * Both proxies log the connecting client's identity on connect ("carried and
 * logged only"). Returns `"<anonymous>"` when no identity was advertised, and
 * `id` (optionally with a `label` suffix) otherwise.
 */
export function describeClientIdentity(identity) {
    if (identity === undefined)
        return "<anonymous>";
    return identity.label !== undefined && identity.label.length > 0
        ? `${identity.id} (${identity.label})`
        : identity.id;
}
// ---------------------------------------------------------------------------
// Type guards — runtime narrowing without external schema libraries
// ---------------------------------------------------------------------------
/**
 * Checks whether a value looks like a ControlMessage at runtime (has a
 * string `type` and a numeric `seq`). Does NOT do deep field validation —
 * use a validator library (e.g. zod) if you need full schema validation.
 *
 * This guard is wire-agnostic: it accepts messages from both the server-proxy wire
 * and the session-proxy wire.
 */
export function isControlMessage(value) {
    return (typeof value === "object" &&
        value !== null &&
        "type" in value &&
        typeof value["type"] === "string" &&
        "seq" in value &&
        typeof value["seq"] === "number");
}
//# sourceMappingURL=envelope.js.map