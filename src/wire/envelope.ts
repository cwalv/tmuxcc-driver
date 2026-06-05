/**
 * Shared wire envelope types and type guards.
 *
 * This module contains the envelope primitives shared by BOTH the broker wire
 * and the daemon wire:
 *   - MessageBase: the discriminant + seq envelope every control-plane message carries.
 *   - Capabilities / WireFeature: the handshake data shape (content differs per wire).
 *   - WIRE_PROTOCOL_VERSION: the monotonically-increasing schema revision integer.
 *   - isControlMessage: shallow structural guard (type: string, seq: number).
 *   - isBrokerMessage / isDaemonMessage / isClientMessage: direction guards whose
 *     concrete narrowings are filled in by broker-control.ts and daemon-control.ts
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
 * the daemon wire ClientMessage union.
 * v2 → v3 (tc-j9c): Broker wire introduced; daemon wire becomes single-session.
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
export const WIRE_PROTOCOL_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// Shared envelope
// ---------------------------------------------------------------------------

/**
 * Every control-plane message on both the broker wire and the daemon wire
 * carries a `type` discriminant and a monotonically-increasing sequence
 * number. The sequence number lets the receiver detect drops and order
 * events; it is per-connection per-sender, starting at 1.
 *
 * Extend with additional envelope fields here if needed — e.g. a correlation
 * ID for request/response pairing in future revisions.
 */
export interface MessageBase {
  /** Discriminant for TypeScript narrowing. */
  readonly type: string;
  /**
   * Per-connection per-sender sequence number, starting at 1, incremented by
   * the SENDER for each message. Broker counters and daemon counters are
   * independent even when both connections originate from the same client.
   */
  readonly seq: number;
}

// ---------------------------------------------------------------------------
// Capabilities (data shape only — handshake flow is tc-auj's job)
// ---------------------------------------------------------------------------

/**
 * Feature flags and version info exchanged during handshake.
 * direction: both (each side advertises its own capabilities).
 *
 * Both the broker wire and the daemon wire use this same shape; only the
 * valid WireFeature strings differ (see broker-control.ts and
 * daemon-control.ts for per-wire feature sets).
 *
 * The handshake *sequence* (who sends first, fallback logic) is defined by
 * bead tc-auj; this type is only the data shape.
 */
export interface Capabilities {
  /** Wire protocol version this endpoint implements. */
  readonly protocolVersion: typeof WIRE_PROTOCOL_VERSION;
  /**
   * Feature flags this endpoint supports.
   * Both sides advertise; the intersection is the effective feature set.
   */
  readonly features: readonly WireFeature[];
}

/**
 * Named feature flags. Extensible: unknown strings are ignored by older
 * implementations (forward-compatible).
 *
 * Valid values differ between the broker wire and the daemon wire; this type
 * is the open union that admits both sets.
 */
export type WireFeature =
  | "pane-lifecycle"    // daemon wire: pane open/close/resize events
  | "layout-updates"   // daemon wire: structured window layout pushes
  | "focus-events"     // daemon wire: active-pane focus notifications
  | "input-forwarding" // daemon wire: client→daemon key/text input
  | "sessions-watch"   // broker wire: push notifications on session-set changes
  | "session-create"   // broker wire: client may request a new session
  | "session-destroy"  // broker wire: client may request a session be killed
  | "session-claim"    // broker wire: client may obtain a daemon endpoint by session
  | (string & Record<never, never>); // open-ended for future features

// ---------------------------------------------------------------------------
// Type guards — runtime narrowing without external schema libraries
// ---------------------------------------------------------------------------

/**
 * Checks whether a value looks like a ControlMessage at runtime (has a
 * string `type` and a numeric `seq`). Does NOT do deep field validation —
 * use a validator library (e.g. zod) if you need full schema validation.
 *
 * This guard is wire-agnostic: it accepts messages from both the broker wire
 * and the daemon wire.
 */
export function isControlMessage(value: unknown): value is MessageBase {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as Record<string, unknown>)["type"] === "string" &&
    "seq" in value &&
    typeof (value as Record<string, unknown>)["seq"] === "number"
  );
}
