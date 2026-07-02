/**
 * Canonical in-session-proxy session model.
 *
 * @module state/model
 *
 * # Design decisions
 *
 * ## Normalized vs nested
 * The model uses a NORMALIZED representation: three flat Maps (sessions, windows,
 * panes) keyed by their branded id types, plus focus pointers. This mirrors the
 * wire's SnapshotMessage (flat arrays + focus object) so projection (tc-7gp) is
 * trivial — iterate the maps, convert each entry to the corresponding Snapshot*
 * type. It also means the reducer (tc-5dd) can update a single pane or window
 * without rebuilding the entire tree, and invariant checks are O(n) passes over
 * the maps.
 *
 * ## Id types
 * The model reuses wire id types directly: `PaneId`, `WindowId`, `SessionId`
 * from `src/wire/ids.ts`. The session-proxy mints new ids (via `paneId()` /
 * `windowId()` / `sessionId()`) when it maps tmux's `%N` / `@N` / `$N` sigil
 * ids at the south boundary. Everything above that mapping point (state,
 * projection, wire) uses these branded strings only — no tmux sigil ids appear
 * in this module.
 *
 * ## Layout storage
 * Each `Window` stores its layout as `WindowLayout` (from `src/wire/layout.ts`)
 * directly. The wire type is an immutable tree that already carries cols/rows and
 * the full LayoutNode tree, so reusing it avoids a translation step in projection.
 * The reducer (tc-5dd) converts parser `ParsedLayout` → `WindowLayout` via the
 * `parsedLayoutToWindowLayout` helper exported from this module; tc-7gp then
 * reads `Window.layout` as-is for `SnapshotWindow.layout`.
 *
 * ## Pane byte-buffer slot
 * Each `Pane` carries a `scrollbackHandle` field typed as `ScrollbackHandle`
 * (an opaque `number` alias defined here). The actual ring-buffer implementation
 * is tc-fx2's responsibility; at that point `ScrollbackHandle` becomes the
 * handle/key type that tc-fx2's store uses. Until then it defaults to
 * `undefined` (the field is `ScrollbackHandle | undefined`).
 *
 * ## PaneMode
 * Reuses `PaneMode` from `src/wire/session-proxy-control.ts` directly. The wire type is
 * already open-ended (`"normal" | "copy" | "view" | string`) so no translation
 * is needed at projection.
 *
 * ## Immutability discipline
 * All struct fields are `readonly`. The reducer produces a new `SessionModel`
 * value (structural sharing via `{ ...old, sessions: new Map(...) }`) rather
 * than mutating the previous model in place. Update helpers exported here
 * return a new model and never mutate their argument.
 *
 * # Invariants (enforced by checkInvariants)
 *   I1. Every pane's `windowId` references an existing window in the model.
 *   I2. Every window's `sessionId` references an existing session in the model.
 *   I3. Every pane stored in a window's `paneIds` set is present in `model.panes`.
 *   I4. Every window stored in a session's `windowIds` set is present in
 *       `model.windows`.
 *   I5. Each non-empty window has exactly one `activePaneId`, and that id is a
 *       member of the window's `paneIds`. Empty windows have `activePaneId: null`.
 *   I6. Each non-empty session has exactly one `activeWindowId`, and that id is
 *       a member of the session's `windowIds`. Empty sessions have
 *       `activeWindowId: null`.
 *   I7. `model.focus.paneId`, `.windowId`, `.sessionId` are either all null or
 *       all non-null and reference entities that exist and are mutually consistent
 *       (focus.pane belongs to focus.window belongs to focus.session; each is the
 *       respective entity's active pointer).
 *   I8. No duplicate ids within each map (enforced by Map keying).
 *   I9. (Optional / layout consistency) When a window has a non-null layout, the
 *       set of leaf pane ids in the layout tree matches the window's `paneIds`.
 *       Not checked by default (layout may lag one event behind pane lifecycle);
 *       callers can pass `checkLayoutConsistency: true` to opt in.
 *
 * # Wire projection contract (tc-7gp)
 *   - SnapshotSession ← Session.{sessionId, name, activeWindowId === focus.windowId}
 *   - SnapshotWindow  ← Window.{windowId, sessionId, name, activePaneId === …, layout}
 *   - SnapshotPane    ← Pane.{paneId, windowId, sessionId, cols, rows}
 *   - focus           ← SessionModel.focus
 */
import type { PaneId, WindowId, SessionId } from "@tmuxcc/protocol";
import type { WindowLayout } from "@tmuxcc/protocol";
import type { PaneMode } from "@tmuxcc/protocol";
import type { ParsedLayout } from "../parser/layout-string.js";
export { paneId, windowId, sessionId } from "@tmuxcc/protocol";
export type { PaneMode } from "@tmuxcc/protocol";
export type { WindowLayout } from "@tmuxcc/protocol";
/**
 * Opaque handle to a pane's scrollback buffer.
 *
 * tc-fx2 will supply the actual ring-buffer implementation and will likely
 * redeclare/merge this or replace it with a richer type. Until then it is an
 * opaque integer key that tc-fx2's store will use to associate buffers with
 * panes. The reducer mints a fresh handle (a simple incrementing counter is
 * fine) when a pane is created; tc-fx2 registers the buffer under that key.
 */
export type ScrollbackHandle = number & {
    readonly __scrollbackHandle: unique symbol;
};
/** @internal Mint a ScrollbackHandle from a raw number (session-proxy use only). */
export declare function scrollbackHandle(n: number): ScrollbackHandle;
/**
 * A single pane in the model.
 *
 * Projection note: maps directly to `SnapshotPane` (paneId, windowId,
 * sessionId, cols, rows). The additional `mode` field projects to
 * `PaneModeChangedMessage` deltas; `scrollbackHandle` is session-proxy-internal only.
 */
export interface Pane {
    /** Wire-branded pane id (same type as SnapshotPane.paneId). */
    readonly paneId: PaneId;
    /** The window that owns this pane. */
    readonly windowId: WindowId;
    /** The session that ultimately owns this pane (denormalized for O(1) lookup). */
    readonly sessionId: SessionId;
    /** Current width in terminal columns. */
    readonly cols: number;
    /** Current height in terminal rows. */
    readonly rows: number;
    /**
     * Current mode of the pane. Reuses the wire PaneMode type directly so
     * projection is a pass-through. Defaults to "normal" on creation.
     */
    readonly mode: PaneMode;
    /**
     * Dead-pane state (tc-4bv2 / tc-295a.10, co-decided shared pane-state shape).
     *
     * True when tmux reports `pane_dead=1` — the pane's process has exited but
     * the pane slot survives because `remain-on-exit on` keeps the corpse in
     * `list-panes`. A dead pane is a FIRST-CLASS member of the model and the
     * snapshot (NOT an absence): the user can inspect its scrollback and
     * kill/reap it. A pane that leaves `list-panes` entirely is removed by the
     * diff and emits `pane.closed` (the strong contract, tc-295a.10) — that is a
     * distinct event from this dead flag.
     *
     * Defaults to false. Authoritative source: the bootstrap requery's
     * `#{pane_dead}` field.
     */
    readonly dead: boolean;
    /**
     * Exit code of the pane's process when known and dead (tmux
     * `#{pane_dead_status}`), else undefined.
     *
     * Only meaningful when `dead === true`. tmux only exposes a dead status for
     * a corpse it is still listing (remain-on-exit); when a pane vanishes from
     * `list-panes` without a corpse phase the code is unknowable and this stays
     * undefined. Carried through to `pane.closed.exitCode` when a dead corpse is
     * later reaped.
     */
    readonly exitCode: number | undefined;
    /**
     * Durable, out-of-band, DRIVER-owned pane name (tc-1a8z).
     *
     * This is the CANONICAL user rename channel — set explicitly via the
     * `rename-pane` wire command, which issues `set-option -pt %N @tmuxcc_label
     * <name>` (the per-pane tmux user-option `@tmuxcc_label`).  It is a SEPARATE
     * channel from the live shell title: it is NEVER set via a title escape
     * (`select-pane -T` / OSC-0/2), so the shell cannot clobber it.
     *
     * Distinct from the (future) `pane_title` field (tc-2mn8) which carries the
     * volatile shell-owned title sniffed from the %output stream.  Render
     * precedence (durable label > live title > paneId) is the downstream
     * consumer's concern (tc-asyq.6), NOT this model's.
     *
     * Authoritative source: the per-pane user-option `@tmuxcc_label`, re-read on
     * every bootstrap requery (BOOTSTRAP_PANES_FORMAT), so the durable name
     * survives a driver restart for free — canonical state lives with the pane in
     * tmux.  `undefined` means no durable name has been set (the option is unset
     * or empty); clearing the name (empty rename) resets to `undefined`.
     */
    readonly label: string | undefined;
    /**
     * Durable binding intent, PER (pane, client-identity) (D3, tc-4b6k.2).
     *
     * The set of durable client-identity ids (`ClientIdentity.id`) that want a VS
     * Code terminal recreated for this pane on attach.  Binding is a per-client
     * fact: "bound in workspace A, detached in workspace B" is a legal, canonical
     * state (this dissolves seam S1 — two windows, two truths — by correcting the
     * fact's cardinality instead of exempting it to per-window memory). Projection
     * resolves the wire `pane.bound` boolean as `boundClients.has(reqClientId)`
     * for the requesting client's identity.
     *
     * Authoritative source: per-client tmux user-options
     * `@tmuxcc-bound-<enc(clientId)>` (see `paneBoundOptionName` in bootstrap.ts),
     * written ONLY via the `set-object-policy` command keyed by the issuing
     * connection's identity (the driver is the sole tmux writer).  Because the
     * client axis is not available to the bulk session-scoped requery, this set is
     * NOT rebuilt by the bulk read: a client's slot is reconstructed on connect (a
     * one-shot per-client `list-panes` read) and carried forward across requery
     * cycles for surviving panes.  It survives a VS Code restart (durable in tmux)
     * and vanishes with the pane.
     */
    readonly boundClients: ReadonlySet<string>;
    /**
     * RESOLVED detach-on-close policy (tc-i9aq.1, cold-start.md §4.A) from the
     * `@tmuxcc-detach` user-option, read through a `#{@tmuxcc-detach}` FORMAT
     * that walks pane→window→session — so this is the EFFECTIVE first-wins
     * cascade value (pane override, else window default, else session default).
     *
     * `"detach"` keeps the tmux pane running when the VS Code tab closes;
     * `"kill"` exits it.  `undefined` means no scope set a policy (the extension
     * applies its own default).  The host owns the close DECISION; tmux merely
     * computes the same first-wins walk.  Per-scope-OWN values (for the toggle
     * UI's current-setting display) live in the extension's ephemeral policy
     * cache, written through the verb.
     */
    readonly detach: "detach" | "kill" | undefined;
    /**
     * Durable icon policy (tc-i9aq.1, cold-start.md §4.A) from the per-pane
     * `@tmuxcc-icon` user-option, or undefined when unset.  Opaque string (e.g. a
     * ThemeIcon id); the extension interprets it.
     */
    readonly icon: string | undefined;
    /**
     * Handle into tc-fx2's scrollback buffer store, or undefined if no buffer
     * has been allocated yet. The reducer mints a handle on pane creation;
     * tc-fx2 registers the buffer under it. This field is session-proxy-internal and
     * never sent on the wire.
     */
    readonly scrollbackHandle?: ScrollbackHandle;
    /**
     * Live shell window title for this pane — the canonical `#{pane_title}`
     * value (tc-2mn8 introduced the field; tc-s6ov.4 reworked the source).
     *
     * Sourced from a control-mode `%*` (all-panes) `#{pane_title}` subscription
     * (`refresh-client -B 'title-watch:%*:#{pane_title}'`): tmux re-evaluates the
     * format per pane on its ~1s timer and emits `%subscription-changed` only on
     * change, so this catches EVERY title source — shell OSC-0/2, another
     * client's `select-pane -T`, automatic title from `#{pane_current_command}`,
     * etc. This SUPERSEDES the original OSC-0/2 `%output` sniff (tc-2mn8), which
     * was blind to out-of-band changes that never flowed through this client's
     * `%output`. The OSC sniffer is retained only to STRIP title sequences from
     * the byte stream, not to feed this field.
     *
     * Absent when no title has been seen yet. An empty string is a valid title
     * (the shell cleared it).
     *
     * Consumer precedence (for tab/tree display):
     *   @tmuxcc_label (durable name) > paneTitle (live) > paneId (fallback)
     */
    readonly paneTitle?: string;
}
/**
 * A window in the model.
 *
 * Projection note: maps to `SnapshotWindow` (windowId, sessionId, name,
 * active flag, layout). The `paneIds` set is used for invariant checking and
 * for populating the `panes` array of a Snapshot.
 */
export interface Window {
    /** Wire-branded window id. */
    readonly windowId: WindowId;
    /** The session that owns this window. */
    readonly sessionId: SessionId;
    /** Human-readable window name (from %window-renamed or list-windows). */
    readonly name: string;
    /**
     * Ordered list of pane ids belonging to this window.
     * Using a readonly array (not a Set) preserves insertion order and is
     * immutable-friendly (spread to produce a new array on update).
     * Invariant I3: every id here must appear in model.panes.
     */
    readonly paneIds: readonly PaneId[];
    /**
     * The currently active (focused) pane in this window.
     * null iff paneIds is empty (window exists but has no panes yet — transient
     * state during bootstrap).
     * Invariant I5: if non-null, must be in paneIds.
     */
    readonly activePaneId: PaneId | null;
    /**
     * Structured layout of this window. Stored as the wire WindowLayout so
     * projection (tc-7gp) can pass it through to SnapshotWindow.layout as-is.
     * null during bootstrap before the first %layout-change / list-windows
     * response is processed.
     * See `parsedLayoutToWindowLayout` for the parser→model conversion.
     */
    readonly layout: WindowLayout | null;
    /**
     * Whether `synchronize-panes` is currently on for this window.
     *
     * When true, tmux broadcasts every `send-keys` to ALL panes in this window
     * (native tmux broadcast — no extension-side fan-out needed; §4.5 VERIFIED).
     * Defaults to false. Updated via an optimistic `internal:set-window-sync`
     * synthetic event after a `set-synchronize-panes` command is sent to tmux.
     * See tc-7xv.12.
     */
    readonly synchronizePanes: boolean;
    /**
     * Whether `monitor-activity` is currently on for this window (tc-7xv.15).
     *
     * When true, tmux flags this window when any pane produces output while it
     * is in the background.  Defaults to true (matching the global default set
     * at bootstrap via `set-option -wg monitor-activity on`; HANDOFF §4.7).
     * Updated via an optimistic `internal:set-window-monitor-activity` synthetic
     * event after a `set-monitor-activity` command is sent to tmux.
     */
    readonly monitorActivity: boolean;
    /**
     * Current `monitor-silence` threshold for this window, in seconds (tc-7xv.15).
     *
     * 0 means disabled (tmux `monitor-silence 0` = off).
     * Positive values mean tmux will alert after that many seconds of no output.
     * Defaults to 0 (off; HANDOFF §4.7 — silence is opt-in).
     * Updated via an optimistic `internal:set-window-monitor-silence` synthetic
     * event after a `set-monitor-silence` command is sent to tmux.
     */
    readonly monitorSilence: number;
}
/**
 * A session in the model.
 *
 * Projection note: maps to `SnapshotSession` (sessionId, name, active flag).
 * The `windowIds` array drives the window list in a Snapshot.
 */
export interface Session {
    /** Wire-branded session id. */
    readonly sessionId: SessionId;
    /** Human-readable session name (from %session-changed / list-sessions). */
    readonly name: string;
    /**
     * Ordered list of window ids belonging to this session.
     * Invariant I4: every id here must appear in model.windows.
     */
    readonly windowIds: readonly WindowId[];
    /**
     * The currently active (focused) window in this session.
     * null iff windowIds is empty.
     * Invariant I6: if non-null, must be in windowIds.
     */
    readonly activeWindowId: WindowId | null;
}
/**
 * Global focus triple: the currently focused pane, its owning window, and its
 * owning session. All three are null if no pane is focused (e.g. no sessions
 * exist). Denormalizing all three here avoids chasing pointers in the hot path.
 *
 * Invariant I7: either all three are null, or all three are non-null and
 * consistent (focus.pane is the activePaneId of focus.window; focus.window is
 * the activeWindowId of focus.session; focus.session is an existing session).
 */
export interface FocusState {
    readonly paneId: PaneId | null;
    readonly windowId: WindowId | null;
    readonly sessionId: SessionId | null;
}
/**
 * Root session-proxy session model.
 *
 * Normalized: three Maps (sessions, windows, panes) keyed by branded ids,
 * plus a global focus triple. The reducer (tc-5dd) produces a new SessionModel
 * on each event (structural sharing — only the affected map entries change).
 *
 * The model is intentionally flat so projection (tc-7gp) can iterate
 * `model.sessions.values()`, `model.windows.values()`, `model.panes.values()`
 * to build the SnapshotMessage flat arrays directly.
 */
export interface SessionModel {
    /** All sessions, keyed by sessionId. */
    readonly sessions: ReadonlyMap<SessionId, Session>;
    /** All windows across all sessions, keyed by windowId. */
    readonly windows: ReadonlyMap<WindowId, Window>;
    /** All panes across all windows, keyed by paneId. */
    readonly panes: ReadonlyMap<PaneId, Pane>;
    /** Global focus (active session→window→pane). */
    readonly focus: FocusState;
}
/**
 * A structured description of a single invariant violation.
 * Used by `checkInvariants` to report problems rather than throwing, so the
 * reducer and tests can assert on specific failure modes.
 */
export type InvariantViolation = {
    readonly kind: "pane-missing-window";
    /** Pane whose windowId doesn't exist in model.windows. */
    readonly paneId: PaneId;
    readonly windowId: WindowId;
} | {
    readonly kind: "window-missing-session";
    /** Window whose sessionId doesn't exist in model.sessions. */
    readonly windowId: WindowId;
    readonly sessionId: SessionId;
} | {
    readonly kind: "window-pane-not-in-map";
    /** A paneId listed in window.paneIds that's absent from model.panes. */
    readonly windowId: WindowId;
    readonly paneId: PaneId;
} | {
    readonly kind: "session-window-not-in-map";
    /** A windowId listed in session.windowIds that's absent from model.windows. */
    readonly sessionId: SessionId;
    readonly windowId: WindowId;
} | {
    readonly kind: "window-active-pane-missing";
    /** Window has a non-null activePaneId that's not in window.paneIds. */
    readonly windowId: WindowId;
    readonly activePaneId: PaneId;
} | {
    readonly kind: "window-no-active-pane";
    /** Non-empty window has activePaneId === null. */
    readonly windowId: WindowId;
} | {
    readonly kind: "session-active-window-missing";
    /** Session has a non-null activeWindowId that's not in session.windowIds. */
    readonly sessionId: SessionId;
    readonly activeWindowId: WindowId;
} | {
    readonly kind: "session-no-active-window";
    /** Non-empty session has activeWindowId === null. */
    readonly sessionId: SessionId;
} | {
    readonly kind: "focus-partial-null";
    /** Some but not all of focus.{paneId,windowId,sessionId} are null. */
    readonly focus: FocusState;
} | {
    readonly kind: "focus-pane-not-found";
    readonly focusPaneId: PaneId;
} | {
    readonly kind: "focus-window-not-found";
    readonly focusWindowId: WindowId;
} | {
    readonly kind: "focus-session-not-found";
    readonly focusSessionId: SessionId;
} | {
    readonly kind: "focus-pane-wrong-window";
    /** focus.paneId is not in focus.window.paneIds. */
    readonly focusPaneId: PaneId;
    readonly focusWindowId: WindowId;
} | {
    readonly kind: "focus-window-wrong-session";
    /** focus.windowId is not in focus.session.windowIds. */
    readonly focusWindowId: WindowId;
    readonly focusSessionId: SessionId;
} | {
    readonly kind: "focus-pane-not-active";
    /** focus.paneId is in focus.window.paneIds but is not activePaneId. */
    readonly focusPaneId: PaneId;
    readonly focusWindowId: WindowId;
    readonly activePaneId: PaneId | null;
} | {
    readonly kind: "focus-window-not-active";
    /** focus.windowId is in focus.session.windowIds but is not activeWindowId. */
    readonly focusWindowId: WindowId;
    readonly focusSessionId: SessionId;
    readonly activeWindowId: WindowId | null;
} | {
    readonly kind: "layout-pane-mismatch";
    /** Layout leaf ids don't match window.paneIds (only when checkLayoutConsistency is true). */
    readonly windowId: WindowId;
    readonly layoutPaneIds: readonly PaneId[];
    readonly modelPaneIds: readonly PaneId[];
};
export interface CheckInvariantsOptions {
    /**
     * When true, also verify that the leaf pane ids in each window's layout tree
     * match the window's paneIds exactly (I9). Disabled by default because layout
     * may legitimately lag one event behind during bootstrap.
     */
    readonly checkLayoutConsistency?: boolean;
}
/**
 * Check all model invariants and return a list of violations (empty = valid).
 *
 * Does not throw; returns structured violations so callers (tests, reducer
 * assertions) can inspect the specific failure mode.
 */
export declare function checkInvariants(model: SessionModel, options?: CheckInvariantsOptions): InvariantViolation[];
/** Return an empty model (no sessions, no windows, no panes, no focus). */
export declare function emptyModel(): SessionModel;
/**
 * Add a session to the model. If the model currently has no sessions, the new
 * session becomes the active session and its focus triplet is set accordingly
 * (only if the session has at least one window+pane; otherwise focus stays null).
 *
 * Does NOT enforce that `session.sessionId` is absent — callers must ensure
 * uniqueness or `checkInvariants` will catch it via duplicate Map key semantics
 * (Maps silently overwrite; that's a structural guarantee violation the reducer
 * should avoid).
 */
export declare function addSession(model: SessionModel, session: Session): SessionModel;
/** Remove a session and all its windows and panes from the model. Clears focus if affected. */
export declare function removeSession(model: SessionModel, sessionId: SessionId): SessionModel;
/** Add a window to its owning session and to the windows map. */
export declare function addWindow(model: SessionModel, win: Window): SessionModel;
/** Remove a window (and all its panes) from the model. Updates session's windowIds and active pointer. */
export declare function removeWindow(model: SessionModel, windowId: WindowId): SessionModel;
/** Add a pane to its owning window and to the panes map. */
export declare function addPane(model: SessionModel, pane: Pane): SessionModel;
/**
 * Remove a pane from the model. Updates its owning window's paneIds and
 * activePaneId (reassigns to first remaining pane, or null if window is now
 * empty). Clears focus if the removed pane was focused.
 */
export declare function removePane(model: SessionModel, paneId: PaneId): SessionModel;
/** Replace a pane's fields (e.g. resize or mode change or title update). */
export declare function updatePane(model: SessionModel, paneId: PaneId, patch: Partial<Pick<Pane, "cols" | "rows" | "mode" | "dead" | "exitCode" | "label" | "scrollbackHandle" | "paneTitle" | "boundClients" | "detach" | "icon">>): SessionModel;
/**
 * Resolve a pane's binding intent for a specific client identity (D3,
 * tc-4b6k.2).  Returns true iff the client's durable id is in the pane's
 * `boundClients`.  An undefined `clientId` (an anonymous connection) is never
 * bound.
 */
export declare function paneBoundFor(pane: Pane, clientId: string | undefined): boolean;
/**
 * Return a `boundClients` set with `clientId`'s membership set to `bound`
 * (D3, tc-4b6k.2).  Returns the same reference when already in the desired
 * state (so a caller's reference-equality no-op check stays cheap).
 */
export declare function setBoundClient(current: ReadonlySet<string>, clientId: string, bound: boolean): ReadonlySet<string>;
/** Replace a window's fields (e.g. rename, layout update, synchronize-panes toggle). */
export declare function updateWindow(model: SessionModel, windowId: WindowId, patch: Partial<Pick<Window, "name" | "layout" | "activePaneId" | "synchronizePanes" | "monitorActivity" | "monitorSilence">>): SessionModel;
/** Replace a session's fields (e.g. rename, activeWindowId change). */
export declare function updateSession(model: SessionModel, sessionId: SessionId, patch: Partial<Pick<Session, "name" | "activeWindowId">>): SessionModel;
/** Set the global focus triple. All three must be non-null or all null. */
export declare function setFocus(model: SessionModel, focus: FocusState): SessionModel;
/**
 * Convert a `ParsedLayout` (from `src/parser/layout-string.ts`) into the wire
 * `WindowLayout` (from `src/wire/layout.ts`) that the model stores.
 *
 * This is the bridge the reducer (tc-5dd) uses when processing a
 * `%layout-change` notification. The projection (tc-7gp) can then use
 * `Window.layout` directly as `SnapshotWindow.layout`.
 *
 * `tmuxPaneIdToWireId` is a mapping function the reducer supplies — it maps
 * the integer tmux pane id from the parser to the session-proxy's branded `PaneId`.
 *
 * @throws {Error} if a leaf pane id is present but has no mapping in `tmuxPaneIdToWireId`.
 */
export declare function parsedLayoutToWindowLayout(parsed: ParsedLayout, tmuxPaneIdToWireId: (tmuxId: number) => PaneId): WindowLayout;
//# sourceMappingURL=model.d.ts.map