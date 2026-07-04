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

import {
  parseLayout,
  dumpLayout,
  layoutChecksum,
  serializeGeometry,
  LayoutParseError,
  type LeafCell,
  type SplitCell,
} from "./layout-string.js";

// ---------------------------------------------------------------------------
// Helper: assert a cell is a leaf with the expected fields
// ---------------------------------------------------------------------------
function assertLeaf(
  cell: unknown,
  expected: { width: number; height: number; x: number; y: number; paneId: number | null },
): asserts cell is LeafCell {
  assert.ok(cell !== null && typeof cell === "object");
  const c = cell as LeafCell;
  assert.equal(c.type, "leaf");
  assert.equal(c.width, expected.width, "width");
  assert.equal(c.height, expected.height, "height");
  assert.equal(c.x, expected.x, "x");
  assert.equal(c.y, expected.y, "y");
  assert.equal(c.paneId, expected.paneId, "paneId");
}

function assertSplit(
  cell: unknown,
  expected: { orientation: "horizontal" | "vertical"; width: number; height: number; x: number; y: number; childCount: number },
): asserts cell is SplitCell {
  assert.ok(cell !== null && typeof cell === "object");
  const c = cell as SplitCell;
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
    const root = result.root as SplitCell;
    assertLeaf(root.children[0], { width: 79, height: 48, x: 0, y: 0, paneId: 1 });
  });

  it("right child is leaf at x=80", () => {
    const result = parseLayout(HORIZ_SPLIT);
    const root = result.root as SplitCell;
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
    const root = result.root as SplitCell;
    assertLeaf(root.children[0], { width: 79, height: 24, x: 0, y: 0, paneId: 3 });
  });

  it("bottom child is leaf at y=25", () => {
    const result = parseLayout(VERT_SPLIT);
    const root = result.root as SplitCell;
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
    const root = result.root as SplitCell;
    assertLeaf(root.children[0], { width: 79, height: 48, x: 0, y: 0, paneId: 1 });
  });

  it("right child is a vertical split with 2 grandchildren", () => {
    const result = parseLayout(NESTED);
    const root = result.root as SplitCell;
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
    const root = result.root as SplitCell;
    const rightSplit = root.children[1] as SplitCell;
    assertLeaf(rightSplit.children[0], { width: 79, height: 24, x: 80, y: 0, paneId: 2 });
  });

  it("bottom-right grandchild is pane 3 at y=25", () => {
    const result = parseLayout(NESTED);
    const root = result.root as SplitCell;
    const rightSplit = root.children[1] as SplitCell;
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
    assert.notEqual(result.computedChecksum, result.checksum,
      "computedChecksum should differ from the prefix checksum after corruption");
  });

  it("wrong checksum prefix detected", () => {
    // Replace the checksum prefix with 0000
    const badPrefix = "0000," + SINGLE_PANE.slice(5);
    const result = parseLayout(badPrefix);
    assert.equal(result.checksum, 0x0000);
    assert.notEqual(result.computedChecksum, 0x0000,
      "computed checksum of the real body should not be 0");
  });
});

// ---------------------------------------------------------------------------
// Round-trip / golden tests
// ---------------------------------------------------------------------------

describe("round-trip (parse → dumpLayout → original)", () => {
  const cases: [string, string][] = [
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

// ---------------------------------------------------------------------------
// Write direction: serializeGeometry (tc-gjdx.3)
// ---------------------------------------------------------------------------

/**
 * Assert a parsed layout cell satisfies tmux's `layout_check` invariants — the
 * exact-fit rules select-layout enforces (layout-custom.c). This is the
 * strongest static guarantee that tmux will ACCEPT the serialized string
 * (the real-tmux apply-at-create suite confirms it end to end).
 */
function assertLayoutConsistent(cell: LeafCell | SplitCell): void {
  if (cell.type === "leaf") return;
  const children = cell.children;
  if (cell.orientation === "horizontal") {
    // {} = LAYOUT_LEFTRIGHT: widths + (n-1) separators sum to parent; heights equal.
    let sum = 0;
    for (const c of children) {
      assert.equal(c.height, cell.height, "child height must equal parent (horizontal)");
      sum += c.width + 1;
    }
    assert.equal(sum - 1, cell.width, "children widths + separators must equal parent width");
  } else {
    // [] = LAYOUT_TOPBOTTOM: heights + (n-1) separators sum to parent; widths equal.
    let sum = 0;
    for (const c of children) {
      assert.equal(c.width, cell.width, "child width must equal parent (vertical)");
      sum += c.height + 1;
    }
    assert.equal(sum - 1, cell.height, "children heights + separators must equal parent height");
  }
  for (const c of children) assertLayoutConsistent(c as LeafCell | SplitCell);
}

describe("layout-string serializeGeometry (write direction, tc-gjdx.3)", () => {
  it("a lone pane leaf serializes to a checksummed leaf and round-trips", () => {
    const s = serializeGeometry({ kind: "pane" }, { cols: 120, rows: 40 });
    const parsed = parseLayout(s);
    assert.equal(parsed.computedChecksum, parsed.checksum, "checksum must be valid");
    assert.equal(parsed.root.type, "leaf");
    const leaf = parsed.root as LeafCell;
    assert.equal(leaf.width, 120);
    assert.equal(leaf.height, 40);
    assert.equal(leaf.x, 0);
    assert.equal(leaf.y, 0);
    assert.equal(leaf.paneId, null, "serialized leaves carry no pane id (positional assignment)");
  });

  it("hsplit(2) → horizontal `{}` split, exact-fit, round-trips", () => {
    const s = serializeGeometry(
      { kind: "hsplit", children: [{ kind: "pane" }, { kind: "pane" }] },
      { cols: 200, rows: 50 },
    );
    const parsed = parseLayout(s);
    assert.equal(parsed.computedChecksum, parsed.checksum);
    assert.equal(parsed.root.type, "split");
    const root = parsed.root as SplitCell;
    assert.equal(root.orientation, "horizontal", "hsplit = side-by-side = horizontal = {}");
    assert.equal(root.children.length, 2);
    assertLayoutConsistent(root);
    // Equal split of 200 with one separator: 99 + 1 + 100 = 200 (or 100/99).
    const [a, b] = root.children as LeafCell[];
    assert.equal(a!.width + b!.width + 1, 200);
    assert.equal(a!.height, 50);
    assert.equal(b!.height, 50);
  });

  it("vsplit(3) → vertical `[]` split, exact-fit, round-trips", () => {
    const s = serializeGeometry(
      { kind: "vsplit", children: [{ kind: "pane" }, { kind: "pane" }, { kind: "pane" }] },
      { cols: 200, rows: 50 },
    );
    const parsed = parseLayout(s);
    assert.equal(parsed.computedChecksum, parsed.checksum);
    const root = parsed.root as SplitCell;
    assert.equal(root.orientation, "vertical", "vsplit = stacked = vertical = []");
    assert.equal(root.children.length, 3);
    assertLayoutConsistent(root);
    // Heights + 2 separators == 50; each full width.
    const heights = (root.children as LeafCell[]).map((c) => c.height);
    assert.equal(heights.reduce((a, b) => a + b, 0) + 2, 50);
    for (const c of root.children as LeafCell[]) assert.equal(c.width, 200);
    // y-offsets are cumulative (stacked top→bottom).
    assert.equal((root.children[0] as LeafCell).y, 0);
  });

  it("nested hsplit[pane, vsplit(2)] stays exact-fit and round-trips", () => {
    const node = {
      kind: "hsplit" as const,
      children: [
        { kind: "pane" as const },
        { kind: "vsplit" as const, children: [{ kind: "pane" as const }, { kind: "pane" as const }] },
      ],
    };
    const s = serializeGeometry(node, { cols: 160, rows: 48 });
    const parsed = parseLayout(s);
    assert.equal(parsed.computedChecksum, parsed.checksum);
    const root = parsed.root as SplitCell;
    assert.equal(root.orientation, "horizontal");
    assert.equal(root.children.length, 2);
    assert.equal(root.children[0]!.type, "leaf");
    assert.equal(root.children[1]!.type, "split");
    assert.equal((root.children[1] as SplitCell).orientation, "vertical");
    assertLayoutConsistent(root);
  });

  it("proportional sizes bias the split roughly by weight, staying exact-fit", () => {
    const s = serializeGeometry(
      { kind: "hsplit", children: [{ kind: "pane" }, { kind: "pane" }], sizes: [3, 1] },
      { cols: 200, rows: 50 },
    );
    const parsed = parseLayout(s);
    const root = parsed.root as SplitCell;
    assertLayoutConsistent(root);
    const [a, b] = root.children as LeafCell[];
    // 3:1 of the 198 pane-cells (200 minus one separator) ≈ 148.5 : 49.5.
    assert.ok(a!.width > b!.width, "the 3-weight child must be wider");
    assert.ok(a!.width >= 140 && a!.width <= 152, `left width ${a!.width} ~ 3/4 of 198`);
    assert.equal(a!.width + b!.width + 1, 200);
  });

  it("many-pane hsplit distributes exactly (no off-by-one)", () => {
    const children = Array.from({ length: 7 }, () => ({ kind: "pane" as const }));
    const s = serializeGeometry({ kind: "hsplit", children }, { cols: 203, rows: 50 });
    const parsed = parseLayout(s);
    const root = parsed.root as SplitCell;
    assert.equal(root.children.length, 7);
    assertLayoutConsistent(root);
    // Every pane at least 1 wide.
    for (const c of root.children as LeafCell[]) assert.ok(c.width >= 1);
  });
});
