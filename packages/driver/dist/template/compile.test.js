/**
 * Unit tests for the pure session-template compiler (tc-gjdx.3).
 *
 * The compiler is a pure function SessionTemplate → CompiledTemplate; these
 * tests pin the flatten order, the single-pane collapse, the vocabulary bridge
 * (command → shellCommand), and the semantic validation JSON Schema can't do
 * (split arity, sizes-length-parallel-to-children, positive weights).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileTemplate, TemplateValidationError } from "./compile.js";
describe("compileTemplate (tc-gjdx.3)", () => {
    it("carries the template identity name for the @tmuxcc-template stamp", () => {
        const compiled = compileTemplate({ name: "dev", windows: [{}] });
        assert.equal(compiled.templateName, "dev");
    });
    it("omits templateName for an inline/ad-hoc (unnamed) template", () => {
        const compiled = compileTemplate({ windows: [{}] });
        assert.equal(compiled.templateName, undefined);
    });
    it("a window with no geometry compiles to a single default pane, no layout", () => {
        const compiled = compileTemplate({ windows: [{ name: "shell" }] });
        assert.equal(compiled.windows.length, 1);
        const w = compiled.windows[0];
        assert.equal(w.name, "shell");
        assert.deepEqual(w.panes, [{}]);
        assert.equal(w.geometry, undefined, "single-pane window needs no select-layout");
    });
    it("a lone pane leaf collapses to a single pane (cwd/command/env bridged), no geometry", () => {
        const compiled = compileTemplate({
            windows: [
                { geometry: { kind: "pane", cwd: "/w", command: "vim", env: { E: "1" } } },
            ],
        });
        const w = compiled.windows[0];
        assert.equal(w.geometry, undefined, "one leaf ⇒ no layout");
        assert.deepEqual(w.panes, [{ cwd: "/w", shellCommand: "vim", env: { E: "1" } }]);
    });
    it("flattens an hsplit depth-first, preserving order, and keeps geometry", () => {
        const template = {
            windows: [
                {
                    geometry: {
                        kind: "hsplit",
                        children: [
                            { kind: "pane", command: "a" },
                            { kind: "pane", command: "b" },
                            { kind: "pane", command: "c" },
                        ],
                    },
                },
            ],
        };
        const w = compileTemplate(template).windows[0];
        assert.equal(w.panes.length, 3);
        assert.deepEqual(w.panes.map((p) => p.shellCommand), ["a", "b", "c"]);
        assert.notEqual(w.geometry, undefined, ">1 pane ⇒ geometry present");
        assert.equal(w.geometry, template.windows[0].geometry, "geometry passed through verbatim");
    });
    it("flattens a NESTED tree in tmux layout_assign order (depth-first left→right)", () => {
        // hsplit[ paneA, vsplit[ paneB, paneC ], paneD ]
        const w = compileTemplate({
            windows: [
                {
                    geometry: {
                        kind: "hsplit",
                        children: [
                            { kind: "pane", command: "A" },
                            {
                                kind: "vsplit",
                                children: [
                                    { kind: "pane", command: "B" },
                                    { kind: "pane", command: "C" },
                                ],
                            },
                            { kind: "pane", command: "D" },
                        ],
                    },
                },
            ],
        }).windows[0];
        assert.deepEqual(w.panes.map((p) => p.shellCommand), ["A", "B", "C", "D"], "depth-first, children in order — matches tmux positional layout_assign");
    });
    it("compiles multiple windows in order", () => {
        const compiled = compileTemplate({
            windows: [{ name: "one" }, { name: "two" }, { name: "three" }],
        });
        assert.deepEqual(compiled.windows.map((w) => w.name), ["one", "two", "three"]);
    });
    // -- semantic validation (JSON Schema can't express these) -----------------
    it("throws on an empty session (no windows)", () => {
        assert.throws(() => compileTemplate({ windows: [] }), TemplateValidationError);
    });
    it("throws on a split with fewer than two children", () => {
        assert.throws(() => compileTemplate({
            windows: [{ geometry: { kind: "hsplit", children: [{ kind: "pane" }] } }],
        }), /at least two children/);
    });
    it("throws when sizes length does not match children length (the schema-uncatchable invariant)", () => {
        assert.throws(() => compileTemplate({
            windows: [
                {
                    geometry: {
                        kind: "vsplit",
                        children: [{ kind: "pane" }, { kind: "pane" }],
                        sizes: [1, 2, 3],
                    },
                },
            ],
        }), /sizes length 3 does not match children length 2/);
    });
    it("throws on a non-positive / non-finite weight", () => {
        assert.throws(() => compileTemplate({
            windows: [
                {
                    geometry: {
                        kind: "hsplit",
                        children: [{ kind: "pane" }, { kind: "pane" }],
                        sizes: [1, 0],
                    },
                },
            ],
        }), /must be a finite positive weight/);
    });
    it("the validation error carries the wire code template.invalid", () => {
        try {
            compileTemplate({ windows: [] });
            assert.fail("should have thrown");
        }
        catch (err) {
            assert.ok(err instanceof TemplateValidationError);
            assert.equal(err.code, "template.invalid");
        }
    });
});
//# sourceMappingURL=compile.test.js.map