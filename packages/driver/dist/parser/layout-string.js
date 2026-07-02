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
export function layoutChecksum(body) {
    let csum = 0;
    for (let i = 0; i < body.length; i++) {
        // Rotate right by 1 bit within 16 bits
        csum = ((csum >> 1) | ((csum & 1) << 15)) & 0xffff;
        // Add the character code
        csum = (csum + body.charCodeAt(i)) & 0xffff;
    }
    return csum;
}
function peek(cur) {
    return cur.s[cur.pos] ?? "";
}
function advance(cur) {
    cur.pos++;
}
/** Read a run of ASCII digits and return the parsed integer, or null if none. */
function readUint(cur) {
    const start = cur.pos;
    while (cur.pos < cur.s.length) {
        const ch = cur.s[cur.pos];
        if (ch < "0" || ch > "9")
            break;
        cur.pos++;
    }
    if (cur.pos === start)
        return null;
    return parseInt(cur.s.slice(start, cur.pos), 10);
}
/** Expect a specific character; throw ParseError if it's not there. */
function expect(cur, ch) {
    if (cur.s[cur.pos] !== ch) {
        throw new LayoutParseError(`Expected '${ch}' at position ${cur.pos}, got '${cur.s[cur.pos] ?? "EOF"}'`);
    }
    cur.pos++;
}
// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------
/** Thrown when the layout string is malformed. */
export class LayoutParseError extends Error {
    constructor(message) {
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
function parseGeometry(cur) {
    const width = readUint(cur);
    if (width === null)
        throw new LayoutParseError(`Expected width at position ${cur.pos}`);
    expect(cur, "x");
    const height = readUint(cur);
    if (height === null)
        throw new LayoutParseError(`Expected height at position ${cur.pos}`);
    expect(cur, ",");
    const x = readUint(cur);
    if (x === null)
        throw new LayoutParseError(`Expected x offset at position ${cur.pos}`);
    expect(cur, ",");
    const y = readUint(cur);
    if (y === null)
        throw new LayoutParseError(`Expected y offset at position ${cur.pos}`);
    return { width, height, x, y };
}
/**
 * Parse one cell (geometry + leaf/split body), matching layout_construct_cell +
 * layout_construct from layout-custom.c.
 */
function parseCell(cur) {
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
    let paneId = null;
    if (ch === ",") {
        const savedPos = cur.pos;
        advance(cur); // consume ','
        const id = readUint(cur);
        if (id !== null && peek(cur) === "x") {
            // It's a new sibling cell starting after the comma — backtrack
            cur.pos = savedPos;
        }
        else if (id !== null) {
            paneId = id;
        }
        else {
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
function parseChildren(cur) {
    const children = [];
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
export function parseLayout(s) {
    // Expect exactly 4 hex digits followed by ','
    if (s.length < 5 || s[4] !== ",") {
        throw new LayoutParseError(`Layout string must start with 4 hex digits followed by ','; got: ${JSON.stringify(s.slice(0, 6))}`);
    }
    const checksumStr = s.slice(0, 4);
    if (!/^[0-9a-f]{4}$/i.test(checksumStr)) {
        throw new LayoutParseError(`Checksum prefix must be exactly 4 hex digits, got: ${JSON.stringify(checksumStr)}`);
    }
    const checksum = parseInt(checksumStr, 16);
    const body = s.slice(5); // everything after "checksum,"
    const computedChecksum = layoutChecksum(body);
    const cur = { s: body, pos: 0 };
    const root = parseCell(cur);
    if (cur.pos !== body.length) {
        throw new LayoutParseError(`Unexpected trailing input at position ${cur.pos + 5}: ${JSON.stringify(body.slice(cur.pos))}`);
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
function dumpCell(cell) {
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
export function dumpLayout(layout) {
    const body = dumpCell(layout.root);
    const csum = layoutChecksum(body);
    const prefix = csum.toString(16).padStart(4, "0");
    return `${prefix},${body}`;
}
//# sourceMappingURL=layout-string.js.map