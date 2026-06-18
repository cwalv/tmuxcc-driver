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

import type {
  PaneId,
  WindowId,
  InputMessage,
  ResizeRequestMessage,
  CommandRequestMessage,
  WireCommand,
  SessionProxyCommandResponseMessage,
  PaneAttachMessage,
} from "@tmuxcc/session-proxy";

// ---------------------------------------------------------------------------
// VerbResult (tc-ozk.1)
// ---------------------------------------------------------------------------

/**
 * The result of a verb sent via `sendVerb`, as RETURNED by the session-proxy
 * in the `command.response` payload (tc-ozk.1 / tc-u7cu.3).
 *
 * Two success variants:
 *
 *   Pane/window-CREATING verbs (split-pane, open-window, break-pane):
 *     `{ ok: true, newPaneId, newWindowId }` — the ids tmux actually created.
 *     The host binds by these ids whenever the pane materialises (which may
 *     arrive before OR after this result), with NO observer/claim correlation.
 *
 *   State-MUTATING non-creating verbs (kill-pane, rename-session, etc.) —
 *   tc-u7cu.3:
 *     `{ ok: true }` — tmux accepted the command (no `%error`).  No new
 *     pane/window was created; `newPaneId` and `newWindowId` are absent.
 *
 * On failure (tmux `%error` or protocol error):
 *     `{ ok: false, code, message }`.
 *
 * Summary:
 *   { ok: true, newPaneId, newWindowId }  — creating verb success
 *   { ok: true }                          — non-creating verb ACK
 *   { ok: false, code, message }          — failure (any verb kind)
 */
export type VerbResult =
  | {
      readonly ok: true;
      /** Wire id of the created pane (`p<N>`). Present only for creating verbs. */
      readonly newPaneId?: PaneId;
      /** Wire id of the window the new pane lives in (`w<N>`). Present only for creating verbs. */
      readonly newWindowId?: WindowId;
    }
  | {
      readonly ok: false;
      /** Machine-readable error code (e.g. "verb.failed"). */
      readonly code: string;
      /** Human-readable error description. */
      readonly message: string;
    };

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
   * Mark the connection disconnected: discard any pending coalesced resize
   * WITHOUT sending it, disarm the scheduled microtask flush, and make all
   * FUTURE `resizePane()` calls no-ops (p8lh).
   *
   * Called by `disconnect()` BEFORE `connection.close()`.  A coalesced
   * `resizePane()` defers its `sender.send()` to a microtask
   * (`Promise.resolve().then(flushResizes)`).  If that microtask runs after
   * `connection.close()` it calls `send()` on a CLOSED connection and throws
   * `SessionProxyConnection.send() ... in state "closed"` — a floating-microtask
   * UNHANDLED REJECTION (the p8lh flake).  Two windows must be closed:
   *   - the resize already buffered at disconnect (drained here), and
   *   - a resize that arrives AFTER disconnect (VS Code fires pty.setDimensions
   *     asynchronously during teardown / spawn-churn) which would otherwise
   *     schedule a fresh deferred send — now dropped by the `disconnected` gate.
   *
   * A resize on a disconnected connection is obsolete by definition, so dropping
   * it is correct; we are STOPPING an illegal send, not muzzling the tripwire
   * (`send()` still throws on a closed connection for any real caller).
   *
   * Symmetric with `rejectAllPending` (which drains the pending verb/capture
   * promises on the same teardown).
   */
  markDisconnected(): void;

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

  /**
   * Send a pane/window-CREATING verb and RESOLVE with its effect ids (tc-ozk.1).
   *
   * Like `sendCommand`, but returns a Promise that resolves when the matching
   * `command.response` arrives (correlated by correlationId).  On success the
   * `VerbResult` carries `{ ok: true, newPaneId, newWindowId }` — the ids tmux
   * actually created — so the caller can bind by id the moment the pane shows
   * up, with zero observer/claim machinery.  On a tmux `%error` (or an
   * unparseable effect-id reply on the session-proxy side) it resolves
   * `{ ok: false, code, message }` (the response is never rejected; failures
   * are values, not exceptions).
   *
   * Routing: the caller MUST feed `command.response` messages to
   * `handleCommandResponse` (connectClient wires this via the mirror).  If the
   * connection closes before the response arrives, the pending verb is rejected
   * via `rejectAllPending`.
   *
   * @param cmd - A creating verb (split-pane / open-window / break-pane).
   *              Other command kinds will also work but only resolve if the
   *              session-proxy sends a command.response for them.
   */
  sendVerb(cmd: WireCommand): Promise<VerbResult>;

  /**
   * Resolve the pending `sendVerb` Promise that matches this response's
   * correlationId (tc-ozk.1).  No-op if no verb is awaiting this id (e.g. a
   * response to a fire-and-forget `sendCommand`, or a duplicate response).
   *
   * connectClient routes every `command.response` here from the mirror's
   * control stream.
   */
  handleCommandResponse(msg: SessionProxyCommandResponseMessage): void;

  /**
   * Reject every in-flight `sendVerb` Promise (tc-ozk.1).
   *
   * Called on disconnect so awaiting callers don't hang forever.  The rejection
   * reason is an Error carrying `reason`.
   */
  rejectAllPending(reason: string): void;

  /**
   * Send a `pane.attach` request to the session-proxy (tc-295a.8).
   *
   * Produces a single `pane.attach` wire message immediately (not coalesced).
   * Triggers on-demand per-pane hydration of `paneId` on this connection — the
   * session-proxy responds with pane.hydration.begin/end (or pane.attach.failed
   * for a vanished pane). Used by the §1.4 bindNew flow.
   *
   * @param paneId - The pane to attach + hydrate.
   */
  attachPane(paneId: PaneId): void;

  /**
   * Send a `pane.capture` command and await the full scrollback text
   * (tc-295a.17 / E3.2).
   *
   * Issues a correlated `command.request { kind: "pane.capture", paneId }` and
   * resolves with the full UTF-8 scrollback text from the `command.response`
   * payload when the session-proxy replies with `result.ok = true`.
   *
   * Rejects (fail-loud) when:
   *   - `result.ok = false` (e.g. code `"pane.not-found"`)
   *   - The connection closes before the response arrives
   *     (`rejectAllPending` is called on disconnect)
   *
   * Routing: requires `handleCommandResponse` to be called with matching
   * `command.response` messages (connectClient wires this via the mirror).
   *
   * @param paneId - The pane to capture.
   */
  sendPaneCapture(paneId: PaneId): Promise<string>;
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
  send(msg: InputMessage | ResizeRequestMessage | CommandRequestMessage | PaneAttachMessage): void;
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

  // p8lh: set by markDisconnected() (called from connectClient().disconnect()).
  // Once disconnected the connection is closed and any further resize is
  // obsolete; resizePane() becomes a no-op so it cannot schedule a deferred
  // flush that would call send() on the closed connection and throw.  VS Code
  // fires pty.setDimensions ASYNCHRONOUSLY — including after the spawn was
  // disposed during teardown / spawn-churn — so resizePane() legitimately
  // arrives post-disconnect; dropping it is correct (the connection is gone),
  // not muzzling the close-state send() tripwire.
  let disconnected = false;

  // tc-ozk.1: pending sendVerb() promises keyed by correlationId.  Resolved by
  // handleCommandResponse when the matching command.response arrives; rejected
  // en masse by rejectAllPending on disconnect.
  const pendingVerbs = new Map<
    string,
    { resolve: (result: VerbResult) => void; reject: (err: Error) => void }
  >();

  // tc-295a.17 / E3.2: pending sendPaneCapture() promises keyed by correlationId.
  // Resolved with the captured text string on success; rejected on wire error or
  // disconnect.  Shared rejectAllPending sweep.
  const pendingCaptures = new Map<
    string,
    { resolve: (text: string) => void; reject: (err: Error) => void }
  >();

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
      // p8lh: after disconnect the connection is closed; a resize is obsolete
      // and sending it would throw "send() ... in state closed".  Drop it.
      if (disconnected) return;
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

    markDisconnected(): void {
      // p8lh: the connection is closing — block further coalesced-resize sends.
      // 1. Drop the pending coalesced resize and disarm the scheduled flush so
      //    the already-queued `flushResizes` microtask is a no-op (empty
      //    `pending`) instead of calling send() on the closing connection.
      // 2. Set `disconnected` so any LATER resizePane() (VS Code fires
      //    pty.setDimensions asynchronously during teardown) is dropped at the
      //    door and never schedules a new deferred send.
      disconnected = true;
      pending.clear();
      flushScheduled = false;
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

    sendVerb(cmd: WireCommand): Promise<VerbResult> {
      const correlationId = String(nextSeq());
      const msg: CommandRequestMessage = {
        type: "command.request",
        seq: Number(correlationId),
        correlationId,
        command: cmd,
      };
      return new Promise<VerbResult>((resolve, reject) => {
        pendingVerbs.set(correlationId, { resolve, reject });
        try {
          sender.send(msg);
        } catch (err) {
          // The send itself failed (e.g. connection not ready) — don't leak the
          // pending entry.
          pendingVerbs.delete(correlationId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    handleCommandResponse(msg: SessionProxyCommandResponseMessage): void {
      // tc-295a.17 / E3.2: dispatch pane.capture responses before verb responses.
      // A correlationId is owned by exactly one pending map — capture OR verb, never both.
      const captureDeferred = pendingCaptures.get(msg.correlationId);
      if (captureDeferred !== undefined) {
        pendingCaptures.delete(msg.correlationId);
        if (msg.result.ok) {
          const text = msg.result.payload?.text;
          if (text !== undefined) {
            captureDeferred.resolve(text);
          } else {
            captureDeferred.reject(new Error(
              `tmuxcc: pane.capture — response ok=true but payload.text was absent: ${JSON.stringify(msg.result.payload)}`,
            ));
          }
        } else {
          captureDeferred.reject(new Error(
            `tmuxcc: pane.capture — ${msg.result.code}: ${msg.result.message}`,
          ));
        }
        return;
      }

      const deferred = pendingVerbs.get(msg.correlationId);
      if (deferred === undefined) return; // not an awaited verb (e.g. fire-and-forget)
      pendingVerbs.delete(msg.correlationId);
      if (msg.result.ok) {
        const payload = msg.result.payload;
        if (payload?.paneId !== undefined && payload?.windowId !== undefined) {
          // Creating verb (split-pane / open-window / break-pane): ids present.
          deferred.resolve({
            ok: true,
            newPaneId: payload.paneId,
            newWindowId: payload.windowId,
          });
        } else if (payload?.paneId === undefined && payload?.windowId === undefined) {
          // tc-u7cu.3: Non-creating state-mutating verb ACK (kill-pane,
          // rename-session, etc.): ok=true with no pane/window ids.
          // Resolve as simple success — the caller distinguishes by checking
          // whether newPaneId/newWindowId are present.
          deferred.resolve({ ok: true });
        } else {
          // ok=true but ONLY ONE id present — session-proxy contract violation.
          // Surface as a failure rather than a half-populated success.
          deferred.resolve({
            ok: false,
            code: "verb.no-effect-ids",
            message: `command.response ok=true but payload had only one of paneId/windowId: ${JSON.stringify(payload)}`,
          });
        }
      } else {
        deferred.resolve({
          ok: false,
          code: msg.result.code,
          message: msg.result.message,
        });
      }
    },

    rejectAllPending(reason: string): void {
      for (const deferred of pendingVerbs.values()) {
        deferred.reject(new Error(reason));
      }
      pendingVerbs.clear();
      // tc-295a.17 / E3.2: also reject in-flight pane.capture awaits.
      for (const deferred of pendingCaptures.values()) {
        deferred.reject(new Error(reason));
      }
      pendingCaptures.clear();
    },

    attachPane(paneId: PaneId): void {
      // tc-295a.8: not coalesced — one wire message per call. Carries a seq from
      // the same per-connection counter as input/resize/command.
      const msg: PaneAttachMessage = {
        type: "pane.attach",
        seq: nextSeq(),
        paneId,
      };
      sender.send(msg);
    },

    sendPaneCapture(paneId: PaneId): Promise<string> {
      // tc-295a.17 / E3.2: one-shot pane text snapshot via the W3.3 wire command.
      // Sends command.request { kind: "pane.capture", paneId } and awaits the
      // matching command.response where result.ok=true and payload.text carries
      // the full scrollback.  Fail-loud on pane.not-found or transport close.
      const correlationId = String(nextSeq());
      const msg: CommandRequestMessage = {
        type: "command.request",
        seq: Number(correlationId),
        correlationId,
        command: { kind: "pane.capture", paneId },
      };
      return new Promise<string>((resolve, reject) => {
        pendingCaptures.set(correlationId, { resolve, reject });
        try {
          sender.send(msg);
        } catch (err) {
          // The send itself failed — don't leak the pending entry.
          pendingCaptures.delete(correlationId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
  };
}
