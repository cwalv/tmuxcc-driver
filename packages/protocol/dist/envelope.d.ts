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
/**
 * Monotonically-increasing integer identifying this schema revision.
 * Increment on any breaking schema change. Non-breaking additions do not
 * require a bump. Version negotiation flow is defined by bead tc-auj.
 */
export declare const WIRE_PROTOCOL_VERSION: 3;
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
export declare function describeClientIdentity(identity: ClientIdentity | undefined): string;
/**
 * Per-client tmux-parity attach flags (D4/D8, decisions §2.1).
 *
 * RESERVED-NOT-IMPLEMENTED in tc-4b6k.1: this type defines the protocol SLOTS
 * the two minimum flags will occupy on the future `session.attach` step (the
 * attach wire step is tc-4b6k.4; the driver behavior — owner-drives-size /
 * observer partition — is tc-4b6k.3). Nothing carries this on the wire yet; it
 * exists so later beads land on a defined shape.
 *
 * The vocabulary mirrors tmux(1) client flags. The wider parity map (per-client
 * size, active-pane, pause-after, no-detach-on-destroy, session groups) is
 * reserved prose in PROTOCOL.md §12, not typed here.
 */
export interface ClientFlags {
    /**
     * tmux-parity `ignore-size`: this client does not contribute its viewport to
     * the session's size arbitration (only the owning client drives
     * `refresh-client -C`). Reserved; the driver does not act on it yet
     * (owner-only size authority is tc-4b6k.3).
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
}
/**
 * Named feature flags. Extensible: unknown strings are ignored by older
 * implementations (forward-compatible).
 *
 * Valid values differ between the server-proxy wire and the session-proxy wire; this type
 * is the open union that admits both sets.
 */
export type WireFeature = "pane-lifecycle" | "layout-updates" | "focus-events" | "input-forwarding" | "client-read-only" | "sessions-watch" | "session-create" | "session-destroy" | "session-claim" | "pane-attach" | "server-proxy-info" | "server-proxy-metrics-http" | "tmux-caps" | (string & Record<never, never>);
/**
 * Checks whether a value looks like a ControlMessage at runtime (has a
 * string `type` and a numeric `seq`). Does NOT do deep field validation —
 * use a validator library (e.g. zod) if you need full schema validation.
 *
 * This guard is wire-agnostic: it accepts messages from both the server-proxy wire
 * and the session-proxy wire.
 */
export declare function isControlMessage(value: unknown): value is MessageBase;
//# sourceMappingURL=envelope.d.ts.map