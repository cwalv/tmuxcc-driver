/**
 * Session freeze (tc-gjdx.5) — snapshot a live tmux session as a schema-valid
 * session template.
 *
 * # What freeze captures
 *
 *   - Geometry: window_layout string → parsed actual tree → desired-geometry
 *     tree (proportional). The actual children widths/heights become the
 *     proportional `sizes` weights, so freeze→apply round-trips with full
 *     topology/geometry fidelity by construction (serializeGeometry re-derives
 *     integer-exact sizes from the same proportions).
 *   - Per-pane cwd: pane_current_path.
 *   - Window names: captured.
 *   - Commands: OMITTED. pane_start_command does NOT faithfully round-trip when
 *     the command has arguments — tmux stores the argv as a single display
 *     string, but the applicator passes shellCommand as ONE quoted tmux argument,
 *     adding an extra layer of quoting that breaks exec. A frozen pane with no
 *     command re-applies as the default shell, which is honest. (Evidence:
 *     tc-gjdx.5 bead comment, first-hand tmux 3.4 test.)
 *   - env: NOT captured (a process's effective environment is not recoverable).
 *
 * # Actual→desired conversion
 *
 * The parsed tree (LayoutCell) has absolute rects and pane IDs. The desired tree
 * (TemplateNode) has NO rects and NO pane IDs — only proportional sizes. The
 * conversion uses the actual children widths (horizontal split) or heights
 * (vertical split) as proportional weights. This is numerically exact because:
 *
 *   distributeSizes(total - (n-1), [child.width...])
 *   re-produces the original children widths exactly, since
 *   total = sum(child.widths) + (n-1) (one separator per adjacent pair).
 *
 * So freeze → compile + apply round-trips to the same layout string (up to
 * tmux rounding), satisfying the AC.
 *
 * @module template/freeze
 */
import { parseLayout } from "../parser/layout-string.js";
/**
 * Convert a parsed actual-layout cell tree into a desired-geometry
 * {@link TemplateNode}.
 *
 * Proportional sizes are derived from the actual pixel widths (horizontal
 * splits) or heights (vertical splits) of the children. This preserves the
 * original proportions through a freeze→compile→apply round-trip.
 *
 * Pane leaf specs carry ONLY `cwd` (from `cwdByPaneNum`). Command and env are
 * OMITTED — see module doc.
 *
 * @param cell - Parsed actual-layout cell.
 * @param cwdByPaneNum - Map from pane number (integer part of %N) to cwd.
 * @returns The equivalent desired-geometry tree node.
 */
export function actualToDesiredNode(cell, cwdByPaneNum) {
    if (cell.type === "leaf") {
        const cwd = cell.paneId !== null ? cwdByPaneNum.get(cell.paneId) : undefined;
        const pane = {
            kind: "pane",
            ...(cwd !== undefined && cwd !== "" ? { cwd } : {}),
        };
        return pane;
    }
    // Split cell: recurse into children and derive proportional sizes.
    const children = cell.children.map((c) => actualToDesiredNode(c, cwdByPaneNum));
    if (cell.orientation === "horizontal") {
        // hsplit = left→right = "horizontal" = {} = LAYOUT_LEFTRIGHT
        // Use children widths as proportional weights — they are already separator-excluded.
        const sizes = cell.children.map((c) => c.width);
        const node = { kind: "hsplit", children, sizes };
        return node;
    }
    // vsplit = top→bottom = "vertical" = [] = LAYOUT_TOPBOTTOM
    // Use children heights as proportional weights.
    const sizes = cell.children.map((c) => c.height);
    const node = { kind: "vsplit", children, sizes };
    return node;
}
// ---------------------------------------------------------------------------
// Build template from freeze data
// ---------------------------------------------------------------------------
/**
 * Build a {@link SessionTemplate} from the freeze query result.
 *
 * Pure: no I/O. The caller (tmux-south + server-proxy) is responsible for
 * supplying the raw data.
 *
 * Each window is converted to a {@link WindowTemplate}: window name is always
 * captured; geometry is captured from the parsed layout tree (absent only when
 * the window has exactly one leaf — a single-pane window needs no geometry node
 * beyond the implicit default, but we DO emit the leaf's cwd on the single
 * `TemplatePane`). Managed-window (strip-shaped) and wild-tree windows are both
 * supported — freeze-don't-reject.
 *
 * @param data - Raw freeze query result from tmux-south.
 * @param name - Optional template name to embed.
 * @returns A schema-valid {@link SessionTemplate}.
 * @throws Error when the layout string for a window is unparseable.
 */
export function buildFrozenTemplate(data, name) {
    // Build pane-number → cwd lookup.
    const cwdByPaneNum = new Map();
    for (const pane of data.panes) {
        cwdByPaneNum.set(pane.paneNum, pane.cwd);
    }
    const windows = [];
    for (const win of data.windows) {
        const parsed = parseLayout(win.layoutString);
        const root = parsed.root;
        let geometry;
        if (root.type === "leaf") {
            // Single-pane window: the "geometry" is just one pane leaf.
            // Emit it so cwd is captured. The compiler treats a single pane leaf
            // the same as a window with no geometry (no select-layout needed).
            const cwd = root.paneId !== null ? cwdByPaneNum.get(root.paneId) : undefined;
            geometry =
                cwd !== undefined && cwd !== ""
                    ? { kind: "pane", cwd }
                    : { kind: "pane" };
        }
        else {
            geometry = actualToDesiredNode(root, cwdByPaneNum);
        }
        windows.push({
            ...(win.name !== "" ? { name: win.name } : {}),
            geometry,
        });
    }
    // A session with no windows is degenerate (schema requires ≥1) — but tmux
    // never returns an empty window list for a live session, so this is
    // structural-only; freeze-don't-reject.
    if (windows.length === 0) {
        throw new Error("freeze: session has no windows");
    }
    return {
        ...(name !== undefined ? { name } : {}),
        windows,
    };
}
//# sourceMappingURL=freeze.js.map