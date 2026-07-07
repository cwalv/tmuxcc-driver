/**
 * Session-template compiler (tc-gjdx.3) — the PURE description→plan half.
 *
 * FP framing (the design trail): a template is a DESCRIPTION; the applicator is
 * an INTERPRETER over the driver's existing creating verbs (open-window /
 * split-pane). This module is the COMPILER between them — a pure function from a
 * concrete {@link SessionTemplate} to an ordered {@link CompiledTemplate} plan
 * of pane creations + per-window geometry. It performs NO I/O and knows nothing
 * about tmux ids, sockets, or the session-proxy — so it is exhaustively
 * testable in isolation. The runtime ids (which the `-P -F` creations mint) are
 * resolved by the applicator ({@link import("./apply.js")}), not here.
 *
 * # What the compiler decides
 *
 *   1. Flatten each window's desired-geometry tree into an ORDERED list of pane
 *      leaves (depth-first, matching tmux's positional `layout_assign` order).
 *      The applicator creates the panes in exactly this order — leaf 0 becomes
 *      the window's `new-window` pane, leaves 1..k-1 become `split-pane`s of the
 *      previously-created pane — so a later `select-layout` tiles them into the
 *      right cells (see layout-string.ts serializeGeometry).
 *   2. The vocabulary bridge: a leaf's `command` (template vocabulary) becomes
 *      the creating verb's `shellCommand`; `cwd` and `env` pass through.
 *   3. Whether a window needs a `select-layout` at all: only when it has >1
 *      pane. A single-pane window (geometry omitted, or a lone `pane` leaf) is
 *      just a `new-window` — no geometry to apply.
 *
 * # Semantic validation (JSON Schema can't express these — tc-gjdx.1)
 *
 * The template arrives already structurally valid (ajv against
 * session-template.json). This compiler enforces the CROSS-FIELD invariants a
 * schema cannot, failing loud with {@link TemplateValidationError} (mapped to
 * the wire `template.invalid` code):
 *   - a split (`hsplit`/`vsplit`) has at least two children;
 *   - a split's `sizes`, when present, is PARALLEL to `children` (equal length)
 *     and every weight is a finite positive number.
 *
 * @module template/compile
 */
import { CommandError } from "@tmuxcc/protocol";
import type { SessionTemplate, TemplateNode } from "@tmuxcc/protocol";
/**
 * One pane to create, in creation order. The vocabulary is already bridged to
 * the creating verbs: `shellCommand` (not the template's `command`), `cwd`
 * (`-c`), `env` (`-e`). All optional — an empty `{}` is a default-shell pane
 * inheriting the session cwd/environment.
 */
export interface CompiledPane {
    readonly cwd?: string;
    /** Bridged from the template leaf's `command` → the verb's `shellCommand`. */
    readonly shellCommand?: string;
    readonly env?: Readonly<Record<string, string>>;
}
/**
 * One window to create: an optional name, its panes in creation order (≥1), and
 * — only when it has more than one pane — the desired-geometry tree the
 * applicator serializes into a `select-layout`.
 */
export interface CompiledWindow {
    readonly name?: string;
    /** Panes in creation order (depth-first leaf order). Always ≥1. */
    readonly panes: readonly CompiledPane[];
    /**
     * The desired-geometry tree to apply via `select-layout`, present IFF
     * `panes.length > 1`. A single-pane window needs no layout.
     */
    readonly geometry?: TemplateNode;
}
/**
 * The compiled transaction: the ordered windows to create plus the template's
 * identity name (for the `@tmuxcc-template` awareness option — absent for
 * inline/ad-hoc templates).
 */
export interface CompiledTemplate {
    /** Template identity, echoed for the `@tmuxcc-template` awareness stamp. */
    readonly templateName?: string;
    /** Windows to create, in order. Always ≥1 (a template is a non-empty session). */
    readonly windows: readonly CompiledWindow[];
}
/**
 * A template that is structurally valid (schema) but violates a cross-field
 * semantic invariant the schema cannot express (tc-gjdx.1). Extends
 * {@link CommandError} with code `"template.invalid"` so the dispatcher's
 * `isCommandError` guard picks it up and `toCommandFailure` converts it to a
 * typed wire failure automatically.
 */
export declare class TemplateValidationError extends CommandError {
    constructor(message: string);
}
/**
 * Compile a concrete {@link SessionTemplate} into an ordered
 * {@link CompiledTemplate} plan.
 *
 * Pure and total apart from {@link TemplateValidationError} on a semantic
 * violation (empty session, split with <2 children, sizes length mismatch,
 * non-positive weight).
 */
export declare function compileTemplate(template: SessionTemplate): CompiledTemplate;
//# sourceMappingURL=compile.d.ts.map