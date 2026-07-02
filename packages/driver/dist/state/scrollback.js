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
// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------
/** Default per-pane byte cap: 1 MiB. */
export const DEFAULT_CAP_BYTES = 1_048_576; // 1 MiB
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create a new `PaneBufferStore`.
 *
 * @param opts.capBytes - Maximum bytes retained per pane (default 1 MiB).
 *   When a pane's total exceeds this limit, oldest bytes are evicted
 *   byte-accurately until the total is ≤ capBytes. A value of 0 is valid and
 *   means "no retention at all" (every append evicts everything).
 */
export function createPaneBufferStore(opts) {
    const capBytes = opts?.capBytes ?? DEFAULT_CAP_BYTES;
    const buffers = new Map();
    function getOrCreate(paneId) {
        let buf = buffers.get(paneId);
        if (buf === undefined) {
            buf = { chunks: [], totalBytes: 0 };
            buffers.set(paneId, buf);
        }
        return buf;
    }
    /**
     * Evict oldest bytes from `buf` until `buf.totalBytes <= capBytes`.
     * Eviction is byte-accurate: if the eviction boundary falls inside the first
     * chunk, that chunk is sliced so exactly the right number of bytes are kept.
     */
    function evict(buf) {
        while (buf.totalBytes > capBytes && buf.chunks.length > 0) {
            const first = buf.chunks[0];
            const excess = buf.totalBytes - capBytes;
            if (excess >= first.length) {
                // Drop the entire first chunk.
                buf.chunks.shift();
                buf.totalBytes -= first.length;
            }
            else {
                // The eviction boundary falls inside this chunk — slice it.
                buf.chunks[0] = first.subarray(excess);
                buf.totalBytes -= excess;
            }
        }
    }
    return {
        append(paneId, bytes) {
            if (bytes.length === 0)
                return;
            const buf = getOrCreate(paneId);
            buf.chunks.push(bytes);
            buf.totalBytes += bytes.length;
            if (buf.totalBytes > capBytes) {
                evict(buf);
            }
        },
        getContents(paneId) {
            const buf = buffers.get(paneId);
            if (buf === undefined || buf.totalBytes === 0)
                return new Uint8Array(0);
            // Fast path: single chunk — return a copy directly.
            if (buf.chunks.length === 1) {
                const only = buf.chunks[0];
                const out = new Uint8Array(only.length);
                out.set(only);
                return out;
            }
            // General path: concatenate chunks into a fresh buffer.
            const out = new Uint8Array(buf.totalBytes);
            let offset = 0;
            for (const chunk of buf.chunks) {
                out.set(chunk, offset);
                offset += chunk.length;
            }
            return out;
        },
        size(paneId) {
            return buffers.get(paneId)?.totalBytes ?? 0;
        },
        drop(paneId) {
            buffers.delete(paneId);
        },
        clear() {
            buffers.clear();
        },
    };
}
//# sourceMappingURL=scrollback.js.map