/**
 * OSC title sniffer — extract shell window titles from decoded pane bytes (tc-2mn8).
 *
 * Sniffs OSC 0 and OSC 2 title sequences out of the decoded terminal byte
 * stream that already flows from `%output` / `%extended-output`.  No new tmux
 * round-trips are needed: the bytes that carry the title to xterm ALREADY
 * arrive via the per-pane `%output` demux; this module extracts the title from
 * them in-stream.
 *
 * # OSC format
 *
 *   ESC ] <Ps> ; <text> <ST>
 *
 *   - ESC = 0x1B
 *   - ]   = 0x5D
 *   - Ps  = decimal integer parameter string (we care about "0" and "2")
 *   - ;   = 0x3B separator between Ps and text
 *   - text = the window title (UTF-8, arbitrary bytes except the terminator)
 *   - ST (String Terminator) = BEL (0x07) OR ESC \ (0x1B 0x5C)
 *
 * OSC 0 sets BOTH the icon name and the window title.
 * OSC 2 sets only the window title.
 * All other OSC numbers (1, 4, 8, 52, …) are passed through without updating
 * the title.
 *
 * # Cross-chunk buffering
 *
 * A sequence may span two or more `%output` chunks.  Each `OscTitleSniffer`
 * instance is per-pane and keeps an internal buffer that is accumulated until
 * a valid terminator is found (or the buffer is garbage-collected by an
 * implicit reset — see `MAX_OSC_BUFFER` below).
 *
 * # Output bytes
 *
 * The sniffer returns the decoded bytes with the OSC title sequences STRIPPED
 * (they were meant for the terminal's title machinery, not for the terminal
 * emulator's display surface).  All other bytes — including other OSC numbers
 * — are passed through unchanged.
 *
 * @module parser/osc-title-sniffer
 */
/**
 * Result of feeding bytes to an {@link OscTitleSniffer}.
 */
export interface OscSniffResult {
    /**
     * Decoded terminal bytes with OSC-0 and OSC-2 title sequences stripped.
     * All other bytes (including other OSC numbers, non-OSC escape sequences,
     * and plain terminal output) are passed through unchanged.
     *
     * In the common case (no OSC title sequence in this chunk) this may be
     * the same Uint8Array passed in, avoiding an allocation.
     */
    readonly passthrough: Uint8Array;
    /**
     * The updated pane title, or `null` if no OSC-0 / OSC-2 sequence completed
     * in this call.  When non-null the caller SHOULD update the pane model.
     */
    readonly updatedTitle: string | null;
}
/**
 * Per-pane streaming OSC title sniffer.
 *
 * Instantiate one per pane.  Feed decoded terminal bytes (from
 * `decodeOutputPayload`) through `feed()`.  When `feed()` returns a non-null
 * `updatedTitle`, update the pane's `paneTitle` in the model.
 *
 * The sniffer is NOT re-entrant: call `feed()` sequentially, never in parallel.
 */
export declare class OscTitleSniffer {
    private _state;
    /** Accumulates the raw OSC sequence bytes (ESC ] onwards). */
    private _buf;
    private _bufLen;
    /**
     * Whether the current OSC is a title-OSC (Ps === "0" or Ps === "2").
     * Set to true when we finish parsing the decimal parameter and it is 0 or 2.
     * Only meaningful after we have seen the `;` separator.
     */
    private _isTitleOsc;
    /** Accumulated decimal digits of the current OSC parameter (Ps). */
    private _paramDigits;
    /**
     * Feed a chunk of decoded terminal bytes.
     *
     * @param chunk  Decoded raw pane bytes from `decodeOutputPayload`.
     * @returns      `{ passthrough, updatedTitle }` — see {@link OscSniffResult}.
     */
    feed(chunk: Uint8Array): OscSniffResult;
    private _bufPush;
    /**
     * Called when we reach a BEL terminator.
     *
     * For title OSCs (Ps 0 or 2): extracts and returns the title; strips the
     * OSC sequence from passthrough (does NOT write to `out`).
     *
     * For non-title OSCs: passes the buffered bytes + BEL through to `out` and
     * returns null title.
     *
     * Resets state to IDLE in either case.
     */
    private _finishOscBEL;
    /**
     * Called when we reach an ESC \ string terminator.
     *
     * For title OSCs (Ps 0 or 2): extracts and returns the title; strips the
     * OSC sequence from passthrough.
     *
     * For non-title OSCs: passes the buffered bytes + ESC \ through to `out` and
     * returns null title.
     *
     * Resets state to IDLE in either case.
     */
    private _finishOscST;
    private _resetOsc;
}
//# sourceMappingURL=osc-title-sniffer.d.ts.map