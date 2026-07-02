/**
 * Close-cause registry — causality attribution for pane-close deltas (tc-u7cu.6).
 *
 * @module runtime/close-cause
 *
 * # Why this exists
 *
 * `pane.closed` carries `cause: {connectionId, requestId}` when the close was
 * caused by a wire verb (close-pane / kill-window), and carries NO cause when
 * unsolicited (shell exit, external `kill-pane`). The session-proxy is the only
 * party that knows who caused what: it records the correlation between a
 * close-verb's ACK and the pane(s) it closed, then stamps the cause on the
 * pane.closed delta when diffModel emits it. This mirrors the VerbOriginRegistry
 * (tc-ozk.2) which does the same for creating verbs and pane.opened.
 *
 * # When the cause is recorded
 *
 * The cause is recorded when the close verb's %end ACK arrives (in the VerbResponder
 * callback). In tmux control mode, the %end for a command always arrives BEFORE
 * any subsequent topology notifications (%window-close) for the same action —
 * tmux processes commands sequentially: sends %end, THEN emits side-effect
 * notifications. So by the time the pane.closed delta is emitted (after the
 * %window-close triggers a requery), the cause is already recorded.
 *
 * # Record / consume, not record / lookup-idempotent
 *
 * Unlike VerbOriginRegistry (which is idempotent for multi-client fan-out of
 * creation deltas), pane close is ONE-SHOT: each pane id can only close once,
 * and diffModel is called once per model transition (not once per client — the
 * close delta itself has no per-client variation). So this registry uses
 * consume-on-lookup (one-shot) semantics, which also self-cleans on the first
 * lookup without needing an explicit clear() call.
 *
 * An explicit clear() is still provided for the case where a recorded pane
 * id never reaches diffModel (e.g. the session-proxy shuts down before the pane
 * closes) — defensive cleanup to bound the map size.
 */
import type { PaneId, ConnectionId } from "@tmuxcc/protocol";
import type { Origin } from "@tmuxcc/protocol";
/** Options for {@link createCloseCauseRegistry}. */
export interface CloseCauseRegistryOptions {
    /** Override the default TTL (ms). */
    readonly ttlMs?: number;
    /** Override the default max live entries. */
    readonly maxEntries?: number;
    /** Injectable clock for tests; defaults to `Date.now`. */
    readonly now?: () => number;
}
/**
 * Correlates a closing verb's pane id(s) to the connection + request that
 * caused the close, so pane.closed deltas can be stamped with their cause.
 */
export interface CloseCauseRegistry {
    /**
     * Record that the verb from `connectionId` with `requestId` caused `paneId`
     * to close. Called once per pane when a close-pane or kill-window verb ACKs.
     */
    record(paneId: PaneId, connectionId: ConnectionId, requestId: string): void;
    /**
     * Consume the cause for a closing pane id. Returns the recorded
     * {@link Origin}, or `undefined` if the close was unsolicited (no matching
     * verb). ONE-SHOT: consuming removes the entry (each pane closes exactly
     * once, and diffModel is called once per model transition — not once per
     * client, unlike creation deltas). This is safe because pane.closed is never
     * re-emitted for the same pane id.
     */
    consume(paneId: PaneId): Origin | undefined;
    /**
     * Drop any recorded cause for `paneId`. Defensive cleanup for the case where
     * a recorded pane id never reaches diffModel (session shutdown, etc.).
     * Idempotent.
     */
    clear(paneId: PaneId): void;
}
/**
 * Create a {@link CloseCauseRegistry}.
 */
export declare function createCloseCauseRegistry(opts?: CloseCauseRegistryOptions): CloseCauseRegistry;
//# sourceMappingURL=close-cause.d.ts.map