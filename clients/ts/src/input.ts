/**
 * Input / resize API — client→session-proxy direction.
 *
 * # Responsibilities
 *
 * This module provides the `InputApi` interface and its `createInputApi`
 * factory, which sits on top of `SessionProxyConnection.send()`:
 *
 *   - `sendInput(paneId, data)` — wraps a string payload in a wire
 *     `InputMessage` (type: "input") and fires it immediately.  Input bytes
 *     are NEVER coalesced: every call produces exactly one wire message,
 *     preserving keystroke ordering.
 *
 *   - `resizePane(paneId, cols, rows)` — wraps dimensions in a wire
 *     `ResizeRequestMessage` (type: "resize.request").  With the default
 *     options, resize requests for the same pane are debounced within a
 *     single async tick (via `Promise.resolve()`) to avoid flooding the
 *     session-proxy during rapid viewport drags.  Only the LAST resize for a given
 *     pane within a tick is sent; the final value is never dropped.
 *
 * # Coalescing policy
 *
 * Resize events can fire at display-refresh rates when a user drags a pane
 * border.  Flooding the session-proxy with hundreds of resize messages per second
 * risks congesting the control plane.  The coalescer keeps only the most
 * recent `{cols, rows}` per pane and flushes after one microtask boundary:
 *
 *   resizePane("p1", 80, 24)  ─┐
 *   resizePane("p1", 81, 24)   ├─ only ResizeRequest{p1, 82, 24} is sent
 *   resizePane("p1", 82, 24)  ─┘
 *
 * Input messages are NOT coalesced; they pass through immediately.
 *
 * Ordering guarantee: because flush happens via `Promise.resolve()`, any
 * input call made in the same synchronous frame as resize calls will be
 * dispatched FIRST (input is synchronous; resize flush is a microtask),
 * preserving input-before-resize ordering for same-tick interleaving.
 * Callers that need a specific input→resize order across async boundaries
 * should `await` between the two.
 *
 * To disable coalescing, pass `{ coalesceResizes: false }` — each resize
 * will be forwarded immediately without buffering.
 *
 * # seq handling
 *
 * The wire `MessageBase` requires a `seq: number` on every message.  The
 * spec says the SENDER increments the counter per connection (per control.ts
 * line 107: "Per-connection sequence number … incremented by the SENDER for
 * each message").  `SessionProxyConnection.send()` calls `transport.sendControl()`
 * directly without stamping a seq, so the seq counter must be managed HERE,
 * at the message-construction level.
 *
 * `createInputApi` maintains a single monotonically-increasing counter
 * (`#seq`) starting at 1.  Every `InputMessage` or `ResizeRequestMessage`
 * constructed here consumes the next value.  The counter is per-`InputApi`
 * instance; if you create multiple `InputApi` instances over the same
 * connection you must share the counter externally or accept that each
 * instance starts from 1 (which is acceptable for the current single-api-
 * per-connection usage pattern).
 *
 * # NO DOM, NO vscode, NO host API, NO Pseudoterminal
 */

import type { PaneId, InputMessage, ResizeRequestMessage, CommandRequestMessage, WireCommand } from "@remux/session-proxy";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Options for `createInputApi`.
 */
export interface InputApiOptions {
  /**
   * Whether to coalesce rapid resize requests for the same pane within one
   * async tick (microtask boundary via `Promise.resolve()`).
   *
   * Default: `true` — only the latest resize per pane within a tick is sent,
   * reducing wire traffic during rapid viewport drags.
   *
   * Set to `false` to disable: every `resizePane()` call produces an
   * immediate wire message (useful for tests that assert message count).
   */
  coalesceResizes?: boolean;
}

/**
 * The input/resize surface exposed by `createInputApi`.
 *
 * Renderers call these methods with already-decoded input — no key-event
 * parsing happens here (that is E6's responsibility).
 */
export interface InputApi {
  /**
   * Send a UTF-8 input string to a pane.
   *
   * Produces a single `InputMessage` (type: "input") immediately.  Input is
   * NEVER coalesced: each call maps 1-to-1 to a wire message to preserve
   * keystroke ordering.  Special key sequences (e.g. `"\x1b[A"` for Up arrow)
   * should already be encoded in `data` before calling.
   *
   * @param paneId - Target pane.
   * @param data   - UTF-8 string to write to the pane's stdin.
   */
  sendInput(paneId: PaneId, data: string): void;

  /**
   * Request a pane resize.
   *
   * With the default options (`coalesceResizes: true`), rapid calls for the
   * same pane are coalesced: only the latest `{cols, rows}` within a single
   * microtask tick is sent.  The final resize is never dropped.
   *
   * With `coalesceResizes: false`, every call produces an immediate wire
   * message.
   *
   * @param paneId - Pane to resize.
   * @param cols   - New width in terminal columns.
   * @param rows   - New height in terminal rows.
   */
  resizePane(paneId: PaneId, cols: number, rows: number): void;

  /**
   * Flush any pending coalesced resize messages immediately.
   *
   * Normally called automatically at the next microtask boundary.  Exposed
   * for test scenarios that need deterministic flushing without waiting for
   * the microtask queue to drain.
   *
   * No-op when `coalesceResizes` is false.
   */
  flush(): void;

  /**
   * Send a model-level command to the sessionProxy (VS Code → tmux direction).
   *
   * Wraps `cmd` in a `command.request` wire message with a unique
   * correlationId (monotonic counter string) and fires it immediately.
   * The command is NOT coalesced — each call produces exactly one wire message.
   *
   * The resulting tmux operation (new window, split, close, etc.) flows back
   * through the normal model-change path as onWindowAdded / onPaneOpened /
   * onPaneClosed callbacks.
   *
   * tc-9hk: consumed by ClientController.sendCommand, which is called from
   * VS Code commands `tmuxcc.newWindow` / `tmuxcc.splitPane` in extension.ts.
   *
   * @param cmd - The model-level command to send.
   */
  sendCommand(cmd: WireCommand): void;
}

// ---------------------------------------------------------------------------
// Minimal send seam (subset of SessionProxyConnection used here)
// ---------------------------------------------------------------------------

/**
 * The only method of `SessionProxyConnection` this module depends on.
 * Accepting an interface (rather than the concrete class) keeps `InputApi`
 * testable without a full handshake — a mock `{ send }` suffices.
 */
export interface InputSender {
  send(msg: InputMessage | ResizeRequestMessage | CommandRequestMessage): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an `InputApi` bound to a `SessionProxyConnection` (or any `InputSender`).
 *
 * ```ts
 * const api = createInputApi(connection);
 * api.sendInput("p0", "hello\r");
 * api.resizePane("p0", 220, 50);
 * ```
 *
 * @param sender - A `SessionProxyConnection` or any object with a `send()` method.
 * @param opts   - Optional tuning; see `InputApiOptions`.
 */
export function createInputApi(
  sender: InputSender,
  opts: InputApiOptions = {},
): InputApi {
  const coalesce = opts.coalesceResizes ?? true;

  // Per-api-instance seq counter.  Starts at 1 per wire spec (control.ts:107).
  let seq = 1;

  // Pending resize buffer: paneId → {cols, rows}.  Only populated when
  // coalesceResizes is true and a flush is scheduled.
  const pending = new Map<PaneId, { cols: number; rows: number }>();
  let flushScheduled = false;

  function nextSeq(): number {
    return seq++;
  }

  function flushResizes(): void {
    flushScheduled = false;
    for (const [paneId, { cols, rows }] of pending) {
      const msg: ResizeRequestMessage = {
        type: "resize.request",
        seq: nextSeq(),
        paneId,
        cols,
        rows,
      };
      sender.send(msg);
    }
    pending.clear();
  }

  function scheduleFlush(): void {
    if (!flushScheduled) {
      flushScheduled = true;
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      Promise.resolve().then(flushResizes);
    }
  }

  return {
    sendInput(paneId: PaneId, data: string): void {
      const msg: InputMessage = {
        type: "input",
        seq: nextSeq(),
        paneId,
        data,
      };
      sender.send(msg);
    },

    resizePane(paneId: PaneId, cols: number, rows: number): void {
      if (!coalesce) {
        const msg: ResizeRequestMessage = {
          type: "resize.request",
          seq: nextSeq(),
          paneId,
          cols,
          rows,
        };
        sender.send(msg);
        return;
      }
      // Coalescing path: overwrite whatever is pending for this pane.
      pending.set(paneId, { cols, rows });
      scheduleFlush();
    },

    flush(): void {
      if (coalesce && pending.size > 0) {
        flushResizes();
      }
    },

    sendCommand(cmd: WireCommand): void {
      // Each sendCommand call consumes a seq and generates a unique correlationId.
      const msg: CommandRequestMessage = {
        type: "command.request",
        seq: nextSeq(),
        correlationId: String(seq - 1), // use the seq we just consumed
        command: cmd,
      };
      sender.send(msg);
    },
  };
}
