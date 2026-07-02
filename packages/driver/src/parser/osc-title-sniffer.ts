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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ESC = 0x1b;   // ESC
const OSC = 0x5d;   // ]
const ST_BEL = 0x07; // BEL — string terminator
const ST_BS = 0x5c;  // \ — second byte of ESC \ string terminator
const SEMI = 0x3b;  // ;

/**
 * Maximum number of bytes to accumulate in the OSC buffer before treating the
 * current partial sequence as garbage and resetting.  A typical shell title is
 * a few hundred bytes at most; 4 KiB is generous and prevents unbounded growth
 * if a misbehaving program emits a long un-terminated sequence.
 *
 * On overflow the buffer is cleared and the sniffer returns to IDLE, accepting
 * new sequences from that point forward.
 */
const MAX_OSC_BUFFER = 4 * 1024; // 4 KiB

// ---------------------------------------------------------------------------
// Internal state machine states
// ---------------------------------------------------------------------------

/**
 * States:
 *   IDLE          — normal terminal bytes (no OSC in progress)
 *   ESC_SEEN      — just saw 0x1B (ESC) — may start an OSC or ST
 *   OSC_PARAM     — inside `ESC ] <Ps>` (accumulating decimal digits)
 *   OSC_TEXT      — inside the text portion after `;`
 *   IN_OSC_ESC    — saw 0x1B inside an OSC text — may be ESC \ (ST)
 */
type State = "IDLE" | "ESC_SEEN" | "OSC_PARAM" | "OSC_TEXT" | "IN_OSC_ESC";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
export class OscTitleSniffer {
  private _state: State = "IDLE";

  /** Accumulates the raw OSC sequence bytes (ESC ] onwards). */
  private _buf = new Uint8Array(256);
  private _bufLen = 0;

  /**
   * Whether the current OSC is a title-OSC (Ps === "0" or Ps === "2").
   * Set to true when we finish parsing the decimal parameter and it is 0 or 2.
   * Only meaningful after we have seen the `;` separator.
   */
  private _isTitleOsc = false;

  /** Accumulated decimal digits of the current OSC parameter (Ps). */
  private _paramDigits = "";

  // ---------------------------------------------------------------------------
  // Core method
  // ---------------------------------------------------------------------------

  /**
   * Feed a chunk of decoded terminal bytes.
   *
   * @param chunk  Decoded raw pane bytes from `decodeOutputPayload`.
   * @returns      `{ passthrough, updatedTitle }` — see {@link OscSniffResult}.
   */
  feed(chunk: Uint8Array): OscSniffResult {
    // Fast path: if there is no OSC state in progress AND the chunk contains
    // neither ESC nor BEL (the two bytes that can start/terminate an OSC),
    // return the chunk unmodified.
    if (this._state === "IDLE" && !containsOscOpener(chunk)) {
      return { passthrough: chunk, updatedTitle: null };
    }

    // Capture the carried-over buffer length BEFORE processing this chunk.
    // Bytes from the prior call's buffer may be flushed into `out` (e.g. when
    // ESC_SEEN discovers the next byte is not `]`, it emits the buffered ESC).
    // Sizing `out` to chunk.length alone is therefore insufficient; we must
    // also account for those pre-buffered bytes to prevent silent out-of-bounds
    // writes. (Bug 2 fix.)
    const initialBufLen = this._bufLen;

    // Slow path: walk byte-by-byte.
    // `out` is sized to the maximum possible passthrough: every byte in the
    // current chunk PLUS any bytes flushed from the carry-over buffer.
    const out = new Uint8Array(chunk.length + initialBufLen);
    let outLen = 0;
    let updatedTitle: string | null = null;

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;

      // Overflow guard: if the OSC buffer is too large, it's garbage — reset.
      if (this._bufLen >= MAX_OSC_BUFFER) {
        this._resetOsc();
      }

      switch (this._state) {
        case "IDLE": {
          if (b === ESC) {
            // Might start an OSC or might be another ESC sequence.
            this._state = "ESC_SEEN";
            this._bufPush(b);
          } else {
            // Plain terminal byte — pass through.
            out[outLen++] = b;
          }
          break;
        }

        case "ESC_SEEN": {
          if (b === OSC) {
            // ESC ] — confirmed OSC intro.
            this._state = "OSC_PARAM";
            this._bufPush(b);
            this._paramDigits = "";
            this._isTitleOsc = false;
          } else {
            // Not an OSC: flush the buffered ESC as passthrough and route b.
            out[outLen++] = ESC;
            this._resetOsc();
            // Re-process b in IDLE (it may itself be ESC again).
            if (b === ESC) {
              this._state = "ESC_SEEN";
              this._bufPush(b);
            } else {
              out[outLen++] = b;
            }
          }
          break;
        }

        case "OSC_PARAM": {
          if (b >= 0x30 && b <= 0x39) {
            // Decimal digit.
            this._bufPush(b);
            this._paramDigits += String.fromCharCode(b);
          } else if (b === SEMI) {
            // Semicolon separates Ps from text.  Classify the param.
            this._bufPush(b);
            const ps = parseInt(this._paramDigits, 10);
            this._isTitleOsc = ps === 0 || ps === 2;
            this._state = "OSC_TEXT";
          } else if (b === ST_BEL) {
            // Degenerate OSC with no text: `ESC ] Ps BEL`.
            // For non-title OSCs, pass the buffered bytes + BEL through.
            // For title OSCs (Ps 0 or 2), strip (no title to extract anyway).
            const ps = parseInt(this._paramDigits, 10);
            if (ps !== 0 && ps !== 2) {
              for (let j = 0; j < this._bufLen; j++) out[outLen++] = this._buf[j]!;
              out[outLen++] = ST_BEL;
            }
            this._resetOsc();
          } else if (b === ESC) {
            // ESC in param area — possible ST or corrupt sequence.
            // Don't push the ESC yet (same pattern as OSC_TEXT: we only push
            // it if the next byte is NOT ST_BS).
            this._state = "IN_OSC_ESC";
          } else {
            // Unexpected byte inside param — treat the whole buffer as garbage
            // and flush it as passthrough, then re-process b in IDLE.
            for (let j = 0; j < this._bufLen; j++) out[outLen++] = this._buf[j]!;
            this._resetOsc();
            if (b === ESC) {
              this._state = "ESC_SEEN";
              this._bufPush(b);
            } else {
              out[outLen++] = b;
            }
          }
          break;
        }

        case "OSC_TEXT": {
          if (b === ST_BEL) {
            // BEL terminator: OSC complete.
            // Bug 1 fix: only strip title OSCs; pass non-title OSCs through.
            const title = this._finishOscBEL(out, outLen);
            outLen = title.newOutLen;
            if (title.updatedTitle !== null) {
              updatedTitle = title.updatedTitle;
            }
          } else if (b === ESC) {
            // May be the start of ESC \ (ST).  Do NOT push the ESC to the
            // buffer yet — we only push it if the next byte is NOT ST_BS
            // (i.e. if it turns out to be a text byte, not a terminator).
            // If it IS ST_BS, the ESC is part of the terminator and MUST NOT
            // appear in the extracted title text.
            this._state = "IN_OSC_ESC";
          } else {
            // Text byte — accumulate.
            this._bufPush(b);
          }
          break;
        }

        case "IN_OSC_ESC": {
          if (b === ST_BS) {
            // ESC \ — confirmed string terminator.
            // The ESC was intentionally NOT pushed to the buffer in OSC_TEXT,
            // so the buffer contains clean title text without a trailing ESC.
            // Bug 1 fix: only strip title OSCs; pass non-title OSCs through.
            const title = this._finishOscST(out, outLen);
            outLen = title.newOutLen;
            if (title.updatedTitle !== null) {
              updatedTitle = title.updatedTitle;
            }
          } else {
            // Not a ST: the pending ESC is a literal byte inside the title.
            // Push the ESC to the buffer now, then handle `b` as OSC_TEXT.
            this._bufPush(ESC);
            this._state = "OSC_TEXT";
            // Re-process `b` as if we had just entered OSC_TEXT.
            if (b === ST_BEL) {
              const title = this._finishOscBEL(out, outLen);
              outLen = title.newOutLen;
              if (title.updatedTitle !== null) updatedTitle = title.updatedTitle;
            } else if (b === ESC) {
              // Another ESC — stay in IN_OSC_ESC (don't push this one yet either).
              this._state = "IN_OSC_ESC";
            } else {
              this._bufPush(b);
            }
          }
          break;
        }
      }
    }

    const passthrough = outLen === chunk.length ? chunk : out.subarray(0, outLen);
    return { passthrough, updatedTitle };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _bufPush(b: number): void {
    if (this._bufLen >= this._buf.length) {
      // Grow the buffer (double).
      const next = new Uint8Array(Math.max(this._buf.length * 2, 64));
      next.set(this._buf);
      this._buf = next;
    }
    this._buf[this._bufLen++] = b;
  }

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
  private _finishOscBEL(
    out: Uint8Array,
    outLen: number,
  ): { updatedTitle: string | null; newOutLen: number } {
    if (this._isTitleOsc) {
      // Title OSC: extract title, strip OSC from passthrough.
      const result = extractTitleFromOscBuffer(this._buf.subarray(0, this._bufLen));
      this._resetOsc();
      return { updatedTitle: result, newOutLen: outLen };
    } else {
      // Non-title OSC: emit buffered intro bytes + BEL terminator to passthrough.
      for (let j = 0; j < this._bufLen; j++) out[outLen++] = this._buf[j]!;
      out[outLen++] = ST_BEL;
      this._resetOsc();
      return { updatedTitle: null, newOutLen: outLen };
    }
  }

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
  private _finishOscST(
    out: Uint8Array,
    outLen: number,
  ): { updatedTitle: string | null; newOutLen: number } {
    if (this._isTitleOsc) {
      // Title OSC: extract title, strip OSC from passthrough.
      // The buffer holds: ESC ] Ps ; <text> (the ESC of ESC\ was NOT pushed).
      const result = extractTitleFromOscBuffer(this._buf.subarray(0, this._bufLen));
      this._resetOsc();
      return { updatedTitle: result, newOutLen: outLen };
    } else {
      // Non-title OSC: emit buffered intro bytes + ESC \ terminator to passthrough.
      for (let j = 0; j < this._bufLen; j++) out[outLen++] = this._buf[j]!;
      out[outLen++] = ESC;
      out[outLen++] = ST_BS;
      this._resetOsc();
      return { updatedTitle: null, newOutLen: outLen };
    }
  }

  private _resetOsc(): void {
    this._state = "IDLE";
    this._bufLen = 0;
    this._paramDigits = "";
    this._isTitleOsc = false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the chunk contains ESC (0x1B) — the only byte that can
 * open an OSC sequence.  Used as a fast-path gate to avoid byte-by-byte work
 * when no OSC-related bytes are present.
 */
function containsOscOpener(chunk: Uint8Array): boolean {
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === ESC) return true;
  }
  return false;
}

/**
 * Extract the title string from an OSC buffer.
 *
 * The buffer contains: ESC(0x1B) ](0x5D) <Ps-digits> ;(0x3B) <title-bytes>.
 * The terminator is NOT in the buffer.
 *
 * Returns the UTF-8 decoded title, or null if the buffer is malformed.
 */
function extractTitleFromOscBuffer(buf: Uint8Array): string | null {
  // Find the semicolon that separates Ps from text.
  let semiIdx = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === SEMI) {
      semiIdx = i;
      break;
    }
  }
  if (semiIdx === -1) return null; // no semicolon found — malformed

  // Title text starts immediately after the semicolon.
  const textStart = semiIdx + 1;
  const textSlice = buf.subarray(textStart);
  if (textSlice.length === 0) {
    // Empty title is valid (clears the title).
    return "";
  }

  // Decode as UTF-8, falling back to Latin-1 on invalid bytes.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(textSlice);
  } catch {
    return new TextDecoder("latin1").decode(textSlice);
  }
}
