/**
 * Pane attention/status escape scanner (tc-76m8.1, user-stories.md S9).
 *
 * A per-pane streaming state machine that recognises notification/status
 * escapes on a pane's DECODED raw pty byte stream and reports them as typed
 * {@link PaneNotifyDetection}s. It is a PURE OBSERVER — it never modifies,
 * strips, or buffers the render-path bytes; the caller passes the same decoded
 * chunk on to the demux untouched. The bead's contract: "unrecognized/malformed
 * bytes pass through untouched, never dropped from the render path."
 *
 * # Recognised signals
 *
 *   BEL (0x07, outside any string)     → { kind: "bell" }                Tier 1
 *   ESC ] 9 ; <body> ST                → { kind: "osc9", source: osc9 }  Tier 1
 *   ESC ] 777 ; notify ; <t> ; <b> ST  → { kind: "osc9", source: osc777 }Tier 1
 *   ESC ] 9 ; 4 ; <st> ; <pr> ST       → { kind: "progress" }            Tier 2
 *   ESC ] 633 ; D ; <code> ST          → { kind: "cmd-exit" }            Tier 2
 *
 * ST (string terminator) is BEL (0x07) OR ESC \ (0x1B 0x5C), per xterm.
 *
 * OSC 0/2 (window/icon title) are NOT recognised here — they are handled by the
 * OSC title sniffer (tc-2mn8) and carry no attention signal. All other OSC
 * numbers pass through without emitting.
 *
 * OSC 1337 (iTerm2): iTerm2's public desktop-notification path is OSC 9 (which
 * we DO recognise); OSC 1337 is a grab-bag of proprietary NON-notification
 * controls (SetMark, CursorShape, file transfer, ...). Blanket-emitting a
 * Tier-1 notification for every 1337 would spam the OS notification centre, so
 * we recognise it STRUCTURALLY (parse + consume it as an OSC so it never
 * corrupts the state machine) but do not emit. See the bd note on tc-76m8.1.
 *
 * # Bounded across chunk boundaries
 *
 * The scanner instance is per-pane and persists its state (and a small
 * partial-sequence buffer) between `scan()` calls, so a sequence split across
 * `%output` chunks is recognised. The buffer is bounded by {@link MAX_OSC_BYTES}
 * — an over-long unterminated sequence is a garbage abort (reset to IDLE),
 * never unbounded growth. A BEL that terminates a DCS/APC/PM/SOS string is
 * consumed by the STRING state and NOT miscounted as a bell.
 *
 * # Emission volume
 *
 * The scanner emits EVERY recognised signal — rate-limiting/coalescing against
 * storms is a SEPARATE concern ({@link PaneNotifyRateLimiter}), applied by the
 * pipeline at emit time so detection stays pure and unit-testable.
 *
 * @module parser/notify-scanner
 */
import type { PaneNotifyKind, PaneNotifyPayload } from "@tmuxcc/protocol";
/**
 * One recognised attention/status signal. Shape-compatible with the wire
 * {@link PaneNotifyMessage} minus the transport fields (type/seq/paneId).
 */
export interface PaneNotifyDetection {
    readonly kind: PaneNotifyKind;
    /** Kind-scoped payload; absent for `bell`. */
    readonly payload?: PaneNotifyPayload;
}
/**
 * Per-pane streaming attention/status scanner.
 *
 * Instantiate one per pane. Feed decoded raw pty bytes (the same bytes that go
 * to the demux) through {@link scan}. The returned detections are surfaced as
 * `pane.notify` events; the input bytes are NOT modified.
 *
 * NOT re-entrant: call `scan()` sequentially, never in parallel.
 */
export declare class PaneNotifyScanner {
    private _state;
    /** Accumulates the current OSC's content bytes (everything after `ESC ]`). */
    private _buf;
    private _bufLen;
    /** Length of the current DCS/APC/PM/SOS string body (bound check only). */
    private _strLen;
    /**
     * Feed a chunk of decoded pty bytes. Returns every signal recognised in this
     * chunk (possibly completing a sequence begun in a prior chunk). Does NOT
     * modify `chunk`.
     */
    scan(chunk: Uint8Array): PaneNotifyDetection[];
    /** Append one OSC content byte; returns false on overflow. */
    private _pushOscByte;
    /**
     * A terminator arrived: parse the accumulated OSC content, reset to IDLE, and
     * return a detection (or null for an OSC we recognise structurally but do not
     * surface, e.g. OSC 0/2 titles or OSC 1337).
     */
    private _finishOsc;
}
/**
 * Parse an OSC's content (everything between `ESC ]` and the terminator) into a
 * detection, or null when it is not an attention/status signal we surface.
 */
export declare function parseOscContent(content: string): PaneNotifyDetection | null;
//# sourceMappingURL=notify-scanner.d.ts.map