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
export const WIRE_PROTOCOL_VERSION = 3 as const;

// ---------------------------------------------------------------------------
// Shared envelope
// ---------------------------------------------------------------------------

/**
 * Every control-plane message on both the server-proxy wire and the session-proxy wire
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
   * the SENDER for each message. ServerProxy counters and session-proxy counters are
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
 * Both the server-proxy wire and the session-proxy wire use this same shape; only the
 * valid WireFeature strings differ (see server-proxy-control.ts and
 * session-proxy-control.ts for per-wire feature sets).
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
 * Durable client identity presented at handshake (D2, tc-4b6k.1).
 * direction: client→proxy (carried on `client.capabilities`, both wires).
 *
 * The enabler for every per-client fact (binding intent D3, per-client size D4):
 * before D2 the wire had no notion of WHICH client is connected, so a per-client
 * fact had no axis to hang on. In this revision the identity is CARRIED AND
 * LOGGED ONLY — no behavior depends on it yet. Both proxies capture it, log it
 * on connect, and surface connected identities in their `*.info` payloads.
 *
 * NOTE: this is a sibling of {@link Capabilities} on the client.capabilities
 * MESSAGE, not a field inside `Capabilities` — the server also advertises
 * `Capabilities` and has no identity.
 */
export interface ClientIdentity {
  /**
   * Durable client identity string, STABLE ACROSS the client's own reloads (a
   * VS Code window reload presents the same id). OPAQUE to the driver — it is
   * the key later beads (D3/D4) use to store/serve per-(object, client) facts.
   * The VS Code client derives it from the workspace, but the wire does not
   * encode host vocabulary (invariant): the derivation is a client-side detail.
   * Distinct durable clients MUST present distinct ids; the same durable client
   * MUST present the same id across reconnects.
   */
  readonly id: string;
  /**
   * Optional human-readable label for logs/diagnostics (e.g. a workspace
   * basename). NEVER load-bearing — the driver keys on `id`; `label` is
   * display-only and may be absent, empty, or non-unique.
   */
  readonly label?: string;
}

/**
 * Format a {@link ClientIdentity} for a one-line log (D2, tc-4b6k.1).
 *
 * Both proxies log the connecting client's identity on connect ("carried and
 * logged only"). Returns `"<anonymous>"` when no identity was advertised, and
 * `id` (optionally with a `label` suffix) otherwise.
 */
export function describeClientIdentity(identity: ClientIdentity | undefined): string {
  if (identity === undefined) return "<anonymous>";
  return identity.label !== undefined && identity.label.length > 0
    ? `${identity.id} (${identity.label})`
    : identity.id;
}

/**
 * Per-client tmux-parity attach flags (D4/D8, decisions §2.1).
 *
 * The core vocabulary mirrors tmux(1) client flags. The wider parity map
 * (active-pane, pause-after, no-detach-on-destroy, session groups) is reserved
 * prose in PROTOCOL.md §12, not typed here. `pullHydration` is tmuxcc-native
 * (no tmux counterpart): it negotiates which side owns the hydration replay for
 * this client.
 */
export interface ClientFlags {
  /**
   * tmux-parity `ignore-size`: this client never reports its viewport, so its
   * windows contribute nothing to tmux's size arbitration (tc-cvny). The
   * session-proxy drops this client's `resize.request` messages; every other
   * client reports its windows per-window (`refresh-client -C @<win>:WxH`).
   */
  readonly ignoreSize?: boolean;
  /**
   * tmux-parity `read-only`: the client attaches as an observer. CAVEAT
   * (decisions §2.1, verified in tmux source): over control mode, `read-only`
   * does NOT bind the `-CC` command channel — its authority semantics are
   * DRIVER-ENFORCED, never delegated to tmux's flag. The protocol CARRIES
   * the flag; the driver owns what it means.
   *
   * Driver enforcement (tc-76m8.2): when `readOnly` is true the session-proxy
   *   - SILENTLY SWALLOWS `input.*` messages (the extension owns the
   *     user-facing "You are observing" toast — the driver stays quiet).
   *   - REJECTS all other mutating `command.request` verbs with a typed
   *     `command.response { ok: false, code: "read-only" }`.
   *   - Passes ALL reads/snapshot/delta messages normally.
   *
   * Advertised in the session-proxy's handshake as the `"client-read-only"`
   * feature string (D9 pattern) so the extension offers the mode only when
   * the driver supports it.
   */
  readonly readOnly?: boolean;
  /**
   * tc-76m8.28: this client requests each pane's hydration replay EXPLICITLY
   * (`pane.attach`) — the session-proxy must NOT push the unsolicited
   * addClient-time bulk replay (tc-5quo) to it.
   *
   * Why this exists: the addClient-time push captures tmux's grid at attach,
   * BEFORE the client has converged tmux to its tabs' geometry. For a client
   * that gates its own replay on geometry settling (the extension's
   * resize-then-restore gate, tc-76m8.24), that early stale-geometry capture
   * is at best redundant (overwritten by the client's own gated `pane.attach`
   * replay) and at worst lands history rows in-viewport on an open tab where
   * the subsequent resize's SIGWINCH redraw destroys them. A client that
   * declares `pullHydration` owns the WHEN of every replay; the driver's only
   * hydration entry point for it is `pane.attach`.
   *
   * Disconnect-gap recovery moves with the pull: the client's `pane.attach`
   * replay is the same full-history capture, so bytes emitted while the
   * client was away still reach it — just at the client's chosen moment.
   *
   * Absent/false → the tc-5quo bulk-push contract is unchanged (clients that
   * never send `pane.attach` still get hydrated).
   */
  readonly pullHydration?: boolean;
}

/**
 * Named feature flags. Extensible: unknown strings are ignored by older
 * implementations (forward-compatible).
 *
 * Valid values differ between the server-proxy wire and the session-proxy wire; this type
 * is the open union that admits both sets.
 */
export type WireFeature =
  | "pane-lifecycle"    // session-proxy wire: pane open/close/resize events
  | "layout-updates"   // session-proxy wire: structured window layout pushes
  | "focus-events"     // session-proxy wire: active-pane focus notifications
  | "input-forwarding" // session-proxy wire: client→session-proxy key/text input
  | "client-read-only" // session-proxy wire: driver enforces read-only client mode via ClientFlags.readOnly (tc-76m8.2)
  | "sessions-watch"   // server-proxy wire: push notifications on session-set changes
  | "session-create"   // server-proxy wire: client may request a new session
  | "session-destroy"  // server-proxy wire: client may request a session be killed
  | "session-claim"    // server-proxy wire: client may obtain a session-proxy endpoint by session
  | "pane-attach"      // server-proxy wire: client may attach to a specific pane (tc-7xv.36)
  | "server-proxy-info"      // server-proxy wire: client may request a diagnostics snapshot (tc-k6v)
  | "server-proxy-metrics-http" // server-proxy wire: client may toggle the /metrics HTTP exposition (tc-44u4.4)
  | "tmux-caps"              // server-proxy wire: driver has probed tmux capabilities; info includes TmuxCapabilityMap (tc-4b6k.12)
  | (string & Record<never, never>); // open-ended for future features

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
