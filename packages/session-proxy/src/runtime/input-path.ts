/**
 * Client→tmux input path (tc-kvk).
 *
 * Maps `ClientMessage` wire messages to tmux control-mode commands and writes
 * them to the tmux host's stdin.  This is the CLIENT→TMUX direction; the
 * complementary TMUX→CLIENT direction (output demux) is handled by tc-fbz.
 *
 * # Handled message types
 *
 *   - `input`          → `send-keys -H -t %<N> <hex-bytes…>`
 *   - `resize.request` → `refresh-client -C <cols>x<rows>`
 *   - `command.request`→ mapped to the matching tmux command via the E2
 *                        serializers (split-pane, new-window etc.).
 *   - `client.capabilities` — silently ignored (handshake concern, tc-auj).
 *
 * # Id-mapping approach
 *
 * Wire `PaneId` / `WindowId` values follow the session-proxy's minting convention
 * (confirmed in src/state/reducer.ts):
 *
 *   - PaneId   → `"p" + tmuxPaneNum`   (e.g. "p1" → tmux pane %1)
 *   - WindowId → `"w" + tmuxWindowNum` (e.g. "w3" → tmux window @3)
 *
 * These are invertible by stripping the leading letter and parsing the
 * remainder as a decimal integer.  The helpers `paneIdToTmux` and
 * `windowIdToTmux` perform this inversion.
 *
 * LIMITATION: this approach relies on the "p<N>"/"w<N>" prefix convention
 * being stable.  A future registry-based approach (session-proxy-level Map<PaneId,
 * number>) would be more robust if the convention changes — e.g. to support
 * multi-session namespacing like "s0-p3".  The factory accepts an optional
 * `paneIdToTmux` override so callers can inject a registry at integration
 * time without changing this module.
 *
 * # Resize mapping decision
 *
 * `ResizeRequestMessage{paneId, cols, rows}` represents a client viewport
 * change — the host window (VS Code pane, terminal emulator) was resized.
 * The correct tmux command is `refresh-client -C <cols>x<rows>`, which sets
 * the **control-mode client** terminal size.  tmux then propagates the new
 * client size to the window layout and ultimately to individual panes.
 *
 * Per-pane sizing via `refresh-client -C @<win>:<cols>x<rows>` (tmux ≥ 3.4)
 * would be the right primitive for multi-window per-tab sizing (e.g. iTerm2),
 * but requires knowing which window the pane belongs to and is outside the
 * scope of this bead.  The `ResizePaneCommand` wire command (handled below) is
 * the explicit user-initiated resize path and also maps to `refresh-client -C`
 * for now; a future bead can refine this to `resize-pane` if needed.
 *
 * # API seam
 *
 * The session-proxy's serve layer (tc-dv3) constructs an InputPath and forwards each
 * decoded ClientMessage to `handleClientMessage`.  Example wiring:
 *
 * ```ts
 * const path = createInputPath({
 *   send: (cmd) => pipeline.send(cmd),
 *   sendBatch: (cmds) => pipeline.sendBatch(cmds),
 * });
 * transport.onControl(msg => path.handleClientMessage(msg));
 * ```
 */

import type { ClientMessage } from "../wire/index.js";
import type { PaneId, WindowId } from "../wire/index.js";
import { paneId as mkPaneId, windowId as mkWindowId } from "../wire/index.js";
import type { CommandResult } from "../parser/correlator.js";
import {
  sendKeysHex,
  refreshClientSize,
  refreshClientWindowSize,
  splitWindow,
  newWindow,
  breakPane,
  parseEffectIds,
  setOptionForWindow,
  setWindowSizeManual,
  resizeWindow,
  resizePane as resizePaneCmd,
} from "../parser/commands.js";
import type { NotificationEvent } from "../parser/notifications.js";
import type { SessionModel } from "../state/model.js";

// ---------------------------------------------------------------------------
// Id-mapping helpers
// ---------------------------------------------------------------------------

/**
 * Default PaneId→tmux-numeric inversion.
 *
 * Strips the leading "p" prefix and parses the remainder as a decimal integer.
 * Throws a TypeError if the id does not match the expected "p<N>" format.
 *
 * Convention source: src/state/reducer.ts `mintPaneId("p" + tmuxId)`.
 *
 * If you have a raw tmux pane id (e.g. "%1" from a tmux query), convert it to
 * the internal model format first: the model mints PaneIds as "p" + tmuxPaneNum,
 * so "%1" becomes "p1".
 */
function defaultPaneIdToTmux(id: PaneId): number {
  const s = id as string;
  if (!s.startsWith("p")) {
    throw new TypeError(
      `defaultPaneIdToTmux: expected internal model PaneId format "p<N>" (e.g. "p1"); ` +
      `got "${s}". If you have a tmux-format id (e.g. "%1"), ` +
      `use the model's PaneId directly (the session-proxy mints them as "p" + tmuxPaneNum).`,
    );
  }
  const n = parseInt(s.slice(1), 10);
  if (Number.isNaN(n)) {
    throw new TypeError(
      `defaultPaneIdToTmux: could not parse numeric suffix from PaneId "${s}".`,
    );
  }
  return n;
}

/**
 * Default WindowId→tmux-numeric inversion.
 *
 * Strips the leading "w" prefix and parses the remainder as a decimal integer.
 * Throws a TypeError if the id does not match the expected "w<N>" format.
 *
 * Convention source: src/state/reducer.ts `mintWindowId("w" + tmuxId)`.
 *
 * If you have a raw tmux window id (e.g. "@9" from a tmux query), convert it to
 * the internal model format first: the model mints WindowIds as "w" + tmuxWindowNum,
 * so "@9" becomes "w9".
 */
function defaultWindowIdToTmux(id: WindowId): number {
  const s = id as string;
  if (!s.startsWith("w")) {
    throw new TypeError(
      `defaultWindowIdToTmux: expected internal model WindowId format "w<N>" (e.g. "w3"); ` +
      `got "${s}". If you have a tmux-format id (e.g. "@9"), ` +
      `use the model's WindowId directly (the session-proxy mints them as "w" + tmuxWindowNum).`,
    );
  }
  const n = parseInt(s.slice(1), 10);
  if (Number.isNaN(n)) {
    throw new TypeError(
      `defaultWindowIdToTmux: could not parse numeric suffix from WindowId "${s}".`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a CommandCorrelator result that input-path observes.
 *
 * `ok` is read on every command; `body` is read only by the creating verbs
 * (tc-ozk.1) to recover the printed `-P -F` effect ids.  The full type lives in
 * `parser/correlator.ts` (`CommandResult`).
 */
export interface InputPathCommandResult {
  /** True on `%end` (tmux accepted); false on `%error` (tmux rejected). */
  readonly ok: boolean;
  /**
   * Raw reply-block body bytes (joined by `\n`).  Carries the `-P -F`
   * effect-id line for creating verbs.  Optional in the minimal interface so
   * non-verb call sites and the existing FakeDeps need not supply it.
   */
  readonly body?: Uint8Array;
}

/**
 * The result of a pane/window-CREATING verb, as returned to the client in the
 * `command.response` payload (tc-ozk.1).
 *
 * On success the verb RETURNS the ids tmux actually created — the host binds by
 * these ids whenever the pane materialises, no observer/claim correlation
 * needed.  On failure (tmux `%error`, or a success reply whose `-P` body we
 * could not parse) it carries a loud error.
 *
 * Field naming mirrors the bead's VerbResult contract:
 *   { ok: true,  newPaneId, newWindowId? }
 *   { ok: false, code, message }
 */
export type VerbResult =
  | {
      readonly ok: true;
      /** Wire id of the created pane (`p<N>`). Always present for the creating verbs. */
      readonly newPaneId: PaneId;
      /** Wire id of the window the new pane lives in (`w<N>`). */
      readonly newWindowId: WindowId;
    }
  | {
      readonly ok: false;
      /** Machine-readable error code. */
      readonly code: string;
      /** Human-readable error description (for logging / surfacing loudly). */
      readonly message: string;
    };

/** Required dependencies for createInputPath. */
export interface InputPathDeps {
  /**
   * Atomic slot+write callback (typically `pipeline.send`). The ONLY way
   * input-path may emit a tmux command — under the requery pipeline every
   * write must register a correlator slot in the same step or its %end reply
   * mis-binds (tc-3si.1).
   */
  send: (command: string) => Promise<CommandResult>;

  /**
   * Atomic slot+write callback for transactional N-line batches (typically
   * `pipeline.sendBatch`). Used by the resize-managed-window path
   * (window-size manual → resize-window → resize-pane×N) where intervening
   * commands from another writer would corrupt the layout transaction.
   */
  sendBatch: (commands: readonly string[]) => Promise<CommandResult>[];
}

/** Options for createInputPath. */
export interface InputPathOptions {
  /**
   * Override the default PaneId→tmux-numeric mapping.
   *
   * The default strips the "p" prefix and parses the trailing decimal integer.
   * Supply a registry-backed function here when the session-proxy maintains an
   * explicit PaneId↔tmux-number map (more robust for future multi-session
   * namespacing).
   */
  paneIdToTmux?: (id: PaneId) => number;

  /**
   * Override the default WindowId→tmux-numeric mapping.
   *
   * The default strips the "w" prefix and parses the trailing decimal integer.
   */
  windowIdToTmux?: (id: WindowId) => number;

  /**
   * Inject a synthetic NotificationEvent into the live pipeline after a
   * session-proxy-issued command that needs to immediately update the model.
   *
   * Used for the optimistic-update path: input-path sends a tmux command and
   * then injects the expected model change without waiting for a tmux
   * notification (tc-7xv.12 synchronize-panes). The pipeline's injectNotification
   * fires onModelChange if the event changes the model.
   *
   * Omitting this option disables optimistic updates (model unchanged until
   * next notification from tmux). This is safe for tests that mock the host
   * without a real pipeline.
   */
  dispatchSynthetic?: (event: NotificationEvent) => void;

  /**
   * Snapshot the current SessionModel (tc-7xv.37).
   *
   * Called by input-path immediately BEFORE an optimistic-update command is
   * sent, so the before-value of the window option can be captured.  If tmux
   * later rejects the command, input-path dispatches a compensating synthetic
   * event with the captured before-value to restore the prior model state.
   *
   * The returned model must reflect the live pipeline's current state at the
   * moment of the call (i.e. `pipeline.getModel()`).
   *
   * Omitting this option disables reversal capture (the optimistic update
   * still fires but no rollback is performed on tmux %error).
   */
  getModel?: () => SessionModel;
}

/**
 * Per-call sink for the VerbResult of a pane/window-CREATING verb (tc-ozk.1).
 *
 * `handleClientMessage` receives ONE of these per call, bound by the caller to
 * the originating transport.  For `split-pane` / `open-window` / `break-pane`,
 * input-path issues the tmux command with `-P -F` (so the created ids are
 * PRINTED into the reply block), awaits the reply, parses the ids, and calls
 * this responder with the request's `correlationId` and the `VerbResult`.
 *
 * The session-proxy wiring binds this to `server.sendCommandResponse` /
 * `sendCommandError` so the ids (or the %error) reach the client as a
 * `command.response` on the right per-connection seq.
 *
 * Threading it per-call (rather than as a factory option) is required because
 * input-path is a singleton while the response must go to the SPECIFIC client
 * that issued the verb.  When omitted, the verb's tmux command is still issued
 * (the extra `-P -F` body is harmless) but no `command.response` is sent —
 * preserving the fire-and-forget path for tests / non-server callers.
 */
export type VerbResponder = (correlationId: string, result: VerbResult) => void;

/** The input path handle returned by createInputPath. */
export interface InputPath {
  /**
   * Route a ClientMessage to the appropriate tmux command and write it to the
   * host's stdin.  Unrecognised or handshake-only messages are silently ignored.
   *
   * For pane/window-CREATING verbs (split-pane / open-window / break-pane) pass
   * a `respond` callback bound to the originating transport (tc-ozk.1): once the
   * verb's `-P -F` reply arrives, input-path parses the created ids and calls
   * `respond(correlationId, verbResult)`.  Omit `respond` to fire-and-forget
   * (no `command.response` is sent).
   *
   * Throws a TypeError if a message carries an id that the id-mapping function
   * cannot convert (e.g. a tmux-format id like "%1" or "@9" passed where the
   * internal model format "p1" / "w9" is expected).  Callers should ensure they
   * pass model-format ids; catching the TypeError surfaces a programming error.
   */
  handleClientMessage(msg: ClientMessage, respond?: VerbResponder): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an InputPath that routes ClientMessages to tmux commands.
 *
 * @param deps  Required dependencies: `send` and `sendBatch` callbacks
 *              (typically `pipeline.send` and `pipeline.sendBatch`).
 * @param opts  Optional id-mapping overrides and future extension points.
 * @returns     An InputPath whose `handleClientMessage` method the serve layer
 *              (tc-dv3) should call for each decoded ClientMessage.
 *
 * @example
 * ```ts
 * const pipeline = createRuntimePipeline(host);
 * await pipeline.start();
 * const inputPath = createInputPath({
 *   send: (cmd) => pipeline.send(cmd),
 *   sendBatch: (cmds) => pipeline.sendBatch(cmds),
 * });
 * transport.onControl(msg => inputPath.handleClientMessage(msg));
 * ```
 */
export function createInputPath(
  deps: InputPathDeps,
  opts: InputPathOptions = {},
): InputPath {
  const send = deps.send;
  const sendBatch = deps.sendBatch;
  const toTmuxPane = opts.paneIdToTmux ?? defaultPaneIdToTmux;
  const toTmuxWindow = opts.windowIdToTmux ?? defaultWindowIdToTmux;
  const dispatchSynthetic = opts.dispatchSynthetic;
  const getModel = opts.getModel;

  /**
   * Atomically register a correlator slot AND write the command (tc-3si.1).
   *
   * Fire-and-forget callers ignore the returned Promise; the slot is still
   * registered so the FIFO stays in sync with tmux's reply order regardless
   * of what other writers (the requery engine, flow control) are doing
   * concurrently. The returned Promise is consumed by `sendCommandWithReversal`
   * for the optimistic-update error-reversal path.
   */
  function sendCommand(cmd: string): Promise<InputPathCommandResult> {
    return send(cmd);
  }

  /**
   * Maximum number of UTF-8 bytes per send-keys -H command (tc-n4ct).
   *
   * tmux's control-mode command-line length limit is empirically ~5447 bytes
   * (5447 OK, 5448 → "failed to send command").  We use 5000 as a comfortable
   * round-number margin.  Each byte encodes to 3 chars in the command line
   * ("XX "), so 5000 bytes → 14 999 chars — well within the ~5447-byte
   * tmux protocol limit.
   *
   * Note: the tmux limit is on the *command string* length, not on the byte
   * count of the payload.  1 byte → 3 chars ("XX "), so the effective
   * payload-byte limit at the 5447-char tmux boundary is ≈1815 bytes.
   * Choosing 5000 payload bytes keeps the command string at ≤14 999 chars,
   * providing a factor-of-3 safety margin over the 5447-char tmux limit.
   */
  const INPUT_CHUNK_BYTES = 5000;

  /**
   * Send a large input byte array as one or more chunked send-keys -H commands.
   *
   * Chunks the byte array into segments of at most INPUT_CHUNK_BYTES and sends
   * each segment sequentially (await each send before the next) to preserve
   * byte order across the correlator FIFO.
   *
   * An empty byte array is still sent as a single send-keys -H (no-op but
   * preserves the existing empty-input behaviour tested by the existing suite).
   */
  async function sendInputChunked(tmuxPaneNum: number, bytes: Uint8Array): Promise<void> {
    if (bytes.length <= INPUT_CHUNK_BYTES) {
      // Single chunk (incl. the empty-input no-op) — equivalent to the
      // pre-chunking code path.
      await sendCommand(sendKeysHex(tmuxPaneNum, bytes));
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + INPUT_CHUNK_BYTES);
      const result = await sendCommand(sendKeysHex(tmuxPaneNum, chunk));
      // %error on a chunk: abort the remainder. Continuing would deliver the
      // later chunks with a hole where the failed one was; a truncated prefix
      // is the lesser corruption and closest to the all-or-nothing semantics
      // of the pre-chunking single command.
      if (!result.ok) return;
    }
  }

  /**
   * Tail of the in-flight chunked-input chain (tc-n4ct cross-message order).
   *
   * Pre-chunking, every input message's command was WRITTEN synchronously at
   * arrival, so arrival order == write order across messages. A multi-chunk
   * send yields between chunks (each chunk awaits tmux's reply), opening a
   * window where a later input message's write could land BETWEEN chunks —
   * e.g. a keystroke typed during a 50KB paste would splice into the middle
   * of the pasted bytes. While a chunked send is in flight, subsequent input
   * messages chain onto this tail instead of writing directly; once the chain
   * drains it resets to null and single-chunk inputs return to the
   * synchronous-write fast path.
   */
  let inputTail: Promise<void> | null = null;

  function enqueueInput(tmuxPaneNum: number, bytes: Uint8Array): void {
    const prev = inputTail;
    const chained = (
      prev === null
        ? sendInputChunked(tmuxPaneNum, bytes)
        : prev.then(() => sendInputChunked(tmuxPaneNum, bytes))
    )
      // A rejected send must not poison the chain for subsequent inputs;
      // send rejections were unobserved fire-and-forget before chunking too.
      .catch(() => {});
    inputTail = chained;
    void chained.then(() => {
      if (inputTail === chained) inputTail = null;
    });
  }

  /**
   * Send an optimistic window-option update with error reversal (tc-7xv.37).
   *
   * Pattern:
   *   1. Capture the before-value from the current model.
   *   2. Call `send(cmd)` (tc-3si.1): atomically registers a correlator slot
   *      AND writes the command, so the next %begin/%end binds to our slot.
   *   3. Dispatch the optimistic synthetic event immediately so downstream
   *      clients see the change without waiting for tmux confirmation.
   *   4. Await the Promise returned by `send`.  On `%error` (ok=false),
   *      dispatch a compensating synthetic event built from the captured
   *      before-value to restore the model to its prior state.
   *
   * If `dispatchSynthetic` or `getModel` is not wired (e.g. tests without a
   * real pipeline), this degrades gracefully: optimistic update still fires
   * but reversal is skipped.  This preserves the no-pipeline test path and
   * matches the pre-tc-7xv.37 fire-and-forget behaviour.
   *
   * @param cmd       The full tmux command line to send (without trailing \n).
   * @param optimistic The optimistic synthetic event to dispatch immediately
   *                  (e.g. `internal:set-window-sync` with the desired value).
   * @param reverse   Builder that, given the captured before-model, returns
   *                  the compensating synthetic event used on tmux %error
   *                  (e.g. `internal:set-window-sync` with the previous value),
   *                  or `null` if no compensating event is needed (e.g. window
   *                  no longer in model — reducer would no-op anyway).
   */
  function sendCommandWithReversal(
    cmd: string,
    optimistic: NotificationEvent,
    reverse: (before: SessionModel) => NotificationEvent | null,
  ): void {
    // Capture before-model BEFORE write (sync) so we have the pre-update state
    // even if onModelChange handlers mutate downstream views inline.
    const before = getModel?.();

    // sendCommand atomically registers the correlator slot AND writes (tc-3si.1).
    // The returned Promise is the result observation we need for error reversal —
    // no need to register a second slot.
    const resultPromise = sendCommand(cmd);

    // Optimistic apply: the model updates immediately so deltas flow to clients
    // without waiting for tmux confirmation.
    dispatchSynthetic?.(optimistic);

    // Error reversal: if any wiring is missing we skip rollback (the optimistic
    // model is left in place; the next bootstrap or external event corrects it).
    if (dispatchSynthetic === undefined || before === undefined) {
      return;
    }

    void resultPromise.then(
      (result) => {
        if (result.ok) return; // tmux accepted — optimistic update was correct.
        // tmux rejected: restore the model to its captured before-state.
        const compensating = reverse(before);
        if (compensating !== null) {
          dispatchSynthetic(compensating);
        }
      },
      (err) => {
        // Protocol error (e.g. cmdnum mismatch) — log and leave the model in
        // its optimistic state.  This is rare and not a tmux rejection; the
        // next bootstrap or external event will eventually correct the model.
        console.warn("[input-path] send rejected for optimistic update:", err);
      },
    );
  }

  /**
   * Issue a pane/window-CREATING verb and RETURN its effect ids (tc-ozk.1).
   *
   * The command MUST already carry `-P -F EFFECT_IDS_FORMAT` so tmux prints the
   * created `<pane_id> <window_id>` into the reply block. We:
   *   1. send the command (atomic slot+write, tc-3si.1);
   *   2. await the matching CommandResult;
   *   3. on `%error` → emit a failed VerbResult (the "+ B5b" %error mapping —
   *      a command-attributable failure, delivered as command.response
   *      ok=false, surfaced loudly);
   *   4. on `%end` → parse the printed ids; if parsing fails we ALSO fail loud
   *      (tmux said ok but we cannot honour the contract of returning the ids);
   *   5. otherwise emit the ids, minting wire ids from the tmux numbers.
   *
   * When no `respond` callback is wired the command is still issued (the extra
   * `-P -F` body is harmless), but no response is delivered — preserving the
   * fire-and-forget path for tests / callers that don't consume the result.
   */
  function runCreatingVerb(
    respond: VerbResponder | undefined,
    correlationId: string,
    verbKind: string,
    cmd: string,
  ): void {
    const resultPromise = sendCommand(cmd);
    if (respond === undefined) return; // no return path wired.

    void resultPromise.then(
      (result) => {
        if (!result.ok) {
          // %error → command-attributable failure. Surface loudly.
          const message = `tmux rejected ${verbKind}`;
          console.warn(`[input-path] ${message} (correlationId=${correlationId})`);
          respond(correlationId, { ok: false, code: "verb.failed", message });
          return;
        }
        const bodyText = result.body !== undefined ? new TextDecoder().decode(result.body) : "";
        const ids = parseEffectIds(bodyText);
        if (ids === null) {
          // tmux accepted the command but we could not recover the printed ids.
          // This breaks the verb's contract — fail LOUD rather than silently
          // returning ok with no ids (FAIL-LOUD policy).
          const message = `${verbKind} succeeded but its -P -F effect-id reply was unparseable: ${JSON.stringify(bodyText)}`;
          console.error(`[input-path] ${message} (correlationId=${correlationId})`);
          respond(correlationId, { ok: false, code: "verb.no-effect-ids", message });
          return;
        }
        respond(correlationId, {
          ok: true,
          newPaneId: mkPaneId("p" + ids.paneNum),
          newWindowId: mkWindowId("w" + ids.windowNum),
        });
      },
      (err) => {
        // Protocol-level rejection (e.g. correlator cmdnum mismatch). Rare;
        // surface loudly as a failed verb so the client's await doesn't hang.
        const message = `${verbKind} command failed at the correlator: ${String(err)}`;
        console.error(`[input-path] ${message} (correlationId=${correlationId})`);
        respond(correlationId, { ok: false, code: "verb.internal", message });
      },
    );
  }

  function handleClientMessage(msg: ClientMessage, respond?: VerbResponder): void {
    switch (msg.type) {
      // -----------------------------------------------------------------------
      // input → send-keys -H
      //
      // The data field is a UTF-8 string.  UTF-8-encode it to bytes and pass
      // through sendKeysHex, which hex-encodes each byte.  This is the lossless
      // path: all byte values including NUL, 0xFF, and C0 control sequences are
      // preserved exactly.  The client pre-encodes special keys as their byte
      // sequences (e.g. ESC-[ sequences for arrow keys) so we just encode the
      // string verbatim.
      //
      // Chunking (tc-n4ct): tmux's control-mode command-line length limit is
      // empirically ~5447 bytes (5447 OK, 5448 → "failed to send command").
      // A 51200-byte paste encodes to a 153618-char command — 28× over limit.
      // To stay safely below the limit we chunk the byte array into ≤5000-byte
      // segments and issue one send-keys -H call per segment.  Chunks are sent
      // sequentially (await each before the next) so byte order is preserved
      // across the correlator FIFO; while a chunked send is in flight, later
      // input messages queue behind it (inputTail) so cross-message byte order
      // is preserved too.
      // -----------------------------------------------------------------------
      case "input": {
        const tmuxPaneNum = toTmuxPane(msg.paneId);
        const bytes = new TextEncoder().encode(msg.data);
        if (inputTail === null && bytes.length <= INPUT_CHUNK_BYTES) {
          // Fast path: synchronous write at arrival — identical to the
          // pre-chunking code path (and to every other handler here).
          sendCommand(sendKeysHex(tmuxPaneNum, bytes));
        } else {
          enqueueInput(tmuxPaneNum, bytes);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // resize.request → refresh-client -C <cols>x<rows>
      //
      // Signals that the client viewport (VS Code pane, terminal window) changed
      // size.  `refresh-client -C WxH` updates the control-mode client's
      // reported terminal dimensions.  tmux propagates this to the window layout
      // and, through layout recalculation, to individual pane sizes.
      //
      // The paneId is carried in the message but is not used in the tmux command:
      // `refresh-client -C` operates on the client (not a specific pane), and
      // tmux determines which pane(s) to resize through its layout engine.  This
      // is the correct mapping for a viewport-driven resize; a per-pane explicit
      // resize would use `resize-pane` (see ResizePaneCommand below).
      // -----------------------------------------------------------------------
      case "resize.request": {
        const cmd = refreshClientSize(msg.cols, msg.rows);
        sendCommand(cmd);
        break;
      }

      // -----------------------------------------------------------------------
      // command.request → tmux command via E2 serializers
      //
      // The WireCommand union covers model-level operations.  We handle the ones
      // for which a direct serializer exists.  Each branch maps kind → tmux cmd.
      // -----------------------------------------------------------------------
      case "command.request": {
        const { command, correlationId } = msg;
        switch (command.kind) {
          case "open-window": {
            // new-window with optional name, cwd, and shellCommand.
            // tc-cr4dz: cwd and shellCommand are additive optional fields set
            // by the cold-start profile applicator after substitution.
            //
            // tc-ozk.1: always print the created ids (-P -F) and RETURN them in
            // the VerbResult via runCreatingVerb.
            const cmd = newWindow({
              printIds: true,
              ...(command.name !== undefined ? { name: command.name } : {}),
              ...(command.cwd !== undefined ? { startDirectory: command.cwd } : {}),
              ...(command.shellCommand !== undefined ? { shellCommand: command.shellCommand } : {}),
            });
            runCreatingVerb(respond, correlationId, "open-window", cmd);
            break;
          }

          case "split-pane": {
            // direction: "horizontal" = left/right (-h); "vertical" = top/bottom (-v)
            // tc-cr4dz: cwd and shellCommand are additive; paneId is optional
            // (when absent, splitWindow emits no -t flag so tmux targets the
            // current pane — used when the new window's first pane ID is not
            // yet known).
            //
            // tc-ozk.1: always print the created ids (-P -F) and RETURN them.
            let tmuxPaneNum: number | undefined;
            if (command.paneId !== undefined) {
              tmuxPaneNum = toTmuxPane(command.paneId);
            }
            const cmd = splitWindow(tmuxPaneNum, command.direction, {
              printIds: true,
              ...(command.cwd !== undefined ? { startDirectory: command.cwd } : {}),
              ...(command.shellCommand !== undefined ? { shellCommand: command.shellCommand } : {}),
            });
            runCreatingVerb(respond, correlationId, "split-pane", cmd);
            break;
          }

          case "close-pane": {
            // kill-pane -t %<N>
            const tmuxPaneNum = toTmuxPane(command.paneId);
            sendCommand(`kill-pane -t %${tmuxPaneNum}`);
            break;
          }

          case "rename-window": {
            // rename-window -t @<N> <name>
            const tmuxWinNum = toTmuxWindow(command.windowId);
            // Single-quote the name to handle spaces / special chars.
            const quotedName = "'" + command.name.replace(/'/g, "'\\''") + "'";
            sendCommand(`rename-window -t @${tmuxWinNum} ${quotedName}`);
            break;
          }

          case "select-pane": {
            // select-pane -t %<N>
            const tmuxPaneNum = toTmuxPane(command.paneId);
            sendCommand(`select-pane -t %${tmuxPaneNum}`);
            break;
          }

          case "resize-pane": {
            // The wire ResizePaneCommand is an explicit user-initiated resize
            // (distinct from viewport-driven resize.request).  We map it to
            // refresh-client -C as the simplest correct tmux command for now.
            // A future refinement could use `resize-pane -t %<N> -x <cols> -y <rows>`
            // for per-pane control, which requires tmux layout awareness.
            const cmd = refreshClientSize(command.cols, command.rows);
            sendCommand(cmd);
            break;
          }

          case "resize-managed-window": {
            // tc-zna.3: VS-Code-authoritative managed-window resize transaction.
            //
            // The VS Code factory owns the truth for windows whose panes form
            // a single split group; when that geometry changes the factory
            // emits ONE of these per window with the strip totals + per-pane
            // dims.  We translate to a deterministic batch:
            //
            //   1. set-window-option -t @<wid> window-size manual  (idempotent;
            //      required so resize-window actually sticks under tmux's
            //      default window-size=latest policy)
            //   2. resize-window -t @<wid> -x <cols> -y <rows>
            //   3. resize-pane  -t %<pid> -x <c> -y <r>  for each pane
            //
            // All three are issued via `sendBatch` so tmux processes the
            // transaction atomically: ONE host write of all lines, with N
            // correlator slots registered in submission order (tc-3si.1).
            // No %layout-change notification can interleave between the
            // window resize and the pane resizes, and the trailing acks
            // cannot mis-bind to any concurrent requery's list-* slot.
            //
            // The blanket resize.request → refresh-client -C path remains
            // available for unmanaged windows (single-pane tabs, editor-area).
            const tmuxWinNum = toTmuxWindow(command.windowId);
            const lines: string[] = [];
            lines.push(setWindowSizeManual(tmuxWinNum));
            lines.push(resizeWindow(tmuxWinNum, command.cols, command.rows));
            for (const pane of command.panes) {
              const tmuxPaneNum = toTmuxPane(pane.paneId);
              lines.push(resizePaneCmd(tmuxPaneNum, pane.cols, pane.rows));
            }
            sendBatch(lines);
            break;
          }

          case "kill-session": {
            // kill-session -t =<sessionName>
            // Terminates the tmux session and all its windows/panes.
            // Used when tmuxcc.killSessionOnLastWindowClose=true (ux-design.md [deleted; map: ux-design-v2 §8] §13).
            // The session-proxy will receive a session exit notification from tmux;
            // callers should expect the connection to close shortly after.
            //
            // tc-91o: the wire command now carries sessionName directly, so no
            // id-mapping is required.  The "=" prefix is the tmux exact-match
            // target selector, which avoids ambiguity when session names share a
            // prefix.
            sendCommand(`kill-session -t =${command.sessionName}`);
            break;
          }

          case "set-synchronize-panes": {
            // set-option -wt @<N> synchronize-panes on|off  (tc-7xv.12)
            //
            // Toggles tmux's synchronize-panes option for the target window.
            // When on, tmux broadcasts every send-keys to ALL panes in the
            // window natively — no extension-side fan-out needed (§4.5 VERIFIED).
            //
            // Optimistic model update with error reversal (tc-7xv.37): after
            // sending the tmux command we immediately inject a synthetic
            // NotificationEvent to update the model without waiting for a tmux
            // notification (tmux 3.4 does NOT emit %window-option-changed for
            // synchronize-panes — verified empirically).  If tmux rejects the
            // command (e.g. no such window), `sendCommandWithReversal` observes
            // the %error via the correlator and dispatches a compensating
            // synthetic with the captured before-value, restoring the model.
            const tmuxWinNum = toTmuxWindow(command.windowId);
            const wid = command.windowId;
            const on = command.on;
            sendCommandWithReversal(
              setOptionForWindow(tmuxWinNum, "synchronize-panes", on ? "on" : "off"),
              { kind: "internal:set-window-sync", windowId: wid, on },
              (before) => {
                const prev = before.windows.get(wid);
                if (prev === undefined) return null; // window gone — nothing to revert.
                return { kind: "internal:set-window-sync", windowId: wid, on: prev.synchronizePanes };
              },
            );
            break;
          }

          // ── tc-7xv.15: monitor-activity / monitor-silence ─────────────────

          case "set-monitor-activity": {
            // set-option -wt @<N> monitor-activity on|off  (tc-7xv.15)
            //
            // Toggles tmux's monitor-activity option for the target window.
            // When on, tmux flags this window in status-bar when panes produce
            // output while the window is in the background.
            //
            // Optimistic model update with error reversal (tc-7xv.37) — same
            // pattern as set-synchronize-panes above.
            const tmuxWinNum = toTmuxWindow(command.windowId);
            const wid = command.windowId;
            const on = command.on;
            sendCommandWithReversal(
              setOptionForWindow(tmuxWinNum, "monitor-activity", on ? "on" : "off"),
              { kind: "internal:set-window-monitor-activity", windowId: wid, on },
              (before) => {
                const prev = before.windows.get(wid);
                if (prev === undefined) return null;
                return { kind: "internal:set-window-monitor-activity", windowId: wid, on: prev.monitorActivity };
              },
            );
            break;
          }

          case "set-monitor-silence": {
            // set-option -wt @<N> monitor-silence <seconds>  (tc-7xv.15)
            //
            // Enables or disables tmux's monitor-silence option for the target
            // window.  `seconds === null` or `seconds === 0` → disables (sends
            // `monitor-silence 0`).  Positive seconds → enables.
            //
            // tmux interprets `monitor-silence 0` as disabled; any positive
            // integer is the threshold in seconds.
            //
            // Optimistic model update with error reversal (tc-7xv.37) — same
            // pattern as set-synchronize-panes above.  tmux 3.4 does NOT emit
            // %window-option-changed for monitor-silence.
            const tmuxWinNum = toTmuxWindow(command.windowId);
            const wid = command.windowId;
            const secondsVal = command.seconds !== null && command.seconds > 0 ? command.seconds : 0;
            sendCommandWithReversal(
              setOptionForWindow(tmuxWinNum, "monitor-silence", String(secondsVal)),
              { kind: "internal:set-window-monitor-silence", windowId: wid, seconds: secondsVal },
              (before) => {
                const prev = before.windows.get(wid);
                if (prev === undefined) return null;
                return { kind: "internal:set-window-monitor-silence", windowId: wid, seconds: prev.monitorSilence };
              },
            );
            break;
          }

          // ── end tc-7xv.15 ────────────────────────────────────────────────────

          // ── tc-7xv.9: pane verbs ───────────────────────────────────────────

          case "break-pane": {
            // break-pane -d -P -F '#{pane_id} #{window_id}' -t %<N>
            // -d keeps the new window in the background (no focus steal).
            // tc-ozk.1: -P -F now PRINTS the broken-out pane id + its new
            // window id into the reply block; runCreatingVerb parses them and
            // RETURNS them in the VerbResult.  For break-pane the "new" entity
            // is the window (the pane is re-homed, not freshly created) — see
            // breakPane() docs.
            const tmuxPaneNum = toTmuxPane(command.paneId);
            runCreatingVerb(respond, correlationId, "break-pane", breakPane(tmuxPaneNum, { printIds: true }));
            break;
          }

          case "swap-pane": {
            // swap-pane: without target uses -D to rotate with next pane;
            // with explicit target uses -s <src> -t <tgt>.
            const tmuxPaneNum = toTmuxPane(command.paneId);
            if (command.targetPaneId !== undefined) {
              const tmuxTargetNum = toTmuxPane(command.targetPaneId);
              sendCommand(`swap-pane -s %${tmuxPaneNum} -t %${tmuxTargetNum}`);
            } else {
              // No explicit target: rotate the pane down (-D) within its window.
              sendCommand(`swap-pane -D -t %${tmuxPaneNum}`);
            }
            break;
          }

          case "rename-pane": {
            // select-pane -T <title> -t %<N>
            // Sets the pane's display title (#{pane_title}).
            // An empty title resets to the default (process name).
            const tmuxPaneNum = toTmuxPane(command.paneId);
            // Single-quote the title to handle spaces / special chars.
            const quotedTitle = "'" + command.title.replace(/'/g, "'\\''") + "'";
            sendCommand(`select-pane -T ${quotedTitle} -t %${tmuxPaneNum}`);
            break;
          }
          // ── tc-7xv.18: window verbs ──────────────────────────────────────────

          case "kill-window": {
            // kill-window -t @<N>  (tc-7xv.18)
            //
            // Kills the tmux window and all its panes.  tmux emits pane-exited
            // and window-close notifications which flow back through the session-proxy
            // mirror as pane.closed + window.removed deltas.
            const tmuxWinNum = toTmuxWindow(command.windowId);
            sendCommand(`kill-window -t @${tmuxWinNum}`);
            break;
          }

          case "swap-window": {
            // swap-window -s @<S> -t @<T>  (tc-7xv.18)
            //
            // Exchanges the positions of two windows within the session.
            // No panes are created or destroyed; tmux reorders the window list.
            const srcNum = toTmuxWindow(command.sourceWindowId);
            const tgtNum = toTmuxWindow(command.targetWindowId);
            sendCommand(`swap-window -s @${srcNum} -t @${tgtNum}`);
            break;
          }

          // ── end tc-7xv.18 ────────────────────────────────────────────────────

          default: {
            // Forward-compatible: unknown command kinds are silently dropped.
            const _exhaustive = command as { kind: string };
            console.warn(`[input-path] unknown command kind "${_exhaustive.kind}" — dropping`);
            break;
          }
        }
        break;
      }

      // -----------------------------------------------------------------------
      // client.capabilities — handshake message, not an input/command.
      // Silently ignored here; the handshake layer (tc-auj) handles it.
      // -----------------------------------------------------------------------
      case "client.capabilities":
        break;

      default: {
        // Forward-compatible: unknown message types are silently ignored.
        const _exhaustive = msg as { type: string };
        console.warn(`[input-path] unknown message type "${_exhaustive.type}" — dropping`);
        break;
      }
    }
  }

  return { handleClientMessage };
}

// ---------------------------------------------------------------------------
// Exports — id-mapping helpers exposed for tests and potential registry wiring
// ---------------------------------------------------------------------------

export { defaultPaneIdToTmux, defaultWindowIdToTmux };
