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

// ---------------------------------------------------------------------------
// Geometry tree types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

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
export function layoutChecksum(body: string): number {
  let csum = 0;
  for (let i = 0; i < body.length; i++) {
    // Rotate right by 1 bit within 16 bits
    csum = ((csum >> 1) | ((csum & 1) << 15)) & 0xffff;
    // Add the character code
    csum = (csum + body.charCodeAt(i)) & 0xffff;
  }
  return csum;
}

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

/**
 * Mutable cursor used during recursive descent parsing.
 * Using an object avoids passing index by reference repeatedly.
 */
interface Cursor {
  s: string;
  pos: number;
}

function peek(cur: Cursor): string {
  return cur.s[cur.pos] ?? "";
}

function advance(cur: Cursor): void {
  cur.pos++;
}

/** Read a run of ASCII digits and return the parsed integer, or null if none. */
function readUint(cur: Cursor): number | null {
  const start = cur.pos;
  while (cur.pos < cur.s.length) {
    const ch = cur.s[cur.pos]!;
    if (ch < "0" || ch > "9") break;
    cur.pos++;
  }
  if (cur.pos === start) return null;
  return parseInt(cur.s.slice(start, cur.pos), 10);
}

/** Expect a specific character; throw ParseError if it's not there. */
function expect(cur: Cursor, ch: string): void {
  if (cur.s[cur.pos] !== ch) {
    throw new LayoutParseError(
      `Expected '${ch}' at position ${cur.pos}, got '${cur.s[cur.pos] ?? "EOF"}'`,
    );
  }
  cur.pos++;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Thrown when the layout string is malformed. */
export class LayoutParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutParseError";
  }
}

// ---------------------------------------------------------------------------
// Recursive descent parser
// ---------------------------------------------------------------------------

/**
 * Parse the geometry header: `<width>x<height>,<x>,<y>`
 * Returns the four numeric fields and leaves `cur.pos` pointing at the character
 * immediately after the yoff digits (which will be `,`, `{`, `[`, `}`, `]`, or EOF).
 */
function parseGeometry(cur: Cursor): { width: number; height: number; x: number; y: number } {
  const width = readUint(cur);
  if (width === null) throw new LayoutParseError(`Expected width at position ${cur.pos}`);
  expect(cur, "x");
  const height = readUint(cur);
  if (height === null) throw new LayoutParseError(`Expected height at position ${cur.pos}`);
  expect(cur, ",");
  const x = readUint(cur);
  if (x === null) throw new LayoutParseError(`Expected x offset at position ${cur.pos}`);
  expect(cur, ",");
  const y = readUint(cur);
  if (y === null) throw new LayoutParseError(`Expected y offset at position ${cur.pos}`);
  return { width, height, x, y };
}

/**
 * Parse one cell (geometry + leaf/split body), matching layout_construct_cell +
 * layout_construct from layout-custom.c.
 */
function parseCell(cur: Cursor): LayoutCell {
  const { width, height, x, y } = parseGeometry(cur);

  const ch = peek(cur);

  if (ch === "{") {
    // LAYOUT_LEFTRIGHT — horizontal split; children are comma-separated
    advance(cur); // consume '{'
    const children = parseChildren(cur);
    expect(cur, "}");
    return { type: "split", orientation: "horizontal", width, height, x, y, children };
  }

  if (ch === "[") {
    // LAYOUT_TOPBOTTOM — vertical split; children are comma-separated
    advance(cur); // consume '['
    const children = parseChildren(cur);
    expect(cur, "]");
    return { type: "split", orientation: "vertical", width, height, x, y, children };
  }

  // Leaf: possibly followed by `,paneId`
  // Disambiguation rule from layout_construct_cell:
  //   if the next char is ',', try to consume ',digits'. If the char after those
  //   digits is 'x', backtrack (it's a sibling cell, not a pane ID). Otherwise
  //   keep the advance and record the pane ID.
  let paneId: number | null = null;
  if (ch === ",") {
    const savedPos = cur.pos;
    advance(cur); // consume ','
    const id = readUint(cur);
    if (id !== null && peek(cur) === "x") {
      // It's a new sibling cell starting after the comma — backtrack
      cur.pos = savedPos;
    } else if (id !== null) {
      paneId = id;
    } else {
      // No digits after ',' — backtrack
      cur.pos = savedPos;
    }
  }

  return { type: "leaf", width, height, x, y, paneId };
}

/**
 * Parse a comma-separated list of child cells inside `{...}` or `[...]`.
 * Stops when the current character is `}` or `]` (does not consume it).
 */
function parseChildren(cur: Cursor): LayoutCell[] {
  const children: LayoutCell[] = [];
  children.push(parseCell(cur));
  while (peek(cur) === ",") {
    advance(cur); // consume ','
    children.push(parseCell(cur));
  }
  return children;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
export function parseLayout(s: string): ParsedLayout {
  // Expect exactly 4 hex digits followed by ','
  if (s.length < 5 || s[4] !== ",") {
    throw new LayoutParseError(
      `Layout string must start with 4 hex digits followed by ','; got: ${JSON.stringify(s.slice(0, 6))}`,
    );
  }
  const checksumStr = s.slice(0, 4);
  if (!/^[0-9a-f]{4}$/i.test(checksumStr)) {
    throw new LayoutParseError(
      `Checksum prefix must be exactly 4 hex digits, got: ${JSON.stringify(checksumStr)}`,
    );
  }
  const checksum = parseInt(checksumStr, 16);
  const body = s.slice(5); // everything after "checksum,"

  const computedChecksum = layoutChecksum(body);

  const cur: Cursor = { s: body, pos: 0 };
  const root = parseCell(cur);

  if (cur.pos !== body.length) {
    throw new LayoutParseError(
      `Unexpected trailing input at position ${cur.pos + 5}: ${JSON.stringify(body.slice(cur.pos))}`,
    );
  }

  return { checksum, computedChecksum, root };
}

// ---------------------------------------------------------------------------
// Serializer (dump) — enables round-trip testing
// ---------------------------------------------------------------------------

/**
 * Serialize a geometry cell back to the body format (without checksum prefix).
 * Mirrors layout_append from layout-custom.c.
 */
function dumpCell(cell: LayoutCell): string {
  const geo = `${cell.width}x${cell.height},${cell.x},${cell.y}`;

  if (cell.type === "leaf") {
    return cell.paneId !== null ? `${geo},${cell.paneId}` : geo;
  }

  // Split cell
  const open = cell.orientation === "horizontal" ? "{" : "[";
  const close = cell.orientation === "horizontal" ? "}" : "]";
  const childrenStr = cell.children.map(dumpCell).join(",");
  return `${geo}${open}${childrenStr}${close}`;
}

/**
 * Serialize a ParsedLayout back to the original layout string (including
 * checksum prefix). The checksum in the output is freshly computed from the
 * body, NOT taken from `layout.checksum` — so round-tripping a valid layout
 * produces an identical string.
 *
 * @param layout - A previously parsed layout (or a hand-constructed one).
 * @returns The wire-format layout string, e.g. `"bb62,159x48,0,0,4"`.
 */
export function dumpLayout(layout: ParsedLayout): string {
  const body = dumpCell(layout.root);
  const csum = layoutChecksum(body);
  const prefix = csum.toString(16).padStart(4, "0");
  return `${prefix},${body}`;
}

// ---------------------------------------------------------------------------
// Write direction: DESIRED-geometry tree → concrete tmux layout string (tc-gjdx.3)
//
// The template compiler (tc-gjdx.3) turns a window's DESIRED-geometry tree — a
// proportional {@link TemplateNode} with NO absolute sizes and NO pane ids —
// into a concrete `select-layout` string sized against the CURRENT window.
//
// Two tmux facts (verified against layout-custom.c) shape this:
//
//   1. `select-layout` assigns the window's EXISTING panes to the layout's
//      leaf cells POSITIONALLY, in `w->panes` order (layout_assign walks
//      TAILQ_FIRST(&w->panes)); the pane ids in the string are IGNORED. So the
//      serialized leaves carry NO pane id — the `window_layout` form
//      select-layout accepts — and the compiler is responsible for creating the
//      panes in the same depth-first order as the leaves here.
//
//   2. `layout_check` requires EXACT integer consistency: for a left-right
//      (`{}`) split the children's widths plus (n-1) separators sum to the
//      parent width and every child's height equals the parent's; for a
//      top-bottom (`[]`) split, the mirror on the height axis. A layout that
//      does not fit is rejected with "size mismatch after applying layout". So
//      the size distribution below is integer-exact by construction.
//
// tmux resizes the window to the layout's root size then reflows to the client
// (window_resize + recalculate_sizes), so the ABSOLUTE size passed here only
// has to be internally consistent and fit the panes — the proportions are what
// survive. We size to the current window so the panes always fit.
//
// Orientation mapping (state/model.ts / the parser above are authoritative;
// the `[…]`/`{…}` parentheticals in the protocol layout doc-comments are
// backwards — the SEMANTICS are the contract):
//   hsplit  = side-by-side, left→right = "horizontal" = `{}` = LAYOUT_LEFTRIGHT
//   vsplit  = stacked,      top→bottom = "vertical"   = `[]` = LAYOUT_TOPBOTTOM
// ---------------------------------------------------------------------------

/** A window's cell size, in terminal columns × rows. */
export interface LayoutSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Distribute `total` cells across `n` children by proportional `weights`,
 * returning integer sizes that sum EXACTLY to `total`, each at least 1 (when
 * `total >= n`).
 *
 * `total` is the space available for the panes THEMSELVES — the caller has
 * already subtracted the (n-1) inter-pane separator cells. Every pane gets a
 * baseline 1 cell, then the remainder is apportioned by weight using the
 * largest-remainder method so the sum stays exact and the split is stable.
 *
 * Degenerate: when `total < n` (a window too small to give each pane a cell)
 * we fall back to an as-even-as-possible non-negative split whose sum is still
 * exactly `total`. The resulting layout may then be rejected by tmux's
 * `layout_check` — a loud, correct failure (fail-loud, no silent clamp).
 */
function distributeSizes(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (n === 1) return [total];

  if (total < n) {
    // Too tight to guarantee >= 1 per pane; even split with exact sum.
    const each = Math.floor(total / n);
    const out = new Array<number>(n).fill(each);
    let rem = total - each * n;
    for (let i = 0; i < n && rem > 0; i++, rem--) out[i] = out[i]! + 1;
    return out;
  }

  // Normalise weights: non-positive / non-finite weights fall back to equal.
  const norm = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const weightSum = norm.reduce((a, b) => a + b, 0);
  const effective = weightSum > 0 ? norm : new Array<number>(n).fill(1);
  const effSum = weightSum > 0 ? weightSum : n;

  const remaining = total - n; // baseline 1 per pane
  const exact = effective.map((w) => (remaining * w) / effSum);
  const floors = exact.map((e) => Math.floor(e));
  const assigned = floors.reduce((a, b) => a + b, 0);
  const leftover = remaining - assigned; // 0..n-1

  // Largest fractional remainder gets the leftover +1s.
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);
  const out = effective.map((_, i) => 1 + floors[i]!);
  for (let k = 0; k < leftover; k++) {
    const idx = order[k]!.i;
    out[idx] = out[idx]! + 1;
  }
  return out;
}

/** Equal weights when `sizes` is omitted; otherwise the provided weights. */
function weightsFor(childCount: number, sizes?: readonly number[]): number[] {
  if (sizes === undefined || sizes.length !== childCount) {
    return new Array<number>(childCount).fill(1);
  }
  return sizes.slice();
}

/**
 * Convert a desired-geometry {@link TemplateNode} into a concrete
 * {@link LayoutCell} occupying the rectangle `(xoff, yoff, sx, sy)`.
 *
 * Sizes are distributed integer-exact so the resulting tree passes tmux's
 * `layout_check`. Leaves carry `paneId: null` (positional assignment — see the
 * module note above).
 */
function geometryToCell(
  node: TemplateNode,
  sx: number,
  sy: number,
  xoff: number,
  yoff: number,
): LayoutCell {
  if (node.kind === "pane") {
    return { type: "leaf", width: sx, height: sy, x: xoff, y: yoff, paneId: null };
  }

  const horizontal = node.kind === "hsplit";
  const children = node.children;
  const n = children.length;
  const weights = weightsFor(n, node.sizes);

  if (horizontal) {
    // Split the WIDTH; each child spans the full height. n-1 separator columns.
    const widths = distributeSizes(sx - (n - 1), weights);
    let cx = xoff;
    const cells = children.map((child, i) => {
      const cell = geometryToCell(child, widths[i]!, sy, cx, yoff);
      cx += widths[i]! + 1;
      return cell;
    });
    return { type: "split", orientation: "horizontal", width: sx, height: sy, x: xoff, y: yoff, children: cells };
  }

  // Vertical: split the HEIGHT; each child spans the full width. n-1 separators.
  const heights = distributeSizes(sy - (n - 1), weights);
  let cy = yoff;
  const cells = children.map((child, i) => {
    const cell = geometryToCell(child, sx, heights[i]!, xoff, cy);
    cy += heights[i]! + 1;
    return cell;
  });
  return { type: "split", orientation: "vertical", width: sx, height: sy, x: xoff, y: yoff, children: cells };
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
export function serializeGeometry(node: TemplateNode, size: LayoutSize): string {
  const root = geometryToCell(node, size.cols, size.rows, 0, 0);
  // dumpLayout recomputes the checksum from the body, so the placeholder
  // checksum fields here are ignored.
  return dumpLayout({ checksum: 0, computedChecksum: 0, root });
}
