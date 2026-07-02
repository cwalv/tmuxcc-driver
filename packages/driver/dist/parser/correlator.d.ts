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
import type { ControlToken, NotificationToken } from "./tokenizer.js";
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
    /**
     * Called once per `%end` / `%error` block that closed with NO pending
     * slot to bind to (and was NOT a `flags=0` startup block — those are a
     * tmux protocol fixture, not a slot regression). This is the
     * `correlator_unsolicited_blocks_total` tripwire seam (tc-3si.5):
     * expected-zero once tc-3si.1's atomic slot+write makes a slot-less
     * reply structurally impossible. Any increment is the flow-load-F4
     * class announcing itself BEFORE corruption.
     *
     * Throws are caught and swallowed so a misbehaving observer cannot
     * break the pipeline.
     */
    onUnsolicitedBlock?: () => void;
    /**
     * Called after every operation that changes the pending FIFO — i.e.
     * `expectCommand()` / `send()` (push), and `_closeBlock` (shift). Fed
     * the current depth and the oldest slot's age in seconds (or 0 when the
     * queue is empty). The wiring layer drives the
     * `correlator_pending_slots` + `correlator_pending_slot_max_age_seconds`
     * gauges from here (tc-3si.5).
     *
     * Hot-path cost: one closure call per command edge — bounded by the
     * command rate (≤ ~10/s in steady state). Throws are caught and
     * swallowed.
     */
    onPendingChanged?: (depth: number, oldestAgeSeconds: number) => void;
    /**
     * Optional clock override for the pending-slot age accounting. Defaults
     * to `Date.now`. Tests inject a controlled clock so age assertions are
     * deterministic without sleeps.
     */
    nowMs?: () => number;
}
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
export declare class CommandCorrelator {
    private readonly _onNotification;
    private readonly _write;
    private readonly _onUnsolicitedBlock;
    private readonly _onPendingChanged;
    private readonly _nowMs;
    /**
     * FIFO queue of pending commands registered by the caller.
     * Dequeued in order as %end/%error blocks complete.
     */
    private readonly _pending;
    /** The command currently open (between %begin and %end/%error), or null. */
    private _inFlight;
    constructor(options?: CommandCorrelatorOptions);
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
    expectCommand(): Promise<CommandResult>;
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
    send(command: string): Promise<CommandResult>;
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
    sendBatch(commands: readonly string[]): Promise<CommandResult>[];
    /**
     * Abandon the `count` OLDEST still-live pending slots (tc-hfxb.15).
     *
     * Used to recover from a STALLED command round-trip (the bootstrap requery
     * whose first `list-*` reply never arrives under host load — see
     * `pipeline.start()`). Each abandoned slot's waiter Promise is REJECTED with
     * `err` so the caller stops awaiting and can re-issue, but the slot is NOT
     * removed from the FIFO: it is flagged `cancelled` and left in place as a
     * DRAINED PLACEHOLDER.
     *
     * Why leave it in the FIFO instead of removing it? The correlator binds
     * replies to slots POSITIONALLY (oldest-first on `%end`/`%error`). If the
     * stalled command's reply eventually does arrive — concurrently with the
     * re-issued command and/or unrelated commands queued behind it — that late
     * reply MUST consume the abandoned slot's position. Removing the slot would
     * shift every later slot forward by one, so the late reply would mis-bind to
     * a live command's slot and corrupt its response (the exact tc-3si.1 / tc-128.4
     * mis-bind class). Keeping the placeholder makes the late reply land on the
     * cancelled slot, where `_closeBlock` discards it.
     *
     * Already-cancelled slots are skipped (idempotent) and do NOT count toward
     * `count`. Returns the number of slots actually cancelled (may be < `count`
     * if fewer live slots are pending).
     */
    cancelOldest(count: number, err: Error): number;
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
    push(token: ControlToken): void;
    private _handleBegin;
    private _handleBody;
    private _handleEnd;
    private _handleError;
    /**
     * Close the current in-flight block and resolve the oldest pending command.
     *
     * @param closingCmdNum - The commandNumber from the %end/%error guard line.
     * @param ok - True for %end, false for %error.
     */
    private _closeBlock;
    /**
     * Snapshot the current pending depth and the oldest slot's age (in
     * seconds), then dispatch to `onPendingChanged`. Throws are swallowed.
     *
     * This is the seam the session-proxy wiring uses to drive the
     * `correlator_pending_slots` + `correlator_pending_slot_max_age_seconds`
     * gauges (tc-3si.5). Called on register and on close; not on body bytes.
     */
    private _firePendingChanged;
    /**
     * Expose the current pending-slot age snapshot so an external poller
     * (e.g. the `session-proxy.info` reader) can refresh the gauges without
     * waiting for the next command edge. Hot-path cost: one Date.now() call
     * + one subtraction.
     *
     * Returns `{ depth: 0, oldestAgeSeconds: 0 }` when the queue is empty.
     */
    pendingSnapshot(): {
        depth: number;
        oldestAgeSeconds: number;
    };
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
    private _collectBody;
    /** Reject the oldest pending command with an error. */
    private _rejectOldest;
}
//# sourceMappingURL=correlator.d.ts.map