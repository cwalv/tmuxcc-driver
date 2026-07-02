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
import { realClock } from "../state/coalescer.js";
/** Default owner-silence hold before a challenger may take size ownership. */
export const DEFAULT_SIZE_OWNERSHIP_DEBOUNCE_MS = 250;
/**
 * Build a {@link SizeOwnershipPolicy}.
 *
 * @see the module docstring for the debounce semantics and the D4/S3 rationale.
 */
export function createSizeOwnershipPolicy(opts = {}) {
    const debounceMs = opts.debounceMs ?? DEFAULT_SIZE_OWNERSHIP_DEBOUNCE_MS;
    const clock = opts.clock ?? realClock();
    const onOwnerChange = opts.onOwnerChange;
    /** Clients eligible to own size (attached, not ignore-size/read-only). */
    const candidates = new Set();
    /** Last activity timestamp per candidate — the tie-break on owner departure. */
    const lastActivity = new Map();
    let owner = null;
    /** Latest challenger awaiting promotion; null when none is pending. */
    let pending = null;
    /** Running while a challenge is pending; measures owner-silence. */
    let timer = null;
    function clearPending() {
        pending = null;
        if (timer !== null) {
            clock.clearTimeout(timer);
            timer = null;
        }
    }
    function setOwner(next) {
        if (next === owner)
            return;
        owner = next;
        onOwnerChange?.(owner);
    }
    /** Timer callback: the owner has been silent for `debounceMs`. */
    function promote() {
        timer = null;
        const challenger = pending;
        pending = null;
        if (challenger !== null && candidates.has(challenger)) {
            setOwner(challenger);
        }
    }
    function mostRecentCandidate() {
        let best = null;
        let bestAt = -Infinity;
        for (const key of candidates) {
            const at = lastActivity.get(key) ?? -Infinity;
            if (best === null || at > bestAt) {
                best = key;
                bestAt = at;
            }
        }
        return best;
    }
    return {
        addClient(key, candidate) {
            if (!candidate)
                return;
            candidates.add(key);
            if (owner === null) {
                // First candidate owns immediately — no contention to debounce.
                setOwner(key);
            }
        },
        removeClient(key) {
            candidates.delete(key);
            lastActivity.delete(key);
            if (pending === key)
                clearPending();
            if (owner === key) {
                // Owner left: hand off immediately (no debounce — the departed owner
                // cannot contest) to the most-recently-active remaining candidate.
                clearPending();
                setOwner(mostRecentCandidate());
            }
        },
        noteActivity(key) {
            if (!candidates.has(key))
                return; // non-candidate / unknown: not activity
            lastActivity.set(key, clock.now());
            if (key === owner) {
                // Owner reasserted — cancel any challenge in flight. This is what makes
                // rapid interleaved typing not oscillate: the owner's own activity keeps
                // resetting the challenger's owner-silence clock.
                clearPending();
                return;
            }
            // Challenger. Track the latest challenger; start the owner-silence timer
            // if one is not already counting (do NOT restart it on repeated challenger
            // activity — it measures the owner's silence, not the challenger's).
            pending = key;
            if (timer === null) {
                timer = clock.setTimeout(promote, debounceMs);
            }
        },
        isSizeOwner(key) {
            return owner === key;
        },
        get owner() {
            return owner;
        },
        dispose() {
            clearPending();
        },
    };
}
//# sourceMappingURL=size-ownership.js.map