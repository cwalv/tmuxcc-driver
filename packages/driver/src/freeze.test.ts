/**
 * freeze.test.ts — unit tests for the tc-gjdx.5 freeze logic.
 *
 * Tests:
 *   U1. actualToDesiredNode: single-pane leaf → TemplatePane with cwd.
 *   U2. actualToDesiredNode: horizontal split → hsplit with proportional sizes.
 *   U3. actualToDesiredNode: vertical split → vsplit with proportional sizes.
 *   U4. actualToDesiredNode: nested wild tree preserves orientation mapping.
 *   U5. buildFrozenTemplate: produces a schema-valid SessionTemplate.
 *   U6. buildFrozenTemplate: optional name is embedded.
 *   U7. buildFrozenTemplate: window with empty name → name field omitted.
 *   U8. freeze→desired tree→serializeGeometry round-trip (pure): the desired
 *       tree re-serializes to a layout string with the same topology and
 *       integer-exact total sizes (verifies proportional-size derivation
 *       is self-consistent with serializeGeometry).
 *
 * @module freeze.test
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";

import { actualToDesiredNode, buildFrozenTemplate } from "./template/freeze.js";
import type { FreezeSessionData } from "./template/freeze.js";
import { parseLayout, serializeGeometry, layoutChecksum } from "./parser/layout-string.js";
import type { LayoutCell } from "./parser/layout-string.js";

// ---------------------------------------------------------------------------
// Schema setup (ajv)
// ---------------------------------------------------------------------------

const __here = dirname(fileURLToPath(import.meta.url));
const driverRoot = resolve(__here, "../../../");
const schemaDir = resolve(driverRoot, "protocol/schemas");

const SCHEMA_FILES = [
  "shared/primitives.json",
  "shared/layout.json",
  "shared/session-template.json",
] as const;

let ajv: InstanceType<typeof Ajv2020>;
let validateTemplate: ValidateFunction;

before(() => {
  ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const file of SCHEMA_FILES) {
    const raw = readFileSync(resolve(schemaDir, file), "utf8");
    ajv.addSchema(JSON.parse(raw) as object);
  }
  validateTemplate = ajv.compile({
    $ref: "tmuxcc:shared/session-template#/$defs/SessionTemplate",
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCwdMap(entries: Array<[number, string]>): Map<number, string> {
  return new Map(entries);
}

/**
 * Build a valid tmux layout string from a LayoutCell tree (with real pane IDs).
 * Uses the same checksum algorithm as tmux.
 */
function buildLayoutString(root: LayoutCell): string {
  function dumpCell(cell: LayoutCell): string {
    const geo = `${cell.width}x${cell.height},${cell.x},${cell.y}`;
    if (cell.type === "leaf") {
      return cell.paneId !== null ? `${geo},${cell.paneId}` : geo;
    }
    const open = cell.orientation === "horizontal" ? "{" : "[";
    const close = cell.orientation === "horizontal" ? "}" : "]";
    return `${geo}${open}${cell.children.map(dumpCell).join(",")}${close}`;
  }
  const body = dumpCell(root);
  const csum = layoutChecksum(body).toString(16).padStart(4, "0");
  return `${csum},${body}`;
}

// ---------------------------------------------------------------------------
// U1–U4: actualToDesiredNode
// ---------------------------------------------------------------------------

describe("actualToDesiredNode", () => {
  it("U1: single leaf → TemplatePane with cwd", () => {
    const leaf: LayoutCell = { type: "leaf", width: 80, height: 24, x: 0, y: 0, paneId: 3 };
    const node = actualToDesiredNode(leaf, makeCwdMap([[3, "/home/user/project"]]));
    assert.deepEqual(node, { kind: "pane", cwd: "/home/user/project" });
  });

  it("U1b: leaf with paneId not in map → TemplatePane without cwd", () => {
    const leaf: LayoutCell = { type: "leaf", width: 80, height: 24, x: 0, y: 0, paneId: 99 };
    const node = actualToDesiredNode(leaf, new Map());
    assert.deepEqual(node, { kind: "pane" });
  });

  it("U1c: leaf with null paneId → TemplatePane without cwd", () => {
    const leaf: LayoutCell = { type: "leaf", width: 80, height: 24, x: 0, y: 0, paneId: null };
    const node = actualToDesiredNode(leaf, makeCwdMap([[1, "/somewhere"]]));
    assert.deepEqual(node, { kind: "pane" });
  });

  it("U2: horizontal split → hsplit with children widths as proportional sizes", () => {
    // Two 80-col panes in a 161-col window (80+1+80=161)
    const split: LayoutCell = {
      type: "split",
      orientation: "horizontal",
      width: 161,
      height: 48,
      x: 0,
      y: 0,
      children: [
        { type: "leaf", width: 80, height: 48, x: 0, y: 0, paneId: 1 },
        { type: "leaf", width: 80, height: 48, x: 81, y: 0, paneId: 2 },
      ],
    };
    const node = actualToDesiredNode(split, makeCwdMap([[1, "/a"], [2, "/b"]]));
    assert.equal(node.kind, "hsplit");
    assert.ok("sizes" in node);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeAny = node as any;
    assert.deepEqual(nodeAny.sizes, [80, 80]);
    assert.equal(nodeAny.children.length, 2);
    assert.deepEqual(nodeAny.children[0], { kind: "pane", cwd: "/a" });
    assert.deepEqual(nodeAny.children[1], { kind: "pane", cwd: "/b" });
  });

  it("U3: vertical split → vsplit with children heights as proportional sizes", () => {
    // 18-row top, 5-row bottom in a 24-row window (18+1+5=24)
    const split: LayoutCell = {
      type: "split",
      orientation: "vertical",
      width: 80,
      height: 24,
      x: 0,
      y: 0,
      children: [
        { type: "leaf", width: 80, height: 18, x: 0, y: 0, paneId: 1 },
        { type: "leaf", width: 80, height: 5, x: 0, y: 19, paneId: 2 },
      ],
    };
    const node = actualToDesiredNode(split, makeCwdMap([[1, "/work"], [2, "/logs"]]));
    assert.equal(node.kind, "vsplit");
    assert.ok("sizes" in node);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeAny = node as any;
    assert.deepEqual(nodeAny.sizes, [18, 5]);
    assert.deepEqual(nodeAny.children[0], { kind: "pane", cwd: "/work" });
    assert.deepEqual(nodeAny.children[1], { kind: "pane", cwd: "/logs" });
  });

  it("U4: nested wild tree — horizontal→hsplit, vertical→vsplit", () => {
    // Root vsplit contains an hsplit and a leaf.
    const root: LayoutCell = {
      type: "split",
      orientation: "vertical",    // → vsplit
      width: 80,
      height: 24,
      x: 0,
      y: 0,
      children: [
        {
          type: "split",
          orientation: "horizontal", // → hsplit
          width: 80,
          height: 18,
          x: 0,
          y: 0,
          children: [
            { type: "leaf", width: 39, height: 18, x: 0, y: 0, paneId: 1 },
            { type: "leaf", width: 40, height: 18, x: 40, y: 0, paneId: 2 },
          ],
        },
        { type: "leaf", width: 80, height: 5, x: 0, y: 19, paneId: 3 },
      ],
    };
    const node = actualToDesiredNode(root, makeCwdMap([[1, "/src"], [2, "/test"], [3, "/"]]));

    assert.equal(node.kind, "vsplit");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeAny = node as any;
    assert.equal(nodeAny.children.length, 2);

    assert.equal(nodeAny.children[0].kind, "hsplit");
    assert.deepEqual(nodeAny.children[0].children[0], { kind: "pane", cwd: "/src" });
    assert.deepEqual(nodeAny.children[0].children[1], { kind: "pane", cwd: "/test" });

    assert.deepEqual(nodeAny.children[1], { kind: "pane", cwd: "/" });
  });
});

// ---------------------------------------------------------------------------
// U5–U7: buildFrozenTemplate
// ---------------------------------------------------------------------------

describe("buildFrozenTemplate", () => {
  // A single-pane session.
  const singlePaneData: FreezeSessionData = {
    windows: [
      {
        windowId: "@1",
        name: "shell",
        layoutString: buildLayoutString({
          type: "leaf", width: 80, height: 24, x: 0, y: 0, paneId: 1,
        }),
      },
    ],
    panes: [{ paneNum: 1, windowId: "@1", cwd: "/home/user" }],
  };

  it("U5: single-pane window → schema-valid SessionTemplate", () => {
    const t = buildFrozenTemplate(singlePaneData);
    assert.ok(validateTemplate(t), `schema invalid: ${JSON.stringify(validateTemplate.errors)}`);
    assert.equal(t.windows.length, 1);
    assert.equal(t.windows[0]!.name, "shell");
    const geo = t.windows[0]!.geometry;
    assert.ok(geo !== undefined);
    assert.equal(geo!.kind, "pane");
    assert.equal((geo as { cwd?: string }).cwd, "/home/user");
  });

  it("U6: optional name is embedded in the frozen template", () => {
    const t = buildFrozenTemplate(singlePaneData, "my-snapshot");
    assert.ok(validateTemplate(t), `schema invalid: ${JSON.stringify(validateTemplate.errors)}`);
    assert.equal(t.name, "my-snapshot");
  });

  it("U7: window with empty name → name field omitted", () => {
    const data: FreezeSessionData = {
      windows: [
        {
          windowId: "@1",
          name: "",
          layoutString: buildLayoutString({
            type: "leaf", width: 80, height: 24, x: 0, y: 0, paneId: 1,
          }),
        },
      ],
      panes: [{ paneNum: 1, windowId: "@1", cwd: "/tmp" }],
    };
    const t = buildFrozenTemplate(data);
    assert.ok(validateTemplate(t), `schema invalid: ${JSON.stringify(validateTemplate.errors)}`);
    assert.equal(t.windows[0]!.name, undefined);
  });

  it("U5b: two-pane hsplit window → schema-valid SessionTemplate with hsplit geometry", () => {
    // 159-column window with a 2-pane horizontal split (79+1+79=159)
    const root: LayoutCell = {
      type: "split",
      orientation: "horizontal",
      width: 159,
      height: 48,
      x: 0,
      y: 0,
      children: [
        { type: "leaf", width: 79, height: 48, x: 0, y: 0, paneId: 1 },
        { type: "leaf", width: 79, height: 48, x: 80, y: 0, paneId: 2 },
      ],
    };
    const data: FreezeSessionData = {
      windows: [{ windowId: "@1", name: "dev", layoutString: buildLayoutString(root) }],
      panes: [
        { paneNum: 1, windowId: "@1", cwd: "/project" },
        { paneNum: 2, windowId: "@1", cwd: "/project/src" },
      ],
    };
    const t = buildFrozenTemplate(data);
    assert.ok(validateTemplate(t), `schema invalid: ${JSON.stringify(validateTemplate.errors)}`);
    assert.equal(t.windows[0]!.geometry!.kind, "hsplit");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geo = t.windows[0]!.geometry as any;
    assert.equal(geo.children.length, 2);
    assert.deepEqual(geo.sizes, [79, 79]);
  });
});

// ---------------------------------------------------------------------------
// U8: freeze→desired tree→serializeGeometry round-trip (pure)
// ---------------------------------------------------------------------------

describe("freeze→desired tree→serializeGeometry round-trip (pure)", () => {
  it("U8: hsplit actual tree → desired node → re-serializes with same topology", () => {
    // Real layout string: "e5d3,159x48,0,0{79x48,0,0,1,79x48,80,0,2}"
    const layoutStr = "e5d3,159x48,0,0{79x48,0,0,1,79x48,80,0,2}";
    const parsed = parseLayout(layoutStr);
    assert.equal(parsed.root.type, "split");

    const cwdMap = makeCwdMap([[1, "/a"], [2, "/b"]]);
    const desired = actualToDesiredNode(parsed.root, cwdMap);
    assert.equal(desired.kind, "hsplit");
    assert.ok("sizes" in desired);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.deepEqual((desired as any).sizes, [79, 79]);

    // Re-serialize at the same window size.
    const size = { cols: 159, rows: 48 };
    const reStr = serializeGeometry(desired, size);
    const reParsed = parseLayout(reStr);

    // Same topology: horizontal split, 2 children.
    assert.equal(reParsed.root.type, "split");
    const reRoot = reParsed.root as Extract<LayoutCell, { type: "split" }>;
    assert.equal(reRoot.orientation, "horizontal");
    assert.equal(reRoot.children.length, 2);
    // Equal-weight 79:79 in 159 cols → distributeSizes(157,[79,79]) → [79,79] (exact)
    assert.equal(reRoot.children[0]!.width, 79);
    assert.equal(reRoot.children[1]!.width, 79);
    // Total must sum: 79 + 1 + 79 = 159 ✓
    assert.equal(reRoot.children[0]!.width + 1 + reRoot.children[1]!.width, 159);
  });

  it("U8b: vsplit actual tree → desired node → re-serializes with total-size invariant", () => {
    // Build a vsplit cell directly (no need to parse from a string).
    const root: LayoutCell = {
      type: "split",
      orientation: "vertical",
      width: 80,
      height: 24,
      x: 0,
      y: 0,
      children: [
        { type: "leaf", width: 80, height: 18, x: 0, y: 0, paneId: 1 },
        { type: "leaf", width: 80, height: 5, x: 0, y: 19, paneId: 2 },
      ],
    };
    const desired = actualToDesiredNode(root, makeCwdMap([[1, "/top"], [2, "/bot"]]));
    assert.equal(desired.kind, "vsplit");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.deepEqual((desired as any).sizes, [18, 5]);

    const size = { cols: 80, rows: 24 };
    const reStr = serializeGeometry(desired, size);
    const reParsed = parseLayout(reStr);

    assert.equal(reParsed.root.type, "split");
    const reRoot = reParsed.root as Extract<LayoutCell, { type: "split" }>;
    assert.equal(reRoot.orientation, "vertical");
    assert.equal(reRoot.children.length, 2);
    // Sum invariant: child0.height + 1 + child1.height = 24
    assert.equal(reRoot.children[0]!.height + 1 + reRoot.children[1]!.height, 24);
  });
});
