/**
 * tmux -CC command-block correlator (tc-82a).
 *
 * This module provides the CORRELATION layer on top of the token stream emitted
 * by `ControlTokenizer` (tc-ckw). It matches each %begin…%end/%error block to
 * the outstanding command that produced it.
 *
 * # Protocol model
 *
 * The client sends commands; tmux replies with command blocks:
 *
 *   %begin  <ts> <cmdnum> <flags>   ← block open
 *   <body lines>                     ← arbitrary bytes (may start with %)
 *   %end    <ts> <cmdnum> <flags>   ← success  (or)
 *   %error  <ts> <cmdnum> <flags>   ← failure
 *
 * Command numbers increase monotonically. Replies arrive in FIFO order
 * (tmux guarantees this). Between blocks, tmux may emit notification lines
 * (%output, %window-add, etc.) that are unrelated to any command.
 *
 * # Correlation strategy
 *
 * This correlator maintains a FIFO queue of pending commands registered by the
 * caller. On `%end`/`%error` it dequeues the OLDEST pending entry and resolves
 * it. As an additional safety check it also verifies that the closing
 * `commandNumber` matches the expected one (it always should per protocol, but
 * if a mismatch is detected the correlator rejects rather than silently
 * mis-correlates).
 *
 * # API overview
 *
 * ```ts
 * const corr = new CommandCorrelator({
 *   onNotification(token) { /* forward to downstream * / },
 * });
 *
 * // When the caller is about to send a command to tmux, register it first:
 * const result: Promise<CommandResult> = corr.expectCommand();
 *
 * // Feed tokens as they arrive from ControlTokenizer:
 * for (const token of tokenizer.push(chunk)) {
 *   corr.push(token);
 * }
 *
 * // The Promise resolves once the matching %end or %error block is complete.
 * const { ok, commandNumber, body } = await result;
 * ```
 *
 * # Thread safety / concurrency
 *
 * `CommandCorrelator` is single-threaded (synchronous push; Promise resolution
 * is microtask-deferred). It has no internal timers or I/O. All state mutation
 * happens inside `push()` calls on the caller's event loop.
 *
 * @module parser/correlator
 */

import type {
  ControlToken,
  NotificationToken,
  BlockBeginToken,
  BlockBodyToken,
  BlockEndToken,
  BlockErrorToken,
} from "./tokenizer.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The resolved result of a command block.
 *
 * Produced when a `%end` or `%error` guard line closes the in-flight block.
 * `body` is the raw bytes of all `block-body` lines between the corresponding
 * `%begin` and the terminator, in order, joined by `\n` (each
 * `BlockBodyToken.bytes` is one line with its own trailing newline already
 * stripped by the tokenizer; there is no trailing `\n` after the last line).
 *
 * tc-fx4: the `\n` join is load-bearing — line-oriented body parsers
 * (bootstrap's `parseWindowsReply` / `parsePanesReply`, the pipeline's
 * %window-add layout reconcile) split on `\n` to recover the reply rows.
 */
export interface CommandResult {
  /** True on `%end` (success), false on `%error` (failure). */
  readonly ok: boolean;
  /** The command sequence number from the `%end`/`%error` guard line. */
  readonly commandNumber: number;
  /**
   * The accumulated raw body bytes from all `block-body` tokens in this
   * block, joined by `\n`. Raw: may contain non-UTF-8 bytes within a line.
   */
  readonly body: Uint8Array;
}

/**
 * Called for every `NotificationToken` that arrives between (or before/after)
 * command blocks. The correlator does NOT consume notifications — they are
 * forwarded here so downstream logic (%output decode, session events, etc.)
 * still receives them.
 */
export type NotificationHandler = (token: NotificationToken) => void;

/**
 * Write the given bytes to the underlying transport (tmux stdin).
 *
 * Supplied via `CommandCorrelatorOptions.write` so the correlator can atomically
 * register a slot AND emit the command in one operation (`send` / `sendBatch`).
 * The pipeline wires this to `host.write` (tc-3si.1).
 */
export type CommandWriter = (data: string | Uint8Array) => void;

/** Options for `CommandCorrelator`. */
export interface CommandCorrelatorOptions {
  /**
   * Called synchronously for each `notification` token that is not part of a
   * command block. Optional; if omitted, notifications are silently discarded.
   */
  onNotification?: NotificationHandler;

  /**
   * Underlying byte writer (tmux stdin). When supplied, the correlator's
   * `send` / `sendBatch` methods are usable — they register one or more slots
   * BEFORE emitting the command bytes so the FIFO queue stays in sync with
   * tmux's reply order. When omitted, callers must use `expectCommand()` and
   * write through some other path (used by parser-level unit tests that only
   * inject reply tokens without driving real writes).
   */
  write?: CommandWriter;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** One entry in the pending-command FIFO queue. */
interface PendingCommand {
  /**
   * The command number we expect to see on the closing guard line.
   * Populated when the matching `%begin` is seen (it carries the commandNumber).
   * Before `%begin` arrives this is `undefined` (we don't know the cmdnum until
   * tmux assigns it and echoes it back in the guard line).
   */
  expectedCommandNumber: number | undefined;
  resolve: (result: CommandResult) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// CommandCorrelator
// ---------------------------------------------------------------------------

/**
 * Stateful correlator that maps %begin…%end/%error command blocks to caller-
 * issued Promises.
 *
 * Usage:
 * 1. Before sending a command to tmux, call `expectCommand()`. Hold the Promise.
 * 2. Feed every `ControlToken` from `ControlTokenizer` into `push()`.
 * 3. The Promise returned in step 1 resolves (or rejects) once tmux's block
 *    for that command completes.
 */
export class CommandCorrelator {
  private readonly _onNotification: NotificationHandler | undefined;
  private readonly _write: CommandWriter | undefined;

  /**
   * FIFO queue of pending commands registered by the caller.
   * Dequeued in order as %end/%error blocks complete.
   */
  private readonly _pending: PendingCommand[] = [];

  /** The command currently open (between %begin and %end/%error), or null. */
  private _inFlight: {
    commandNumber: number;
    bodyChunks: Uint8Array[];
    bodyLen: number;
    /**
     * True when this in-flight block was opened by a %begin with flags=0
     * (the implicit tmux startup block).  Startup blocks must NOT be matched
     * to any pending expectCommand() slot — they are silently discarded on close.
     */
    isStartupBlock: boolean;
  } | null = null;

  constructor(options: CommandCorrelatorOptions = {}) {
    this._onNotification = options.onNotification;
    this._write = options.write;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register an outstanding command.
   *
   * Call this BEFORE (or immediately after) sending the command bytes to tmux,
   * so that the FIFO queue stays in sync with tmux's reply order. Multiple
   * callers may queue multiple commands; they resolve in the order the blocks
   * arrive (which is the same as the order they were sent).
   *
   * The returned Promise:
   * - Resolves with `CommandResult` when the matching `%end` block completes.
   * - Resolves with `CommandResult` (ok=false) when the matching `%error` block
   *   completes.
   * - Rejects with an `Error` only on a protocol violation (e.g. commandNumber
   *   mismatch, which would indicate a bug in the tokenizer layer or in the
   *   caller's call ordering).
   *
   * @returns A Promise that resolves when tmux's reply block for this command
   *   is fully received.
   */
  expectCommand(): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      this._pending.push({
        expectedCommandNumber: undefined,
        resolve,
        reject,
      });
    });
  }

  /**
   * Atomically register a slot AND write the command (tc-3si.1).
   *
   * This is the only legal command-send path under the requery pipeline: the
   * slot registration and the host write happen together so the FIFO pairing
   * stays in sync regardless of what other writers (the requery engine, flow
   * control, input path) are doing concurrently. Without that pairing the
   * command's `%end` reply could mis-bind to a concurrent requery's
   * `list-*` slot, corrupting the engine's topology snapshot (see tc-128.4).
   *
   * The returned Promise resolves with the matching `CommandResult` once tmux's
   * reply block completes (`ok=true` on `%end`, `ok=false` on `%error`).
   * Fire-and-forget callers may ignore it — the slot is still registered so
   * the FIFO sequence stays correct.
   *
   * Throws if the correlator was constructed without a `write` callback (i.e.
   * configured for parser-level testing only).
   */
  send(command: string): Promise<CommandResult> {
    if (this._write === undefined) {
      throw new Error("CommandCorrelator.send called without a `write` callback");
    }
    const promise = this.expectCommand();
    this._write(command + "\n");
    return promise;
  }

  /**
   * Atomically register N slots AND write N command lines as ONE chunk
   * (tc-3si.1).
   *
   * Use when a caller needs tmux to process several command lines without
   * permitting another writer to interleave between them (e.g. the
   * resize-managed-window transaction in input-path: window-size manual →
   * resize-window → resize-pane×N, where an intervening %layout-change
   * notification between resize-window and the pane resizes would corrupt the
   * layout). Each command line still gets its own `%begin/%end` block; the
   * returned Promises resolve in submission order.
   *
   * Equivalent to N individual `send()` calls except for the atomicity: this
   * method emits ONE `write()` call with all lines joined by `\n`, so no other
   * writer can land bytes in between (the writer is a synchronous handle to a
   * single-producer stream).
   *
   * Throws if the correlator was constructed without a `write` callback.
   */
  sendBatch(commands: readonly string[]): Promise<CommandResult>[] {
    if (this._write === undefined) {
      throw new Error("CommandCorrelator.sendBatch called without a `write` callback");
    }
    if (commands.length === 0) return [];
    const promises: Promise<CommandResult>[] = [];
    for (let i = 0; i < commands.length; i++) {
      promises.push(this.expectCommand());
    }
    this._write(commands.map((c) => c + "\n").join(""));
    return promises;
  }

  /**
   * Feed one token from `ControlTokenizer` into the correlator.
   *
   * - `block-begin`: opens a new in-flight block; associates it with the oldest
   *   pending command (if any). If no command was pre-registered, the block is
   *   buffered and matched when a command is registered later via
   *   `expectCommand()` — but callers SHOULD register before sending to avoid
   *   races.
   * - `block-body`: accumulates bytes for the current in-flight block.
   * - `block-end` / `block-error`: closes the in-flight block, resolves the
   *   matching pending command.
   * - `notification`: forwarded to `onNotification`; not correlated.
   * - `dcs-open` / `dcs-close`: ignored (informational from the tokenizer).
   */
  push(token: ControlToken): void {
    switch (token.kind) {
      case "block-begin":
        this._handleBegin(token);
        break;
      case "block-body":
        this._handleBody(token);
        break;
      case "block-end":
        this._handleEnd(token);
        break;
      case "block-error":
        this._handleError(token);
        break;
      case "notification":
        this._onNotification?.(token);
        break;
      case "dcs-open":
      case "dcs-close":
        // Informational; no correlation action needed.
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Internal handlers
  // -------------------------------------------------------------------------

  private _handleBegin(token: BlockBeginToken): void {
    if (this._inFlight !== null) {
      // Protocol violation: %begin while a block is already open.
      // This cannot happen if the tokenizer is correct, but be defensive.
      this._rejectOldest(
        new Error(
          `correlator: %begin (cmdnum=${token.commandNumber}) arrived while block ` +
            `${this._inFlight.commandNumber} is still open`,
        ),
      );
    }

    // tmux uses flags=0 for the implicit startup block that it emits once at
    // the very start of a -CC session (before responding to any user commands).
    // This block is NOT the reply to any expectCommand() slot — binding it to
    // the oldest pending entry would consume a slot intended for the first real
    // bootstrap command (list-windows), corrupting the FIFO sequence.
    const isStartupBlock = token.flags === 0;

    // Open a new in-flight accumulation slot.
    this._inFlight = {
      commandNumber: token.commandNumber,
      bodyChunks: [],
      bodyLen: 0,
      isStartupBlock,
    };

    if (isStartupBlock) {
      // Startup block: accumulate body/end but do NOT bind to any pending entry.
      // _closeBlock will check isStartupBlock and silently discard on close.
      return;
    }

    // Bind the commandNumber to the oldest pending command, if any.
    const oldest = this._pending[0];
    if (oldest !== undefined) {
      oldest.expectedCommandNumber = token.commandNumber;
    }
    // If no pending command exists: the block will still be accumulated.
    // When push() sees %end/%error it will resolve whoever is at the front
    // of the queue at that time (or reject with a mismatch error if still none).
  }

  private _handleBody(token: BlockBodyToken): void {
    if (this._inFlight === null) {
      // Protocol violation: body outside a block. Ignore defensively.
      return;
    }
    this._inFlight.bodyChunks.push(token.bytes);
    this._inFlight.bodyLen += token.bytes.length;
  }

  private _handleEnd(token: BlockEndToken): void {
    this._closeBlock(token.commandNumber, true);
  }

  private _handleError(token: BlockErrorToken): void {
    this._closeBlock(token.commandNumber, false);
  }

  /**
   * Close the current in-flight block and resolve the oldest pending command.
   *
   * @param closingCmdNum - The commandNumber from the %end/%error guard line.
   * @param ok - True for %end, false for %error.
   */
  private _closeBlock(closingCmdNum: number, ok: boolean): void {
    if (this._inFlight === null) {
      // No open block — stray %end/%error. Ignore.
      return;
    }

    // Safety: verify the commandNumber on the closing guard matches the one
    // on the opening %begin. A mismatch would indicate a protocol anomaly.
    if (this._inFlight.commandNumber !== closingCmdNum) {
      const err = new Error(
        `correlator: commandNumber mismatch — %begin had ${this._inFlight.commandNumber}` +
          `, but closing guard has ${closingCmdNum}`,
      );
      // Collect the body anyway (best effort) but reject the pending command.
      this._inFlight = null;
      this._rejectOldest(err);
      return;
    }

    const { isStartupBlock } = this._inFlight;

    // Materialise the accumulated body.
    const body = this._collectBody();
    const commandNumber = closingCmdNum;
    this._inFlight = null;

    // Startup blocks (flags=0) are never bound to a pending expectCommand() slot.
    // Silently discard rather than dequeuing from _pending.
    if (isStartupBlock) {
      return;
    }

    // Dequeue the oldest pending command.
    const pending = this._pending.shift();
    if (pending === undefined) {
      // No registered command — unsolicited block. Silently discard.
      // (This can happen if the caller fires a command without registering via
      // expectCommand(), which is a caller error.)
      return;
    }

    // Secondary safety: if we bound a commandNumber to this pending entry on
    // %begin, verify it matches now.
    if (
      pending.expectedCommandNumber !== undefined &&
      pending.expectedCommandNumber !== commandNumber
    ) {
      pending.reject(
        new Error(
          `correlator: expected cmdnum ${pending.expectedCommandNumber} but got ${commandNumber}`,
        ),
      );
      return;
    }

    pending.resolve({ ok, commandNumber, body });
  }

  /**
   * Join all accumulated body chunks into one Uint8Array, with a `\n` (0x0a)
   * separator between chunks (each chunk is one tokenizer line, already
   * stripped of its trailing newline).
   *
   * tc-fx4: this restores the documented `CommandResult.body` contract
   * ("lines are joined by `\n`").  The previous implementation concatenated
   * chunks with NO separator, which glued multi-line replies together and
   * silently broke every line-oriented body parser: bootstrap's
   * `parseWindowsReply` / `parsePanesReply` (multi-window / multi-pane
   * sessions lost all rows after the first) and the pipeline's %window-add
   * layout reconcile.
   */
  private _collectBody(): Uint8Array {
    if (this._inFlight === null) return new Uint8Array(0);
    const { bodyChunks, bodyLen } = this._inFlight;
    if (bodyChunks.length === 0) return new Uint8Array(0);
    if (bodyChunks.length === 1) return bodyChunks[0]!;

    // bodyLen content bytes + one 0x0a separator between adjacent chunks.
    const out = new Uint8Array(bodyLen + bodyChunks.length - 1);
    let offset = 0;
    for (let i = 0; i < bodyChunks.length; i++) {
      if (i > 0) {
        out[offset] = 0x0a; // '\n'
        offset += 1;
      }
      const chunk = bodyChunks[i]!;
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Reject the oldest pending command with an error. */
  private _rejectOldest(err: Error): void {
    const pending = this._pending.shift();
    pending?.reject(err);
  }
}
