/**
 * Data-plane binary frame format for the tmuxcc wire protocol.
 *
 * # Why binary, not JSON/base64?
 *
 * The data plane carries raw terminal output bytes for panes. A busy terminal
 * can push megabytes per second. JSON encoding would add per-byte string-escape
 * overhead; base64 would inflate every payload by 33%. Binary framing carries
 * the payload bytes as-is, with only a small fixed-overhead header. At hot-path
 * volumes this difference is material.
 *
 * The control plane (tc-auj) uses JSON because it is low-volume and benefits
 * from human-readability. The data plane does not.
 *
 * # Frame layout
 *
 * Every frame is a contiguous byte sequence with this layout:
 *
 * ```
 * Offset  Size  Field
 * ------  ----  -------------------------------------------------------
 *      0     1  MAGIC  — 0xCC (mnemonic: "control-client")
 *      1     4  SEQ    — uint32, big-endian; per-pane monotonic counter
 *      5     4  PAYLEN — uint32, big-endian; payload byte length
 *      9     2  IDLEN  — uint16, big-endian; paneId UTF-8 byte length
 *     11  IDLEN  PANEID — paneId encoded as UTF-8 bytes (variable length)
 *  11+IDLEN PAYLEN PAYLOAD — raw terminal output bytes (opaque; any byte value)
 * ```
 *
 * Total header overhead per frame: 11 bytes + len(paneId as UTF-8).
 *
 * Field sizes and rationale:
 *   - MAGIC (1 byte): Allows a decoder to detect framing errors and re-sync on
 *     a corrupted stream. Value 0xCC was chosen as unlikely to appear at the
 *     start of an accidental alignment (not a printable ASCII or valid UTF-8
 *     start byte for common paneId strings).
 *   - SEQ (4 bytes, uint32): 4 billion frames per pane before wrap; at 1 MB/s
 *     of 4 KB frames that is ~48 years. Wrapping at 0xFFFFFFFF is allowed;
 *     clients detect it as a gap of exactly UINT32_MAX or a rollover.
 *   - PAYLEN (4 bytes, uint32): supports frames up to ~4 GB in the field.
 *     The decoder enforces a MAX_FRAME cap (8 MiB); frames with PAYLEN above
 *     that cap are rejected with a RangeError before any buffering or
 *     allocation — the caller must tear down the connection.
 *   - IDLEN (2 bytes, uint16): supports paneId strings up to 65535 UTF-8 bytes.
 *     Current ids are short ("p0", "s0-p3") so this is over-provisioned; 2
 *     bytes keeps the header word-aligned without a full 4-byte field.
 *   - PANEID: variable-length UTF-8. PaneId is a branded string of unknown
 *     length, so we length-prefix it rather than using a fixed slot. This is
 *     option (a) from the design doc: no separate numeric handle needed.
 *     Trade-off: a numeric alias (option b) would shrink the header for long ids
 *     at the cost of a state table (alias↔PaneId mapping). For the current id
 *     scheme ("p0"…"pN"), option (a) costs only 2–4 extra bytes per frame.
 *   - PAYLOAD: raw bytes, opaque. May contain 0x00, 0xFF, invalid UTF-8, or any
 *     other byte value. Never base64 or escaped.
 *
 * # Sequence numbers
 *
 * SEQ is a per-pane monotonically-increasing uint32, starting at 0.  The session-proxy
 * owns the counter for each pane and increments it for every frame it emits.
 * Clients use it to:
 *   - Detect frame drops (gap in seq for the same paneId).
 *   - Restore output ordering if frames arrive out-of-order (unlikely on a local
 *     socket, but possible on a routed transport).
 *
 * Callers of `encodeFrame` pass the current seq value; the session-proxy is responsible
 * for maintaining a per-pane counter and incrementing it.
 *
 * # Streaming decoder
 *
 * TCP/pipe reads do not respect frame boundaries. `FrameDecoder` maintains an
 * internal byte buffer and accumulates chunks until a complete frame is
 * available, then emits it. Callers push raw byte chunks with `push(chunk)` and
 * collect decoded frames from the returned array. Multiple frames in a single
 * chunk are all returned; partial frames are held in the buffer.
 *
 * @module framing
 */
import type { PaneId } from "./ids.js";
/** Magic byte that starts every data-plane frame. Value 0xCC. */
export declare const FRAME_MAGIC: 204;
/**
 * Maximum permitted payload length in bytes (8 MiB).
 *
 * The PAYLEN field is a u32, which can theoretically reach ~4 GiB. Without a
 * cap, a sender that writes a frame header with a large PAYLEN but never
 * delivers the payload body causes FrameDecoder to pin up to PAYLEN bytes of
 * buffered chunks indefinitely. The cap is enforced on the decode path so that
 * untrusted transports (network sockets) cannot trigger unbounded allocation.
 *
 * 8 MiB is chosen as well above any legitimate single frame: the session-proxy's
 * practical chunk size is ~4 KiB of terminal output, and the flow-control
 * high-water mark is 256 KiB. 8 MiB leaves a 32× headroom buffer for large
 * burst payloads while bounding the worst-case allocation to a reasonable
 * amount. If legitimate frames ever exceed this limit, raise the constant and
 * document the reason.
 */
export declare const MAX_FRAME = 8388608;
/**
 * A fully decoded data-plane frame.
 *
 * `payload` is the raw terminal output bytes for `paneId`. It may contain any
 * byte value including 0x00, 0xFF, and sequences that are not valid UTF-8.
 * Do NOT convert to string without an explicit charset decoder (e.g. the pane's
 * terminal emulator).
 */
export interface DataFrame {
    /** Which pane's output stream this frame belongs to. */
    readonly paneId: PaneId;
    /** Per-pane monotonic sequence number (uint32). */
    readonly seq: number;
    /** Raw terminal output bytes. Binary; any byte value. */
    readonly payload: Uint8Array;
}
/**
 * Encode a data-plane frame into a single contiguous `Uint8Array`.
 *
 * The caller is responsible for maintaining a per-pane monotonically-increasing
 * `seq` counter and passing the current value here. `seq` is treated as a
 * uint32 (values 0 – 4294967295); wrapping is allowed.
 *
 * @param id      - Pane identifier (UTF-8 string, max 65535 bytes when encoded).
 * @param seq     - Per-pane frame sequence number (uint32, 0-based).
 * @param payload - Raw terminal output bytes. Any byte value is permitted.
 * @returns A `Uint8Array` containing the complete frame (header + payload).
 *
 * @throws {RangeError} if the UTF-8 encoding of `id` exceeds 65535 bytes.
 * @throws {RangeError} if `payload.length` exceeds 4294967295 bytes.
 */
export declare function encodeFrame(id: PaneId, seq: number, payload: Uint8Array): Uint8Array;
/**
 * Stateful streaming decoder for data-plane frames.
 *
 * Raw byte streams (from a socket or pipe) do not respect frame boundaries:
 * a single `read()` call may return a partial frame, exactly one frame, or
 * multiple frames. `FrameDecoder` buffers incomplete bytes between calls.
 *
 * Usage:
 * ```ts
 * const dec = new FrameDecoder();
 * socket.on("data", (chunk: Uint8Array) => {
 *   const frames = dec.push(chunk);
 *   for (const frame of frames) {
 *     // frame.paneId, frame.seq, frame.payload
 *   }
 * });
 * ```
 *
 * The decoder is intentionally simple — it does not implement re-sync logic
 * beyond magic-byte verification. A bad magic byte throws a `RangeError` so
 * the caller can tear down and reconnect the transport.
 */
export declare class FrameDecoder {
    /** Byte chunks accumulated between `push` calls. */
    private _chunks;
    /** Total bytes currently buffered. */
    private _bufferedLen;
    /**
     * Feed a new byte chunk to the decoder.
     *
     * Returns all complete frames decoded from the current buffer (may be zero,
     * one, or many). Any partial frame at the end remains buffered for the next
     * call.
     *
     * @throws {RangeError} if a frame starts with a byte that is not `FRAME_MAGIC`.
     */
    push(chunk: Uint8Array): DataFrame[];
    /**
     * Return a view of exactly `n` bytes from the front of the buffer without
     * consuming them. Returns a new Uint8Array (does not mutate `_chunks`).
     * @internal
     */
    private _peekBytes;
    /**
     * Remove and return exactly `n` bytes from the front of the buffer.
     * @internal
     */
    private _consumeBytes;
}
/**
 * Decode a single data-plane frame from a complete byte buffer.
 *
 * Use this when you already have a complete, isolated frame (e.g. in tests).
 * For streaming decoding use `FrameDecoder`.
 *
 * @throws {RangeError} if the buffer does not start with `FRAME_MAGIC`.
 * @throws {RangeError} if the buffer is too short to contain a complete frame.
 */
export declare function decodeFrame(buf: Uint8Array): DataFrame;
//# sourceMappingURL=framing.d.ts.map