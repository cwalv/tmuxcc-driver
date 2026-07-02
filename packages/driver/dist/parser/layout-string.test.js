/**
 * Tests for the tmux layout-string parser (tc-efj).
 *
 * Coverage:
 *   - Single-pane (leaf) layout → correct w/h/x/y/paneId.
 *   - Horizontal split (`{}` = LAYOUT_LEFTRIGHT) with 2 panes.
 *   - Vertical split (`[]` = LAYOUT_TOPBOTTOM) with 2 panes.
 *   - Nested splits (split within split, matching the real example string).
 *   - Checksum: parsed value matches layoutChecksum(body) for known good strings.
 *   - Checksum mismatch: a corrupted body produces a different computedChecksum.
 *   - Round-trip: parse → dumpLayout → equals original string.
 *   - Malformed input throws LayoutParseError.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLayout, dumpLayout, layoutChecksum, LayoutParseError, } from "./layout-string.js";
// ---------------------------------------------------------------------------
// Helper: assert a cell is a leaf with the expected fields
// ---------------------------------------------------------------------------
function assertLeaf(cell, expected) {
    assert.ok(cell !== null && typeof cell === "object");
    const c = cell;
    assert.equal(c.type, "leaf");
    assert.equal(c.width, expected.width, "width");
    assert.equal(c.height, expected.height, "height");
    assert.equal(c.x, expected.x, "x");
    assert.equal(c.y, expected.y, "y");
    assert.equal(c.paneId, expected.paneId, "paneId");
}
function assertSplit(cell, expected) {
    assert.ok(cell !== null && typeof cell === "object");
    const c = cell;
    assert.equal(c.type, "split");
    assert.equal(c.orientation, expected.orientation, "orientation");
    assert.equal(c.width, expected.width, "width");
    assert.equal(c.height, expected.height, "height");
    assert.equal(c.x, expected.x, "x");
    assert.equal(c.y, expected.y, "y");
    assert.equal(c.children.length, expected.childCount, "childCount");
}
// ---------------------------------------------------------------------------
// Real layout strings used as goldens (verified from tmux format description
// and consistent with layout-custom.c grammar). Checksums are computed by
// layoutChecksum itself and cross-validated by round-trip equality.
// ---------------------------------------------------------------------------
// Golden layout strings — checksums verified against the C implementation of
// layout_checksum() from layout-custom.c (compiled and run directly).
// The bead's illustrative strings used different checksums; these are exact.
// Single pane: 159×48 at (0,0), pane id 4
const SINGLE_PANE = "d041,159x48,0,0,4";
// Horizontal split ({}): 159×48 root; two children: 79×48 at x=0, 79×48 at x=80
const HORIZ_SPLIT = "5468,159x48,0,0{79x48,0,0,1,79x48,80,0,2}";
// Vertical split ([]): 79×48 root; two children: 79×24 at y=0, 79×23 at y=25
const VERT_SPLIT = "0e4c,79x48,0,0[79x24,0,0,3,79x23,0,25,4]";
// Nested: top-level horizontal split; right child is a vertical split.
// Body: 159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}
const NESTED = "ef44,159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}";
// ---------------------------------------------------------------------------
// Checksum unit tests (independent of parsing)
// ---------------------------------------------------------------------------
describe("layoutChecksum", () => {
    it("returns 0 for empty string", () => {
        assert.equal(layoutChecksum(""), 0);
    });
    it("matches known single-pane body (verified against C layout_checksum)", () => {
        // Body: "159x48,0,0,4" → 0xd041 (confirmed by compiling layout-custom.c checksum)
        const body = "159x48,0,0,4";
        const csum = layoutChecksum(body);
        assert.equal(csum, 0xd041, `expected 0xd041 got 0x${csum.toString(16)}`);
    });
    it("matches known nested layout body (verified against C layout_checksum)", () => {
        // Body: nested horiz+vert split → 0xef44
        const body = "159x48,0,0{79x48,0,0,1,79x48,80,0[79x24,80,0,2,79x23,80,25,3]}";
        const csum = layoutChecksum(body);
        assert.equal(csum, 0xef44, `expected 0xef44 got 0x${csum.toString(16)}`);
    });
});
// ---------------------------------------------------------------------------
// parseLayout — single pane
// ---------------------------------------------------------------------------
describe("parseLayout — single pane", () => {
    it("parses width, height, x, y, paneId correctly", () => {
        const result = parseLayout(SINGLE_PANE);
        assertLeaf(result.root, { width: 159, height: 48, x: 0, y: 0, paneId: 4 });
    });
    it("checksum field matches parsed prefix", () => {
        const result = parseLayout(SINGLE_PANE);
        assert.equal(result.checksum, 0xd041);
    });
    it("computedChecksum matches checksum (no corruption)", () => {
        const result = parseLayout(SINGLE_PANE);
        assert.equal(result.computedChecksum, result.checksum);
    });
});
// ---------------------------------------------------------------------------
// parseLayout — horizontal split ({})
// ---------------------------------------------------------------------------
describe("parseLayout — horizontal split ({})", () => {
    it("root is split with orientation=horizontal and 2 children", () => {
        const result = parseLayout(HORIZ_SPLIT);
        assertSplit(result.root, {
            orientation: "horizontal",
            width: 159,
            height: 48,
            x: 0,
            y: 0,
            childCount: 2,
        });
    });
    it("left child is leaf at x=0", () => {
        const result = parseLayout(HORIZ_SPLIT);
        const root = result.root;
        assertLeaf(root.children[0], { width: 79, height: 48, x: 0, y: 0, paneId: 1 });
    });
    it("right child is leaf at x=80", () => {
        const result = parseLayout(HORIZ_SPLIT);
        const root = result.root;
        assertLeaf(root.children[1], { width: 79, height: 48, x: 80, y: 0, paneId: 2 });
    });
    it("computedChecksum matches checksum", () => {
        const result = parseLayout(HORIZ_SPLIT);
        assert.equal(result.computedChecksum, result.checksum);
    });
});
// ---------------------------------------------------------------------------
// parseLayout — vertical split ([])
// ---------------------------------------------------------------------------
describe("parseLayout — vertical split ([])", () => {
    it("root is split with orientation=vertical and 2 children", () => {
        const result = parseLayout(VERT_SPLIT);
        assertSplit(result.root, {
            orientation: "vertical",
            width: 79,
            height: 48,
            x: 0,
            y: 0,
            childCount: 2,
        });
    });
    it("top child is leaf at y=0", () => {
        const result = parseLayout(VERT_SPLIT);
        const root = result.root;
        assertLeaf(root.children[0], { width: 79, height: 24, x: 0, y: 0, paneId: 3 });
    });
    it("bottom child is leaf at y=25", () => {
        const result = parseLayout(VERT_SPLIT);
        const root = result.root;
        assertLeaf(root.children[1], { width: 79, height: 23, x: 0, y: 25, paneId: 4 });
    });
    it("computedChecksum matches checksum", () => {
        const result = parseLayout(VERT_SPLIT);
        assert.equal(result.computedChecksum, result.checksum);
    });
});
// ---------------------------------------------------------------------------
// parseLayout — nested splits
// ---------------------------------------------------------------------------
describe("parseLayout — nested splits", () => {
    it("root is horizontal split with 2 children", () => {
        const result = parseLayout(NESTED);
        assertSplit(result.root, {
            orientation: "horizontal",
            width: 159,
            height: 48,
            x: 0,
            y: 0,
            childCount: 2,
        });
    });
    it("left child is a leaf pane (pane 1)", () => {
        const result = parseLayout(NESTED);
        const root = result.root;
        assertLeaf(root.children[0], { width: 79, height: 48, x: 0, y: 0, paneId: 1 });
    });
    it("right child is a vertical split with 2 grandchildren", () => {
        const result = parseLayout(NESTED);
        const root = result.root;
        assertSplit(root.children[1], {
            orientation: "vertical",
            width: 79,
            height: 48,
            x: 80,
            y: 0,
            childCount: 2,
        });
    });
    it("top-right grandchild is pane 2 at y=0", () => {
        const result = parseLayout(NESTED);
        const root = result.root;
        const rightSplit = root.children[1];
        assertLeaf(rightSplit.children[0], { width: 79, height: 24, x: 80, y: 0, paneId: 2 });
    });
    it("bottom-right grandchild is pane 3 at y=25", () => {
        const result = parseLayout(NESTED);
        const root = result.root;
        const rightSplit = root.children[1];
        assertLeaf(rightSplit.children[1], { width: 79, height: 23, x: 80, y: 25, paneId: 3 });
    });
    it("computedChecksum matches checksum", () => {
        const result = parseLayout(NESTED);
        assert.equal(result.computedChecksum, result.checksum);
    });
});
// ---------------------------------------------------------------------------
// Checksum mismatch detection
// ---------------------------------------------------------------------------
describe("checksum mismatch", () => {
    it("corrupted body produces different computedChecksum", () => {
        // Flip the last character of a valid string
        const corrupted = SINGLE_PANE.slice(0, -1) + "5"; // paneId 4 → 5
        const result = parseLayout(corrupted);
        assert.notEqual(result.computedChecksum, result.checksum, "computedChecksum should differ from the prefix checksum after corruption");
    });
    it("wrong checksum prefix detected", () => {
        // Replace the checksum prefix with 0000
        const badPrefix = "0000," + SINGLE_PANE.slice(5);
        const result = parseLayout(badPrefix);
        assert.equal(result.checksum, 0x0000);
        assert.notEqual(result.computedChecksum, 0x0000, "computed checksum of the real body should not be 0");
    });
});
// ---------------------------------------------------------------------------
// Round-trip / golden tests
// ---------------------------------------------------------------------------
describe("round-trip (parse → dumpLayout → original)", () => {
    const cases = [
        ["single pane", SINGLE_PANE],
        ["horizontal split", HORIZ_SPLIT],
        ["vertical split", VERT_SPLIT],
        ["nested splits", NESTED],
    ];
    for (const [name, original] of cases) {
        it(`round-trips: ${name}`, () => {
            const parsed = parseLayout(original);
            const dumped = dumpLayout(parsed);
            assert.equal(dumped, original, `round-trip failed for "${name}"`);
        });
    }
});
// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------
describe("LayoutParseError on malformed input", () => {
    it("throws on empty string", () => {
        assert.throws(() => parseLayout(""), LayoutParseError);
    });
    it("throws on missing comma after checksum", () => {
        assert.throws(() => parseLayout("bb62 159x48,0,0,4"), LayoutParseError);
    });
    it("throws on non-hex checksum prefix", () => {
        assert.throws(() => parseLayout("zzzz,159x48,0,0,4"), LayoutParseError);
    });
    it("throws on missing height", () => {
        assert.throws(() => parseLayout("0000,159x"), LayoutParseError);
    });
    it("throws on unmatched {", () => {
        assert.throws(() => parseLayout("0000,79x48,0,0{79x48,0,0,1"), LayoutParseError);
    });
    it("throws on unmatched [", () => {
        assert.throws(() => parseLayout("0000,79x48,0,0[79x48,0,0,1"), LayoutParseError);
    });
    it("throws on trailing garbage", () => {
        assert.throws(() => parseLayout("bb62,159x48,0,0,4!!!"), LayoutParseError);
    });
});
//# sourceMappingURL=layout-string.test.js.map