/**
 * Per-pane scrollback byte-buffer store.
 *
 * @module state/scrollback
 *
 * # Design
 *
 * ## Keying
 * Buffers are keyed by `PaneId` directly (not by the `ScrollbackHandle` opaque
 * number). `PaneId` is already the canonical per-pane identity used everywhere
 * in the sessionProxy, so keying by it avoids a needless indirection layer. The
 * `scrollbackHandle` field on `Pane` was reserved as an opaque slot in the
 * model spec; this module documents the decision to use `PaneId` instead — the
 * reducer (tc-5dd) should do the same when calling `append`/`drop`.
 *
 * ## Internal structure (chunk list + running total)
 * Each pane's buffer is stored as `{ chunks: Uint8Array[], totalBytes: number }`.
 * Append is O(1) amortized: push the incoming chunk, add its length to the
 * total. Eviction runs only when `totalBytes > capBytes`, iterating from the
 * front of the chunk list, either dropping whole chunks or slicing the first
 * chunk when the byte boundary falls inside it — so eviction is byte-accurate,
 * not chunk-granular. `getContents` concatenates the chunk list into a single
 * fresh Uint8Array, which is O(retained bytes); the caller (projection tc-7gp)
 * calls it once per pane on snapshot, so this is acceptable.
 *
 * ### Complexity
 * - `append(id, bytes)` — O(1) amortized; O(k) eviction where k = number of
 *   chunks dropped (bounded by total chunk count, which is bounded by the number
 *   of append calls since the last eviction).
 * - `getContents(id)` — O(n) where n = retained bytes.
 * - `size(id)`, `drop(id)`, `clear()` — O(1) / O(p) (p = pane count).
 *
 * ## Cap default
 * 1 MiB (1_048_576 bytes) per pane. This is enough to hold a full terminal
 * scrollback of several thousand lines without wasting memory for typical pane
 * counts (< 100 panes per session). Callers can override via `opts.capBytes`.
 *
 * ## Raw bytes, no stringification
 * The store treats all data as opaque `Uint8Array` values. It never decodes to
 * UTF-8 or applies any transformation. Non-UTF-8 bytes are preserved as-is.
 *
 * ## No I/O
 * Pure in-memory data structure. No filesystem, network, or async operations.
 */
import type { PaneId } from "@tmuxcc/protocol";
/**
 * Store for per-pane scrollback byte buffers.
 *
 * Implementations must be mutable (methods update state in place). This is a
 * session-proxy-internal store; it is NOT serialized to the wire directly. Projection
 * (tc-7gp) calls `getContents` to embed the retained bytes in a `SnapshotPane`
 * for newly-connecting clients.
 */
export interface PaneBufferStore {
    /**
     * Append decoded output bytes to a pane's buffer (creates the buffer if
     * absent). If the new total exceeds the byte cap, the oldest bytes are
     * evicted until the total is ≤ capBytes. Eviction is byte-accurate: the
     * boundary may fall inside a previously-appended chunk, which is sliced.
     */
    append(paneId: PaneId, bytes: Uint8Array): void;
    /**
     * Current buffered contents for a pane (most recent bytes up to the cap),
     * oldest→newest. Returns an empty Uint8Array if the pane has no buffer or
     * its buffer is empty.
     *
     * The returned array is a fresh copy — callers may hold it without aliasing
     * the internal state.
     */
    getContents(paneId: PaneId): Uint8Array;
    /**
     * Total bytes currently retained for a pane. Returns 0 if the pane has no
     * buffer or has been dropped.
     */
    size(paneId: PaneId): number;
    /**
     * Drop a pane's buffer entirely (call on pane close). Subsequent calls to
     * `getContents`/`size` return empty/0 for that paneId.
     */
    drop(paneId: PaneId): void;
    /**
     * Remove all buffers (full reset). After this call `getContents` returns
     * empty for every previously-known paneId.
     */
    clear(): void;
}
/** Default per-pane byte cap: 1 MiB. */
export declare const DEFAULT_CAP_BYTES = 1048576;
/**
 * Create a new `PaneBufferStore`.
 *
 * @param opts.capBytes - Maximum bytes retained per pane (default 1 MiB).
 *   When a pane's total exceeds this limit, oldest bytes are evicted
 *   byte-accurately until the total is ≤ capBytes. A value of 0 is valid and
 *   means "no retention at all" (every append evicts everything).
 */
export declare function createPaneBufferStore(opts?: {
    capBytes?: number;
}): PaneBufferStore;
//# sourceMappingURL=scrollback.d.ts.map