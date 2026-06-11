/**
 * tmux -CC control-mode stream tokenizer.
 *
 * Turns a raw byte stream from `tmux -CC` into a sequence of typed tokens.
 * This is the SOUTH-facing parser layer — it consumes tmux's control-mode
 * syntax and emits structured tokens for higher-level consumers.
 *
 * # Protocol overview
 *
 * When launched with `-CC` (CLIENT_CONTROLCONTROL), tmux wraps the entire
 * control-mode session in a DCS sequence:
 *
 *   \x1bP1000p         ← DCS intro (7 bytes: ESC P 1 0 0 0 p)
 *   ...control lines...
 *   \x1b\              ← ST (string terminator: ESC \)
 *
 * Inside the wrapper the protocol is line-oriented (LF or CRLF):
 *
 *   %notification-keyword args\n        ← notification line
 *   %begin <timestamp> <cmdnum> <flags> ← start of command response block
 *   literal body line\n                 ← block body (may be non-UTF-8)
 *   %end <timestamp> <cmdnum> <flags>   ← end of block (success)
 *   %error <timestamp> <cmdnum> <flags> ← end of block (failure)
 *
 * Critical: body lines inside a %begin…%end block are NEVER interpreted as
 * notifications, even if they start with `%`.
 *
 * # Token types
 *
 * See `ControlToken` for the discriminated union. Key design decisions:
 *
 * - `notification` tokens carry `rawLine: Uint8Array` — the complete raw bytes
 *   of the line (excluding the trailing newline). tc-8yz uses this to decode
 *   octal-escaped %output payloads without lossy UTF-8 re-encoding. tc-wvu
 *   uses it to parse notification semantics. The `keyword` field is the ASCII
 *   keyword after `%` (e.g. "output", "begin", "session-changed") decoded as
 *   UTF-8 (it is always ASCII by tmux spec).
 *
 * - `block-body` tokens carry `bytes: Uint8Array` — raw line content (no
 *   trailing newline). May be arbitrary bytes including invalid UTF-8.
 *
 * - `block-begin` / `block-end` / `block-error` parse the three numeric fields
 *   from the guard lines. tc-82a uses these to correlate request/response pairs.
 *
 * - `dcs-open` / `dcs-close` are emitted when the DCS wrapper is detected.
 *   They are informational; downstream consumers may ignore them.
 *
 * # Streaming API
 *
 * `ControlTokenizer` is incremental: feed arbitrary byte chunks with `push()`,
 * collect whatever complete tokens are now available. Partial lines (or a
 * partial DCS intro/ST split across chunks) are buffered internally.
 *
 * # DCS handling
 *
 * State machine has three top-level states:
 *   BEFORE_DCS  — waiting for \x1bP1000p (or just bare lines if no DCS)
 *   IN_DCS      — inside the DCS envelope; parsing control lines
 *   AFTER_DCS   — ST received; session over
 *
 * Tolerant: if the DCS intro is absent (e.g. test fragments feeding bare
 * lines, or a session that somehow omits it), the tokenizer starts parsing
 * immediately in "no DCS" mode. It detects the DCS intro only as an exact
 * prefix at the very start of input; if the first byte is not \x1b it skips
 * the DCS state and moves directly to line parsing.
 *
 * # Line endings
 *
 * Handles both LF (\n) and CRLF (\r\n). The \r is stripped before tokenizing;
 * the raw `rawLine` / `bytes` fields never contain the trailing \r or \n.
 *
 * @module parser/tokenizer
 */

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

/** A top-level notification line (NOT inside a command block). */
export interface NotificationToken {
  readonly kind: "notification";
  /**
   * The keyword after `%`, decoded as ASCII/UTF-8.
   * E.g. "output", "session-changed", "window-add", "exit", "pause", etc.
   * Does NOT include the `%` prefix.
   */
  readonly keyword: string;
  /**
   * The complete raw line bytes, excluding the trailing newline (and \r if
   * CRLF). Starts with `%keyword`. Preserved as raw bytes so that downstream
   * parsers (tc-8yz for %output octal decoding; tc-wvu for notification
   * semantics) can operate without lossy re-encoding.
   */
  readonly rawLine: Uint8Array;
}

/** Parsed fields from a %begin guard line — starts a command response block. */
export interface BlockBeginToken {
  readonly kind: "block-begin";
  /** Unix timestamp from the %begin line (decimal integer string → number). */
  readonly timestamp: number;
  /** Command sequence number from tmux (unique per-client per-session). */
  readonly commandNumber: number;
  /** Flags field from the guard line (integer; tmux uses 0 or 1). */
  readonly flags: number;
}

/**
 * A literal output line inside a %begin…%end command block.
 * May be non-UTF-8 (terminal output is arbitrary bytes). Never interpret as
 * a notification even if it starts with `%`.
 */
export interface BlockBodyToken {
  readonly kind: "block-body";
  /** Raw line bytes, excluding the trailing newline. */
  readonly bytes: Uint8Array;
}

/** Parsed fields from a %end guard line — successful block terminator. */
export interface BlockEndToken {
  readonly kind: "block-end";
  readonly timestamp: number;
  readonly commandNumber: number;
  readonly flags: number;
}

/** Parsed fields from a %error guard line — failed block terminator. */
export interface BlockErrorToken {
  readonly kind: "block-error";
  readonly timestamp: number;
  readonly commandNumber: number;
  readonly flags: number;
}

/**
 * Emitted when the DCS intro sequence (\x1bP1000p) is consumed.
 * Informational; downstream may ignore.
 */
export interface DcsOpenToken {
  readonly kind: "dcs-open";
}

/**
 * Emitted when the ST terminator (\x1b\) is consumed, closing the DCS.
 * Informational; downstream may ignore.
 */
export interface DcsCloseToken {
  readonly kind: "dcs-close";
}

/** All token kinds emitted by the tokenizer. */
export type ControlToken =
  | NotificationToken
  | BlockBeginToken
  | BlockBodyToken
  | BlockEndToken
  | BlockErrorToken
  | DcsOpenToken
  | DcsCloseToken;

// ---------------------------------------------------------------------------
// DCS framing constants
// ---------------------------------------------------------------------------

/**
 * DCS intro bytes: ESC P 1 0 0 0 p  (\x1bP1000p).
 * Tmux emits this at the start of a -CC session (CLIENT_CONTROLCONTROL flag).
 * Source: control.c:805 `bufferevent_write(cs->write_event, "\033P1000p", 7)`.
 */
const DCS_INTRO = new Uint8Array([0x1b, 0x50, 0x31, 0x30, 0x30, 0x30, 0x70]);

/**
 * ST (string terminator): ESC \  (\x1b\x5c).
 * Emitted by the tmux CLIENT (not server) on exit: client.c:439 `printf("\033\\")`.
 * The tokenizer also handles receiving it from the server stream should tmux
 * emit it (defensive; the spec is clear it marks end-of-DCS).
 */
const ST_BYTES = new Uint8Array([0x1b, 0x5c]);

// ASCII codes for structural parsing
const LF = 0x0a; // \n
const CR = 0x0d; // \r
const PERCENT = 0x25; // %
const SPACE = 0x20; // space

// ---------------------------------------------------------------------------
// Tokenizer state
// ---------------------------------------------------------------------------

const enum DcsState {
  /** Waiting to see the DCS intro; if first byte is not ESC, skip to INSIDE. */
  BEFORE_DCS,
  /** Consuming the DCS intro bytes (partial match buffered). */
  MATCHING_DCS_INTRO,
  /** Inside the DCS envelope (or no DCS at all): parsing control lines. */
  INSIDE,
  /** Possibly consuming ST (saw \x1b, waiting for \x5c). */
  MAYBE_ST,
  /** DCS closed (ST received or session ended). */
  AFTER_DCS,
}

const enum BlockState {
  /** Not inside a command block — lines are notifications. */
  OUTSIDE,
  /** Inside a %begin…%end block — lines are block-body. */
  INSIDE,
}

// ---------------------------------------------------------------------------
// Main tokenizer class
// ---------------------------------------------------------------------------

/**
 * Stateful streaming tokenizer for the tmux -CC control-mode byte stream.
 *
 * Usage:
 * ```ts
 * const tok = new ControlTokenizer();
 * socket.on("data", (chunk: Uint8Array) => {
 *   const tokens = tok.push(chunk);
 *   for (const token of tokens) { ... }
 * });
 * ```
 */
export class ControlTokenizer {
  /** Accumulates bytes for the current in-progress line. */
  private _lineBuf: Uint8Array[] = [];
  private _lineBufLen = 0;

  /** DCS envelope state machine. */
  private _dcsState: DcsState = DcsState.BEFORE_DCS;
  /** How many bytes of DCS_INTRO we have matched so far. */
  private _dcsIntroMatched = 0;

  /** Whether we are currently inside a %begin…%end command block. */
  private _blockState: BlockState = BlockState.OUTSIDE;

  /**
   * Feed a new byte chunk to the tokenizer.
   *
   * Returns all complete tokens decoded from the current input (may be zero,
   * one, or many). Any partial line or DCS sequence remains buffered for the
   * next call.
   *
   * @param chunk - Raw bytes from the tmux -CC stream.
   * @returns Tokens decoded from this and any previously buffered bytes.
   */
  push(chunk: Uint8Array): ControlToken[] {
    if (chunk.length === 0) return [];
    const tokens: ControlToken[] = [];
    this._processChunk(chunk, tokens);
    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Internal: byte-level processing
  // ---------------------------------------------------------------------------

  private _processChunk(chunk: Uint8Array, out: ControlToken[]): void {
    let i = 0;

    while (i < chunk.length) {
      switch (this._dcsState) {
        case DcsState.BEFORE_DCS:
          i = this._processBefore(chunk, i, out);
          break;

        case DcsState.MATCHING_DCS_INTRO:
          i = this._matchDcsIntro(chunk, i, out);
          break;

        case DcsState.INSIDE:
          i = this._processInside(chunk, i, out);
          break;

        case DcsState.MAYBE_ST:
          i = this._maybeSt(chunk, i, out);
          break;

        case DcsState.AFTER_DCS:
          // Discard everything after the DCS closes.
          return;
      }
    }
  }

  /**
   * BEFORE_DCS: decide whether the stream starts with a DCS intro or bare lines.
   * Called at most once (handles only the very first bytes).
   */
  private _processBefore(chunk: Uint8Array, i: number, out: ControlToken[]): number {
    const b = chunk[i]!;

    if (b === DCS_INTRO[0]) {
      // Could be a DCS intro — start matching.
      this._dcsState = DcsState.MATCHING_DCS_INTRO;
      this._dcsIntroMatched = 1;
      return i + 1;
    }

    // Not an ESC → no DCS wrapper present; parse bare control lines directly.
    this._dcsState = DcsState.INSIDE;
    return i; // re-process this byte in INSIDE state
  }

  /**
   * MATCHING_DCS_INTRO: consume bytes of DCS_INTRO one at a time.
   * If the match succeeds, emit dcs-open and enter INSIDE.
   * If it fails at any point, the bytes consumed so far were non-DCS — treat
   * the whole intro as line content and enter INSIDE.
   */
  private _matchDcsIntro(chunk: Uint8Array, i: number, out: ControlToken[]): number {
    while (i < chunk.length && this._dcsIntroMatched < DCS_INTRO.length) {
      const b = chunk[i]!;
      const expected = DCS_INTRO[this._dcsIntroMatched]!;

      if (b === expected) {
        this._dcsIntroMatched++;
        i++;
      } else {
        // Mismatch: the bytes we consumed were not a DCS intro.
        // Emit them as part of the line buffer and enter INSIDE.
        this._appendToLine(DCS_INTRO.subarray(0, this._dcsIntroMatched));
        this._dcsState = DcsState.INSIDE;
        this._dcsIntroMatched = 0;
        return i; // re-process current byte in INSIDE state
      }
    }

    if (this._dcsIntroMatched === DCS_INTRO.length) {
      // Full DCS intro matched.
      out.push({ kind: "dcs-open" });
      this._dcsState = DcsState.INSIDE;
      this._dcsIntroMatched = 0;
    }
    // else: consumed all of chunk without finishing the match — stay in MATCHING_DCS_INTRO

    return i;
  }

  /**
   * INSIDE: normal line parsing. Scan for LF (line terminator) or ESC (potential ST).
   * Appends bytes to _lineBuf; on LF, processes the complete line.
   */
  private _processInside(chunk: Uint8Array, i: number, out: ControlToken[]): number {
    // Fast scan: find next LF or ESC in the remaining slice.
    const start = i;
    while (i < chunk.length) {
      const b = chunk[i]!;

      if (b === LF) {
        // Line complete. Append bytes up to (not including) LF.
        if (i > start) {
          this._appendToLine(chunk.subarray(start, i));
        }
        this._flushLine(out);
        i++;
        return i; // resume at next byte (will re-enter _processInside via loop)
      }

      if (b === 0x1b) {
        // Potential ST (\x1b\). Append everything before this ESC to the line.
        if (i > start) {
          this._appendToLine(chunk.subarray(start, i));
        }
        this._dcsState = DcsState.MAYBE_ST;
        return i + 1; // consumed the ESC; next byte decides
      }

      i++;
    }

    // End of chunk without hitting LF or ESC — buffer the whole tail.
    if (i > start) {
      this._appendToLine(chunk.subarray(start, i));
    }
    return i;
  }

  /**
   * MAYBE_ST: we saw \x1b inside INSIDE state. If next byte is \x5c (backslash),
   * it's the ST — emit dcs-close and enter AFTER_DCS.
   * Otherwise, the \x1b was literal content — put it back in the line buffer.
   */
  private _maybeSt(chunk: Uint8Array, i: number, out: ControlToken[]): number {
    const b = chunk[i]!;

    if (b === ST_BYTES[1]) {
      // Full ST: \x1b\x5c
      // Flush any buffered line content before closing.
      if (this._lineBufLen > 0) {
        this._flushLine(out);
      }
      out.push({ kind: "dcs-close" });
      this._dcsState = DcsState.AFTER_DCS;
      return i + 1;
    }

    // Not ST — the ESC was literal content. Put it in the line buffer and
    // continue processing this byte in INSIDE state.
    this._appendToLine(ST_BYTES.subarray(0, 1)); // just the 0x1b byte
    this._dcsState = DcsState.INSIDE;
    return i; // re-process current byte in INSIDE state
  }

  // ---------------------------------------------------------------------------
  // Internal: line buffer helpers
  // ---------------------------------------------------------------------------

  private _appendToLine(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this._lineBuf.push(bytes);
    this._lineBufLen += bytes.length;
  }

  /** Materialise the line buffer into a single Uint8Array and clear it. */
  private _collectLine(): Uint8Array {
    if (this._lineBuf.length === 0) return new Uint8Array(0);

    let line: Uint8Array;

    if (this._lineBuf.length === 1) {
      line = this._lineBuf[0]!;
    } else {
      line = new Uint8Array(this._lineBufLen);
      let offset = 0;
      for (const chunk of this._lineBuf) {
        line.set(chunk, offset);
        offset += chunk.length;
      }
    }

    this._lineBuf = [];
    this._lineBufLen = 0;

    // Strip trailing \r (CRLF → LF normalisation).
    if (line.length > 0 && line[line.length - 1] === CR) {
      line = line.subarray(0, line.length - 1);
    }

    return line;
  }

  /**
   * Process a complete line (collected after seeing LF).
   * Emits the appropriate token based on current block state and line content.
   */
  private _flushLine(out: ControlToken[]): void {
    const line = this._collectLine();

    if (this._blockState === BlockState.INSIDE) {
      // Inside a command block: check for %end / %error terminators first.
      // These are structurally special — the tokenizer must recognize them to
      // exit block state. All other lines (including those starting with %)
      // are block-body.
      if (line.length > 0 && line[0] === PERCENT) {
        const guardResult = this._tryParseGuardLine(line, out);
        if (guardResult) return;
      }
      // Emit as block-body (raw bytes, any content).
      out.push({ kind: "block-body", bytes: line });
      return;
    }

    // OUTSIDE block: check for notification lines.
    if (line.length === 0) {
      // Empty line — ignore (tmux doesn't emit bare empty lines, but be safe).
      return;
    }

    if (line[0] === PERCENT) {
      // It's a %-line. Parse %begin specially (enters block state).
      // All other % lines are notifications.
      this._parseNotificationOrBegin(line, out);
      return;
    }

    // Non-% line outside a block: treat as a bare line / ignore.
    // (Tmux control mode doesn't produce non-% content outside blocks.)
  }

  /**
   * Parse a `%...` line when we are OUTSIDE a block.
   * If it's `%begin`, parse the guard fields and enter block state.
   * Otherwise emit a notification token.
   */
  private _parseNotificationOrBegin(line: Uint8Array, out: ControlToken[]): void {
    const keyword = this._extractKeyword(line);

    if (keyword === "begin") {
      const guard = this._parseGuardFields(line);
      if (guard !== null) {
        out.push({ kind: "block-begin", ...guard });
        this._blockState = BlockState.INSIDE;
        return;
      }
      // Malformed %begin: treat as a notification (defensive).
    }

    out.push({ kind: "notification", keyword, rawLine: line });
  }

  /**
   * When inside a block, try to match `%end` or `%error`.
   * Returns true if we matched and emitted a terminator token (exits block state).
   * Returns false if this line should be treated as block-body.
   */
  private _tryParseGuardLine(line: Uint8Array, out: ControlToken[]): boolean {
    const keyword = this._extractKeyword(line);

    if (keyword === "end" || keyword === "error") {
      const guard = this._parseGuardFields(line);
      if (guard !== null) {
        out.push({
          kind: keyword === "end" ? "block-end" : "block-error",
          ...guard,
        });
        this._blockState = BlockState.OUTSIDE;
        return true;
      }
    }

    return false;
  }

  /**
   * Extract the ASCII keyword from a %-line.
   * Line format: `%keyword [args...]`
   * Returns the keyword string (without `%`), or the empty string on parse error.
   * Only decodes the ASCII structural prefix — safe even if rest of line is binary.
   */
  private _extractKeyword(line: Uint8Array): string {
    // line[0] === PERCENT (caller ensures this)
    let end = 1;
    while (end < line.length && line[end] !== SPACE && line[end] !== LF && line[end] !== CR) {
      end++;
    }
    // Keyword is always ASCII — safe to decode character-by-character.
    let kw = "";
    for (let i = 1; i < end; i++) {
      kw += String.fromCharCode(line[i]!);
    }
    return kw;
  }

  /**
   * Parse the three numeric fields from a guard line:
   *   `%begin|%end|%error <timestamp> <commandNumber> <flags>`
   *
   * Source: cmd-queue.c:832
   *   `control_write(c, "%%%s %ld %u %d", guard, t, number, flags)`
   *
   * Returns `{ timestamp, commandNumber, flags }` or null if malformed.
   */
  private _parseGuardFields(
    line: Uint8Array,
  ): { timestamp: number; commandNumber: number; flags: number } | null {
    // Skip `%keyword `
    let i = 1;
    while (i < line.length && line[i] !== SPACE) i++; // skip keyword
    if (i >= line.length) return null;
    i++; // skip space after keyword

    const field1 = this._readDecimalField(line, i);
    if (field1 === null) return null;
    i = field1.nextIdx;
    if (i >= line.length || line[i] !== SPACE) return null;
    i++;

    const field2 = this._readDecimalField(line, i);
    if (field2 === null) return null;
    i = field2.nextIdx;
    if (i >= line.length || line[i] !== SPACE) return null;
    i++;

    const field3 = this._readDecimalField(line, i);
    if (field3 === null) return null;

    return {
      timestamp: field1.value,
      commandNumber: field2.value,
      flags: field3.value,
    };
  }

  /**
   * Read a decimal integer from `line` starting at `start`.
   * Returns `{ value, nextIdx }` where `nextIdx` points past the last digit,
   * or `null` if no digit was found.
   */
  private _readDecimalField(
    line: Uint8Array,
    start: number,
  ): { value: number; nextIdx: number } | null {
    let i = start;
    let value = 0;
    let hasDigit = false;

    while (i < line.length) {
      const b = line[i]!;
      if (b >= 0x30 && b <= 0x39) {
        // '0'..'9'
        value = value * 10 + (b - 0x30);
        hasDigit = true;
        i++;
      } else {
        break;
      }
    }

    if (!hasDigit) return null;
    return { value, nextIdx: i };
  }
}

// ---------------------------------------------------------------------------
// Convenience: tokenize a complete buffer at once
// ---------------------------------------------------------------------------

/**
 * Tokenize a complete, self-contained control-mode byte buffer.
 *
 * For streaming input use `ControlTokenizer`. This helper is convenient for
 * tests and offline processing where all bytes are available at once.
 *
 * @param buf - Complete (or fragment) control-mode byte stream.
 * @returns All tokens decoded from `buf`.
 */
export function tokenizeBuffer(buf: Uint8Array): ControlToken[] {
  return new ControlTokenizer().push(buf);
}
