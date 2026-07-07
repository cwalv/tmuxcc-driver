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
 * ## Keying and connection refcounting
 *
 * Clients are keyed by an opaque, caller-supplied string: the durable client
 * identity from D2 when present (else the connection id). The policy never
 * interprets the key; it only compares for equality.
 *
 * One window can hold SEVERAL connections under the same identity key at once —
 * its main session connection, an auxiliary pane-scoped connection, and a
 * transient old/new overlap across a reconnect all present the same durable
 * identity. Candidacy is therefore REFCOUNTED per key: a key is a size candidate
 * while >=1 of its live connections registered as a candidate. Only the count's
 * 0->1 edge can make a key own (the first candidate), and only its 1->0 edge (the
 * LAST candidate connection for a key closing) drops candidacy / hands off
 * ownership. Without the refcount, one connection closing would strip a
 * still-connected window's candidacy: `removeClient` fires once per transport, so
 * an auxiliary or overlapping same-identity connection closing would delete the
 * shared key out from under the connection still driving size.
 *
 * @module runtime/size-ownership
 */

import type { Clock } from "../state/coalescer.js";
import { realClock } from "../state/coalescer.js";

/** Default owner-silence hold before a challenger may take size ownership. */
export const DEFAULT_SIZE_OWNERSHIP_DEBOUNCE_MS = 250;

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
   * Register a connection for `key`. `candidate` is false for connections that
   * can never own size (tmux `attach -r` parity: `ignore-size`/`read-only` attach
   * flags) — those are ignored entirely (not refcounted). A candidate connection
   * increments `key`'s candidate refcount; the FIRST candidate for the session
   * (an ownerless session's 0->1 edge) becomes the owner immediately (no debounce
   * — nothing to contend). A further candidate connection — whether for a key
   * already present or a second key — never steals ownership on connect (mere
   * connection is not activity).
   */
  addClient(key: string, candidate: boolean): void;

  /**
   * Deregister a connection for `key` (transport closed). `wasCandidate` must
   * match the `candidate` this connection registered with — a non-candidate
   * connection closing is a no-op. Decrements `key`'s candidate refcount; only
   * when the LAST candidate connection for `key` closes (its 1->0 edge) does the
   * key stop being a candidate. If that key was the owner, ownership passes
   * immediately (no debounce) to the most-recently-active remaining candidate, or
   * to `null` if none remain. A key that still has other live candidate
   * connections keeps its candidacy and ownership untouched.
   */
  removeClient(key: string, wasCandidate: boolean): void;

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
export function createSizeOwnershipPolicy(
  opts: SizeOwnershipPolicyOptions = {},
): SizeOwnershipPolicy {
  const debounceMs = opts.debounceMs ?? DEFAULT_SIZE_OWNERSHIP_DEBOUNCE_MS;
  const clock = opts.clock ?? realClock();
  const onOwnerChange = opts.onOwnerChange;

  /**
   * Live candidate-connection count per key. A key is eligible to own size while
   * this is >=1 (present in the map); an entry at 0 is deleted, so `.has(key)` is
   * the candidacy test. Refcounting keeps one window's several same-identity
   * connections (main + pane-scoped aux + reconnect overlap) from stripping each
   * other's candidacy when any one of them closes.
   */
  const candidateRefs = new Map<string, number>();
  /** Last activity timestamp per candidate key — the tie-break on owner departure. */
  const lastActivity = new Map<string, number>();

  let owner: string | null = null;
  /** Latest challenger awaiting promotion; null when none is pending. */
  let pending: string | null = null;
  /** Running while a challenge is pending; measures owner-silence. */
  let timer: ReturnType<Clock["setTimeout"]> | null = null;

  function clearPending(): void {
    pending = null;
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  }

  function setOwner(next: string | null): void {
    if (next === owner) return;
    owner = next;
    onOwnerChange?.(owner);
  }

  /** Timer callback: the owner has been silent for `debounceMs`. */
  function promote(): void {
    timer = null;
    const challenger = pending;
    pending = null;
    if (challenger !== null && candidateRefs.has(challenger)) {
      setOwner(challenger);
    }
  }

  function mostRecentCandidate(): string | null {
    let best: string | null = null;
    let bestAt = -Infinity;
    for (const key of candidateRefs.keys()) {
      const at = lastActivity.get(key) ?? -Infinity;
      if (best === null || at > bestAt) {
        best = key;
        bestAt = at;
      }
    }
    return best;
  }

  return {
    addClient(key: string, candidate: boolean): void {
      if (!candidate) return;
      const prev = candidateRefs.get(key) ?? 0;
      candidateRefs.set(key, prev + 1);
      // Owner only on the ownerless-session edge. `owner === null` implies no key
      // is a candidate yet, so this is necessarily the session's first candidate;
      // a second connection for this key (prev>0) or a rival key never contends
      // on connect (mere connection is not activity).
      if (owner === null) {
        setOwner(key);
      }
    },

    removeClient(key: string, wasCandidate: boolean): void {
      if (!wasCandidate) return; // non-candidate connection: never refcounted
      const remaining = (candidateRefs.get(key) ?? 0) - 1;
      if (remaining > 0) {
        // Other live candidate connections for this key remain: the key is still a
        // candidate and, if it was, still the owner. Nothing changes.
        candidateRefs.set(key, remaining);
        return;
      }
      // The LAST candidate connection for this key closed — it is no longer a
      // candidate. (A negative `remaining` from a spurious double-remove lands
      // here too and is idempotent: delete of an absent key is a no-op.)
      candidateRefs.delete(key);
      lastActivity.delete(key);
      if (pending === key) clearPending();
      if (owner === key) {
        // Owner's last connection left: hand off immediately (no debounce — the
        // departed owner cannot contest) to the most-recently-active remaining
        // candidate.
        clearPending();
        setOwner(mostRecentCandidate());
      }
    },

    noteActivity(key: string): void {
      if (!candidateRefs.has(key)) return; // non-candidate / unknown: not activity
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

    isSizeOwner(key: string): boolean {
      return owner === key;
    },

    get owner(): string | null {
      return owner;
    },

    dispose(): void {
      clearPending();
    },
  };
}
