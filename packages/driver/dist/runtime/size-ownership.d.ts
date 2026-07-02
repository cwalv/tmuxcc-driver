/**
 * Size-ownership policy — who among peer clients drives the session size.
 *
 * S3 "Geometry among peers" / D4 policy layer (tc-76m8.3). This is the POLICY
 * that sits on top of D4's frozen MECHANISM. D4 (ownership-seams-decisions.md)
 * ratified the mechanism: the driver holds ONE tmux `-CC` client per session
 * (always FULL); every VS Code window is a driver-side client multiplexed onto
 * it, and `resize.request → refresh-client -C WxH` sets that one tmux client's
 * size. "Size ownership" is therefore purely driver-side — which client's
 * `resize.request` is allowed through; non-owners' resizes are dropped. The
 * mechanism is unchanged here.
 *
 * What this adds is the policy for WHO owns, window-size-`latest` style:
 * ownership follows activity — the most-recently-ACTIVE client owns the size.
 * The active human gets native-perfect geometry automatically; the idle window
 * absorbs the degradation, no gesture required. Two signals count as activity
 * (defined by the bead): `input` traffic per client identity, and an explicit
 * `client.focus` message from the extension. Mere connection is NOT activity —
 * a freshly-attached idle peer must not seize size from the client in use.
 * `resize.request` is NOT activity either: resizing a background window must not
 * steal ownership.
 *
 * ## Debounce — the anti-thrash guarantee
 *
 * S3 names thrash (ping-ponging reflows under simultaneous typing) as the risk.
 * The debounce is a hysteresis on the CURRENT OWNER's silence: a challenger
 * (a non-owner that shows activity) only wins after the current owner has been
 * silent for `debounceMs`. Any activity from the owner cancels the pending
 * reassignment. Consequences:
 *
 *   - Alternation (AC1): owner goes idle, a challenger keeps typing → after
 *     `debounceMs` of owner-silence the challenger wins. A clean handoff.
 *   - Rapid interleave (AC2): both peers typing within `debounceMs` of each
 *     other → the owner's activity keeps cancelling the pending timer, so the
 *     timer never fires and ownership never flips. No oscillation.
 *
 * The timer measures owner-silence, so repeated challenger activity does NOT
 * restart it — a challenger that types once and stops still wins once the owner
 * has been quiet long enough (it is the more-recently-active client). The
 * `pending` challenger always tracks the latest challenger, so whoever is most
 * recent at the moment owner-silence elapses is the one promoted.
 *
 * No explicit "hold ownership" escape hatch is built (S3 defers it unless the
 * debounce proves insufficient in practice).
 *
 * ## Keying
 *
 * Clients are keyed by an opaque, caller-supplied string (the durable client
 * identity from D2 when present, else the connection id). The policy never
 * interprets the key; it only compares for equality.
 *
 * @module runtime/size-ownership
 */
import type { Clock } from "../state/coalescer.js";
/** Default owner-silence hold before a challenger may take size ownership. */
export declare const DEFAULT_SIZE_OWNERSHIP_DEBOUNCE_MS = 250;
/** Options for {@link createSizeOwnershipPolicy}. */
export interface SizeOwnershipPolicyOptions {
    /**
     * Owner-silence hold (ms). A challenger wins only after the current owner has
     * been silent this long. Defaults to {@link DEFAULT_SIZE_OWNERSHIP_DEBOUNCE_MS}.
     */
    readonly debounceMs?: number;
    /**
     * Clock for `setTimeout`/`clearTimeout`/`now`. Defaults to the real clock;
     * tests inject a synthetic clock to advance time deterministically.
     */
    readonly clock?: Clock;
    /**
     * Called synchronously whenever the size owner changes — including the first
     * candidate becoming owner, and the owner leaving (ownerKey `null` when no
     * candidate remains). The session-proxy uses this to re-apply the new owner's
     * last-known viewport size so tmux reflows to it immediately.
     */
    readonly onOwnerChange?: (ownerKey: string | null) => void;
}
/**
 * Per-session size-ownership policy. One instance per session-proxy; all of the
 * session's clients register here and their activity drives ownership.
 */
export interface SizeOwnershipPolicy {
    /**
     * Register a client. `candidate` is false for clients that can never own size
     * (tmux `attach -r` parity: `ignore-size`/`read-only` attach flags) — they are
     * tracked so removal is symmetric but never become owner. The first candidate
     * registered becomes the owner immediately (no debounce — nothing to contend).
     */
    addClient(key: string, candidate: boolean): void;
    /**
     * Deregister a client (transport closed). If the departing client was the
     * owner, ownership passes immediately (no debounce) to the most-recently-active
     * remaining candidate, or to `null` if none remain.
     */
    removeClient(key: string): void;
    /**
     * Record an activity signal (`input` or `client.focus`) from a client. Only
     * candidates affect ownership; activity from a non-candidate (or an unknown
     * key) is ignored. If the active client is not already the owner, it becomes
     * the pending challenger and — after `debounceMs` of owner-silence — the owner.
     */
    noteActivity(key: string): void;
    /** True iff `key` is the current size owner. */
    isSizeOwner(key: string): boolean;
    /** The current owner key, or `null` if the session has no size owner. */
    readonly owner: string | null;
    /** Cancel any pending timer. Called on session teardown. */
    dispose(): void;
}
/**
 * Build a {@link SizeOwnershipPolicy}.
 *
 * @see the module docstring for the debounce semantics and the D4/S3 rationale.
 */
export declare function createSizeOwnershipPolicy(opts?: SizeOwnershipPolicyOptions): SizeOwnershipPolicy;
//# sourceMappingURL=size-ownership.d.ts.map