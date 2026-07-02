/**
 * Model→wire projection for the tmuxcc sessionProxy (tc-7gp, updated tc-j9c.2).
 *
 * Two entry points:
 *   - `projectSnapshot(model, opts?)` — full-state snapshot for a new client.
 *   - `diffModel(prev, next)` — minimal incremental deltas between two model
 *     versions, for ongoing broadcast to connected clients.
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES
 * ---------------------------------------------------------------------------
 *
 * ## Single-session (v3)
 * The session-proxy wire is single-session. `projectSnapshot` takes the first session
 * from the model as the bound session. `diffModel` emits only
 * `SessionProxySessionRenamedMessage` for session renames (no session.added,
 * session.closed, session.changed). The `sessionId` field is absent from
 * all pane/window/layout/focus deltas.
 *
 * ## SnapshotPane and pane bytes
 * `SnapshotPane` in session-proxy-control.ts does NOT carry pane byte content.
 * Initial byte sync is therefore the data-plane's responsibility (tc-2mq /
 * tc-fbz), not the projection's.
 *
 * ## Sequence numbers (seq)
 * `seq` is a per-connection counter owned by the SENDER (spec: MessageBase).
 * The session-proxy runtime (E4 / tc-dv3) maintains the counter and passes `nextSeq`
 * via `ProjectSnapshotOpts`. If not supplied, `projectSnapshot` starts at 2
 * (the snapshot is always the second message after capabilities at seq=1).
 * `diffModel` does NOT assign seq values — the returned delta array has
 * `seq: 0` placeholders. The E4 caller stamps actual seq values before sending,
 * iterating the array in order. This lets the projection stay stateless (no
 * connection state).
 *
 * ## Delta ordering rule
 * Deltas are ordered so a client can always apply them sequentially without
 * referencing an entity that hasn't been announced yet:
 *
 *   1. window.added        — new windows (panes reference them)
 *   2. pane.opened         — new panes
 *   3. layout.updated      — window layout changes (may ref existing panes)
 *   3b. pane.moved         — window-membership change on an existing pane
 *                            (break-pane re-home; the target window is already
 *                            announced by window.added above) (tc-4gor)
 *   4. pane.resized        — size changes on existing panes
 *   5. pane.mode-changed   — mode changes on existing panes
 *   5a2. pane.label-changed — durable pane-name changes on existing panes (tc-1a8z)
 *   5b. pane.dead-changed  — dead-state flip on existing panes (tc-4bv2/tc-295a.10)
 *   6. window.renamed      — renames (entity already exists)
 *   7. session.renamed     — session rename
 *   8. focus.changed       — focus (all referenced entities now exist)
 *   9. pane.closed         — removals after any focus update away from them
 *  10. window.closed       — window removals after pane removals
 *
 * Within each group, ordering is Map-iteration order (stable insertion order).
 *
 * ## Round-trip guarantee
 * The test file (projection.test.ts) proves:
 *   `applyDeltas(projectSnapshot(prev), diffModel(prev, next))`
 *   deep-equals `projectSnapshot(next)`
 * for several prev/next pairs including multi-change scenarios.
 * `applyDeltas` is a reference implementation in the test file itself.
 */
import type { SessionModel } from "./model.js";
import type { PaneId, WindowId } from "@tmuxcc/protocol";
import type { SnapshotMessage, SessionProxyMessage, Origin } from "@tmuxcc/protocol";
/**
 * Lookup the causality {@link Origin} for a newly-created pane or window
 * (tc-ozk.2).
 *
 * Threaded into {@link diffModel} so the SINGLE place that emits
 * `pane.opened` / `window.added` — used by BOTH the event path (serve.ts
 * per-client `onModelChange`) AND the diff path (requery.ts `requeryDiff`) —
 * can stamp the origin uniformly. Called once per newly-appearing pane id and
 * once per newly-appearing window id.
 *
 * Returns the verb's `{connectionId, requestId}` when the id matches a recent
 * wire verb's returned effect ids (the daemon recorded the correlation when
 * the verb replied, tc-ozk.1), or `undefined` for a FOREIGN creation (no
 * matching verb — native client, script). An `undefined` result leaves the
 * delta untagged.
 */
export type OriginLookup = (id: PaneId | WindowId) => Origin | undefined;
/**
 * Consume the close cause for a pane that is about to be closed (tc-u7cu.6).
 *
 * Threaded into {@link diffModel} so the SINGLE place that emits `pane.closed`
 * can stamp the cause uniformly. Called once per disappearing pane id.
 *
 * Returns `{connectionId, requestId}` when the id was killed by a wire verb
 * (close-pane / kill-window), or `undefined` when the close was unsolicited
 * (shell exit, external kill-pane). ONE-SHOT: the registry removes the entry
 * on consume (each pane id closes exactly once; diffModel is not called
 * per-client for close deltas so idempotency is not needed here).
 *
 * Omitting `closeCauseLookup` leaves all close deltas untagged — the correct
 * default for callers without close-verb-correlation state (tests).
 */
export type CloseCauseLookup = (id: PaneId) => Origin | undefined;
/**
 * Options for projectSnapshot.
 *
 * `seq`: the sequence number to stamp on the snapshot message. The E4 session-proxy
 * runtime owns the per-connection counter and passes it here. Defaults to 2
 * (snapshot is always the second session-proxy→client message after capabilities
 * at seq=1).
 *
 * `attachedClientCount`: the number of session-proxy-protocol clients connected at
 * snapshot time (tc-1elae, §11.4 tooltip). The serve layer (tc-dv3) passes
 * `server.clientCount()` here. Omit to leave the field absent (backwards-
 * compatible; older clients simply do not read it).
 */
export interface ProjectSnapshotOpts {
    readonly seq?: number;
    readonly attachedClientCount?: number;
    /**
     * tc-ozk.2: THIS client's own connectionId, stamped into the snapshot so the
     * client can compare it against `origin.connectionId` on creation deltas to
     * decide whether a creation is its own. Omit to leave the field absent
     * (callers without per-connection identity — tests).
     */
    readonly connectionId?: import("@tmuxcc/protocol").ConnectionId;
    /**
     * tc-4b6k.2 (D3): the requesting client's durable identity id
     * (`ClientIdentity.id`). Binding intent is per-client, so each pane's wire
     * `bound` boolean is resolved for THIS client as
     * `pane.boundClients.has(clientId)`. Omit (or undefined) for an anonymous
     * connection — then no pane is bound. The serve layer passes the identity it
     * captured at handshake.
     */
    readonly clientId?: string | undefined;
}
/**
 * Project the full model state into a wire SnapshotMessage.
 *
 * Called once per new client connection, immediately after the capabilities
 * handshake. The snapshot carries the bound session, flat arrays
 * (windows, panes), and the focus pair. All ids are the model's branded ids
 * (same types as the wire uses — no conversion needed).
 *
 * Assumes the model has exactly one session (the session-proxy's bound session).
 * If the model is empty (no sessions), returns a snapshot with a placeholder
 * session identity.
 *
 * SnapshotPane does NOT carry pane byte content; initial byte delivery is the
 * data-plane's responsibility (see module-level design notes).
 */
export declare function projectSnapshot(model: SessionModel, opts?: ProjectSnapshotOpts): SnapshotMessage;
/**
 * Compute the minimal set of wire delta messages that transforms a client
 * holding `prev` into the state described by `next`.
 *
 * Returned messages have `seq: 0` — the E4 runtime stamps real seq values
 * before sending, iterating the array in order. Caller must NOT reorder the
 * array, as the ordering rule (see module-level notes) ensures a client can
 * apply the deltas without referencing a not-yet-announced entity.
 *
 * Returns an empty array if `prev` and `next` are observably identical.
 *
 * `originLookup` (tc-ozk.2): optional causality resolver. When supplied, each
 * newly-appearing pane / window has its id passed to the lookup; a non-undefined
 * result is stamped as the `origin` field on the emitted `pane.opened` /
 * `window.added` (verb-caused), and `undefined` leaves it untagged (foreign).
 * Omitting `originLookup` leaves every creation untagged — the correct default
 * for callers without verb-correlation state (tests, the metrics-only patch
 * path). This is the SINGLE choke point that both the event path (serve.ts) and
 * the diff/requery path (requery.ts) pass the lookup through, so attribution is
 * uniform across both.
 *
 * `closeCauseLookup` (tc-u7cu.6): optional close-cause resolver. When supplied,
 * each disappearing pane has its id passed to the lookup (consume, one-shot);
 * a non-undefined result is stamped as the `cause` field on the emitted
 * `pane.closed` (verb-caused), and `undefined` leaves it untagged (unsolicited).
 *
 * `clientId` (tc-4b6k.2, D3): the requesting client's durable identity id.
 * Binding intent is per-client, so `pane.opened.bound` and the
 * `pane.policy-changed` binding delta are resolved for THIS client
 * (`boundClients.has(clientId)`). Omit for the metrics-only / test diffs that
 * have no client — then binding resolves to false and never produces a
 * binding-only `pane.policy-changed` (the per-client stream in serve.ts is the
 * one that carries binding deltas to a real client).
 */
export interface DiffOptions {
    readonly originLookup?: OriginLookup | undefined;
    readonly closeCauseLookup?: CloseCauseLookup | undefined;
    readonly clientId?: string | undefined;
}
export declare function diffModel(prev: SessionModel, next: SessionModel, opts?: DiffOptions): SessionProxyMessage[];
//# sourceMappingURL=projection.d.ts.map