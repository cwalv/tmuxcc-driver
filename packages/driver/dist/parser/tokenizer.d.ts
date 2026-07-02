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
 * notifications, even if they start with `%`. The same opaqueness applies to
 * the DCS String Terminator (ESC `\`): block bodies carry arbitrary raw bytes
 * (e.g. `capture-pane -e` preserves raw escape sequences; tmux does NOT
 * octal-escape command-block bodies, only %output — control.c:639), so an
 * ESC `\` landing in a body must NOT be mistaken for the envelope-closing ST.
 * The real closing ST only ever arrives at top level (block depth 0) after all
 * control lines, never mid-block, so suppressing ST detection inside a block is
 * safe. (Cross-checked against iTerm2's TmuxGateway.m: it reads line-by-line,
 * tracks %begin/%end, and appends block bodies as opaque bytes — it never
 * byte-scans block-body content for the ST. tc-44u4.)
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
export type ControlToken = NotificationToken | BlockBeginToken | BlockBodyToken | BlockEndToken | BlockErrorToken | DcsOpenToken | DcsCloseToken;
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
export declare class ControlTokenizer {
    /** Accumulates bytes for the current in-progress line. */
    private _lineBuf;
    private _lineBufLen;
    /** DCS envelope state machine. */
    private _dcsState;
    /** How many bytes of DCS_INTRO we have matched so far. */
    private _dcsIntroMatched;
    /** Whether we are currently inside a %begin…%end command block. */
    private _blockState;
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
    push(chunk: Uint8Array): ControlToken[];
    private _processChunk;
    /**
     * BEFORE_DCS: decide whether the stream starts with a DCS intro or bare lines.
     * Called at most once (handles only the very first bytes).
     */
    private _processBefore;
    /**
     * MATCHING_DCS_INTRO: consume bytes of DCS_INTRO one at a time.
     * If the match succeeds, emit dcs-open and enter INSIDE.
     * If it fails at any point, the bytes consumed so far were non-DCS — treat
     * the whole intro as line content and enter INSIDE.
     */
    private _matchDcsIntro;
    /**
     * INSIDE: normal line parsing. Scan for LF (line terminator), and — only when
     * we are NOT inside a %begin…%end block — ESC (potential closing ST).
     *
     * Block bodies are opaque: they carry arbitrary raw bytes (including ESC `\`
     * from `capture-pane -e`, nested DCS/OSC sequences, kitty-protocol escapes,
     * etc.) and must only be terminated by LF, never by a byte-level ST scan.
     * Suppressing ST detection inside a block is safe because tmux's real closing
     * ST only ever arrives at top level (block depth 0) after all control lines.
     * (Oracle: iTerm2 TmuxGateway.m treats block-body data as opaque bytes and
     * never scans it for the ST. tc-44u4.)
     *
     * Appends bytes to _lineBuf; on LF, processes the complete line.
     */
    private _processInside;
    /**
     * MAYBE_ST: we saw \x1b inside INSIDE state. If next byte is \x5c (backslash),
     * it's the ST — emit dcs-close and enter AFTER_DCS.
     * Otherwise, the \x1b was literal content — put it back in the line buffer.
     */
    private _maybeSt;
    private _appendToLine;
    /** Materialise the line buffer into a single Uint8Array and clear it. */
    private _collectLine;
    /**
     * Process a complete line (collected after seeing LF).
     * Emits the appropriate token based on current block state and line content.
     */
    private _flushLine;
    /**
     * Parse a `%...` line when we are OUTSIDE a block.
     * If it's `%begin`, parse the guard fields and enter block state.
     * Otherwise emit a notification token.
     */
    private _parseNotificationOrBegin;
    /**
     * When inside a block, try to match `%end` or `%error`.
     * Returns true if we matched and emitted a terminator token (exits block state).
     * Returns false if this line should be treated as block-body.
     */
    private _tryParseGuardLine;
    /**
     * Extract the ASCII keyword from a %-line.
     * Line format: `%keyword [args...]`
     * Returns the keyword string (without `%`), or the empty string on parse error.
     * Only decodes the ASCII structural prefix — safe even if rest of line is binary.
     */
    private _extractKeyword;
    /**
     * Parse the three numeric fields from a guard line:
     *   `%begin|%end|%error <timestamp> <commandNumber> <flags>`
     *
     * Source: cmd-queue.c:832
     *   `control_write(c, "%%%s %ld %u %d", guard, t, number, flags)`
     *
     * Returns `{ timestamp, commandNumber, flags }` or null if malformed.
     */
    private _parseGuardFields;
    /**
     * Read a decimal integer from `line` starting at `start`.
     * Returns `{ value, nextIdx }` where `nextIdx` points past the last digit,
     * or `null` if no digit was found.
     */
    private _readDecimalField;
}
/**
 * Tokenize a complete, self-contained control-mode byte buffer.
 *
 * For streaming input use `ControlTokenizer`. This helper is convenient for
 * tests and offline processing where all bytes are available at once.
 *
 * @param buf - Complete (or fragment) control-mode byte stream.
 * @returns All tokens decoded from `buf`.
 */
export declare function tokenizeBuffer(buf: Uint8Array): ControlToken[];
//# sourceMappingURL=tokenizer.d.ts.map