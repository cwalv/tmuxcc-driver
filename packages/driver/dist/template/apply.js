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
import { newWindow, splitWindow, selectLayout, killWindow, setOptionForSession, displayMessagePane, parseEffectIds, } from "../parser/commands.js";
import { serializeGeometry } from "../parser/layout-string.js";
/**
 * The tmux user-option that records the applied template's identity on the
 * session, so "created from template X" survives reattach and driver restarts
 * with no driver-side state to go stale (tc-gjdx.3 awareness).
 */
export const TEMPLATE_SESSION_OPTION = "@tmuxcc-template";
/**
 * A mid-transaction apply failure (tc-gjdx.3 partial-failure semantics). Carries
 * the wire `template.invalid` code, the failed verb, tmux's verbatim reason, and
 * the created-so-far topology. NO rollback was performed — the partial session
 * persists as evidence. tc-gjdx.4 (apply-to-live) reuses this shape.
 */
export class TemplateApplyError extends Error {
    failedVerb;
    failedCommand;
    tmuxMessage;
    created;
    code = "template.invalid";
    constructor(
    /** The verb that failed, e.g. `open-window`, `split-pane`, `select-layout`. */
    failedVerb, 
    /** The exact tmux command string that failed. */
    failedCommand, 
    /** tmux's verbatim refusal text (or a driver-side reason). */
    tmuxMessage, 
    /** Topology created before the failure — NOT rolled back. */
    created) {
        super(`template apply failed at ${failedVerb}: ${tmuxMessage}. ` +
            `Created before failure: ${describeCreated(created)} (no rollback — partial session preserved).`);
        this.failedVerb = failedVerb;
        this.failedCommand = failedCommand;
        this.tmuxMessage = tmuxMessage;
        this.created = created;
        this.name = "TemplateApplyError";
    }
}
function describeCreated(outcome) {
    if (outcome.windows.length === 0)
        return "nothing";
    return outcome.windows
        .map((w) => `${w.windowId}[${w.paneIds.join(",")}]`)
        .join(" ");
}
// ---------------------------------------------------------------------------
// Applicator
// ---------------------------------------------------------------------------
/**
 * Apply a {@link CompiledTemplate} to the session `send` is bound to.
 *
 * `sessionName` targets the `@tmuxcc-template` awareness option (tmux
 * `set-option -t <name>` — the session-proxy is bound to exactly one session).
 *
 * Resolves with the created topology on success; rejects with
 * {@link TemplateApplyError} on the first failure (no rollback).
 */
export async function applyCompiledTemplate(send, plan, sessionName) {
    const created = [];
    const outcome = () => ({ windows: created.slice() });
    // Run a non-creating verb; throw a fail-loud TemplateApplyError on refusal.
    const run = async (verb, command) => {
        const result = await send(command);
        if (!result.ok) {
            throw new TemplateApplyError(verb, command, tmuxText(result) || `tmux rejected ${verb}`, outcome());
        }
    };
    // Run a CREATING verb (`-P -F` id-printing) and return the minted tmux ids.
    const runCreating = async (verb, command) => {
        const result = await send(command);
        if (!result.ok) {
            throw new TemplateApplyError(verb, command, tmuxText(result) || `tmux rejected ${verb}`, outcome());
        }
        const ids = parseEffectIds(decode(result.body));
        if (ids === null) {
            // tmux accepted but the -P -F reply did not parse — the verb's contract
            // is broken; fail loud rather than continue against unknown ids.
            throw new TemplateApplyError(verb, command, `${verb} succeeded but its -P -F effect-id reply was unparseable: ${JSON.stringify(decode(result.body))}`, outcome());
        }
        return ids;
    };
    // Query a single expanded format value from a pane (window dims for the layout).
    const query = async (verb, command) => {
        const result = await send(command);
        if (!result.ok) {
            throw new TemplateApplyError(verb, command, tmuxText(result) || `tmux rejected ${verb}`, outcome());
        }
        return decode(result.body).trim();
    };
    // Identify the throwaway initial window BEFORE creating any template window,
    // so we can kill it at the end. A freshly-minted session has exactly one.
    const initialWindowNum = await query("list-windows", "list-windows -F '#{window_id}'");
    const initialWindowId = firstLine(initialWindowNum); // e.g. "@0"
    // Awareness FIRST: record provenance so a later partial failure still stamps
    // "created from template X" onto the persisted (partial) session.
    if (plan.templateName !== undefined) {
        await run("set-option @tmuxcc-template", setOptionForSession(sessionName, TEMPLATE_SESSION_OPTION, plan.templateName));
    }
    for (const window of plan.windows) {
        await applyWindow(window, created, run, runCreating, query);
    }
    // Kill the throwaway initial window LAST — the session already has ≥1
    // template window, so it is never emptied.
    if (initialWindowId !== null) {
        const num = tmuxNum(initialWindowId);
        if (num !== null) {
            await run("kill-window", killWindow(num));
        }
    }
    return outcome();
}
async function applyWindow(window, created, run, runCreating, query) {
    const [first, ...rest] = window.panes;
    // Leaf 0 → new-window (carrying the leaf's name/cwd/command/env).
    const firstIds = await runCreating("open-window", newWindow({
        printIds: true,
        ...(window.name !== undefined ? { name: window.name } : {}),
        ...paneCreateOpts(first),
    }));
    const applied = {
        windowId: `@${firstIds.windowNum}`,
        paneIds: [`%${firstIds.paneNum}`],
        ...(window.name !== undefined ? { name: window.name } : {}),
    };
    // Push eagerly so the created-so-far report includes this window even if a
    // later split within it fails.
    created.push(applied);
    const paneIds = applied.paneIds;
    // Leaves 1..k-1 → split the previously-created pane (keeps w->panes in order).
    let lastPaneNum = firstIds.paneNum;
    for (const pane of rest) {
        const ids = await runCreating("split-pane", splitWindow(lastPaneNum, "horizontal", {
            printIds: true,
            ...paneCreateOpts(pane),
        }));
        lastPaneNum = ids.paneNum;
        paneIds.push(`%${ids.paneNum}`);
    }
    // Geometry (present iff >1 pane) → select-layout sized to the current window.
    if (window.geometry !== undefined) {
        const dims = await query("display-message", displayMessagePane(firstIds.paneNum, "#{window_width}x#{window_height}"));
        const size = parseDims(dims);
        if (size === null) {
            throw new TemplateApplyError("select-layout", `display-message …#{window_width}x#{window_height} (@${firstIds.windowNum})`, `could not read window size for select-layout (got ${JSON.stringify(dims)})`, { windows: created.slice() });
        }
        await run("select-layout", selectLayout(firstIds.windowNum, serializeGeometry(window.geometry, size)));
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Compiled pane → the creating verb's cwd/env/shellCommand options. */
function paneCreateOpts(pane) {
    return {
        ...(pane.cwd !== undefined ? { startDirectory: pane.cwd } : {}),
        ...(pane.env !== undefined ? { env: { ...pane.env } } : {}),
        ...(pane.shellCommand !== undefined ? { shellCommand: pane.shellCommand } : {}),
    };
}
const DECODER = new TextDecoder();
function decode(body) {
    return body !== undefined ? DECODER.decode(body) : "";
}
/** tmux's verbatim reply/error text (trimmed), or "" when the block had no body. */
function tmuxText(result) {
    return decode(result.body).trim();
}
function firstLine(s) {
    for (const raw of s.split("\n")) {
        const line = raw.trim();
        if (line !== "")
            return line;
    }
    return null;
}
/** `@12` / `%3` → 12 / 3; null when it does not match a tmux id. */
function tmuxNum(id) {
    const m = /^[@%$](\d+)$/.exec(id.trim());
    return m === null ? null : parseInt(m[1], 10);
}
/** `"200x50"` → `{ cols: 200, rows: 50 }`; null on a malformed value. */
function parseDims(s) {
    const m = /^(\d+)x(\d+)$/.exec(s.trim());
    if (m === null)
        return null;
    return { cols: parseInt(m[1], 10), rows: parseInt(m[2], 10) };
}
//# sourceMappingURL=apply.js.map