/**
 * Bootstrap reply parsing + initial-model builder (tc-835, retained tc-128.4).
 *
 * @module state/bootstrap
 *
 * # What this used to be
 *
 * In the per-event-reducer architecture (tc-5dd) this module also hosted a
 * `BootstrapCoordinator` class that drove an attach-time list-windows /
 * list-panes exchange, BUFFERED live notifications during the round-trip,
 * REPLAYED them through `reduce()` on completion, and then transitioned to
 * "live" reducer mode.
 *
 * # What it is now (tc-128.4)
 *
 * The §6 requery-on-event design (state-model.md) retired the reducer's
 * per-event interpretation; `RequeryEngine` (state/requery.ts) now owns the
 * bootstrap path end-to-end. Bootstrap is just `engine.requery()` with the
 * empty model as the previous: the diff against empty yields a full snapshot
 * of deltas, and there's no separate "live vs bootstrapping" phase to
 * coordinate. Notifications that arrive during the round-trip are demoted to
 * a dirty bit by the coalescer, which schedules the next requery — no
 * separate buffer-and-replay path is needed.
 *
 * This module survives because the WIRE-LEVEL pieces are still used:
 *
 *   - `BOOTSTRAP_WINDOWS_FORMAT` / `BOOTSTRAP_PANES_FORMAT` — the
 *     `display-message -F` format strings.
 *   - `bootstrapCommands(sessionName?)` — builds the two `list-*` command
 *     lines (engine calls this on every cycle).
 *   - `parseWindowsReply` / `parsePanesReply` — turn the command-reply
 *     bodies into typed rows.
 *   - `buildInitialModel` — folds the rows into a complete `SessionModel`.
 *
 * The engine composes these in `requeryDiff` (state/requery.ts).
 *
 * # Format strings (validated against real tmux 3.4 output)
 *
 * ## BOOTSTRAP_WINDOWS_FORMAT
 *
 *   `#{session_id}\t#{session_name}\t#{window_id}\t#{window_name}\t` +
 *   `#{window_width}\t#{window_height}\t#{window_layout}\t` +
 *   `#{window_flags}\t#{?window_active,1,0}`
 *
 * Fields (tab-separated, 9 per line):
 *   [0] session_id    — `$N`  (e.g. "$0")
 *   [1] session_name  — human name
 *   [2] window_id     — `@N`  (e.g. "@1")
 *   [3] window_name   — human name
 *   [4] window_width  — integer columns
 *   [5] window_height — integer rows
 *   [6] window_layout — layout string (e.g. "b25d,80x24,0,0,0")
 *   [7] window_flags  — flag chars (e.g. "*", "-", "!")
 *   [8] window_active — "1" if this is the session's active window, "0" otherwise
 *
 * ## BOOTSTRAP_PANES_FORMAT
 *
 *   `#{pane_id}\t#{window_id}\t#{session_id}\t#{pane_index}\t` +
 *   `#{pane_width}\t#{pane_height}\t#{pane_top}\t#{pane_left}\t` +
 *   `#{?pane_active,1,0}\t#{pane_pid}\t#{pane_current_command}\t` +
 *   `#{?pane_dead,1,0}\t#{pane_dead_status}\t#{@tmuxcc_label}`
 *
 * Fields (tab-separated, 14 per line). Fields [11]/[12] are the dead-pane state
 * (tc-4bv2 / tc-295a.10 shared shape); [13] is the durable pane name (tc-1a8z):
 *   [11] pane_dead        — "1" if the pane's process has exited but the slot
 *                           survives (remain-on-exit corpse), "0" otherwise.
 *   [12] pane_dead_status — the exited process's status code; empty string when
 *                           the pane is alive or tmux has no status to report.
 *   [13] @tmuxcc_label    — the durable, driver-owned pane name (the per-pane
 *                           user-option set by the `rename-pane` verb); empty
 *                           string when no durable name is set.  Re-read on
 *                           every requery so the name survives a driver restart.
 *
 * # Id mapping convention
 *
 *   paneId("p" + N)    for tmux `%N`
 *   windowId("w" + N)  for tmux `@N`
 *   sessionId("s" + N) for tmux `$N`
 */
import type { SessionModel } from "./model.js";
/**
 * The per-pane tmux user-option that stores the durable, driver-owned pane
 * name (tc-1a8z).
 *
 * Single source of truth for the option NAME, shared by the WRITE side
 * (input-path's `rename-pane` verb → `set-option -pt %N @tmuxcc_label <name>`)
 * and the READ side (BOOTSTRAP_PANES_FORMAT below → `#{@tmuxcc_label}`).  It
 * mirrors the session-ownership marker `@tmuxcc` (tc-w61): canonical state
 * lives WITH the pane in tmux, so it survives a driver restart for free and is
 * natively introspectable.
 *
 * This is the DURABLE channel — never set via a title escape, so the shell
 * cannot clobber it.  Distinct from the live pane_title (tc-2mn8).
 */
export declare const TMUXCC_LABEL_OPTION = "@tmuxcc_label";
/**
 * Per-(pane, client-identity) binding-intent marker (D3, tc-4b6k.2; supersedes
 * the single-scalar `@tmuxcc-bound` of tc-i9aq.1).  `1` means "the client with
 * this identity wants a VS Code terminal recreated for this pane on attach";
 * unset/empty means no intent for that client.  Binding is per-client, so the
 * durable option name carries the client-identity key: two workspaces binding
 * the same pane write DISTINCT options and never collide (dissolves seam S1).
 *
 * Written by the `set-object-policy` verb at PANE scope keyed by the ISSUING
 * connection's identity (`set-option -pt %N @tmuxcc-bound-<key> 1` / `-u` to
 * clear); read per-client on connect and carried forward across requery cycles
 * (see model.ts `boundClients`).  Lives WITH the pane in tmux, so it survives a
 * VS Code restart and vanishes with the pane — staleness is structurally
 * impossible (it cannot outlive its referent).
 *
 * This bare prefix is also the LEGACY / anonymous-connection key: a connection
 * that presents no `ClientIdentity` binds/reads here (see
 * {@link paneBoundOptionName}).
 */
export declare const TMUXCC_BOUND_OPTION = "@tmuxcc-bound";
/**
 * The per-client tmux user-option name that stores binding intent for one
 * client identity (D3, tc-4b6k.2).
 *
 *   `paneBoundOptionName(id) = "@tmuxcc-bound-" + sha1hex(id).slice(0, 16)`
 *
 * `ClientIdentity.id` is OPAQUE to the driver (the wire contract forbids the
 * driver assuming its charset), so the id is HASHED into the option-name suffix
 * rather than embedded verbatim.  sha1-hex is:
 *   - always format-safe — `#{@tmuxcc-bound-<hex>}` contains no format
 *     metacharacters (verified against tmux next-3.7: user-option names accept
 *     any characters except the `[` array sigil; options.c);
 *   - bounded (~30-char name, no length concern);
 *   - injective in practice for the handful of distinct workspaces attached to
 *     one tmux server (16 hex = 64 bits).
 *
 * An `undefined` clientId (anonymous connection / legacy) falls back to the bare
 * {@link TMUXCC_BOUND_OPTION} — a single shared slot for all anonymous clients,
 * and the back-compat key.
 */
export declare function paneBoundOptionName(clientId: string | undefined): string;
/**
 * Detach-on-close policy (cold-start.md §4.A).  Value is `detach` or `kill`;
 * unset/empty means "inherit" (defer to the next scope in the cascade).  Set at
 * PANE, WINDOW, or SESSION scope by the `set-object-policy` verb.
 *
 * tmux does NOT inherit user-options across scopes for `show-options`, but a
 * `#{@tmuxcc-detach}` FORMAT reference DOES walk pane→window→session (verified
 * tmux 3.4).  The requery reads this through `list-panes -F`, so the pane row
 * carries the RESOLVED (effective) close policy — pane override, else window
 * default, else session default — which is exactly the first-wins cascade the
 * host's close decision consumes.  Per-scope-OWN values (for the toggle UI's
 * "current setting" display) are tracked optimistically in the extension's
 * in-memory policy cache (bucket B), written through this verb; the durable
 * truth is the tmux object.
 */
export declare const TMUXCC_DETACH_OPTION = "@tmuxcc-detach";
/**
 * Per-pane icon policy (cold-start.md §4.A).  Opaque string (a VS Code
 * ThemeIcon id or icon-policy token); unset/empty means "no durable icon
 * policy".  Written at PANE scope by the `set-object-policy` verb and re-read
 * on every requery.
 */
export declare const TMUXCC_ICON_OPTION = "@tmuxcc-icon";
/**
 * Format string for `list-windows` during bootstrap.
 *
 * Includes `session_id` and `session_name` so the engine can build Session
 * entities from the windows reply alone (no separate `list-sessions` needed).
 */
export declare const BOOTSTRAP_WINDOWS_FORMAT: string;
/**
 * Format string for `list-panes` during bootstrap.
 */
export declare const BOOTSTRAP_PANES_FORMAT: string;
/**
 * How the requery engine scopes its `list-windows` / `list-panes` cycle to a
 * single session.
 *
 *   - `{ kind: "id", sessionId }` — target by the IMMUTABLE tmux session id
 *     (`$N`). This is the steady-state target: it survives a `rename-session`
 *     (the id never changes), so the requery keeps observing the right session
 *     after a rename and can emit the `session.renamed` delta (tc-0v59).
 *   - `{ kind: "name", sessionName }` — target by the (mutable) session name
 *     (`=<name>`). Used ONLY for the very first cold cycle, before any reply
 *     has revealed the immutable id. The name is correct at bootstrap; the
 *     engine captures the id from the first successful reply and switches to
 *     id-targeting forever after.
 *   - `undefined` — no scope: fall back to `-a` (all sessions), the legacy
 *     behaviour for bootstrap shapes that know neither the id nor the name.
 */
export type SessionTarget = {
    readonly kind: "id";
    readonly sessionId: number;
} | {
    readonly kind: "name";
    readonly sessionName: string;
};
/**
 * Return the two tmux commands the requery engine issues on every cycle.
 *
 * When `target` is provided the commands are scoped to that one session
 * (avoiding cross-session contamination in multi-session environments). The
 * `"id"` form targets by the immutable session id `$N` (rename-safe); the
 * `"name"` form targets by `=<name>` (used only before the id is known).
 * When `target` is absent, falls back to `-a` (all sessions).
 *
 * Returns: `[listWindowsCommand, listPanesCommand]`
 */
export declare function bootstrapCommands(target?: SessionTarget): [string, string];
/**
 * Parsed record from one line of a `list-windows` reply.
 * @internal
 */
export interface WindowsReplyRow {
    readonly tmuxSessionId: number;
    readonly sessionName: string;
    readonly tmuxWindowId: number;
    readonly windowName: string;
    readonly width: number;
    readonly height: number;
    readonly layoutString: string;
    readonly flags: string;
    readonly active: boolean;
}
/**
 * Parsed record from one line of a `list-panes` reply.
 * @internal
 */
export interface PanesReplyRow {
    readonly tmuxPaneId: number;
    readonly tmuxWindowId: number;
    readonly tmuxSessionId: number;
    readonly paneIndex: number;
    readonly width: number;
    readonly height: number;
    readonly paneTop: number;
    readonly paneLeft: number;
    readonly active: boolean;
    /** True when `pane_dead=1` (remain-on-exit corpse). Defaults false on legacy
     *  replies that don't carry the field. */
    readonly dead: boolean;
    /** Exit status from `pane_dead_status` when dead and known, else undefined. */
    readonly exitCode: number | undefined;
    /**
     * Durable, driver-owned pane name from the `@tmuxcc_label` pane user-option
     * (tc-1a8z), or undefined when the option is unset/empty.  Re-read on every
     * requery so the durable name survives a driver restart.
     */
    readonly label: string | undefined;
    /**
     * RESOLVED detach-on-close policy from the `@tmuxcc-detach` user-option
     * (tc-i9aq.1, cold-start.md §4.A), read via a `#{@tmuxcc-detach}` format that
     * walks pane→window→session, so this is the effective first-wins cascade
     * value.  `"detach"` or `"kill"` when set at any scope; undefined when unset
     * at every scope (the extension applies its default).
     */
    readonly detach: "detach" | "kill" | undefined;
    /**
     * Durable icon policy from the `@tmuxcc-icon` pane user-option (tc-i9aq.1,
     * cold-start.md §4.A), or undefined when unset/empty.
     */
    readonly icon: string | undefined;
}
/**
 * Parse the body of a `list-windows` command reply.
 *
 * Each non-empty line is one window, tab-separated in BOOTSTRAP_WINDOWS_FORMAT
 * order. Lines with wrong field count are silently skipped (defensive).
 */
export declare function parseWindowsReply(body: Uint8Array): WindowsReplyRow[];
/**
 * Parse the body of a `list-panes` command reply.
 */
export declare function parsePanesReply(body: Uint8Array): PanesReplyRow[];
/**
 * Build a fresh `SessionModel` from parsed windows + panes rows.
 *
 * The requery engine calls this on every cycle: the model is the diff
 * baseline that `diffModel(prev, next)` turns into wire deltas.
 *
 * @param windowRows - Output of `parseWindowsReply`.
 * @param paneRows   - Output of `parsePanesReply`.
 */
export declare function buildInitialModel(windowRows: WindowsReplyRow[], paneRows: PanesReplyRow[]): SessionModel;
//# sourceMappingURL=bootstrap.d.ts.map