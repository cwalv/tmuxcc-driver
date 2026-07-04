/**
 * tmux layout-string parser (tc-efj).
 *
 * Parses the compact layout strings that tmux emits in `%layout-change`
 * notifications and `list-windows -F '#{window_layout}'` output.
 *
 * # Grammar (from tmux layout-custom.c: layout_append / layout_construct)
 *
 *   layout-string  ::= checksum "," cell
 *   checksum       ::= 4 lower-hex digits          (16-bit rolling checksum of <cell>)
 *   cell           ::= geometry leaf
 *                    | geometry "{" children "}"   (LAYOUT_LEFTRIGHT  — horizontal / left-right)
 *                    | geometry "[" children "]"   (LAYOUT_TOPBOTTOM  — vertical  / top-bottom)
 *   geometry       ::= width "x" height "," xoff "," yoff
 *   leaf           ::= "," paneId                  (integer; present only when pane is assigned)
 *                    | ε                            (unassigned leaf — rare in practice)
 *   children       ::= cell ("," cell)*
 *
 * Bracket orientation (confirmed from layout-custom.c:layout_append):
 *   {}  →  LAYOUT_LEFTRIGHT  →  orientation "horizontal"  (panes side-by-side, left→right)
 *   []  →  LAYOUT_TOPBOTTOM  →  orientation "vertical"    (panes stacked, top→bottom)
 *
 * Pane-ID disambiguation (layout_construct_cell):
 *   After `geometry`, if the next char is "," try to read `,digits`. If the char
 *   immediately following those digits is "x", it is NOT a pane ID (it is the start
 *   of the next sibling cell separated by a comma) — backtrack. Otherwise consume
 *   the pane ID.
 *
 * # Checksum algorithm (layout_checksum in layout-custom.c)
 *
 *   csum = 0  (16-bit unsigned)
 *   for each byte c of the body string (everything after "checksum,"):
 *     csum = (csum >> 1) | ((csum & 1) << 15)   // rotate right by 1
 *     csum = (csum + c) & 0xFFFF                 // add byte, keep 16 bits
 *
 * # Supported form
 *
 *   The "visible layout" form that includes pane IDs — the form emitted by
 *   `%layout-change` and `list-windows` with `#{window_layout}`. Pane IDs are
 *   captured in leaf nodes. If a leaf is unassigned (no pane ID in the string)
 *   its `paneId` field will be `null`.
 *
 * @module parser/layout-string
 */
import type { TemplateNode } from "@tmuxcc/protocol";
/**
 * A leaf cell — corresponds to LAYOUT_WINDOWPANE in tmux.
 * Represents a single pane at a fixed position and size.
 */
export interface LeafCell {
    readonly type: "leaf";
    readonly width: number;
    readonly height: number;
    /** X offset from the window's top-left corner (pixels/columns). */
    readonly x: number;
    /** Y offset from the window's top-left corner (rows). */
    readonly y: number;
    /**
     * The tmux pane index (`wp->id`) from the layout string, or `null` if the
     * cell has no assigned pane (unassigned leaf). In the visible-layout form
     * emitted by `%layout-change` this is always a non-null integer.
     */
    readonly paneId: number | null;
}
/**
 * A split cell — either LAYOUT_LEFTRIGHT (`{}`) or LAYOUT_TOPBOTTOM (`[]`).
 *
 * Orientation mapping (confirmed from layout-custom.c):
 *   "horizontal"  ←→  {}  ←→  LAYOUT_LEFTRIGHT  (children laid out left→right)
 *   "vertical"    ←→  []  ←→  LAYOUT_TOPBOTTOM  (children stacked top→bottom)
 */
export interface SplitCell {
    readonly type: "split";
    /** "horizontal" = {} = LAYOUT_LEFTRIGHT; "vertical" = [] = LAYOUT_TOPBOTTOM */
    readonly orientation: "horizontal" | "vertical";
    readonly width: number;
    readonly height: number;
    readonly x: number;
    readonly y: number;
    readonly children: LayoutCell[];
}
/** A node in the parsed geometry tree. */
export type LayoutCell = LeafCell | SplitCell;
/** Result of parsing a full layout string (checksum prefix + tree). */
export interface ParsedLayout {
    /** The 16-bit checksum value parsed from the 4-hex-digit prefix. */
    readonly checksum: number;
    /**
     * Checksum computed from the body (everything after "checksum,").
     * Should equal `checksum`; exposed so callers can validate.
     */
    readonly computedChecksum: number;
    /** The root geometry cell. */
    readonly root: LayoutCell;
}
/**
 * Compute tmux's 16-bit rolling layout checksum.
 *
 * Algorithm (layout_checksum in layout-custom.c):
 *   csum = 0
 *   for each char c in the string:
 *     csum = (csum >> 1) | ((csum & 1) << 15)   // rotate right 1 bit
 *     csum = (csum + char_code(c)) & 0xFFFF
 *
 * @param body - The layout body string (everything AFTER the "checksum," prefix).
 * @returns 16-bit checksum (0–65535).
 */
export declare function layoutChecksum(body: string): number;
/** Thrown when the layout string is malformed. */
export declare class LayoutParseError extends Error {
    constructor(message: string);
}
/**
 * Parse a full tmux layout string, including the 4-hex-digit checksum prefix.
 *
 * Format:  `<4hexdigits>,<cell>`
 * Example: `bb62,159x48,0,0,4`
 * Example: `e5d3,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}`
 *
 * The parsed checksum (`result.checksum`) and computed checksum
 * (`result.computedChecksum`) are both returned; callers can detect corruption
 * by comparing them. This function does NOT throw on checksum mismatch — it
 * only throws on structural parse errors.
 *
 * @param s - The raw layout string as it appears on the wire.
 * @returns ParsedLayout with geometry tree and both checksum values.
 * @throws LayoutParseError if the string is structurally malformed.
 */
export declare function parseLayout(s: string): ParsedLayout;
/**
 * Serialize a ParsedLayout back to the original layout string (including
 * checksum prefix). The checksum in the output is freshly computed from the
 * body, NOT taken from `layout.checksum` — so round-tripping a valid layout
 * produces an identical string.
 *
 * @param layout - A previously parsed layout (or a hand-constructed one).
 * @returns The wire-format layout string, e.g. `"bb62,159x48,0,0,4"`.
 */
export declare function dumpLayout(layout: ParsedLayout): string;
/** A window's cell size, in terminal columns × rows. */
export interface LayoutSize {
    readonly cols: number;
    readonly rows: number;
}
/**
 * Serialize a desired-geometry {@link TemplateNode} into a concrete tmux layout
 * string (checksum prefix + body), sized against `size` (the current window),
 * suitable for `select-layout '<string>'` (tc-gjdx.3).
 *
 * The panes must already exist in the window in the same depth-first order as
 * the tree's leaves (the compiler guarantees this by creating them in order);
 * `select-layout` then tiles them positionally into the cells this produces.
 *
 * Round-trips with {@link parseLayout}: `parseLayout(serializeGeometry(node,
 * size))` yields the same geometry (orientation + structure + integer-exact
 * sizes), which is how the serializer is verified against the parser.
 */
export declare function serializeGeometry(node: TemplateNode, size: LayoutSize): string;
//# sourceMappingURL=layout-string.d.ts.map