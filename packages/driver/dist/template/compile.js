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
/**
 * A template that is structurally valid (schema) but violates a cross-field
 * semantic invariant the schema cannot express (tc-gjdx.1). Carries the wire
 * error code so the broker surfaces it as `template.invalid` (fail-loud).
 */
export class TemplateValidationError extends Error {
    code = "template.invalid";
    constructor(message) {
        super(message);
        this.name = "TemplateValidationError";
    }
}
// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------
/**
 * Compile a concrete {@link SessionTemplate} into an ordered
 * {@link CompiledTemplate} plan.
 *
 * Pure and total apart from {@link TemplateValidationError} on a semantic
 * violation (empty session, split with <2 children, sizes length mismatch,
 * non-positive weight).
 */
export function compileTemplate(template) {
    if (template.windows.length === 0) {
        throw new TemplateValidationError("session template has no windows");
    }
    const windows = template.windows.map((w, i) => compileWindow(w, i));
    return {
        ...(template.name !== undefined ? { templateName: template.name } : {}),
        windows,
    };
}
function compileWindow(window, index) {
    // Geometry omitted ⇒ a single default-shell pane (the common "just give me a
    // window" case) — no geometry, no select-layout.
    if (window.geometry === undefined) {
        return {
            ...(window.name !== undefined ? { name: window.name } : {}),
            panes: [{}],
        };
    }
    const leaves = [];
    collectLeaves(window.geometry, leaves, `windows[${index}].geometry`);
    const panes = leaves.map(leafToPane);
    return {
        ...(window.name !== undefined ? { name: window.name } : {}),
        panes,
        // A lone leaf collapses to a single-pane window; no layout to apply.
        ...(panes.length > 1 ? { geometry: window.geometry } : {}),
    };
}
/**
 * Depth-first collect the `pane` leaves of a geometry tree into `out`, in the
 * order tmux's `layout_assign` will consume them (children left→right /
 * top→bottom). Validates split semantics along the way.
 */
function collectLeaves(node, out, path) {
    if (node.kind === "pane") {
        out.push(node);
        return;
    }
    const { children, sizes } = node;
    if (children.length < 2) {
        throw new TemplateValidationError(`${path}: a ${node.kind} must have at least two children (has ${children.length})`);
    }
    if (sizes !== undefined) {
        if (sizes.length !== children.length) {
            throw new TemplateValidationError(`${path}: ${node.kind} sizes length ${sizes.length} does not match children length ${children.length} ` +
                `(sizes are proportional weights PARALLEL to children)`);
        }
        for (let i = 0; i < sizes.length; i++) {
            const s = sizes[i];
            if (!Number.isFinite(s) || s <= 0) {
                throw new TemplateValidationError(`${path}: ${node.kind} sizes[${i}] must be a finite positive weight (got ${s})`);
            }
        }
    }
    children.forEach((child, i) => collectLeaves(child, out, `${path}.children[${i}]`));
}
/** Vocabulary bridge: template leaf `command` → verb `shellCommand`; cwd/env pass through. */
function leafToPane(leaf) {
    return {
        ...(leaf.cwd !== undefined ? { cwd: leaf.cwd } : {}),
        ...(leaf.command !== undefined ? { shellCommand: leaf.command } : {}),
        ...(leaf.env !== undefined ? { env: leaf.env } : {}),
    };
}
//# sourceMappingURL=compile.js.map