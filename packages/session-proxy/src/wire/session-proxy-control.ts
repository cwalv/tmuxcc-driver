/**
 * SessionProxy wire control-plane message schema for the tmuxcc wire protocol.
 *
 * These are the STRUCTURED messages that flow between session-proxy and client
 * on the session-proxy wire (one connection = one tmux session).
 * They are transport-agnostic: no WebSocket frames, no pipe framing, no
 * length-prefixed byte streams (that is tc-2mq's job).
 *
 * INVARIANT (enforced by design):
 *   - No tmux south-side vocabulary: no %output, no %begin/%end, no tmux
 *     command numbers, no octal escapes, no layout-string syntax.
 *   - No renderer/host vocabulary: no Pseudoterminal, no VS Code types, no DOM.
 *   The wire is the session-proxy's projection of its model, not a passthrough of
 *   tmux's control-mode syntax and not a renderer API.
 *
 * ---------------------------------------------------------------------------
 * DIRECTION MODEL
 * ---------------------------------------------------------------------------
 *
 * SessionProxy → Client (server push): the session-proxy is the source of truth and pushes
 *   state changes to the client. These are read-only events from the client's
 *   perspective.
 *
 * Client → SessionProxy (client request): the client sends input or resize requests
 *   to the session-proxy.
 *
 * Both: the handshake messages (capabilities exchange) flow in both directions;
 *   their sequencing is defined by tc-auj; here we only define the data shapes.
 *
 * ---------------------------------------------------------------------------
 * VERSIONING
 * ---------------------------------------------------------------------------
 *
 * See envelope.ts for WIRE_PROTOCOL_VERSION.
 *
 * v2 → v3 (tc-j9c.1/tc-j9c.2): SessionProxy wire becomes single-session.
 *   - Plural `sessions[]` snapshot replaced by singular `session`.
 *   - `sessionId` stripped from every delta (PaneOpenedMessage, PaneClosedMessage,
 *     LayoutUpdatedMessage, FocusChangedMessage, WindowAddedMessage, WindowClosedMessage).
 *   - `active` stripped from SnapshotSession (always true — bound session).
 *   - `sessionId` stripped from SnapshotWindow, SnapshotPane, and focus.
 *   - SessionAddedMessage, SessionChangedMessage removed from session-proxy wire
 *     (moved to server-proxy wire).
 *   - SessionRenamedMessage renamed SessionProxySessionRenamedMessage; sessionId dropped.
 *   - SessionClosedMessage removed; session destruction surfaces as ErrorMessage
 *     with code "session.unavailable".
 *   - CommandRequestMessage renamed SessionProxyCommandRequestMessage;
 *     CommandResponseMessage renamed SessionProxyCommandResponseMessage;
 *     CommandOkPayload renamed SessionProxyCommandOkPayload.
 *   - `sessionId` dropped from OpenWindowCommand.
 *   - "session.closed" removed from WireErrorCode; "session.unavailable" remains.
 */

import type { PaneId, WindowId, ConnectionId } from "./ids.js";
import type { WindowLayout } from "./layout.js";
import type { MessageBase, Capabilities } from "./envelope.js";

// ---------------------------------------------------------------------------
// Causality tag for creation deltas (tc-ozk.2)
// ---------------------------------------------------------------------------

/**
 * The origin of a verb-caused creation delta (tc-ozk.2).
 *
 * Stamped by the session-proxy on a `pane.opened` / `window.added` when the
 * creation was caused by a wire verb (split-pane / open-window / break-pane).
 * The session-proxy is the only party that knows who caused what — it
 * correlates the verb's returned effect ids (tc-ozk.1) to the creation it
 * emits — so it stamps this rather than every host guessing.
 *
 * ABSENT (the `origin` field omitted from the delta) means FOREIGN: a native
 * tmux client, a script, or any non-wire cause. This formalises and supersedes
 * the bare `created` flag (tc-3y8.2). A client compares `connectionId` against
 * its OWN connectionId (advertised in the snapshot) to decide whether the
 * creation is its own — a FIELD CHECK, including the multi-client case (client
 * B sees client A's connectionId and correctly treats it as not-its-own).
 */
export interface Origin {
  /** The connection whose wire verb caused this creation. */
  readonly connectionId: ConnectionId;
  /**
   * The `correlationId` of the originating `command.request` (echoed verbatim).
   * Lets the causing client match the creation to the specific verb it issued.
   */
  readonly requestId: string;
}

// ---------------------------------------------------------------------------
// SessionProxy → Client messages (server push)
// ---------------------------------------------------------------------------

/**
 * A new pane has been created.
 * direction: session-proxy→client
 *
 * Sent when a pane opens (new window, split, or any other tmux operation
 * that produces a new pane). The session-proxy maps the tmux-internal id to a
 * wire PaneId before sending; `%N` never appears here.
 */
export interface PaneOpenedMessage extends MessageBase {
  readonly type: "pane.opened";
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  /** Initial size of the pane in terminal cells. */
  readonly cols: number;
  readonly rows: number;
  /**
   * True if this pane is the active (focused) pane at the moment of opening.
   * Clients MAY use this to avoid a separate focus event on startup.
   */
  readonly active: boolean;
  /**
   * True when this pane is already dead at the moment it enters the model
   * (tc-4bv2 / tc-295a.10 shared pane-state shape). This happens when a
   * requery (cold attach to a pre-existing session, or reconnect) observes a
   * `remain-on-exit` corpse for the first time — the pane is born into the
   * client's model already exited.
   *
   * Additive optional field — absent means false. Non-breaking per the
   * versioning policy above.
   */
  readonly dead?: boolean;
  /**
   * Exit code of the pane's process when `dead` is true and the code is known
   * (tmux `pane_dead_status`). Absent when the pane is alive or the code is
   * unknowable. Additive optional field — non-breaking.
   */
  readonly exitCode?: number;
  /**
   * Durable, driver-owned pane name (tc-1a8z) when this pane is born already
   * carrying a `@tmuxcc_label` user-option — e.g. a cold attach / reconnect
   * that observes a pane a previous session renamed.  Absent/empty means no
   * durable name.  See {@link SnapshotPane.label}.  Additive optional field.
   */
  readonly label?: string;
  /**
   * Durable binding intent (tc-i9aq.1, cold-start.md §4.A) when this pane is
   * born already carrying `@tmuxcc-bound` — e.g. a cold attach that observes a
   * pane a previous session marked.  Absent means no intent.  Additive optional.
   */
  readonly bound?: boolean;
  /**
   * RESOLVED detach-on-close policy (tc-i9aq.1) when this pane is born carrying
   * a `@tmuxcc-detach` policy at any scope.  Absent means inherit.  Additive.
   */
  readonly detach?: "detach" | "kill";
  /**
   * Durable icon policy (tc-i9aq.1) when this pane is born carrying
   * `@tmuxcc-icon`.  Absent means no policy.  Additive optional.
   */
  readonly icon?: string;
  /**
   * Causality tag (tc-ozk.2). PRESENT when this pane was created by a wire verb
   * (split-pane / open-window): names the connection + requestId that caused
   * it. ABSENT when foreign (native client, script). Additive optional field
   * that supersedes the bare `created` flag (tc-3y8.2). See {@link Origin}.
   */
  readonly origin?: Origin;
}

/**
 * A pane's dead state changed without the pane leaving the session
 * (tc-4bv2 / tc-295a.10 shared pane-state shape).
 * direction: session-proxy→client
 *
 * Emitted when a LIVE pane transitions to dead (its process exited but the
 * pane slot survives because `remain-on-exit on`), or — defensively — back to
 * live (a dead pane respawned in place, `respawn-pane`). The pane stays in the
 * model and the snapshot the whole time; this delta only flips the `dead`
 * flag.
 *
 * This is DISTINCT from `pane.closed`: closed means the pane slot left
 * `list-panes` entirely (the strong contract, tc-295a.10). A dead pane is a
 * reapable corpse the user can still inspect and kill.
 *
 * Non-breaking additive delta — older clients that do not recognise this type
 * fall through to the `default` branch in `applyDelta` and ignore it (the
 * pane simply continues to render as live until the next snapshot).
 */
export interface PaneDeadChangedMessage extends MessageBase {
  readonly type: "pane.dead-changed";
  readonly paneId: PaneId;
  /** True when the pane is now dead; false when it returned to live. */
  readonly dead: boolean;
  /**
   * Exit code when `dead` is true and known (tmux `pane_dead_status`); absent
   * otherwise (alive, or code unknowable).
   */
  readonly exitCode?: number;
}

/**
 * A pane has been closed (exited or killed).
 * direction: session-proxy→client
 *
 * `exitCode` is the process exit code if the session-proxy captured it. It is
 * optional because the current tmux notification layer (%window-close) does
 * not carry the per-pane exit status — tmux only notifies that the window
 * closed, not the individual pane's exit code. When absent, renderers should
 * display a generic "[process exited]" message rather than "[process exited —
 * code N]". This field is additive/optional and does not require a protocol
 * version bump (non-breaking per the versioning policy above).
 *
 * tc-295a.10 (strong contract): pane.closed means the pane SLOT left
 * `list-panes` entirely — it is emitted EXACTLY ONCE when a pane id present in
 * the previous requery model is absent from the next. It is DISTINCT from
 * PaneDeadChangedMessage (a `remain-on-exit` corpse that stays in the model).
 * When the closed pane was previously observed as a dead corpse with a known
 * `pane_dead_status`, that code is carried through here as `exitCode`.
 *
 * `cause` is the causality tag (tc-u7cu.6). PRESENT when this pane was closed
 * by a wire verb (close-pane / kill-window) from a specific connection: names
 * the connection + requestId that caused the close. ABSENT when the close was
 * unsolicited (shell exit, external kill-pane from a native tmux client, or any
 * non-wire cause). Mirrors the `origin` field on `pane.opened` / `window.added`
 * (tc-ozk.2): the session-proxy is the only party that knows which closes it
 * caused, so it stamps this rather than every host guessing. Additive optional
 * field — older clients that do not read it are unaffected (non-breaking per
 * the versioning policy above). See {@link Origin}.
 */
export interface PaneClosedMessage extends MessageBase {
  readonly type: "pane.closed";
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  /**
   * Exit code of the pane's process, if known.
   * Absent when the session-proxy could not determine the exit code (most common case:
   * tmux's %window-close notification does not include a per-pane exit status).
   */
  readonly exitCode?: number;
  /**
   * Causality tag (tc-u7cu.6). PRESENT when this pane was closed by a wire
   * verb (close-pane / kill-window): names the connection + requestId that
   * caused the close. ABSENT when the close was unsolicited (shell exit,
   * external kill-pane). Additive optional field — see {@link Origin}.
   */
  readonly cause?: Origin;
}

/**
 * A pane's dimensions have changed (user resized the terminal or layout changed).
 * direction: session-proxy→client
 *
 * Distinct from ResizeRequestMessage (client→sessionProxy): this is the session-proxy
 * confirming the new size after the resize has taken effect.
 */
export interface PaneResizedMessage extends MessageBase {
  readonly type: "pane.resized";
  readonly paneId: PaneId;
  readonly cols: number;
  readonly rows: number;
}

/**
 * A pane's durable, driver-owned name changed (tc-1a8z).
 * direction: session-proxy→client
 *
 * Emitted when the per-pane `@tmuxcc_label` user-option changes — either
 * optimistically right after a `rename-pane` command, or when a later requery
 * observes the user-option's new value.  This is the CANONICAL user rename
 * channel, DISTINCT from the volatile shell title (tc-2mn8): it is set ONLY via
 * `set-option -pt %N @tmuxcc_label`, never a title escape, so the shell cannot
 * clobber it.
 *
 * `label` absent means the durable name was CLEARED (empty rename → the
 * user-option is now unset); a non-empty `label` is the new durable name.
 *
 * Non-breaking additive delta — older clients that do not recognise this type
 * ignore it (the pane continues to render with its prior name until the next
 * snapshot).
 */
export interface PaneLabelChangedMessage extends MessageBase {
  readonly type: "pane.label-changed";
  readonly paneId: PaneId;
  /** The new durable name, or absent when the name was cleared. */
  readonly label?: string;
}

/**
 * The layout of a window has changed.
 * direction: session-proxy→client
 *
 * Sent whenever panes are added, removed, or resized within a window,
 * giving clients the full current geometry as a structured tree.
 * See layout.ts for the WindowLayout / LayoutNode types.
 *
 * Clients should apply the layout atomically: update all pane rects before
 * re-rendering to avoid flickering.
 */
export interface LayoutUpdatedMessage extends MessageBase {
  readonly type: "layout.updated";
  readonly windowId: WindowId;
  readonly layout: WindowLayout;
}

/**
 * The active (focused) pane has changed.
 * direction: session-proxy→client
 *
 * Sent when the user navigates between panes or when tmux changes focus for
 * any reason. If no pane is active (e.g., no windows open), `paneId` is null.
 */
export interface FocusChangedMessage extends MessageBase {
  readonly type: "focus.changed";
  readonly paneId: PaneId | null;
  readonly windowId: WindowId | null;
}

/**
 * The session-proxy's capabilities advertisement (sent once at handshake time).
 * direction: session-proxy→client
 *
 * The handshake sequence is defined by bead tc-auj; this is just the shape.
 */
export interface SessionProxyCapabilitiesMessage extends MessageBase {
  readonly type: "session-proxy.capabilities";
  readonly capabilities: Capabilities;
}

// ---------------------------------------------------------------------------
// Snapshot (session-proxy→client, sent once on connect)
// ---------------------------------------------------------------------------

/**
 * The bound session as represented in a Snapshot.
 * Only carries identity — the session is always the bound session (always active).
 */
export interface SnapshotSession {
  readonly sessionId: import("./ids.js").SessionId;
  readonly name: string;
}

/**
 * A window as represented in a Snapshot.
 */
export interface SnapshotWindow {
  readonly windowId: WindowId;
  readonly name: string;
  /** True if this is the active window in the session. */
  readonly active: boolean;
  /** Structured pane layout for this window. */
  readonly layout: WindowLayout;
  /**
   * True when `synchronize-panes` is on for this window at snapshot time.
   * tc-7xv.12: present in all snapshots; defaults to false.
   */
  readonly synchronizePanes: boolean;
  /**
   * True when `monitor-activity` is on for this window at snapshot time.
   * tc-7xv.15: present in all snapshots; defaults to true (global default).
   */
  readonly monitorActivity: boolean;
  /**
   * Current `monitor-silence` threshold in seconds, or 0 when disabled.
   * tc-7xv.15: present in all snapshots; defaults to 0 (off).
   */
  readonly monitorSilence: number;
}

/**
 * A pane as represented in a Snapshot.
 */
export interface SnapshotPane {
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  /** Width in columns. */
  readonly cols: number;
  /** Height in rows. */
  readonly rows: number;
  /**
   * True when the pane is dead at snapshot time (tc-4bv2 / tc-295a.10 shared
   * pane-state shape): its process has exited but the pane slot survives
   * (`remain-on-exit` corpse). A dead pane is part of the snapshot so the
   * client can render it, inspect its scrollback, and kill/reap it.
   *
   * Additive optional field — absent means false. This is what lets an
   * all-dead-pane session appear in the panel (the bead's core fix).
   */
  readonly dead?: boolean;
  /**
   * Exit code when `dead` is true and known (tmux `pane_dead_status`); absent
   * when alive or the code is unknowable. Additive optional field.
   */
  readonly exitCode?: number;
  /**
   * Durable, driver-owned pane name (tc-1a8z) — the canonical user rename
   * channel, stored in the per-pane `@tmuxcc_label` tmux user-option and set
   * ONLY via the `rename-pane` command (never via a title escape).  Survives a
   * driver restart (re-read from the user-option on every requery).
   *
   * DISTINCT from the live shell title `pane_title` (tc-2mn8): this is the
   * out-of-band durable name the shell cannot clobber.  Render precedence
   * (durable label > live title > paneId) is the consumer's concern (tc-asyq.6).
   *
   * Additive optional field — absent/empty means no durable name is set.
   */
  readonly label?: string;
  /**
   * Durable binding intent (tc-i9aq.1, cold-start.md §4.A) from the per-pane
   * `@tmuxcc-bound` user-option.  True when the user wants a VS Code terminal
   * recreated for this pane on attach.  Additive optional field — absent/false
   * means no intent.
   */
  readonly bound?: boolean;
  /**
   * RESOLVED detach-on-close policy (tc-i9aq.1, cold-start.md §4.A) — the
   * effective first-wins value of `@tmuxcc-detach` walked pane→window→session.
   * "detach" keeps the tmux pane alive when the tab closes; "kill" exits it.
   * Absent means no scope set a policy (the extension applies its default).
   */
  readonly detach?: "detach" | "kill";
  /**
   * Durable icon policy (tc-i9aq.1, cold-start.md §4.A) from the per-pane
   * `@tmuxcc-icon` user-option.  Absent means no policy.
   */
  readonly icon?: string;
  /**
   * Live shell window title for this pane — the canonical `#{pane_title}`
   * value (tc-2mn8; canonical source reworked in tc-s6ov.4). Sourced by the
   * session-proxy from a control-mode `%*` `#{pane_title}` subscription, which
   * catches every title source (shell OSC-0/2, another client's
   * `select-pane -T`, automatic title from the current command), superseding
   * the original OSC-0/2 `%output` sniff. Absent when no title has been
   * observed yet (pane just opened, or shell has not set a title). Empty
   * string means the title was explicitly cleared.
   *
   * Additive optional field — older clients that do not read it are unaffected.
   */
  readonly paneTitle?: string;
}

/**
 * Full-state snapshot, sent once by the session-proxy immediately after the
 * capabilities handshake.
 * direction: session-proxy→client
 *
 * Design: normalized (flat arrays) rather than deeply nested. The client
 * builds its own in-memory tree by joining on ids. This avoids deeply
 * nested JSON and makes incremental Delta application straightforward —
 * each collection is independently patchable.
 *
 * After receiving Snapshot, the client applies subsequent Delta messages
 * (ordered by seq) to maintain an up-to-date local model. The Snapshot
 * seq acts as the baseline; any Delta with a higher seq is applied on top.
 *
 * The session-proxy is bound to exactly one session for its lifetime; that session
 * is carried in `session`. There is no `sessions[]` array — the plural
 * multi-session shape was removed in v3 (tc-j9c.2).
 *
 * Focus state (active pane/window) is carried separately in the `focus`
 * field to avoid scattering active-flag logic across two lists.
 */
export interface SnapshotMessage extends MessageBase {
  readonly type: "snapshot";
  /** The session-proxy's bound session. */
  readonly session: SnapshotSession;
  /** All windows in the bound session. */
  readonly windows: readonly SnapshotWindow[];
  /** All panes across all windows. */
  readonly panes: readonly SnapshotPane[];
  /**
   * Currently focused pane/window pair.
   * Both are null if no pane is focused (e.g. no windows exist).
   */
  readonly focus: {
    readonly paneId: PaneId | null;
    readonly windowId: WindowId | null;
  };
  /**
   * Number of session-proxy-protocol clients currently connected to the server at
   * the moment the snapshot was built.
   *
   * tc-1elae (Phase 2 — §11.4 tooltip): used by the VS Code status bar to
   * render "Attached clients: K". The value is static at snapshot time — it
   * reflects the count when the snapshot was sent, NOT a live-updating counter.
   * Live updates land in Phase 4 (tc-44wu0).
   *
   * Additive optional field — older clients that do not read this field are
   * unaffected (non-breaking per the versioning policy above).
   */
  readonly attachedClientCount?: number;
  /**
   * THIS client's own connectionId, assigned by the session-proxy when the
   * connection was accepted (tc-ozk.2).
   *
   * A client stores this and compares it against `origin.connectionId` on each
   * `pane.opened` / `window.added` to decide whether a creation is its own
   * (`===` ⇒ mine) versus foreign / another client's (`!==` or absent ⇒ not
   * mine). This is what makes bind-on-provenance a FIELD CHECK rather than a
   * stateful gate, including the multi-client case.
   *
   * Additive optional field — older clients that do not read it are unaffected.
   * Re-sent on every snapshot (including resync) so a reconnecting client always
   * re-learns its current connectionId.
   */
  readonly connectionId?: ConnectionId;
}

// ---------------------------------------------------------------------------
// Additional Deltas — window lifecycle (session-proxy→client)
// ---------------------------------------------------------------------------

/**
 * A new window was added to the bound session.
 * direction: session-proxy→client
 */
export interface WindowAddedMessage extends MessageBase {
  readonly type: "window.added";
  readonly windowId: WindowId;
  readonly name: string;
  /**
   * True if the new window immediately became the active window in the session.
   * Clients may use this to avoid a separate focus event.
   */
  readonly active: boolean;
  /**
   * Causality tag (tc-ozk.2). PRESENT when this window was created by a wire
   * verb (open-window, or the new window break-pane re-homes a pane into):
   * names the connection + requestId that caused it. ABSENT when foreign
   * (native client, script). Additive optional field that supersedes the bare
   * `created` flag (tc-3y8.2). See {@link Origin}.
   */
  readonly origin?: Origin;
}

/**
 * A window was closed (all its panes exited or it was explicitly destroyed).
 * direction: session-proxy→client
 */
export interface WindowClosedMessage extends MessageBase {
  readonly type: "window.closed";
  readonly windowId: WindowId;
}

/**
 * A window was renamed.
 * direction: session-proxy→client
 */
export interface WindowRenamedMessage extends MessageBase {
  readonly type: "window.renamed";
  readonly windowId: WindowId;
  readonly newName: string;
}

// ---------------------------------------------------------------------------
// Additional Deltas — synchronize-panes state (session-proxy→client, tc-7xv.12)
// ---------------------------------------------------------------------------

/**
 * The synchronize-panes state of a window has changed.
 * direction: session-proxy→client
 *
 * Emitted by the session-proxy when `synchronize-panes` is toggled for a window —
 * either via a `set-synchronize-panes` command (tc-7xv.12, optimistic update)
 * or via a future reactive mechanism for out-of-band CLI changes.
 *
 * `on: true`  → broadcasting is active (all send-keys go to every pane).
 * `on: false` → normal per-pane targeting.
 *
 * tc-7xv.17 (b2b) consumes this delta to render the amber pill in the
 * window tree and to keep the window menu toggle in sync.
 *
 * Non-breaking additive delta — older clients that do not recognise this type
 * fall through to the `default` branch in `applyDelta` and ignore it.
 */
export interface WindowSyncChangedMessage extends MessageBase {
  readonly type: "window.sync.changed";
  readonly windowId: WindowId;
  /** True when synchronize-panes is on for this window. */
  readonly on: boolean;
}

// ---------------------------------------------------------------------------
// Additional Deltas — monitor-activity / monitor-silence state (tc-7xv.15)
// ---------------------------------------------------------------------------

/**
 * The monitor-activity state of a window has changed.
 * direction: session-proxy→client
 *
 * Emitted by the session-proxy when `monitor-activity` is toggled for a window via a
 * `set-monitor-activity` command (tc-7xv.15, optimistic update).
 *
 * `on: true`  → activity monitoring is active for this window.
 * `on: false` → activity monitoring is disabled.
 *
 * Non-breaking additive delta — older clients that do not recognise this type
 * fall through to the `default` branch in `applyDelta` and ignore it.
 */
export interface WindowMonitorActivityChangedMessage extends MessageBase {
  readonly type: "window.monitor.activity.changed";
  readonly windowId: WindowId;
  /** True when monitor-activity is on for this window. */
  readonly on: boolean;
}

/**
 * The monitor-silence state of a window has changed.
 * direction: session-proxy→client
 *
 * Emitted by the session-proxy when `monitor-silence` is toggled for a window via a
 * `set-monitor-silence` command (tc-7xv.15, optimistic update).
 *
 * `seconds > 0` → silence monitoring is active (fires after N seconds of no output).
 * `seconds === 0` → silence monitoring is disabled (tmux `monitor-silence 0` = off).
 *
 * Non-breaking additive delta — older clients that do not recognise this type
 * fall through to the `default` branch in `applyDelta` and ignore it.
 */
export interface WindowMonitorSilenceChangedMessage extends MessageBase {
  readonly type: "window.monitor.silence.changed";
  readonly windowId: WindowId;
  /**
   * Silence threshold in seconds (positive = on), or 0 when disabled.
   * Clients may treat 0 as "off" and any positive value as "on for N seconds".
   */
  readonly seconds: number;
}

// ---------------------------------------------------------------------------
// Additional Deltas — live pane title (session-proxy→client, tc-2mn8)
// ---------------------------------------------------------------------------

/**
 * The live shell window title of a pane has changed.
 * direction: session-proxy→client
 *
 * Emitted when the canonical `#{pane_title}` for a pane changes (tc-2mn8
 * introduced the delta; tc-s6ov.4 reworked the source). The session-proxy
 * sources the value from a control-mode `%*` `#{pane_title}` subscription,
 * which catches EVERY title source — shell OSC-0/2, another client's
 * `select-pane -T`, automatic title from `#{pane_current_command}` — and
 * supersedes the original in-stream OSC-0/2 `%output` sniff (which was blind
 * to out-of-band changes that never reached this client's `%output`).
 *
 * `title` is the new title string (may be an empty string when the title was
 * cleared).
 *
 * Consumer precedence for display:
 *   @tmuxcc_label (durable name) > pane.title-changed (live) > paneId (fallback)
 *
 * Non-breaking additive delta — older clients that do not recognise this type
 * fall through to the `default` branch in `applyDelta` and ignore it.
 */
export interface PaneTitleChangedMessage extends MessageBase {
  readonly type: "pane.title-changed";
  readonly paneId: PaneId;
  /** The new live shell window title. Empty string means the shell cleared it. */
  readonly title: string;
}

/**
 * A pane's durable policy/intent (cold-start.md §4.A) changed.
 * direction: session-proxy→client
 *
 * Carries the per-pane `@tmuxcc-*` user-options surfaced by the requery
 * (tc-i9aq.1):
 *   - `bound`  — binding intent (recreate a terminal on attach).
 *   - `detach` — RESOLVED close policy ("detach"|"kill"); absent = inherit (no
 *                scope set a policy).  The `#{@tmuxcc-detach}` format walks
 *                pane→window→session, so this is the effective first-wins value.
 *   - `icon`   — durable icon policy string; absent = no policy.
 *
 * Emitted either optimistically (the input-path injects `internal:set-pane-policy`
 * right after a `set-object-policy` command) or when a later requery re-reads the
 * options' new values.  A pane present in BOTH prev and next whose policy fields
 * differ gets a delta; absent fields mean that aspect returned to unset.
 *
 * Non-breaking additive delta — older clients that do not recognise this type
 * fall through to the `default` branch in `applyDelta` and ignore it.
 */
export interface PanePolicyChangedMessage extends MessageBase {
  readonly type: "pane.policy-changed";
  readonly paneId: PaneId;
  /** Binding intent: true when `@tmuxcc-bound` is set. */
  readonly bound: boolean;
  /** Resolved detach-on-close policy; absent when unset at every scope. */
  readonly detach?: "detach" | "kill";
  /** Durable icon policy; absent when unset. */
  readonly icon?: string;
}

// ---------------------------------------------------------------------------
// Additional Deltas — client-count changes (session-proxy→client, tc-44wu0)
// ---------------------------------------------------------------------------

/**
 * The number of session-proxy-protocol clients connected to this session has changed.
 * direction: session-proxy→client
 *
 * Sent by the ControlServer whenever a client connects or disconnects so that
 * every still-connected client can update its "Attached clients: K" tooltip
 * line without waiting for the next snapshot (tc-44wu0 / ux-design.md [deleted; map: ux-design-v2 §8] §11.4).
 *
 * `count` is the authoritative connected-client count at the moment the event
 * is sent:
 *   - On connect  : count includes the newly-connected client (≥ 1).
 *   - On disconnect: count excludes the just-disconnected client (≥ 0).
 *
 * Non-breaking additive field — older clients that do not recognise this type
 * fall through to the `default` branch in `applyDelta` and ignore it.
 */
export interface ClientCountChangedMessage extends MessageBase {
  readonly type: "client-count.changed";
  /** Authoritative number of connected session-proxy-protocol clients. */
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Additional Deltas — session lifecycle (session-proxy→client)
// ---------------------------------------------------------------------------

/**
 * The bound session was renamed.
 * direction: session-proxy→client
 *
 * There is only one session on the session-proxy wire; no sessionId is needed.
 * The server-proxy wire emits its own ServerProxySessionRenamedMessage to server-proxy-wire
 * subscribers for the same rename event.
 *
 * Session creation and destruction are server-proxy-wire concerns. Session
 * destruction surfaces on the session-proxy wire as ErrorMessage{code:"session.unavailable"}.
 */
export interface SessionProxySessionRenamedMessage extends MessageBase {
  readonly type: "session.renamed";
  readonly newName: string;
}

// ---------------------------------------------------------------------------
// Additional Deltas — pane mode (session-proxy→client)
// ---------------------------------------------------------------------------

/**
 * Model-level pane mode.
 *
 * "normal"  — the pane is in its default interactive mode.
 * "copy"    — the pane is in copy/scroll mode (user is browsing history).
 * "view"    — the pane output is being viewed in a pager-like mode.
 *
 * The type is open-ended (`string & {}`) so future modes can be added without
 * a breaking schema change. Clients MUST treat unknown modes as opaque strings
 * and not crash; they may render them as "unknown mode".
 *
 * Note: tmux-internal copy-mode sub-states (vi vs emacs keybindings, cursor
 * position, etc.) are NOT represented here. This is a model-level signal only.
 */
export type PaneMode = "normal" | "copy" | "view" | (string & Record<never, never>);

/**
 * A pane entered or left a mode (e.g. entered copy mode, or returned to normal).
 * direction: session-proxy→client
 */
export interface PaneModeChangedMessage extends MessageBase {
  readonly type: "pane.mode-changed";
  readonly paneId: PaneId;
  readonly mode: PaneMode;
}

// ---------------------------------------------------------------------------
// Per-pane attach + hydration protocol (tc-295a.8 / tc-295a.9)
// ---------------------------------------------------------------------------

/**
 * A pane attach targeted a pane the session-proxy does not know about.
 * direction: session-proxy→client
 *
 * tc-295a.8 (W2.2): fail-loud, named error for the attach path. Distinct from
 * the generic `command.response` failure shape because `pane.attach` is NOT a
 * correlated `command.request` — it is a fire-and-forget client→session-proxy
 * intent message (and the session-proxy itself issues the attach internally for
 * the broker-forwarded primary pane). Surfacing this on the session-proxy wire
 * (per-pane vocabulary) rather than as a `command.response` keeps the broker's
 * own `pane.attach` response (sessions vocabulary) untouched.
 *
 * Operator policy (FAIL-LOUD): this is the visible signal an attach hit a
 * vanished pane. The session-proxy does NOT silently absorb the request.
 */
export interface PaneAttachFailedMessage extends MessageBase {
  readonly type: "pane.attach.failed";
  readonly paneId: PaneId;
  /** Always "pane.not-found" today; open-ended for forward compatibility. */
  readonly code: "pane.not-found" | (string & Record<never, never>);
  /** Human-readable error description (English, for logging/debugging). */
  readonly message: string;
}

/**
 * Sentinel: per-pane hydration is starting.
 * direction: session-proxy→client
 *
 * tc-295a.9 (W2.3): the session-proxy is about to deliver the clear-then-replay
 * hydration frame for `paneId` on the data plane. Between this message and the
 * matching `pane.hydration.end`, live `%output` bytes for `paneId` are QUEUED
 * by the driver (NOT interleaved with the hydration frame). After `end` the
 * queued bytes are replayed in arrival order and the pane returns to live
 * pass-through.
 *
 * The no-interleave guarantee is a DRIVER guarantee, not a client convention:
 * a client that ignores these sentinels still receives bytes in the correct
 * order (clear+replay, then queued live, then live). The sentinels exist so a
 * renderer MAY (e.g.) suppress a spinner or reset emulator state precisely at
 * the hydration boundary; correctness does not depend on the client acting.
 */
export interface PaneHydrationBeginMessage extends MessageBase {
  readonly type: "pane.hydration.begin";
  readonly paneId: PaneId;
}

/**
 * Sentinel: per-pane hydration is complete.
 * direction: session-proxy→client
 *
 * tc-295a.9 (W2.3): the clear-then-replay frame for `paneId` has been delivered
 * and any live bytes queued during the hydration window have been flushed. All
 * subsequent data-plane bytes for `paneId` are live output.
 */
export interface PaneHydrationEndMessage extends MessageBase {
  readonly type: "pane.hydration.end";
  readonly paneId: PaneId;
}

/**
 * Client requests that the session-proxy attach (validate + hydrate) a pane on
 * THIS connection.
 * direction: client→session-proxy
 *
 * tc-295a.8 (W2.2): two callers issue this —
 *   1. The broker-mediated first attach: the server-proxy forwards the target
 *      paneId, and the session-proxy issues the attach internally for the
 *      transport's primary pane immediately after the snapshot.
 *   2. Mid-connection re-hydration (the §1.4 bindNew flow): the client binds a
 *      new VS Code tab to an existing pane on an already-connected session and
 *      sends `pane.attach` to trigger hydration begin/bytes/end for THAT pane
 *      on the existing transport.
 *
 * On success the session-proxy emits `pane.hydration.begin` → (clear+replay on
 * the data plane) → `pane.hydration.end`. If the pane is not in the model the
 * session-proxy emits `pane.attach.failed{code:"pane.not-found"}` (fail-loud).
 *
 * Not correlated: there is no correlationId. The hydration sentinels (or the
 * failure message) ARE the response. This keeps the attach intent symmetric
 * whether it originates from the client or from the session-proxy's own
 * addClient path.
 */
export interface PaneAttachMessage extends MessageBase {
  readonly type: "pane.attach";
  readonly paneId: PaneId;
}

// ---------------------------------------------------------------------------
// Command request / response (client↔sessionProxy, correlated)
// ---------------------------------------------------------------------------

/**
 * Open a new window in the bound session.
 * The session-proxy chooses the pane id(s); the created window/pane ids arrive via
 * SessionProxyCommandResponseMessage on success (payload.windowId, payload.paneId).
 */
export interface OpenWindowCommand {
  readonly kind: "open-window";
  /** Optional name for the new window. If omitted the session-proxy picks one. */
  readonly name?: string;
  /**
   * Working directory for the first pane of the new window (`-c <dir>`).
   * Additive optional field — non-breaking per the versioning policy.
   * tc-cr4dz: set by the cold-start profile applicator after substitution.
   */
  readonly cwd?: string;
  /**
   * Shell command to run in the first pane of the new window.
   * Passed as a trailing argument to `new-window`.
   * Additive optional field — non-breaking per the versioning policy.
   * tc-cr4dz: set by the cold-start profile applicator after substitution.
   */
  readonly shellCommand?: string;
}

/**
 * Split an existing pane into two.
 * The new pane's id arrives in SessionProxyCommandResponseMessage on success (payload.paneId).
 */
export interface SplitPaneCommand {
  readonly kind: "split-pane";
  /**
   * The pane to split.  When absent, the session-proxy splits the current pane
   * (tmux's implicit target).  This is used by the cold-start profile
   * applicator (tc-cr4dz) when splitting a pane in a newly-created window
   * where the new window's first pane ID is not yet known.
   *
   * Additive optional field — non-breaking per the versioning policy.
   */
  readonly paneId?: PaneId;
  /** "horizontal" = side-by-side; "vertical" = stacked top-to-bottom. */
  readonly direction: "horizontal" | "vertical";
  /**
   * Working directory for the new pane (`-c <dir>`).
   * Additive optional field — non-breaking per the versioning policy.
   * tc-cr4dz: set by the cold-start profile applicator after substitution.
   */
  readonly cwd?: string;
  /**
   * Shell command to run in the new pane.
   * Passed as a trailing argument to `split-window`.
   * Additive optional field — non-breaking per the versioning policy.
   * tc-cr4dz: set by the cold-start profile applicator after substitution.
   */
  readonly shellCommand?: string;
}

/**
 * Close (kill) a pane. The session-proxy emits a pane.closed delta on success.
 */
export interface ClosePaneCommand {
  readonly kind: "close-pane";
  readonly paneId: PaneId;
}

/**
 * Rename a window. The session-proxy emits a window.renamed delta on success.
 */
export interface RenameWindowCommand {
  readonly kind: "rename-window";
  readonly windowId: WindowId;
  readonly name: string;
}

/**
 * Rename the bound tmux session.
 *
 * Issues `rename-session -t =<currentName> <newName>` in the session-proxy.
 * The session-proxy emits a `session.renamed` delta on success, which propagates
 * to all connected clients and updates all surfaces (tree, status bar, tab titles).
 *
 * The name must be non-empty; the session-proxy drops the command if empty
 * (fail-loud in the handler).
 *
 * Additive addition — tc-6gnc.9: resolves the tc-asyq.10 stub.
 */
export interface RenameSessionCommand {
  readonly kind: "rename-session";
  /** The new session name. Must be non-empty. */
  readonly name: string;
}

/**
 * Focus (select) a pane. The session-proxy emits a focus.changed delta on success.
 */
export interface SelectPaneCommand {
  readonly kind: "select-pane";
  readonly paneId: PaneId;
}

/**
 * Resize a pane. The session-proxy emits a pane.resized delta on success.
 * Distinct from ResizeRequestMessage (viewport-driven); this is an explicit
 * user-initiated resize command.
 */
export interface ResizePaneCommand {
  readonly kind: "resize-pane";
  readonly paneId: PaneId;
  readonly cols: number;
  readonly rows: number;
}

/**
 * tc-zna.3: Atomic per-window resize transaction for VS-Code-managed strips.
 *
 * The VS Code factory is the authoritative geometry source for "managed"
 * windows (windows whose tmux panes are mirrored 1:1 onto VS Code terminal
 * tabs in a single split group / strip).  When the strip changes — split
 * arrives, sash drag re-tiles, member promoted out — the factory aggregates
 * the new geometry and emits ONE ResizeManagedWindow transaction per window.
 *
 * The session-proxy translates this to a deterministic tmux command batch:
 *
 *   1. `set-window-option -t @<wid> window-size manual`
 *      (idempotent; switches the window out of "follow the smallest client"
 *       sizing into client-authoritative mode)
 *   2. `resize-window -t @<wid> -x <cols> -y <rows>`
 *   3. `resize-pane -t %<paneId> -x <cols> -y <rows>` for each pane in `panes`
 *
 * Batching is required: tmux processes each command independently, and a
 * naive sequence of per-pane refresh-client calls causes the geometry storm
 * the bead describes.  Issuing the window+pane resizes as one block bounds
 * the work tmux has to do per VS-Code-side dim change.
 *
 * The blanket `resize.request` (→ `refresh-client -C`) wire message remains
 * available for unmanaged paths (single-pane tabs, the editor-area / panel
 * viewport).  Managed windows use this command instead.
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface ResizeManagedWindowCommand {
  readonly kind: "resize-managed-window";
  readonly windowId: WindowId;
  /** Authoritative window dims (strip sum, separator-inclusive). */
  readonly cols: number;
  readonly rows: number;
  /** Per-pane dims for every pane in the strip. */
  readonly panes: ReadonlyArray<{
    readonly paneId: PaneId;
    readonly cols: number;
    readonly rows: number;
  }>;
}

/**
 * tc-pizl.9: Release VS-Code-managed `window-size manual` for a window that
 * has dropped from a managed strip to a single pane.
 *
 * When a bound 2-pane (or N-pane) strip loses a pane and only one pane
 * survives, the `resize-managed-window` path left tmux's `window-size manual`
 * set on the window.  With `manual` active the surviving pane is pinned to
 * the stale doubled/combined geometry — TUIs (e.g. `top`) read the oversized
 * `TIOCGWINSZ` and render at the wrong size.
 *
 * The session-proxy translates this command to:
 *   `set-window-option -u -t @<wid> window-size`
 * which resets the window's sizing policy to the global default (`latest` or
 * `largest`), allowing the surviving pane to resume tracking its tmux client.
 *
 * Additive addition — non-breaking per the versioning policy.  Older
 * session-proxies respond with `protocol.unknown-message`; the managed-strip
 * case requires a paired session-proxy that handles this command.
 */
export interface ReleaseManagedWindowCommand {
  readonly kind: "release-managed-window";
  readonly windowId: WindowId;
}

/**
 * One-shot pane text snapshot (tc-295a.11 / W3.3 / gap A1d).
 *
 * Requests the current scrollback text for a live pane in a single correlated
 * round-trip.  This REUSES the existing `capturePane` machinery from the
 * hydration path (runtime/hydration.ts) — it is the same tmux `capture-pane
 * -t %N -p -e -S - -E -` command the W2.2/W2.3 hydration path uses, but the
 * raw text is returned in the `command.response` payload instead of being
 * delivered as clear-then-replay bytes on the data plane.
 *
 * On success:   `command.response { result: { ok: true, payload: { text } } }`
 *               where `text` is the full UTF-8 scrollback string (LF-terminated
 *               lines, as tmux emits).  Clients that want CRLF can run their
 *               own LF→CRLF pass; the wire is the raw tmux output.
 *
 * On failure:   `command.response { result: { ok: false, code: "pane.not-found",
 *               message: "..." } }` — the pane is not in the model or the
 *               capture-pane call came back as %error (pane vanished between
 *               the model check and the capture reply).  FAIL-LOUD; the driver
 *               never returns a silent empty string.
 *
 * Extension consumer (E3.2): the VS Code extension switch that consumes this
 * command to kill the C15 out-of-band `tmux capture-pane` shell-out lives in
 * E3.2 — NOT this bead.  This bead adds the wire command + driver impl + tests.
 *
 * Additive addition — non-breaking per the versioning policy. Older session-proxies
 * respond with `protocol.unknown-message`; consumers may display a fallback.
 */
export interface PaneCaptureCommand {
  readonly kind: "pane.capture";
  readonly paneId: PaneId;
}

/**
 * Read-only diagnostics snapshot for the session-proxy (tc-x6l).
 *
 * Issued by debug surfaces to inspect runtime metrics without a side-effect.
 * The session-proxy responds with a `SessionProxyCommandResponseMessage` whose
 * `payload` carries a `SessionProxyInfoPayload`.
 *
 * Additive addition — non-breaking per the versioning policy. Older session-proxies
 * respond with `protocol.unknown-message`; debug clients may display a
 * "session-proxy does not support session-proxy.info" fallback.
 */
export interface SessionProxyInfoCommand {
  readonly kind: "session-proxy.info";
}

/**
 * Payload of a successful `session-proxy.info` response (tc-x6l).
 *
 * Contains runtime metrics in Prometheus text-exposition format plus
 * a snapshot of the storm alarm's current window state for attribution.
 */
export interface SessionProxyInfoPayload {
  /**
   * Prometheus text exposition of all per-session-proxy counters and histograms.
   *
   * Includes:
   *   - `topology_events_total{kind}` — per-kind topology notification counts.
   *   - `commands_issued_total` — south-side tmux commands issued.
   *   - `deltas_fanned_out_total{client}` — model-change deltas sent to clients.
   *   - `command_round_trip_seconds` — command latency histogram.
   */
  readonly metricsText: string;
  /**
   * Total topology events counted in the current sliding window
   * (default: last 5 seconds).
   */
  readonly stormWindowTotal: number;
  /**
   * Per-kind breakdown of events in the current sliding window.
   *
   * An object mapping notification kind (e.g. "layout-change") to the
   * count of events seen in the window. Useful for identifying which
   * event kind is responsible for a high storm rate.
   */
  readonly stormWindowBreakdown: Record<string, number>;
  /**
   * The configured storm alarm threshold (events in the window before an
   * alarm trips). Included for context when interpreting `stormWindowTotal`.
   */
  readonly stormThreshold: number;
}

/**
 * Kill the tmux session entirely.
 *
 * Used when `tmuxcc.killSessionOnLastWindowClose: true` (ux-design.md [deleted; map: ux-design-v2 §8] §13)
 * and the last window of the session is closed. The session-proxy emits
 * ErrorMessage{code:"session.unavailable"} and closes all client connections.
 *
 * Additive addition — non-breaking per the versioning policy
 * (new optional command kind; existing implementations silently drop unknown
 * command kinds per the forward-compatible `default` branch in input-path.ts).
 *
 * tc-91o: uses sessionName (string) rather than sessionId (SessionId) so the
 * session-proxy can pass the name directly to `kill-session -t =<name>` without a
 * fragile numeric-id mapping (tmux session numbers can be reshuffled).
 */
export interface KillSessionCommand {
  readonly kind: "kill-session";
  readonly sessionName: string;
}

/**
 * Toggle `synchronize-panes` for a window.
 * direction: client→session-proxy
 *
 * The session-proxy emits `set-option -wt @<N> synchronize-panes on|off` and, when the
 * hook detects the option change, pushes a `window.sync.changed` delta to all
 * connected clients (tc-7xv.12).
 *
 * `windowId` is the wire WindowId of the target window (e.g. "w3").
 * `on: true` enables broadcasting; `on: false` disables it.
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface SetSynchronizePanesCommand {
  readonly kind: "set-synchronize-panes";
  readonly windowId: WindowId;
  /** True to enable synchronize-panes; false to disable. */
  readonly on: boolean;
}

// ── tc-7xv.9: pane verbs ──────────────────────────────────────────────────

/**
 * Break a pane out of its window into a new window.
 * direction: client→session-proxy
 *
 * Corresponds to `break-pane -dP -s %<N>` (tc-6dof: `-s` names the SOURCE
 * pane; `-t` is the DESTINATION window).  The `-d` flag keeps the new
 * window in the background so VS Code's tab strip doesn't jump focus.
 *
 * The session-proxy will emit a window.added delta (new window) followed by
 * pane.opened (the pane in its new home).  The old window may emit
 * window.closed if it had only one pane.
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface BreakPaneCommand {
  readonly kind: "break-pane";
  readonly paneId: PaneId;
}

/**
 * Swap a pane with the most-recently-used (MRU) other pane.
 * direction: client→session-proxy
 *
 * When `targetPaneId` is absent the session-proxy calls `swap-pane -D`, which
 * rotates the active pane with the next pane in the window's layout — a
 * simple "swap with next" that requires no picker.  When `targetPaneId`
 * is supplied the session-proxy calls `swap-pane -s %<src> -t %<tgt>`.
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface SwapPaneCommand {
  readonly kind: "swap-pane";
  readonly paneId: PaneId;
  /** Optional explicit target pane.  When absent, rotates with -D. */
  readonly targetPaneId?: PaneId;
}

/**
 * Set the DURABLE, driver-owned pane name (tc-1a8z).
 * direction: client→session-proxy
 *
 * This is the CANONICAL user rename channel.  The session-proxy issues
 * `set-option -pt %N @tmuxcc_label <name>` — the per-pane tmux user-option — and
 * NEVER `select-pane -T`.  Setting only `@tmuxcc_label` keeps the durable name
 * in a SEPARATE channel from the volatile shell title (`pane_title`, tc-2mn8):
 * the shell's OSC-0/2 stream cannot clobber it, and it survives a driver
 * restart because canonical state lives with the pane in tmux (re-read from the
 * user-option on every requery).
 *
 * An empty `title` CLEARS the durable name (`set-option -pt %N @tmuxcc_label ''`
 * → the model's `label` returns to unset).
 *
 * The session-proxy injects an optimistic `internal:set-pane-label` event
 * (tc-7xv.37 reversal pattern) so the model updates immediately, then surfaces
 * the change as a `pane.label-changed` delta.  Render precedence (durable label
 * > live title > paneId) is the consumer's concern (tc-asyq.6).
 *
 * NOTE: the wire `kind` stays `"rename-pane"` and the field stays `title` for
 * shape stability, but the SEMANTICS are now the durable name, not a tmux pane
 * title.
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface RenamePaneCommand {
  readonly kind: "rename-pane";
  readonly paneId: PaneId;
  /** New durable pane name.  Empty string clears the durable name. */
  readonly title: string;
}
// ── tc-i9aq.1: durable object-policy/intent write (cold-start.md §4.A/§6.1) ──

/**
 * Write a durable per-object policy/intent `@tmuxcc-*` user-option.
 * direction: client→session-proxy
 *
 * This is the SOLE channel by which the extension's policy layer makes durable
 * per-object state changes (cold-start.md §6.1: "the extension never shells out
 * to tmux" — it issues this verb; the driver runs the `set-option`).  The
 * change reappears in the next requery as canonical state (one fact, one owner).
 *
 * Scopes (tmux does not inherit user-options across scopes; the extension
 * resolves the cascade host-side):
 *   - `"pane"`    → `set-option -pt %N <option> <value>` (target = `paneId`).
 *   - `"window"`  → `set-option -wt @N <option> <value>` (target = `windowId`).
 *   - `"session"` → `set-option -t <session-name> <option> <value>` (the bound
 *                   session, resolved by name from the model — tmux 3.4 rejects
 *                   the `-t =` current-session sigil here; the session-proxy is
 *                   bound to exactly one session for its lifetime).
 *
 * Options (cold-start.md §4.A):
 *   - `"bound"`  (pane)                 — binding intent.
 *   - `"detach"` (pane/window/session)  — detach-on-close policy.
 *   - `"icon"`   (pane)                 — icon policy.
 * (The durable name `@tmuxcc-name` is the pre-existing `@tmuxcc_label`, written
 * via `rename-pane`; it is NOT routed through this verb.)
 *
 * `value: null` CLEARS the option (`set-option -u`), which the requery maps back
 * to unset.  A non-null string sets it.  The session-proxy injects an optimistic
 * `internal:set-pane-policy` event for pane-scope writes (the model + the
 * `pane.policy-changed` delta update immediately) with %error reversal; window /
 * session writes reconcile on the next requery (their values surface as the
 * RESOLVED pane `detach`).
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface SetObjectPolicyCommand {
  readonly kind: "set-object-policy";
  /** Object scope the option is written at. */
  readonly scope: "pane" | "window" | "session";
  /** Target pane id (scope "pane"). */
  readonly paneId?: PaneId;
  /** Target window id (scope "window"). */
  readonly windowId?: WindowId;
  /** Which `@tmuxcc-*` option to write. */
  readonly option: "bound" | "detach" | "icon";
  /** New value, or null to clear (unset) the option. */
  readonly value: string | null;
}

// ── tc-7xv.15: monitor-activity / monitor-silence commands ──────────────────

/**
 * Set `monitor-activity` for a window.
 * direction: client→session-proxy
 *
 * The session-proxy emits `set-option -wt @<N> monitor-activity on|off` and injects
 * an optimistic `internal:set-window-monitor-activity` event to update the
 * model immediately (tc-7xv.15).
 *
 * `windowId` is the wire WindowId of the target window (e.g. "w3").
 * `on: true` enables activity monitoring; `on: false` disables it.
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface SetMonitorActivityCommand {
  readonly kind: "set-monitor-activity";
  readonly windowId: WindowId;
  /** True to enable monitor-activity; false to disable. */
  readonly on: boolean;
}

/**
 * Set `monitor-silence` for a window.
 * direction: client→session-proxy
 *
 * The session-proxy emits `set-option -wt @<N> monitor-silence <seconds>` (when
 * enabling) or `set-option -wt @<N> monitor-silence 0` (when disabling) and
 * injects an optimistic `internal:set-window-monitor-silence` event (tc-7xv.15).
 *
 * `windowId` is the wire WindowId of the target window (e.g. "w3").
 * `seconds`: positive number to enable silence monitoring after that many
 *   seconds of inactivity; 0 or null to disable.
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface SetMonitorSilenceCommand {
  readonly kind: "set-monitor-silence";
  readonly windowId: WindowId;
  /**
   * Silence threshold in seconds (1..N to enable), or 0/null to disable.
   * tmux interprets `monitor-silence 0` as "off".
   */
  readonly seconds: number | null;
}

// ── tc-7xv.18: window verbs ──────────────────────────────────────────────────

/**
 * Kill a tmux window and all its panes.
 *
 * Issues `kill-window -t @<N>` in the bound session.
 * The session-proxy emits window.removed + pane.closed deltas for each affected pane.
 *
 * `windowId` is the wire WindowId of the window to kill (e.g. "w2").
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface KillWindowCommand {
  readonly kind: "kill-window";
  readonly windowId: WindowId;
}

/**
 * Swap two windows within the session.
 *
 * Issues `swap-window -s @<S> -t @<T>`.
 * Positions are exchanged; no panes are closed.  The mirror will emit
 * window.reordered (or equivalent) deltas reflecting the new order.
 *
 * `sourceWindowId` is the window to move; `targetWindowId` is the destination
 * slot.  Both must exist in the bound session.
 *
 * Additive addition — non-breaking per the versioning policy.
 */
export interface SwapWindowCommand {
  readonly kind: "swap-window";
  readonly sourceWindowId: WindowId;
  readonly targetWindowId: WindowId;
}

// ── end tc-7xv.18 ──────────────────────────────────────────────────────────

/**
 * Discriminated union of all model-level commands a client may issue.
 * Narrow with `cmd.kind` to get the specific shape.
 *
 * All commands are model-level — no raw tmux command strings are exposed.
 * The session-proxy translates each command kind to the appropriate tmux operation
 * internally (south-side boundary). The E4 session-proxy runtime implements the
 * actual tmux side; this is the wire shape only.
 *
 * All commands operate within the bound session. None carry sessionId.
 */
export type WireCommand =
  | OpenWindowCommand
  | SplitPaneCommand
  | ClosePaneCommand
  | RenameWindowCommand
  // tc-6gnc.9: rename the bound tmux session
  | RenameSessionCommand
  | SelectPaneCommand
  | ResizePaneCommand
  | KillSessionCommand
  | SetSynchronizePanesCommand
  // tc-7xv.15: monitor-activity / monitor-silence
  | SetMonitorActivityCommand
  | SetMonitorSilenceCommand
  // tc-7xv.9: pane verbs
  | BreakPaneCommand
  | SwapPaneCommand
  | RenamePaneCommand
  // tc-i9aq.1: durable object-policy/intent write (cold-start.md §4.A)
  | SetObjectPolicyCommand
  // tc-7xv.18: window verbs
  | KillWindowCommand
  | SwapWindowCommand
  // tc-zna.3: VS-Code-authoritative managed-window resize transaction
  | ResizeManagedWindowCommand
  // tc-pizl.9: release manual window-size on strip→single-pane teardown
  | ReleaseManagedWindowCommand
  // tc-x6l: read-only diagnostics + metrics
  | SessionProxyInfoCommand
  // tc-295a.11: one-shot pane text snapshot (kills C15 third authority)
  | PaneCaptureCommand;

/**
 * Client issues a model-level command to the session-proxy.
 * direction: client→session-proxy
 *
 * `correlationId` is a client-generated opaque string (e.g. a UUID or
 * monotonic counter string) that the session-proxy echoes back in
 * `SessionProxyCommandResponseMessage`. Clients use it to match responses to outstanding
 * requests. The session-proxy does NOT assign correlation ids.
 */
export interface SessionProxyCommandRequestMessage extends MessageBase {
  readonly type: "command.request";
  /** Client-generated opaque string, echoed in the matching response. */
  readonly correlationId: string;
  /** The model operation to perform. */
  readonly command: WireCommand;
}

/**
 * Successful command result payload. Fields are optional because not every
 * command produces a new entity.
 *
 * tc-ozk.1: the pane/window-CREATING verbs RETURN their effect ids here —
 * split-pane → {paneId, windowId}, open-window → {paneId, windowId},
 * break-pane → {paneId (re-homed), windowId (new)}.  The session-proxy recovers
 * them from tmux's `-P -F '#{pane_id} #{window_id}'` reply (it no longer infers
 * the ids from a later %window-add / %layout-change notification).  The host
 * binds by these returned ids the moment the pane materialises — the verb reply
 * may arrive before OR after the pane's pane.opened delta, so binding is by id,
 * never by ordering, and needs no observer/claim correlation.
 *
 * tc-x6l: `info` carries the `session-proxy.info` diagnostic payload.
 *
 * tc-295a.11: `text` carries the captured pane text for `pane.capture` responses.
 */
export interface SessionProxyCommandOkPayload {
  readonly windowId?: WindowId;
  readonly paneId?: PaneId;
  /** session-proxy.info diagnostics payload (tc-x6l). Present only in session-proxy.info responses. */
  readonly info?: SessionProxyInfoPayload;
  /**
   * Captured pane text for `pane.capture` responses (tc-295a.11 / W3.3).
   *
   * Full UTF-8 scrollback string as tmux emits it: rows separated by bare LF
   * (`\n`).  Clients that need CRLF can apply their own LF→CRLF pass — the
   * wire carries the raw tmux output so callers can choose their own rendering.
   * Present only in `pane.capture` command responses; absent otherwise.
   */
  readonly text?: string;
}

/**
 * The session-proxy's response to a SessionProxyCommandRequestMessage.
 * direction: session-proxy→client
 *
 * Error handling: command-specific failures (unknown pane, invalid size,
 * permission denied) arrive HERE as `result.ok = false`. The separate
 * `ErrorMessage` (type: "error") is for UNSOLICITED / protocol-level errors
 * (malformed message, unknown message type, session in bad state) where there
 * is no in-flight command to correlate. If a failure is attributable to a
 * specific command request, the error comes in SessionProxyCommandResponseMessage, not
 * ErrorMessage. This keeps the contract simple: command.request always gets
 * exactly one command.response.
 */
export interface SessionProxyCommandResponseMessage extends MessageBase {
  readonly type: "command.response";
  /** Echoed from the matching SessionProxyCommandRequestMessage. */
  readonly correlationId: string;
  /** Discriminated result: success or failure. */
  readonly result:
    | { readonly ok: true; readonly payload?: SessionProxyCommandOkPayload }
    | { readonly ok: false; readonly code: string; readonly message: string };
}

// ---------------------------------------------------------------------------
// Error — unsolicited / protocol-level errors (session-proxy→client)
// ---------------------------------------------------------------------------

/**
 * SessionProxy-level error codes.
 *
 * "protocol.unknown-message"   — the session-proxy received a message type it does not
 *                                recognise; the message was dropped.
 * "protocol.malformed"         — the session-proxy could not parse the message
 *                                (e.g. missing required field, wrong type).
 * "protocol.version-mismatch"  — protocol version negotiation failed.
 * "session.unavailable"        — the tmux session the connection was bound to
 *                                has gone away unexpectedly, or a switch-client
 *                                caused the bound session to disappear.
 * "internal"                   — unexpected session-proxy-side error not attributable
 *                                to a specific command.
 *
 * The type is open-ended for forward compatibility.
 */
export type WireErrorCode =
  | "protocol.unknown-message"
  | "protocol.malformed"
  | "protocol.version-mismatch"
  | "session.unavailable"
  | "internal"
  | (string & Record<never, never>);

/**
 * Unsolicited error pushed by the session-proxy.
 * direction: session-proxy→client
 *
 * ONLY for errors that are NOT attributable to a specific outstanding
 * SessionProxyCommandRequestMessage. If the error IS attributable to a command, the session-proxy
 * sends a SessionProxyCommandResponseMessage with `result.ok = false` instead.
 *
 * `correlationId` is OPTIONAL: if present, it ties the error to an earlier
 * command request that the session-proxy is now aborting without a normal response
 * (e.g. the session died mid-execution). If absent, the error is fully
 * unsolicited (e.g. protocol parse failure on an unrelated frame).
 *
 * Clients SHOULD display or log the `message` and MAY use `code` to trigger
 * specific recovery logic. After "protocol.version-mismatch" or
 * "session.unavailable", the client should consider the connection dead.
 */
export interface ErrorMessage extends MessageBase {
  readonly type: "error";
  readonly code: WireErrorCode;
  /** Human-readable error description (English, for logging/debugging). */
  readonly message: string;
  /** If set, ties this error to a prior SessionProxyCommandRequestMessage. */
  readonly correlationId?: string;
}

// ---------------------------------------------------------------------------
// Client → SessionProxy messages (client requests)
// ---------------------------------------------------------------------------

/**
 * Client sends text/key input destined for a pane.
 * direction: client→session-proxy
 *
 * Input is represented as a UTF-8 string. The session-proxy forwards this to the
 * pane's pty without tmux-level interpretation (NOT tmux send-keys syntax;
 * the session-proxy writes bytes directly). Special keys (e.g. escape sequences)
 * should be pre-encoded by the client as their byte sequences before sending.
 *
 * Rationale for string vs Uint8Array: the control plane is structured text
 * (JSON-serializable). Raw byte streams go through the data plane (tc-2mq).
 * Input here is typically short key-sequences or pasted text — UTF-8 strings
 * cover this well and remain JSON-serializable.
 */
export interface InputMessage extends MessageBase {
  readonly type: "input";
  readonly paneId: PaneId;
  /** UTF-8 text to write to the pane's stdin. */
  readonly data: string;
}

/**
 * Client requests that a pane be resized.
 * direction: client→session-proxy
 *
 * The client sends this when the host viewport changes (e.g. VS Code pane
 * resized). The session-proxy applies the resize to tmux and then emits a
 * PaneResizedMessage (session-proxy→client) confirming the new dimensions.
 */
export interface ResizeRequestMessage extends MessageBase {
  readonly type: "resize.request";
  readonly paneId: PaneId;
  readonly cols: number;
  readonly rows: number;
}

/**
 * Client's capabilities advertisement (sent once at handshake time).
 * direction: client→sessionProxy (and client→serverProxy)
 *
 * This message type is shared between both wires — the same `type:
 * "client.capabilities"` discriminant is used on both the server-proxy wire and
 * the session-proxy wire (each connection sends this once at handshake).
 *
 * The handshake sequence is defined by bead tc-auj; this is just the shape.
 */
export interface ClientCapabilitiesMessage extends MessageBase {
  readonly type: "client.capabilities";
  readonly capabilities: Capabilities;
}

/**
 * Client requests that the session-proxy re-send a full snapshot for this connection.
 * direction: client→session-proxy
 *
 * Sent when the mirror detects a seq gap (a delta was dropped in transit) and
 * needs to re-establish a consistent baseline. No payload is required — the
 * connection identity is implicit in the transport.
 *
 * SessionProxy response: re-sends a SnapshotMessage at the next per-connection seq.
 * The session-proxy does NOT reset its seq counter; subsequent deltas continue from
 * the seq that follows the re-sent snapshot.
 *
 * Client policy (tc-7ml.4):
 *   1. On gap detect: set an in-flight `resyncRequested` flag; send this
 *      message once.
 *   2. On snapshot arrival: clear the flag (resync complete).
 *   3. While the flag is set: ignore further gap signals (dedup).
 *   4. If a gap is still present AFTER the snapshot delivers (persistent gap):
 *      escalate to `transport.close()` — the reconnect path handles the rest.
 *
 * Added in protocol v2 (tc-7ml.4). A v1 session-proxy receiving this message will
 * treat it as an unknown type; both sides must be v2+ for resync to work.
 * The exact-version handshake enforces this.
 */
export interface ResyncRequestMessage extends MessageBase {
  readonly type: "resync.request";
}

// ---------------------------------------------------------------------------
// Union types — the top-level discriminated unions
// ---------------------------------------------------------------------------

/**
 * All messages the session-proxy pushes to the client.
 * Narrow with `msg.type` to get the specific shape.
 *
 * Grouped by family:
 *   Capabilities:  SessionProxyCapabilitiesMessage
 *   Snapshot:      SnapshotMessage
 *   Pane deltas:   PaneOpenedMessage | PaneClosedMessage | PaneResizedMessage | PaneModeChangedMessage | PaneLabelChangedMessage | PaneTitleChangedMessage
 *   Window deltas: WindowAddedMessage | WindowClosedMessage | WindowRenamedMessage | WindowSyncChangedMessage | WindowMonitorActivityChangedMessage | WindowMonitorSilenceChangedMessage
 *   Layout deltas: LayoutUpdatedMessage
 *   Focus deltas:  FocusChangedMessage
 *   Session delta: SessionProxySessionRenamedMessage
 *   Client delta:  ClientCountChangedMessage
 *   Commands:      SessionProxyCommandResponseMessage
 *   Errors:        ErrorMessage
 */
export type SessionProxyMessage =
  // Capabilities
  | SessionProxyCapabilitiesMessage
  // Snapshot
  | SnapshotMessage
  // Pane deltas
  | PaneOpenedMessage
  | PaneClosedMessage
  | PaneResizedMessage
  | PaneModeChangedMessage
  // Durable pane-name delta (tc-1a8z)
  | PaneLabelChangedMessage
  // Dead-pane state delta (tc-4bv2 / tc-295a.10)
  | PaneDeadChangedMessage
  // Live shell title delta (tc-2mn8)
  | PaneTitleChangedMessage
  // Durable policy/intent delta (tc-i9aq.1, cold-start.md §4.A)
  | PanePolicyChangedMessage
  // Window deltas
  | WindowAddedMessage
  | WindowClosedMessage
  | WindowRenamedMessage
  // Sync-panes delta (tc-7xv.12)
  | WindowSyncChangedMessage
  // Monitor deltas (tc-7xv.15)
  | WindowMonitorActivityChangedMessage
  | WindowMonitorSilenceChangedMessage
  // Layout deltas
  | LayoutUpdatedMessage
  // Focus deltas
  | FocusChangedMessage
  // Session delta (only rename survives in the session-proxy wire)
  | SessionProxySessionRenamedMessage
  // Client-count delta (tc-44wu0)
  | ClientCountChangedMessage
  // Per-pane attach + hydration protocol (tc-295a.8 / tc-295a.9)
  | PaneAttachFailedMessage
  | PaneHydrationBeginMessage
  | PaneHydrationEndMessage
  // Command responses
  | SessionProxyCommandResponseMessage
  // Unsolicited errors
  | ErrorMessage;

/**
 * All messages the client sends to the session-proxy.
 * Narrow with `msg.type` to get the specific shape.
 */
export type ClientMessage =
  | InputMessage
  | ResizeRequestMessage
  | ClientCapabilitiesMessage
  | SessionProxyCommandRequestMessage
  | ResyncRequestMessage
  // Per-pane attach (tc-295a.8)
  | PaneAttachMessage;

/**
 * Any control-plane message (either direction) on the session-proxy wire.
 * Useful for generic transport code that doesn't care about direction.
 */
export type ControlMessage = SessionProxyMessage | ClientMessage;

// ---------------------------------------------------------------------------
// Type guards — runtime narrowing without external schema libraries.
// ---------------------------------------------------------------------------

/** Narrows a ControlMessage to a specific session-proxy→client message type. */
export function isSessionProxyMessage(msg: ControlMessage): msg is SessionProxyMessage {
  const t = msg.type;
  return (
    // Capabilities
    t === "session-proxy.capabilities" ||
    // Snapshot
    t === "snapshot" ||
    // Pane deltas
    t === "pane.opened" ||
    t === "pane.closed" ||
    t === "pane.resized" ||
    t === "pane.mode-changed" ||
    t === "pane.dead-changed" ||
    // Durable pane name delta (tc-1a8z)
    t === "pane.label-changed" ||
    // Live shell title delta (tc-2mn8)
    t === "pane.title-changed" ||
    // Window deltas
    t === "window.added" ||
    t === "window.closed" ||
    t === "window.renamed" ||
    // Sync-panes delta (tc-7xv.12)
    t === "window.sync.changed" ||
    // Monitor deltas (tc-7xv.15)
    t === "window.monitor.activity.changed" ||
    t === "window.monitor.silence.changed" ||
    // Layout deltas
    t === "layout.updated" ||
    // Focus deltas
    t === "focus.changed" ||
    // Session delta
    t === "session.renamed" ||
    // Client-count delta (tc-44wu0)
    t === "client-count.changed" ||
    // Per-pane attach + hydration protocol (tc-295a.8 / tc-295a.9)
    t === "pane.attach.failed" ||
    t === "pane.hydration.begin" ||
    t === "pane.hydration.end" ||
    // Command responses
    t === "command.response" ||
    // Unsolicited errors
    t === "error"
  );
}

/** Narrows a ControlMessage to a specific client→session-proxy message type. */
export function isClientMessage(msg: ControlMessage): msg is ClientMessage {
  const t = msg.type;
  return (
    t === "input" ||
    t === "resize.request" ||
    t === "client.capabilities" ||
    t === "command.request" ||
    t === "resync.request" ||
    // Per-pane attach (tc-295a.8)
    t === "pane.attach"
  );
}

// ---------------------------------------------------------------------------
// Backward-compatible type aliases
// ---------------------------------------------------------------------------

/**
 * @deprecated Use SessionProxyCommandRequestMessage. Kept for transition period.
 */
export type CommandRequestMessage = SessionProxyCommandRequestMessage;

/**
 * @deprecated Use SessionProxyCommandResponseMessage. Kept for transition period.
 */
export type CommandResponseMessage = SessionProxyCommandResponseMessage;

/**
 * @deprecated Use SessionProxyCommandOkPayload. Kept for transition period.
 */
export type CommandOkPayload = SessionProxyCommandOkPayload;
