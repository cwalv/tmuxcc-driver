/**
 * tmux -CC notification semantic parser.
 *
 * Parses `NotificationToken`s emitted by the tokenizer into a typed
 * discriminated-union of notification events. This is SOUTH-facing — it
 * interprets tmux's control-mode notification vocabulary; no I/O.
 *
 * # Notification formats (verified against tmux control-notify.c / control.c)
 *
 * ## Output
 *   %output %<pane> <octal-escaped-payload>
 *   %extended-output %<pane> <age_ms> : <octal-escaped-payload>
 *
 * The payload is octal-escaped (characters < 0x20 or '\\' are written as
 * \NNN). Decoding is the responsibility of tc-8yz (output-codec.ts). This
 * module emits the raw payload bytes and documents the integration point.
 *
 * ## Window
 *   %window-add @<win>
 *   %window-close @<win>
 *   %unlinked-window-add @<win>
 *   %unlinked-window-close @<win>
 *   %window-renamed @<win> <name>          (name may contain spaces)
 *   %unlinked-window-renamed @<win> <name>
 *   %window-pane-changed @<win> %<pane>
 *
 * ## Session
 *   %session-changed $<sess> <name>
 *   %client-session-changed <client> $<sess> <name>
 *   %session-renamed $<sess> <name>
 *   %sessions-changed
 *   %session-window-changed $<sess> @<win>
 *
 * ## Pane
 *   %pane-mode-changed %<pane>
 *
 * ## Subscription
 *   %subscription-changed <name> $<sess> @<win> <idx> %<pane> : <value>
 *   %subscription-changed <name> $<sess> @<win> <idx> - : <value>
 *   %subscription-changed <name> $<sess> - - - : <value>
 *   (session-level subscription; window/pane fields are "-" when absent)
 *
 * ## Flow control
 *   %pause %<pane>
 *   %continue %<pane>
 *
 * ## Lifecycle
 *   %exit [reason]   (reason is optional — may be absent)
 *
 * ## Unknown
 *   Any other %-keyword → UnknownNotification (never fatal).
 *
 * # ID conventions
 *   %N  → pane   (paneId: number)
 *   @N  → window (windowId: number)
 *   $N  → session (sessionId: number)
 * IDs are stored as plain numbers without the sigil.
 *
 * @module parser/notifications
 */
import type { NotificationToken } from "./tokenizer.js";
import type { WindowId, PaneId } from "@tmuxcc/protocol";
/**
 * %output %<pane> <payload>
 *
 * `rawPayload` is the octal-escaped payload bytes exactly as received from
 * tmux (the suffix of the rawLine after `%output %N `). To get decoded
 * terminal bytes, run through tc-8yz's `decodeOutputPayload()` at the
 * integration point.
 *
 * NOTE (tc-wvu): tc-8yz (output-codec.ts) is a concurrent bead. At TL
 * reconcile time the integration point wires `rawPayload` through
 * `decodeOutputPayload`. This module emits raw bytes to keep the codec in
 * one place and avoid duplicate divergent implementations.
 */
export interface OutputNotification {
    readonly kind: "output";
    readonly paneId: number;
    /** Raw octal-escaped payload; decode via tc-8yz output-codec.ts. */
    readonly rawPayload: Uint8Array;
}
/**
 * %extended-output %<pane> <age_ms> : <payload>
 *
 * Same payload convention as OutputNotification. `ageMs` is the age of the
 * data in milliseconds (tmux reports microseconds as %llu; iTerm2 divides
 * by 1000 — we keep milliseconds).
 *
 * The `: ` separator between age and payload is a fixed delimiter (any
 * fields added by future tmux versions appear between `age_ms` and `: `).
 * We skip unknown intermediate fields by scanning for ` : ` (space-colon-space).
 */
export interface ExtendedOutputNotification {
    readonly kind: "extended-output";
    readonly paneId: number;
    /** Age of the data in milliseconds (from tmux's microsecond counter). */
    readonly ageMs: bigint;
    /** Raw octal-escaped payload; decode via tc-8yz output-codec.ts. */
    readonly rawPayload: Uint8Array;
}
/**
 * %window-add @<win>
 * %unlinked-window-add @<win>
 */
export interface WindowAddNotification {
    readonly kind: "window-add";
    readonly windowId: number;
    /** True when the keyword was %unlinked-window-add. */
    readonly unlinked: boolean;
}
/**
 * %window-close @<win>
 * %unlinked-window-close @<win>
 */
export interface WindowCloseNotification {
    readonly kind: "window-close";
    readonly windowId: number;
    readonly unlinked: boolean;
}
/**
 * %window-renamed @<win> <name>
 * %unlinked-window-renamed @<win> <name>
 * Name may contain spaces — rest-of-line after the window id.
 */
export interface WindowRenamedNotification {
    readonly kind: "window-renamed";
    readonly windowId: number;
    readonly name: string;
    readonly unlinked: boolean;
}
/**
 * %window-pane-changed @<win> %<pane>
 */
export interface WindowPaneChangedNotification {
    readonly kind: "window-pane-changed";
    readonly windowId: number;
    readonly paneId: number;
}
/**
 * %session-changed $<sess> <name>
 */
export interface SessionChangedNotification {
    readonly kind: "session-changed";
    readonly sessionId: number;
    readonly name: string;
}
/**
 * %client-session-changed <client> $<sess> <name>
 */
export interface ClientSessionChangedNotification {
    readonly kind: "client-session-changed";
    readonly clientName: string;
    readonly sessionId: number;
    readonly name: string;
}
/**
 * %session-renamed $<sess> <name>
 * (tmux ≥3.x; older versions may omit $id — handled gracefully by treating
 * the entire argument as the name if the first token doesn't start with $.)
 */
export interface SessionRenamedNotification {
    readonly kind: "session-renamed";
    readonly sessionId: number | null;
    readonly name: string;
}
/**
 * %sessions-changed
 * No arguments; signals any session list change.
 */
export interface SessionsChangedNotification {
    readonly kind: "sessions-changed";
}
/**
 * %session-window-changed $<sess> @<win>
 */
export interface SessionWindowChangedNotification {
    readonly kind: "session-window-changed";
    readonly sessionId: number;
    readonly windowId: number;
}
/**
 * %pane-mode-changed %<pane>
 */
export interface PaneModeChangedNotification {
    readonly kind: "pane-mode-changed";
    readonly paneId: number;
}
/**
 * %subscription-changed <name> $<sess> @<win>|"-" <idx>|"-" %<pane>|"-" : <value>
 *
 * The window/idx/pane fields are "-" when not applicable to the subscription
 * type (session-level subscriptions omit window/pane context; window-level
 * subscriptions omit pane). We represent absent fields as null.
 */
export interface SubscriptionChangedNotification {
    readonly kind: "subscription-changed";
    /** Subscription name as registered by the client. */
    readonly name: string;
    readonly sessionId: number;
    readonly windowId: number | null;
    /** Winlink index within the session (present when windowId is present). */
    readonly windowIdx: number | null;
    readonly paneId: number | null;
    /** The formatted value (everything after `: `). */
    readonly value: string;
}
/**
 * %pause %<pane>
 */
export interface PauseNotification {
    readonly kind: "pause";
    readonly paneId: number;
}
/**
 * %continue %<pane>
 */
export interface ContinueNotification {
    readonly kind: "continue";
    readonly paneId: number;
}
/**
 * %exit [reason]
 * Reason is optional. When present it is a human-readable string.
 */
export interface ExitNotification {
    readonly kind: "exit";
    readonly reason: string | null;
}
/**
 * Any %-keyword not matched above. Never fatal — graceful degradation.
 */
export interface UnknownNotification {
    readonly kind: "unknown";
    readonly keyword: string;
    readonly rawLine: Uint8Array;
}
/**
 * Synthetic internal event: the session-proxy applied a set-synchronize-panes command
 * (optimistic) and is now updating the model.
 *
 * This event is NEVER parsed from tmux control-mode output — it is injected by
 * input-path.ts (tc-7xv.12) on two occasions:
 *
 *   1. After sending `set-option -wt @N synchronize-panes on|off`, with the
 *      newly requested value (optimistic apply).
 *   2. If tmux subsequently replies with %error, with the captured before-value
 *      (compensating reversal — tc-7xv.37).
 */
export interface InternalWindowSyncSetNotification {
    readonly kind: "internal:set-window-sync";
    readonly windowId: WindowId;
    readonly on: boolean;
}
/**
 * Synthetic internal event: the session-proxy applied a set-monitor-activity command
 * (optimistic) and is now updating the model.
 *
 * This event is NEVER parsed from tmux control-mode output — it is injected by
 * input-path.ts (tc-7xv.15) on two occasions:
 *
 *   1. After sending `set-option -wt @N monitor-activity on|off` with the new
 *      value (optimistic apply).
 *   2. If tmux subsequently replies with %error, with the captured before-value
 *      (compensating reversal — tc-7xv.37).
 */
export interface InternalWindowMonitorActivitySetNotification {
    readonly kind: "internal:set-window-monitor-activity";
    readonly windowId: WindowId;
    readonly on: boolean;
}
/**
 * Synthetic internal event: the session-proxy applied a set-monitor-silence command
 * (optimistic) and is now updating the model.
 *
 * This event is NEVER parsed from tmux control-mode output — it is injected by
 * input-path.ts (tc-7xv.15) on two occasions:
 *
 *   1. After sending `set-option -wt @N monitor-silence <seconds|0>` with the
 *      new value (optimistic apply).  `seconds === 0` means disabled (tmux
 *      `monitor-silence 0` = off).
 *   2. If tmux subsequently replies with %error, with the captured before-value
 *      (compensating reversal — tc-7xv.37).
 */
export interface InternalWindowMonitorSilenceSetNotification {
    readonly kind: "internal:set-window-monitor-silence";
    readonly windowId: WindowId;
    /** 0 means disabled; positive values are the threshold in seconds. */
    readonly seconds: number;
}
/**
 * Synthetic internal event: the session-proxy applied a `rename-pane` command
 * (optimistic) and is now updating the durable pane name (tc-1a8z).
 *
 * This event is NEVER parsed from tmux control-mode output — it is injected by
 * input-path.ts on two occasions:
 *
 *   1. After sending `set-option -pt %N @tmuxcc_label <name>` with the new
 *      value (optimistic apply).  `label === undefined` means the durable name
 *      was cleared (empty rename → `set-option -pt %N @tmuxcc_label ''`).
 *   2. If tmux subsequently replies with %error, with the captured before-value
 *      (compensating reversal — tc-7xv.37).
 */
export interface InternalPaneLabelSetNotification {
    readonly kind: "internal:set-pane-label";
    readonly paneId: PaneId;
    /** The new durable name, or undefined when cleared. */
    readonly label: string | undefined;
}
/**
 * Synthetic internal event: the session-proxy applied a `set-object-policy`
 * command at PANE scope (optimistic) and is now updating the pane's durable
 * policy/intent fields (tc-i9aq.1, cold-start.md §4.A).
 *
 * This event is NEVER parsed from tmux control-mode output — it is injected by
 * input-path.ts on two occasions:
 *
 *   1. After sending `set-option -pt %N @tmuxcc-<opt> <value>` (optimistic
 *      apply). Each field is present iff that aspect was the one written; the
 *      reducer patches only the present fields.
 *   2. If tmux subsequently replies with %error, with the captured before-value
 *      (compensating reversal — tc-7xv.37).
 *
 * Only PANE-scope writes inject this event: window/session writes change the
 * RESOLVED pane `detach` and reconcile on the next requery (their per-scope-own
 * values are not separately modelled — cold-start.md §4.A keeps resolution
 * host-side and the canonical pane carries the effective value).
 */
export interface InternalPanePolicySetNotification {
    readonly kind: "internal:set-pane-policy";
    readonly paneId: PaneId;
    /**
     * New binding-intent value, when this write touched a `@tmuxcc-bound-<key>`
     * option (D3, tc-4b6k.2). Binding is per-client, so `clientId` names WHOSE
     * intent flipped — the pipeline patch updates that client's membership in the
     * pane's `boundClients` set. Both are present together (or neither).
     */
    readonly bound?: boolean;
    /**
     * The issuing connection's durable identity id, present iff `bound` is — the
     * client whose per-client binding slot this write touched (D3, tc-4b6k.2).
     */
    readonly clientId?: string | undefined;
    /**
     * New detach policy, when this write touched `@tmuxcc-detach` at pane scope.
     * `null` means cleared (returned to inherit/unset).
     */
    readonly detach?: "detach" | "kill" | null;
    /**
     * New icon policy, when this write touched `@tmuxcc-icon`.  `null` means
     * cleared.
     */
    readonly icon?: string | null;
}
export type NotificationEvent = OutputNotification | ExtendedOutputNotification | WindowAddNotification | WindowCloseNotification | WindowRenamedNotification | WindowPaneChangedNotification | SessionChangedNotification | ClientSessionChangedNotification | SessionRenamedNotification | SessionsChangedNotification | SessionWindowChangedNotification | PaneModeChangedNotification | SubscriptionChangedNotification | PauseNotification | ContinueNotification | ExitNotification | UnknownNotification | InternalWindowSyncSetNotification | InternalWindowMonitorActivitySetNotification | InternalWindowMonitorSilenceSetNotification | InternalPaneLabelSetNotification | InternalPanePolicySetNotification;
/**
 * Parse a `NotificationToken` into a typed `NotificationEvent`.
 *
 * Dispatches on `token.keyword`. Unknown keywords return an `UnknownNotification`
 * rather than throwing — graceful degradation for newer/unknown tmux versions.
 *
 * All parsers are tolerant of extra trailing fields (cross-version drift):
 * they read only the fields they expect and ignore the remainder.
 *
 * @param token - A notification token from the tokenizer (tc-ckw).
 * @returns A typed notification event.
 */
export declare function parseNotification(token: NotificationToken): NotificationEvent;
//# sourceMappingURL=notifications.d.ts.map