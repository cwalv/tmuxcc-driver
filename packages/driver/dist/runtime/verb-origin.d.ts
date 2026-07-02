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
import type { PaneId, WindowId, ConnectionId } from "@tmuxcc/protocol";
import type { Origin } from "@tmuxcc/protocol";
/** Options for {@link createVerbOriginRegistry}. */
export interface VerbOriginRegistryOptions {
    /** Override the default TTL (ms). */
    readonly ttlMs?: number;
    /** Override the default max live entries. */
    readonly maxEntries?: number;
    /** Injectable clock for tests; defaults to `Date.now`. */
    readonly now?: () => number;
}
/**
 * Correlates a creating verb's returned effect ids to the connection + request
 * that caused them, so creation deltas can be stamped with their {@link Origin}.
 */
export interface VerbOriginRegistry {
    /**
     * Record that the verb from `connectionId` with `requestId` created the given
     * pane and window ids (tc-ozk.1 returned both). Both ids are keyed to the
     * SAME origin: split-pane's new pane AND open-window's new window are tagged.
     * For break-pane the returned window is the new one (the pane is re-homed),
     * so the window.added gets the origin while the (already-existing) pane id
     * record is harmless — it is cleared if the pane never re-appears.
     */
    record(paneId: PaneId, windowId: WindowId, connectionId: ConnectionId, requestId: string): void;
    /**
     * Look up the origin for a newly-created pane or window id. Returns the
     * recorded {@link Origin}, or `undefined` if foreign (no matching verb) or
     * the entry has expired. Read-only / idempotent — does NOT consume the entry,
     * so every connected client's `diffModel` pass tags the same creation
     * identically.
     */
    lookup(id: PaneId | WindowId): Origin | undefined;
    /**
     * Drop any recorded origin for `id`. Called when the pane / window leaves the
     * model (it can never be re-announced as a new creation for that id), so the
     * map does not accumulate. Idempotent.
     */
    clear(id: PaneId | WindowId): void;
}
/**
 * Create a {@link VerbOriginRegistry}.
 */
export declare function createVerbOriginRegistry(opts?: VerbOriginRegistryOptions): VerbOriginRegistry;
//# sourceMappingURL=verb-origin.d.ts.map