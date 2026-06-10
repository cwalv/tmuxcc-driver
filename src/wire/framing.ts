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
import { paneId } from "./ids.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic byte that starts every data-plane frame. Value 0xCC. */
export const FRAME_MAGIC = 0xcc as const;

/**
 * Byte offset of each fixed header field.
 * @internal
 */
const OFF_MAGIC = 0; // 1 byte
const OFF_SEQ = 1; // 4 bytes (uint32 BE)
const OFF_PAYLEN = 5; // 4 bytes (uint32 BE)
const OFF_IDLEN = 9; // 2 bytes (uint16 BE)
const OFF_PANEID = 11; // variable (IDLEN bytes)

/** Minimum number of bytes needed to read MAGIC + SEQ + PAYLEN + IDLEN. */
const MIN_HEADER_BYTES = 11;

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
export const MAX_FRAME = 8_388_608; // 8 MiB (8 * 1024 * 1024)

// ---------------------------------------------------------------------------
// Decoded frame
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

const _encoder = new TextEncoder();

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
export function encodeFrame(id: PaneId, seq: number, payload: Uint8Array): Uint8Array {
  const idBytes = _encoder.encode(id as string);

  if (idBytes.length > 0xffff) {
    throw new RangeError(`paneId UTF-8 encoding exceeds maximum length of 65535 bytes`);
  }
  if (payload.length > 0xffffffff) {
    throw new RangeError(`payload length exceeds maximum of 4294967295 bytes`);
  }

  const frameLen = MIN_HEADER_BYTES + idBytes.length + payload.length;
  const frame = new Uint8Array(frameLen);
  const view = new DataView(frame.buffer);

  // MAGIC
  frame[OFF_MAGIC] = FRAME_MAGIC;

  // SEQ — uint32 big-endian
  view.setUint32(OFF_SEQ, seq >>> 0, false);

  // PAYLEN — uint32 big-endian
  view.setUint32(OFF_PAYLEN, payload.length >>> 0, false);

  // IDLEN — uint16 big-endian
  view.setUint16(OFF_IDLEN, idBytes.length, false);

  // PANEID bytes
  frame.set(idBytes, OFF_PANEID);

  // PAYLOAD bytes
  frame.set(payload, OFF_PANEID + idBytes.length);

  return frame;
}

// ---------------------------------------------------------------------------
// Streaming decoder
// ---------------------------------------------------------------------------

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
export class FrameDecoder {
  /** Byte chunks accumulated between `push` calls. */
  private _chunks: Uint8Array[] = [];
  /** Total bytes currently buffered. */
  private _bufferedLen = 0;

  /**
   * Feed a new byte chunk to the decoder.
   *
   * Returns all complete frames decoded from the current buffer (may be zero,
   * one, or many). Any partial frame at the end remains buffered for the next
   * call.
   *
   * @throws {RangeError} if a frame starts with a byte that is not `FRAME_MAGIC`.
   */
  push(chunk: Uint8Array): DataFrame[] {
    if (chunk.length === 0) return [];

    this._chunks.push(chunk);
    this._bufferedLen += chunk.length;

    const frames: DataFrame[] = [];

    while (this._bufferedLen >= MIN_HEADER_BYTES) {
      // Peek at the fixed header without materialising the full buffer yet.
      const header = this._peekBytes(MIN_HEADER_BYTES);
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

      // Verify magic.
      const magic = header[0];
      if (magic !== FRAME_MAGIC) {
        throw new RangeError(
          `data-plane framing error: expected magic byte 0xCC, got 0x${magic!.toString(16).padStart(2, "0")} — stream may be corrupted`,
        );
      }

      const payLen = view.getUint32(OFF_PAYLEN, false);
      const idLen = view.getUint16(OFF_IDLEN, false);

      // Reject oversized frames before buffering grows beyond the cap.
      if (payLen > MAX_FRAME) {
        throw new RangeError(
          `data-plane framing error: PAYLEN ${payLen} exceeds MAX_FRAME cap of ${MAX_FRAME} bytes — possible garbage or hostile frame`,
        );
      }

      const totalFrameLen = MIN_HEADER_BYTES + idLen + payLen;

      if (this._bufferedLen < totalFrameLen) {
        // Not enough bytes yet — wait for more.
        break;
      }

      // We have a complete frame. Materialise exactly `totalFrameLen` bytes.
      const frameBytes = this._consumeBytes(totalFrameLen);
      const frameView = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);

      const seq = frameView.getUint32(OFF_SEQ, false);

      const idStart = OFF_PANEID;
      const idEnd = idStart + idLen;
      const idRaw = frameBytes.subarray(idStart, idEnd);
      const idStr = new TextDecoder().decode(idRaw);

      const payStart = idEnd;
      const payEnd = payStart + payLen;
      // Copy payload into an independent Uint8Array so the consumer is not
      // tied to the internal buffer.
      const payload = frameBytes.slice(payStart, payEnd);

      frames.push({ paneId: paneId(idStr), seq, payload });
    }

    return frames;
  }

  /**
   * Return a view of exactly `n` bytes from the front of the buffer without
   * consuming them. Returns a new Uint8Array (does not mutate `_chunks`).
   * @internal
   */
  private _peekBytes(n: number): Uint8Array {
    // Fast path: the first chunk already has enough bytes.
    if (this._chunks.length > 0 && this._chunks[0]!.length >= n) {
      return this._chunks[0]!.subarray(0, n);
    }
    // Slow path: copy bytes into a new buffer without removing them from _chunks.
    const out = new Uint8Array(n);
    let written = 0;
    for (const chunk of this._chunks) {
      if (written >= n) break;
      const needed = n - written;
      if (chunk.length <= needed) {
        out.set(chunk, written);
        written += chunk.length;
      } else {
        out.set(chunk.subarray(0, needed), written);
        written += needed;
      }
    }
    return out;
  }

  /**
   * Remove and return exactly `n` bytes from the front of the buffer.
   * @internal
   */
  private _consumeBytes(n: number): Uint8Array {
    this._bufferedLen -= n;

    // Fast path: the first chunk is exactly the right size.
    if (this._chunks.length > 0 && this._chunks[0]!.length === n) {
      return this._chunks.shift()!;
    }

    // Fast path: the first chunk has more than enough.
    if (this._chunks.length > 0 && this._chunks[0]!.length > n) {
      const chunk = this._chunks[0]!;
      const result = chunk.subarray(0, n);
      this._chunks[0] = chunk.subarray(n);
      return result;
    }

    // Slow path: gather from multiple chunks into a new buffer and trim _chunks.
    const out = new Uint8Array(n);
    let written = 0;

    while (written < n) {
      const chunk = this._chunks[0];
      if (chunk === undefined) break; // should not happen if bufferedLen is tracked correctly

      const needed = n - written;
      if (chunk.length <= needed) {
        // Consume entire chunk.
        out.set(chunk, written);
        written += chunk.length;
        this._chunks.shift();
      } else {
        // Consume a prefix of the chunk; leave the rest.
        out.set(chunk.subarray(0, needed), written);
        written += needed;
        this._chunks[0] = chunk.subarray(needed);
      }
    }

    return out;
  }
}

// ---------------------------------------------------------------------------
// Convenience: decode a single frame from a complete byte buffer
// ---------------------------------------------------------------------------

/**
 * Decode a single data-plane frame from a complete byte buffer.
 *
 * Use this when you already have a complete, isolated frame (e.g. in tests).
 * For streaming decoding use `FrameDecoder`.
 *
 * @throws {RangeError} if the buffer does not start with `FRAME_MAGIC`.
 * @throws {RangeError} if the buffer is too short to contain a complete frame.
 */
export function decodeFrame(buf: Uint8Array): DataFrame {
  if (buf.length < MIN_HEADER_BYTES) {
    throw new RangeError(`buffer too short: ${buf.length} < ${MIN_HEADER_BYTES} minimum header bytes`);
  }

  if (buf[OFF_MAGIC] !== FRAME_MAGIC) {
    throw new RangeError(
      `data-plane framing error: expected magic byte 0xCC, got 0x${buf[OFF_MAGIC]!.toString(16).padStart(2, "0")}`,
    );
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const seq = view.getUint32(OFF_SEQ, false);
  const payLen = view.getUint32(OFF_PAYLEN, false);
  const idLen = view.getUint16(OFF_IDLEN, false);

  // Reject oversized frames before allocating.
  if (payLen > MAX_FRAME) {
    throw new RangeError(
      `data-plane framing error: PAYLEN ${payLen} exceeds MAX_FRAME cap of ${MAX_FRAME} bytes — possible garbage or hostile frame`,
    );
  }

  const expectedLen = MIN_HEADER_BYTES + idLen + payLen;
  if (buf.length < expectedLen) {
    throw new RangeError(
      `buffer too short: ${buf.length} bytes, frame requires ${expectedLen} bytes`,
    );
  }

  const idStr = new TextDecoder().decode(buf.subarray(OFF_PANEID, OFF_PANEID + idLen));
  const payload = buf.slice(OFF_PANEID + idLen, OFF_PANEID + idLen + payLen);

  return { paneId: paneId(idStr), seq, payload };
}
