/**
 * Structured layout representation for the tmuxcc wire protocol.
 *
 * The session-proxy parses tmux's south-side layout strings (e.g.
 * "5x24,0,0[5x12,0,0,0,5x12,0,12,1]") and converts them into this
 * transport-agnostic tree. The wire carries the structured tree; layout
 * strings never appear on the wire.
 *
 * Design: recursive split tree with typed nodes. Two kinds of internal nodes
 * (horizontal / vertical splits) and one leaf (pane). Sizes are always in
 * terminal cells (columns × rows).
 */
import type { PaneId } from "./ids.js";
/** A rectangle in terminal-cell coordinates, origin at top-left of the tmux client area. */
export interface Rect {
    /** Column of the top-left corner (0-based). */
    readonly x: number;
    /** Row of the top-left corner (0-based). */
    readonly y: number;
    /** Width in columns. */
    readonly cols: number;
    /** Height in rows. */
    readonly rows: number;
}
/**
 * A leaf node: a single pane occupying a rectangle.
 */
export interface LayoutPane {
    readonly kind: "pane";
    readonly paneId: PaneId;
    readonly rect: Rect;
}
/**
 * A horizontal split: children are arranged side-by-side (left → right).
 * The split direction matches tmux's "{…}" (LAYOUT_LEFTRIGHT, horizontal)
 * notation but is expressed as a semantic tag, not a tmux character.
 */
export interface LayoutHSplit {
    readonly kind: "hsplit";
    readonly rect: Rect;
    readonly children: readonly LayoutNode[];
}
/**
 * A vertical split: children are stacked top-to-bottom.
 * Matches tmux's "[…]" (LAYOUT_TOPBOTTOM, vertical) notation, expressed semantically.
 */
export interface LayoutVSplit {
    readonly kind: "vsplit";
    readonly rect: Rect;
    readonly children: readonly LayoutNode[];
}
/** Any node in the layout tree. */
export type LayoutNode = LayoutPane | LayoutHSplit | LayoutVSplit;
/**
 * The complete layout for a single window: a tree rooted at one LayoutNode,
 * plus the window's total dimensions for reference.
 */
export interface WindowLayout {
    /** Total size of the window (enclosing rect). */
    readonly cols: number;
    readonly rows: number;
    /** Root of the layout tree. */
    readonly root: LayoutNode;
}
//# sourceMappingURL=layout.d.ts.map