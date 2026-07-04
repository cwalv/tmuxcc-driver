/**
 * Session-template applicator (tc-gjdx.3) — the INTERPRETER half.
 *
 * Executes a {@link CompiledTemplate} plan against a live session by issuing the
 * driver's existing creating verbs through a single `send` seam (the
 * session-proxy's slotted, correlated command path). The compiler
 * ({@link import("./compile.js")}) is pure and id-free; this module resolves the
 * runtime tmux ids the `-P -F` creations mint and threads them into the
 * subsequent split / select-layout / kill steps.
 *
 * # Compile→apply order (per window)
 *
 *   1. `new-window -P -F …`  → the window's FIRST pane (leaf 0), with the
 *      leaf's name/cwd/command/env.
 *   2. `split-window -P -F …` for leaves 1..k-1, each splitting the
 *      PREVIOUSLY-created pane. Splitting the last-created pane keeps tmux's
 *      `w->panes` list in creation order, which equals the layout's depth-first
 *      leaf order — so the positional `select-layout` assignment lands each leaf
 *      in the right cell.
 *   3. `select-layout` (only when the window has >1 pane) applies the desired
 *      geometry, sized against the window's CURRENT dimensions.
 *
 * After all template windows exist, the throwaway INITIAL window (the one a
 * freshly-minted session is born with — its pane can't carry per-pane
 * cwd/command/env) is killed. This runs LAST, after ≥1 template window exists,
 * so the session is never emptied.
 *
 * # Awareness (survives reattach / driver restart with no driver-side state)
 *
 * When the template is named, `@tmuxcc-template=<name>` is set as a session
 * user-option FIRST, so "created from template X" is recorded even if a later
 * step fails (fail-loud preserves provenance alongside the partial session). The
 * broker surfaces it on the session row (see tmux-south listSessions).
 *
 * # Partial failure (ratified: stop-first, no rollback — tc-gjdx.3)
 *
 * Apply is a SEQUENCE of creating verbs. On the FIRST failure — a rejected verb
 * OR a `select-layout` tmux refuses — we STOP and throw {@link
 * TemplateApplyError} naming the failed verb, tmux's verbatim reason, and the
 * created-so-far topology. There is NO auto-rollback: rollback would destroy the
 * evidence (and possibly real user work). The old extension applicator swallowed
 * these to a warn-log; that class of swallow is exactly what this replaces.
 *
 * @module template/apply
 */
import type { CommandResult } from "../parser/correlator.js";
import type { CompiledTemplate } from "./compile.js";
/**
 * The tmux user-option that records the applied template's identity on the
 * session, so "created from template X" survives reattach and driver restarts
 * with no driver-side state to go stale (tc-gjdx.3 awareness).
 */
export declare const TEMPLATE_SESSION_OPTION = "@tmuxcc-template";
/**
 * The single command seam the applicator drives: send a tmux command string
 * through the session-proxy's slotted, correlated path and resolve with the
 * {@link CommandResult} (`ok` + reply `body`). This is exactly
 * `SessionProxy.send`; a fake makes the applicator unit-testable without tmux.
 */
export type TemplateApplySend = (command: string) => Promise<CommandResult>;
/** One window created by an apply, in creation order. */
export interface AppliedWindow {
    /** tmux window id (`@N`). */
    readonly windowId: string;
    /** tmux pane ids (`%N`) in creation order (leaf order). */
    readonly paneIds: readonly string[];
    /** The window's template name, when it had one. */
    readonly name?: string;
}
/** The topology an apply created (so far). Reused by tc-gjdx.4's apply-to-live. */
export interface TemplateApplyOutcome {
    readonly windows: readonly AppliedWindow[];
}
/**
 * A mid-transaction apply failure (tc-gjdx.3 partial-failure semantics). Carries
 * the wire `template.invalid` code, the failed verb, tmux's verbatim reason, and
 * the created-so-far topology. NO rollback was performed — the partial session
 * persists as evidence. tc-gjdx.4 (apply-to-live) reuses this shape.
 */
export declare class TemplateApplyError extends Error {
    /** The verb that failed, e.g. `open-window`, `split-pane`, `select-layout`. */
    readonly failedVerb: string;
    /** The exact tmux command string that failed. */
    readonly failedCommand: string;
    /** tmux's verbatim refusal text (or a driver-side reason). */
    readonly tmuxMessage: string;
    /** Topology created before the failure — NOT rolled back. */
    readonly created: TemplateApplyOutcome;
    readonly code = "template.invalid";
    constructor(
    /** The verb that failed, e.g. `open-window`, `split-pane`, `select-layout`. */
    failedVerb: string, 
    /** The exact tmux command string that failed. */
    failedCommand: string, 
    /** tmux's verbatim refusal text (or a driver-side reason). */
    tmuxMessage: string, 
    /** Topology created before the failure — NOT rolled back. */
    created: TemplateApplyOutcome);
}
/**
 * Options for {@link applyCompiledTemplate}.
 */
export interface ApplyCompiledTemplateOptions {
    /**
     * When true (the default — apply-at-create path), the applicator identifies
     * the session's initial throwaway window before applying template windows
     * and kills it after the last template window is created.
     *
     * Set to false for apply-to-live (tc-gjdx.4): the session already has user
     * windows, there is no throwaway initial window, and no existing window
     * must be killed.
     */
    killInitialWindow?: boolean;
}
/**
 * Apply a {@link CompiledTemplate} to the session `send` is bound to.
 *
 * `sessionName` targets the `@tmuxcc-template` awareness option (tmux
 * `set-option -t <name>` — the session-proxy is bound to exactly one session).
 *
 * `opts.killInitialWindow` (default `true`): the apply-at-create path kills
 * the throwaway initial window after creating all template windows.  Pass
 * `{ killInitialWindow: false }` for the apply-to-live path, where the
 * session already has real user windows.
 *
 * Resolves with the created topology on success; rejects with
 * {@link TemplateApplyError} on the first failure (no rollback).
 */
export declare function applyCompiledTemplate(send: TemplateApplySend, plan: CompiledTemplate, sessionName: string, opts?: ApplyCompiledTemplateOptions): Promise<TemplateApplyOutcome>;
//# sourceMappingURL=apply.d.ts.map