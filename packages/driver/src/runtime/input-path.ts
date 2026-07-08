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

import type { ClientMessage } from "@tmuxcc/protocol";
import type { PaneId, WindowId } from "@tmuxcc/protocol";
import { paneId as mkPaneId, windowId as mkWindowId } from "@tmuxcc/protocol";
import type { CommandResult } from "../parser/correlator.js";
import type { SessionProxyRegistry } from "../metrics/registry.js";
import {
  sendKeysHex,
  refreshClientSize,
  refreshClientWindowSize,
  splitWindow,
  newWindow,
  breakPane,
  parseEffectIds,
  setOptionForWindow,
  setOptionForPane,
  unsetOptionForPane,
  unsetOptionForWindow,
  setOptionForSession,
  unsetOptionForSession,
  setWindowSizeManual,
  setWindowSizeDefault,
  resizeWindow,
  resizePane as resizePaneCmd,
} from "../parser/commands.js";
import type { NotificationEvent } from "../parser/notifications.js";
import { PHASE_TIMING_ENABLED, phaseLog } from "./phase-timing.js";
import type { SessionModel } from "../state/model.js";
import {
  TMUXCC_LABEL_OPTION,
  paneBoundOptionName,
  TMUXCC_DETACH_OPTION,
  TMUXCC_ICON_OPTION,
} from "../state/bootstrap.js";

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
// tc-i9aq.1: set-object-policy helpers (cold-start.md §4.A)
// ---------------------------------------------------------------------------

/**
 * Build the optimistic `internal:set-pane-policy` event for a PANE-scope
 * `set-object-policy` write.  Only the field the write touched is set; `null`
 * value means the option was cleared (returns to unset/inherit).
 *
 * tc-4b6k.2 (D3): binding intent is per-client, so a `bound` write carries the
 * issuing connection's `clientId` — the pipeline patch flips only that client's
 * membership in the pane's `overlay.boundClients` set.
 */
function buildPanePolicyEvent(
  paneId: PaneId,
  option: "bound" | "detach" | "icon",
  value: string | null,
  clientId: string | undefined,
): NotificationEvent {
  switch (option) {
    case "bound":
      return { kind: "internal:set-pane-policy", paneId, bound: value !== null, clientId };
    case "detach":
      return {
        kind: "internal:set-pane-policy",
        paneId,
        detach: value === "detach" || value === "kill" ? value : null,
      };
    case "icon":
      return { kind: "internal:set-pane-policy", paneId, icon: value };
  }
}

/**
 * Build the compensating `internal:set-pane-policy` event that restores the
 * before-value of the touched field (tc-7xv.37 reversal) on tmux %error.
 *
 * tc-4b6k.2 (D3): the `bound` revert restores the issuing client's own prior
 * membership (`prev.overlay.boundClients.has(clientId)`), not a shared scalar.
 */
function buildPanePolicyRevert(
  paneId: PaneId,
  option: "bound" | "detach" | "icon",
  prev: {
    readonly overlay: { readonly boundClients: ReadonlySet<string> };
    readonly detach: "detach" | "kill" | undefined;
    readonly icon: string | undefined;
  },
  clientId: string | undefined,
): NotificationEvent {
  switch (option) {
    case "bound":
      return {
        kind: "internal:set-pane-policy",
        paneId,
        bound: clientId !== undefined && prev.overlay.boundClients.has(clientId),
        clientId,
      };
    case "detach":
      return { kind: "internal:set-pane-policy", paneId, detach: prev.detach ?? null };
    case "icon":
      return { kind: "internal:set-pane-policy", paneId, icon: prev.icon ?? null };
  }
}

/**
 * The bound session's name from the live model.  The session-proxy is bound to
 * exactly one session for its lifetime, so the first (only) session's name is
 * the right `set-option -t <name>` target for a session-scope write.  Returns
 * undefined when the model carries no session yet (cold bootstrap race).
 */
function firstSessionName(model: SessionModel): string | undefined {
  for (const session of model.sessions.values()) {
    return session.name;
  }
  return undefined;
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
      /**
       * Wire id of the created pane (`p<N>`).
       * Present for pane/window-CREATING verbs; absent for non-creating ACKs
       * (tc-u7cu.3: kill-pane, rename-session, etc.).
       */
      readonly newPaneId?: PaneId;
      /**
       * Wire id of the window the new pane lives in (`w<N>`).
       * Present for creating verbs; absent for non-creating ACKs (tc-u7cu.3).
       */
      readonly newWindowId?: WindowId;
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

  /**
   * Session-proxy metrics registry for signalling send rejections (tc-1wx5).
   *
   * When provided, `enqueueInput` increments `input_send_rejected_total` on
   * every `sendInputChunked` rejection and also writes a line to stderr.
   * Omitting this option disables the counter (the stderr write still fires).
   */
  metrics?: SessionProxyRegistry;
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
   *
   * `clientId` (tc-4b6k.2, D3) is the ISSUING connection's durable identity id.
   * It keys per-client writes — a `set-object-policy` binding-intent write emits
   * `set-option -pt %N @tmuxcc-bound-<key>` for THIS client's slot, and the
   * optimistic model patch flips only this client's membership. Omit for
   * anonymous / non-server callers: a binding write then targets the legacy
   * shared `@tmuxcc-bound` slot (back-compat) and resolves to no per-client
   * intent.
   */
  handleClientMessage(msg: ClientMessage, respond?: VerbResponder, clientId?: string): void;
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
  const metrics = opts.metrics;

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
      // A rejected send must not poison the chain for subsequent inputs.
      // Log + count so a broken send-keys path is visible in metrics and
      // stderr rather than silently swallowed (tc-1wx5).
      .catch((err: unknown) => {
        process.stderr.write(
          `[input-path] input send rejected for pane ${tmuxPaneNum}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        metrics?.incInputSendRejected();
      });
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
    ackOpts?: { respond: VerbResponder; correlationId: string; verbKind: string },
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

    // tc-u7cu.3: if an ACK responder was provided, always observe the result to
    // send a command.response back to the issuing client.
    const { respond: ackRespond, correlationId: ackCorrelationId, verbKind: ackVerbKind } = ackOpts ?? {};

    // Error reversal: if no wiring is present we still need to observe the
    // result for the ACK (if any), so we cannot return early.
    if (dispatchSynthetic === undefined || before === undefined) {
      if (ackRespond !== undefined && ackCorrelationId !== undefined && ackVerbKind !== undefined) {
        // Only wired for ACK, not for reversal.
        void resultPromise.then(
          (result) => {
            if (!result.ok) {
              const errorBody = result.body !== undefined ? new TextDecoder().decode(result.body).trim() : "";
              const message = errorBody !== "" ? errorBody : `tmux rejected ${ackVerbKind}`;
              ackRespond(ackCorrelationId, { ok: false, code: "verb.failed", message });
            } else {
              ackRespond(ackCorrelationId, { ok: true });
            }
          },
          (err) => {
            ackRespond(ackCorrelationId, { ok: false, code: "verb.internal", message: String(err) });
          },
        );
      }
      return;
    }

    void resultPromise.then(
      (result) => {
        if (result.ok) {
          // tmux accepted — optimistic update was correct.
          ackRespond?.(ackCorrelationId!, { ok: true });
          return;
        }
        // tmux rejected: restore the model to its captured before-state.
        const compensating = reverse(before);
        if (compensating !== null) {
          dispatchSynthetic(compensating);
        }
        if (ackRespond !== undefined && ackCorrelationId !== undefined && ackVerbKind !== undefined) {
          const errorBody = result.body !== undefined ? new TextDecoder().decode(result.body).trim() : "";
          const message = errorBody !== "" ? errorBody : `tmux rejected ${ackVerbKind}`;
          ackRespond(ackCorrelationId, { ok: false, code: "verb.failed", message });
        }
      },
      (err) => {
        // Protocol error (e.g. cmdnum mismatch) — log and leave the model in
        // its optimistic state.  This is rare and not a tmux rejection; the
        // next bootstrap or external event will eventually correct the model.
        console.warn("[input-path] send rejected for optimistic update:", err);
        ackRespond?.(ackCorrelationId!, { ok: false, code: "verb.internal", message: String(err) });
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
    emptyBodyFallback?: () => VerbResult | null,
  ): void {
    // tc-jlyi.7: broker verb→tree hop trace — the tmux command leaving the
    // broker for this creating verb. Inert unless TMUXCC_PHASE_TIMING (reuses
    // the [tc-is5w] phaseLog stderr channel → server-proxy.log).
    if (PHASE_TIMING_ENABLED) {
      phaseLog({ inst: "tc-jlyi.7", hop: "tmux-cmd", correlationId, verb: verbKind, cmd });
    }
    const resultPromise = sendCommand(cmd);
    if (respond === undefined) return; // no return path wired.

    void resultPromise.then(
      (result) => {
        if (!result.ok) {
          // %error → command-attributable failure (the "+ B5b" %error mapping).
          //
          // tc-yudx: surface tmux's VERBATIM refusal text, not a generic
          // "tmux rejected" string.  In control mode a failed command emits its
          // error reason as the body of the %begin…%error block (e.g.
          // "create pane failed: pane too small"); the correlator accumulates
          // that into `result.body` for error blocks exactly as it does for
          // %end blocks.  Pass it through as the message so the host can show
          // the user WHY tmux refused — distinct from a transport/timeout
          // stall (tc-yudx: a vague "no response within Ns" hides the cause).
          // Fall back to the generic phrasing only when tmux emitted no body.
          const errorBody =
            result.body !== undefined
              ? new TextDecoder().decode(result.body).trim()
              : "";
          const message = errorBody !== "" ? errorBody : `tmux rejected ${verbKind}`;
          console.warn(`[input-path] tmux rejected ${verbKind}: ${message} (correlationId=${correlationId})`);
          // tc-jlyi.7: tmux refused the creating verb — broker egress of the
          // failure (distinct from a stall: a stall emits no response-send).
          if (PHASE_TIMING_ENABLED) {
            phaseLog({ inst: "tc-jlyi.7", hop: "response-send", correlationId, verb: verbKind, ok: false, reason: message });
          }
          respond(correlationId, { ok: false, code: "verb.failed", message });
          return;
        }
        const bodyText = result.body !== undefined ? new TextDecoder().decode(result.body) : "";
        const ids = parseEffectIds(bodyText);
        if (ids === null) {
          // tmux accepted the command (%end) but the `-P -F` body did not parse.
          // Two structurally distinct cases hide behind a null parse — keep them
          // apart (tc-0c30.20):
          //
          //   (1) EMPTY body — tmux printed NOTHING. For `break-pane` this is a
          //       legitimate IDEMPOTENT NO-OP: the source pane is already the
          //       sole pane in its own window, so there is nothing to break out
          //       and tmux's `-P` prints no `#{pane_id} #{window_id}` line
          //       (verified against tmux 3.4: `break-pane -d -P -F … -s %N` on an
          //       already-sole pane returns `%end` with an EMPTY body — 15/15).
          //       This races the auto-promotion path: the promotion check picks
          //       an outlier from the (coalesced-lag) model, but by the time the
          //       command lands the sibling has exited / a prior promotion has
          //       already re-homed it, so the pane is alone — the promotion's
          //       goal is ALREADY met. An `emptyBodyFallback` lets the caller
          //       resolve to the no-op success (the pane's CURRENT ids) instead
          //       of a spurious "unparseable" failure that reddens the gate.
          //
          //   (2) NON-EMPTY but malformed body — tmux printed SOMETHING we could
          //       not parse. That IS a contract violation; fail LOUD regardless
          //       of the fallback (FAIL-LOUD policy).
          //
          // split-pane / open-window pass NO fallback: those verbs ALWAYS create
          // a fresh entity, so an empty body there is a genuine anomaly and still
          // fails loud.
          if (bodyText.trim() === "" && emptyBodyFallback !== undefined) {
            const fallback = emptyBodyFallback();
            if (fallback !== null) {
              console.info(
                `[input-path] ${verbKind} returned %end with an empty -P -F body — ` +
                  `treating as an idempotent no-op (source already its own window) ` +
                  `(correlationId=${correlationId})`,
              );
              respond(correlationId, fallback);
              return;
            }
          }
          // tmux accepted the command but we could not recover the printed ids.
          // This breaks the verb's contract — fail LOUD rather than silently
          // returning ok with no ids (FAIL-LOUD policy).
          const message = `${verbKind} succeeded but its -P -F effect-id reply was unparseable: ${JSON.stringify(bodyText)}`;
          console.error(`[input-path] ${message} (correlationId=${correlationId})`);
          respond(correlationId, { ok: false, code: "verb.no-effect-ids", message });
          return;
        }
        // tc-jlyi.7: tmux acked the creating verb with effect ids — the broker
        // egress of the verb result (Sig2 localization: present here ⇒ the
        // round-trip reached tmux and came back; absent ⇒ stalled at tmux).
        if (PHASE_TIMING_ENABLED) {
          phaseLog({
            inst: "tc-jlyi.7",
            hop: "response-send",
            correlationId,
            verb: verbKind,
            ok: true,
            paneId: "p" + ids.paneNum,
            windowId: "w" + ids.windowNum,
          });
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

  /**
   * tc-u7cu.3: Issue a state-MUTATING NON-CREATING verb and ACK its result.
   *
   * For verbs that do NOT produce new pane/window ids (kill-pane, rename-session,
   * kill-window, swap-window, set-synchronize-panes, etc.) this replaces the old
   * fire-and-forget `sendCommand` when the caller needs to know whether tmux
   * accepted or rejected the command.
   *
   * Unlike `runCreatingVerb`, the command does NOT carry `-P -F`; the reply body
   * is ignored.  On `%end` the result is `{ ok: true }` (no ids).  On `%error`
   * the tmux error text is surfaced as `{ ok: false, code: "verb.failed", message }`.
   *
   * When no `respond` callback is wired the command is still issued as
   * fire-and-forget (no `command.response` is sent) — same as the previous
   * `sendCommand` path.
   */
  function runAckVerb(
    respond: VerbResponder | undefined,
    correlationId: string,
    verbKind: string,
    cmd: string,
  ): void {
    // tc-jlyi.7: broker tmux command for a non-creating mutating verb.
    if (PHASE_TIMING_ENABLED) {
      phaseLog({ inst: "tc-jlyi.7", hop: "tmux-cmd", correlationId, verb: verbKind, cmd });
    }
    const resultPromise = sendCommand(cmd);
    if (respond === undefined) return; // no return path wired — fire-and-forget.

    void resultPromise.then(
      (result) => {
        if (!result.ok) {
          const errorBody =
            result.body !== undefined
              ? new TextDecoder().decode(result.body).trim()
              : "";
          const message = errorBody !== "" ? errorBody : `tmux rejected ${verbKind}`;
          console.warn(`[input-path] tmux rejected ${verbKind}: ${message} (correlationId=${correlationId})`);
          if (PHASE_TIMING_ENABLED) {
            phaseLog({ inst: "tc-jlyi.7", hop: "response-send", correlationId, verb: verbKind, ok: false, reason: message });
          }
          respond(correlationId, { ok: false, code: "verb.failed", message });
          return;
        }
        // %end: tmux accepted the command.  Respond with a simple ACK
        // (no pane/window ids — this is a non-creating verb).
        if (PHASE_TIMING_ENABLED) {
          phaseLog({ inst: "tc-jlyi.7", hop: "response-send", correlationId, verb: verbKind, ok: true });
        }
        respond(correlationId, { ok: true });
      },
      (err) => {
        const message = `${verbKind} command failed at the correlator: ${String(err)}`;
        console.error(`[input-path] ${message} (correlationId=${correlationId})`);
        respond(correlationId, { ok: false, code: "verb.internal", message });
      },
    );
  }

  function handleClientMessage(msg: ClientMessage, respond?: VerbResponder, clientId?: string): void {
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
        // tc-jlyi.7: broker received the verb off the wire — the first broker
        // hop. A request-recv with no later tmux-cmd/response-send localizes a
        // stall to the broker's command-dispatch; a missing request-recv means
        // the wire send never arrived (Sig2 wire-drop). Inert unless gated.
        if (PHASE_TIMING_ENABLED) {
          const target =
            (command as { paneId?: string }).paneId ??
            (command as { windowId?: string }).windowId ??
            (command as { name?: string }).name;
          phaseLog({ inst: "tc-jlyi.7", hop: "request-recv", correlationId, verb: command.kind, target });
        }
        switch (command.kind) {
          case "open-window": {
            // new-window with optional name, cwd, shellCommand, and env.
            // tc-cr4dz: cwd and shellCommand are additive optional fields set
            // by the cold-start profile applicator after substitution.
            // tc-gjdx.2: env is an additive optional map compiled to repeated
            // -e NAME=value flags; floor is tmux 3.0 = MINIMUM, no gate needed.
            //
            // tc-ozk.1: always print the created ids (-P -F) and RETURN them in
            // the VerbResult via runCreatingVerb.
            const cmd = newWindow({
              printIds: true,
              ...(command.name !== undefined ? { name: command.name } : {}),
              ...(command.cwd !== undefined ? { startDirectory: command.cwd } : {}),
              ...(command.env !== undefined ? { env: command.env } : {}),
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
            // tc-gjdx.2: env is an additive optional map compiled to repeated
            // -e NAME=value flags; floor is tmux 3.0 = MINIMUM, no gate needed.
            //
            // tc-ozk.1: always print the created ids (-P -F) and RETURN them.
            let tmuxPaneNum: number | undefined;
            if (command.paneId !== undefined) {
              tmuxPaneNum = toTmuxPane(command.paneId);
            }
            const cmd = splitWindow(tmuxPaneNum, command.direction, {
              printIds: true,
              ...(command.cwd !== undefined ? { startDirectory: command.cwd } : {}),
              ...(command.env !== undefined ? { env: command.env } : {}),
              ...(command.shellCommand !== undefined ? { shellCommand: command.shellCommand } : {}),
            });
            runCreatingVerb(respond, correlationId, "split-pane", cmd);
            break;
          }

          case "close-pane": {
            // kill-pane -t %<N>  (tc-u7cu.3: ACK round-trip so %error surfaces)
            const tmuxPaneNum = toTmuxPane(command.paneId);
            runAckVerb(respond, correlationId, "close-pane", `kill-pane -t %${tmuxPaneNum}`);
            break;
          }

          case "rename-window": {
            // rename-window -t @<N> <name>  (tc-u7cu.3: ACK round-trip)
            const tmuxWinNum = toTmuxWindow(command.windowId);
            // Single-quote the name to handle spaces / special chars.
            const quotedName = "'" + command.name.replace(/'/g, "'\\''") + "'";
            runAckVerb(respond, correlationId, "rename-window", `rename-window -t @${tmuxWinNum} ${quotedName}`);
            break;
          }

          case "rename-session": {
            // rename-session -t =<currentName> <newName>  (tc-6gnc.9)
            //
            // Renames the bound tmux session.  The "=" prefix is the tmux
            // exact-match target selector (same pattern as kill-session tc-91o)
            // to avoid ambiguity when session names share a prefix.
            //
            // The session-proxy observes the resulting %session-renamed
            // notification and emits a session.renamed delta to all connected
            // clients — no optimistic model update is needed here; the mirror
            // drives the UI update.
            //
            // Fail-loud on empty name: drop the command with a warning.
            if (command.name.length === 0) {
              console.warn("[input-path] rename-session received empty name — dropping");
              break;
            }
            // Resolve the current session name from the live model.  In a
            // session-proxy there is exactly one session; take the first one.
            // Falls back to no target flag if the model is unavailable (pre-snapshot),
            // which makes tmux rename the currently attached session — the
            // correct behaviour in all real-world cases.
            const currentModel = getModel?.();
            const currentSessionName = currentModel?.sessions.values().next().value?.name;
            const targetFlag = currentSessionName !== undefined
              ? `-t =${currentSessionName} `
              : "";
            // Single-quote the new name to handle spaces / special chars.
            const quotedNewSessionName = "'" + command.name.replace(/'/g, "'\\''") + "'";
            // tc-u7cu.3: ACK round-trip so %error (e.g. duplicate name) surfaces.
            runAckVerb(respond, correlationId, "rename-session", `rename-session ${targetFlag}${quotedNewSessionName}`);
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

          case "release-managed-window": {
            // tc-pizl.9: Strip→single-pane teardown — release the manual window-size
            // override left by the managed-strip path so the surviving pane resumes
            // auto-tracking its tmux client dimensions.
            //
            // Translates to: set-window-option -u -t @<wid> window-size
            //
            // The `-u` flag unsets the window-local option and falls back to the
            // global default (typically `latest`), restoring client-driven sizing.
            // Idempotent — safe to send even when the window was not manual.
            const tmuxWinNum = toTmuxWindow(command.windowId);
            sendCommand(setWindowSizeDefault(tmuxWinNum));
            break;
          }

          case "kill-session": {
            // kill-session -t =<sessionName>
            // Terminates the tmux session and all its windows/panes.
            // The session-proxy will receive a session exit notification from tmux;
            // callers should expect the connection to close shortly after.
            //
            // tc-91o: the wire command now carries sessionName directly, so no
            // id-mapping is required.  The "=" prefix is the tmux exact-match
            // target selector, which avoids ambiguity when session names share a
            // prefix.
            //
            // tc-u7cu.3: ACK round-trip so %error surfaces.  In practice,
            // kill-session will terminate the connection before the ACK arrives
            // (the session-proxy receives a session exit from tmux), but we
            // still register the responder so a genuine %error (e.g. unknown
            // session) is surfaced.
            runAckVerb(respond, correlationId, "kill-session", `kill-session -t =${command.sessionName}`);
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
            //
            // tc-u7cu.3: also ACK the round-trip so %error surfaces to the caller.
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
              respond !== undefined ? { respond, correlationId, verbKind: "set-synchronize-panes" } : undefined,
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
            // tc-u7cu.3: also ACK the round-trip so %error surfaces.
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
              respond !== undefined ? { respond, correlationId, verbKind: "set-monitor-activity" } : undefined,
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
            // tc-u7cu.3: also ACK the round-trip so %error surfaces.
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
              respond !== undefined ? { respond, correlationId, verbKind: "set-monitor-silence" } : undefined,
            );
            break;
          }

          // ── end tc-7xv.15 ────────────────────────────────────────────────────

          // ── tc-7xv.9: pane verbs ───────────────────────────────────────────

          case "break-pane": {
            // break-pane -d -P -F '#{pane_id} #{window_id}' -s %<N>  (tc-6dof:
            // `-s` is the SOURCE pane; `-t` is the DESTINATION window.)
            // -d keeps the new window in the background (no focus steal).
            // tc-ozk.1: -P -F now PRINTS the broken-out pane id + its new
            // window id into the reply block; runCreatingVerb parses them and
            // RETURNS them in the VerbResult.  For break-pane the "new" entity
            // is the window (the pane is re-homed, not freshly created) — see
            // breakPane() docs.
            const tmuxPaneNum = toTmuxPane(command.paneId);
            const breakSourcePaneId = command.paneId;
            // tc-0c30.20: empty-body NO-OP fallback. tmux returns `%end` with an
            // EMPTY `-P` body when the source pane is already the sole pane in
            // its own window (nothing to break out). That races the auto-
            // promotion path (the model lags tmux; the sibling exited / a prior
            // promotion already re-homed the pane). In that case the pane keeps
            // BOTH its id (break-pane never re-mints the pane) AND its current
            // window, so resolve to those CURRENT ids: the verb succeeded as an
            // idempotent no-op, and the client's id-bind re-fire lands on the
            // pane already in place. Returns null (→ fail-loud) only when the
            // pane is no longer in the model (it genuinely vanished), preserving
            // the loud signal for a true contract violation.
            runCreatingVerb(
              respond,
              correlationId,
              "break-pane",
              breakPane(tmuxPaneNum, { printIds: true }),
              () => {
                const model = getModel?.();
                const pane = model?.panes.get(breakSourcePaneId);
                if (pane === undefined) return null;
                return {
                  ok: true,
                  newPaneId: breakSourcePaneId,
                  newWindowId: pane.windowId,
                };
              },
            );
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
            // set-option -pt %<N> @tmuxcc_label <name>  (tc-1a8z)
            //
            // Sets the DURABLE, driver-owned pane name in the per-pane tmux
            // user-option `@tmuxcc_label`.  This is the canonical user rename
            // channel — a SEPARATE channel from the volatile shell title.  We
            // do NOT issue `select-pane -T` (which fights the shell for the
            // #{pane_title} slot); the durable name lives with the pane in tmux
            // and is re-read on every requery (BOOTSTRAP_PANES_FORMAT), so it
            // survives a driver restart for free.
            //
            // An empty title CLEARS the durable name: tmux stores `''` and the
            // requery maps an empty option value back to "no name" (undefined).
            //
            // Optimistic model update with error reversal (tc-7xv.37) — same
            // pattern as set-synchronize-panes.  We inject internal:set-pane-label
            // so the model (and the pane.label-changed delta) updates immediately;
            // on %error we restore the captured before-value.
            // tc-u7cu.3: also ACK the round-trip so %error surfaces.
            const tmuxPaneNum = toTmuxPane(command.paneId);
            const pid = command.paneId;
            // Empty title → clear the durable name (model label: undefined).
            const newLabel = command.title === "" ? undefined : command.title;
            sendCommandWithReversal(
              setOptionForPane(tmuxPaneNum, TMUXCC_LABEL_OPTION, command.title),
              { kind: "internal:set-pane-label", paneId: pid, label: newLabel },
              (before) => {
                const prev = before.panes.get(pid);
                if (prev === undefined) return null; // pane gone — nothing to revert.
                return { kind: "internal:set-pane-label", paneId: pid, label: prev.label };
              },
              respond !== undefined ? { respond, correlationId, verbKind: "rename-pane" } : undefined,
            );
            break;
          }

          case "set-object-policy": {
            // tc-i9aq.1 (cold-start.md §4.A/§6.1): write a durable per-object
            // @tmuxcc-* user-option.  The driver is the SOLE tmux writer; the
            // extension issues this verb instead of shelling out.  The change
            // reappears in the next requery as canonical state.
            //
            // tc-4b6k.2 (D3): binding intent is per-client, so the `bound`
            // option name carries the ISSUING connection's identity key
            // (`@tmuxcc-bound-<key>`); two clients binding the same pane write
            // distinct options and never collide. `detach`/`icon` stay shared.
            const optionName =
              command.option === "bound" ? paneBoundOptionName(clientId)
              : command.option === "detach" ? TMUXCC_DETACH_OPTION
              : TMUXCC_ICON_OPTION;
            const clear = command.value === null;

            if (command.scope === "pane") {
              if (command.paneId === undefined) {
                respond?.(correlationId, {
                  ok: false,
                  code: "verb.failed",
                  message: "set-object-policy: scope 'pane' requires paneId",
                });
                break;
              }
              const tmuxPaneNum = toTmuxPane(command.paneId);
              const pid = command.paneId;
              const cmd = clear
                ? unsetOptionForPane(tmuxPaneNum, optionName)
                : setOptionForPane(tmuxPaneNum, optionName, command.value as string);
              // Optimistic apply with %error reversal (tc-7xv.37 pattern): patch
              // only the field this write touched; capture the before-value so a
              // rejection restores it.  The next requery re-confirms (incl. the
              // RESOLVED detach).
              const optimistic = buildPanePolicyEvent(pid, command.option, command.value, clientId);
              sendCommandWithReversal(
                cmd,
                optimistic,
                (before) => {
                  const prev = before.panes.get(pid);
                  if (prev === undefined) return null; // pane gone — nothing to revert.
                  return buildPanePolicyRevert(pid, command.option, prev, clientId);
                },
                respond !== undefined ? { respond, correlationId, verbKind: "set-object-policy" } : undefined,
              );
              break;
            }

            if (command.scope === "window") {
              if (command.windowId === undefined) {
                respond?.(correlationId, {
                  ok: false,
                  code: "verb.failed",
                  message: "set-object-policy: scope 'window' requires windowId",
                });
                break;
              }
              const tmuxWinNum = toTmuxWindow(command.windowId);
              const cmd = clear
                ? unsetOptionForWindow(tmuxWinNum, optionName)
                : setOptionForWindow(tmuxWinNum, optionName, command.value as string);
              // Window/session scope: no per-scope-own model field — the change
              // surfaces as the RESOLVED pane `detach` on the next requery.  ACK
              // only (no optimistic patch).
              runAckVerb(respond, correlationId, "set-object-policy", cmd);
              break;
            }

            // scope === "session": target the bound session by name.  The
            // session-proxy is bound to exactly one session; read its name from
            // the live model (the only session present).
            const model = getModel?.();
            const sessionName = model !== undefined ? firstSessionName(model) : undefined;
            if (sessionName === undefined) {
              respond?.(correlationId, {
                ok: false,
                code: "verb.failed",
                message: "set-object-policy: scope 'session' but no bound session in model",
              });
              break;
            }
            const cmd = clear
              ? unsetOptionForSession(sessionName, optionName)
              : setOptionForSession(sessionName, optionName, command.value as string);
            runAckVerb(respond, correlationId, "set-object-policy", cmd);
            break;
          }
          // ── tc-7xv.18: window verbs ──────────────────────────────────────────

          case "kill-window": {
            // kill-window -t @<N>  (tc-7xv.18)
            //
            // Kills the tmux window and all its panes.  tmux emits pane-exited
            // and window-close notifications which flow back through the session-proxy
            // mirror as pane.closed + window.removed deltas.
            // tc-u7cu.3: ACK round-trip so %error surfaces.
            const tmuxWinNum = toTmuxWindow(command.windowId);
            runAckVerb(respond, correlationId, "kill-window", `kill-window -t @${tmuxWinNum}`);
            break;
          }

          case "swap-window": {
            // swap-window -s @<S> -t @<T>  (tc-7xv.18)
            //
            // Exchanges the positions of two windows within the session.
            // No panes are created or destroyed; tmux reorders the window list.
            // tc-u7cu.3: ACK round-trip so %error surfaces.
            const srcNum = toTmuxWindow(command.sourceWindowId);
            const tgtNum = toTmuxWindow(command.targetWindowId);
            runAckVerb(respond, correlationId, "swap-window", `swap-window -s @${srcNum} -t @${tgtNum}`);
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
