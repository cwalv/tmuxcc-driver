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
import type { CommandResult } from "../parser/correlator.js";
import type { NotificationEvent } from "../parser/notifications.js";
import type { SessionModel } from "../state/model.js";
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
declare function defaultPaneIdToTmux(id: PaneId): number;
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
declare function defaultWindowIdToTmux(id: WindowId): number;
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
export type VerbResult = {
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
} | {
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
export declare function createInputPath(deps: InputPathDeps, opts?: InputPathOptions): InputPath;
export { defaultPaneIdToTmux, defaultWindowIdToTmux };
//# sourceMappingURL=input-path.d.ts.map