/**
 * Verb-origin registry — causality attribution for creation deltas (tc-ozk.2).
 *
 * @module runtime/verb-origin
 *
 * # Why this exists
 *
 * `pane.opened` / `window.added` carry `origin: {connectionId, requestId}` when
 * they were caused by a wire verb (split-pane / open-window / break-pane), and
 * carry NO origin when foreign (native tmux client, script). The session-proxy
 * is the only party that knows who caused what: tc-ozk.1 made the creating
 * verbs RETURN their effect ids in `command.response`, so the daemon already
 * correlates (originating connection + requestId) → (newPaneId / newWindowId).
 * This registry holds that correlation between the moment a verb replies and
 * the moment the corresponding creation delta is emitted.
 *
 * # Record / lookup, not record / consume-on-emit
 *
 * The lookup is consulted by `diffModel` (projection.ts) — the single place
 * that emits creation deltas. `diffModel` runs on BOTH paths:
 *
 *   - the diff/requery path (requery.ts): once per model transition;
 *   - the EVENT path (serve.ts): once PER CONNECTED CLIENT for the same model
 *     transition (each client re-derives its own deltas from the shared model).
 *
 * Because the same new pane is emitted to every client, the lookup must return
 * the SAME origin for all of them — so it is a read-only, idempotent lookup,
 * NOT a one-shot consume. An entry is cleared explicitly when the pane / window
 * LEAVES the model (its creation can never be re-announced for that id) and is
 * additionally bounded by a TTL + size cap so a verb whose effect never
 * materialises (defensive — a returned id always materialises in practice)
 * cannot leak the map.
 *
 * # No ordering assumption
 *
 * The verb reply may arrive BEFORE or AFTER the pane's delta:
 *   - reply first → `record()` runs, then `diffModel` looks it up → tagged.
 *   - delta first → `diffModel` finds no entry → the pane is emitted UNTAGGED;
 *     the host still binds it by the `sendVerb`-returned id (tc-ozk.1). The
 *     late `record()` is then a no-op for that already-emitted delta (the
 *     attribution degrades to "untagged but correctly bound", never mis-tagged).
 *   This decoupling is the whole point of a registry rather than inline tagging.
 */
/**
 * Default time-to-live for a recorded origin (ms). An entry that is never
 * matched by a creation delta within this window is evicted on the next access.
 * Generous: a verb reply and its pane.opened are normally within one tmux
 * round-trip (sub-millisecond to low-ms); 30 s tolerates a slow requery cycle
 * while still bounding a leaked entry's lifetime.
 */
const DEFAULT_TTL_MS = 30_000;
/**
 * Hard cap on the number of live entries. Defends against a pathological burst
 * of verbs whose effects never materialise. When exceeded, the oldest entries
 * are evicted first (insertion-ordered Map). Far above any realistic count of
 * in-flight creating verbs.
 */
const DEFAULT_MAX_ENTRIES = 1024;
/**
 * Create a {@link VerbOriginRegistry}.
 */
export function createVerbOriginRegistry(opts = {}) {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const now = opts.now ?? (() => Date.now());
    // Keyed by the wire id STRING (PaneId and WindowId share the string space
    // only nominally — "p1" vs "w1" never collide — so one Map is safe and lets
    // lookup() accept either kind without a discriminant).
    const entries = new Map();
    function evictExpired() {
        if (entries.size === 0)
            return;
        const cutoff = now() - ttlMs;
        for (const [key, entry] of entries) {
            if (entry.recordedAtMs < cutoff) {
                entries.delete(key);
            }
        }
    }
    function set(key, origin) {
        const recordedAtMs = now();
        entries.set(key, { origin, recordedAtMs });
        // Size cap: evict oldest (insertion order) until under the limit. Combined
        // with the TTL sweep this bounds the map even under a verb storm whose
        // effects never materialise.
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined)
                break;
            entries.delete(oldest);
        }
    }
    return {
        record(paneId, windowId, connectionId, requestId) {
            evictExpired();
            const origin = { connectionId, requestId };
            set(paneId, origin);
            set(windowId, origin);
        },
        lookup(id) {
            const entry = entries.get(id);
            if (entry === undefined)
                return undefined;
            if (entry.recordedAtMs < now() - ttlMs) {
                entries.delete(id);
                return undefined;
            }
            return entry.origin;
        },
        clear(id) {
            entries.delete(id);
        },
    };
}
//# sourceMappingURL=verb-origin.js.map