/**
 * Unit tests for the session-template applicator (tc-gjdx.3), driven by a FAKE
 * `send` seam (no real tmux). These pin the interpreter contract:
 *   - compile→apply order (query initial window, awareness FIRST, new-window,
 *     splits of the previously-created pane, select-layout, kill-initial LAST);
 *   - runtime id threading (each `-P -F` result feeds the next step);
 *   - the vocabulary bridge reaches the wire (command → shellCommand);
 *   - fail-loud, no-rollback partial failure (stop at first failure, report the
 *     failed verb + created-so-far, issue NO destructive compensations).
 *
 * The real-tmux behaviour (topology/geometry/cwd/env, exactly-once, coalescer
 * burst) is covered in apply-at-create.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileTemplate } from "./compile.js";
import { applyCompiledTemplate, TemplateApplyError, TEMPLATE_SESSION_OPTION } from "./apply.js";
// ---------------------------------------------------------------------------
// Fake tmux send seam
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
function ok(body = "") {
    return { ok: true, commandNumber: 0, body: enc.encode(body) };
}
function err(body = "") {
    return { ok: false, commandNumber: 0, body: enc.encode(body) };
}
/**
 * A fake `send` that mints monotonic tmux ids for creating verbs and records
 * every command. `new-window`/`split-window` return a `%P @W` body parseable by
 * parseEffectIds; splits reuse the last new-window's window id.
 */
function makeFake(opts = {}) {
    const commands = [];
    let nextPane = 1;
    let nextWindow = 1;
    let lastWindow = 0;
    const initialWindow = opts.initialWindow ?? "@0";
    const send = async (cmd) => {
        const idx = commands.length;
        commands.push(cmd);
        const forced = opts.override?.(cmd, idx) ?? null;
        if (forced !== null)
            return forced;
        if (cmd.startsWith("list-windows"))
            return ok(initialWindow);
        if (cmd.startsWith("new-window")) {
            const w = nextWindow++;
            const p = nextPane++;
            lastWindow = w;
            return ok(`%${p} @${w}`);
        }
        if (cmd.startsWith("split-window")) {
            const p = nextPane++;
            return ok(`%${p} @${lastWindow}`);
        }
        if (cmd.startsWith("display-message"))
            return ok("200x50");
        // set-option / select-layout / kill-window → plain ok.
        return ok();
    };
    return { send, commands };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("applyCompiledTemplate (tc-gjdx.3, fake send)", () => {
    it("single-pane named-template window: awareness FIRST, new-window, kill-initial LAST", async () => {
        const { send, commands } = makeFake();
        const plan = compileTemplate({ name: "dev", windows: [{ name: "editor" }] });
        const outcome = await applyCompiledTemplate(send, plan, "sess");
        // list-windows (query initial) → set-option @tmuxcc-template → new-window → kill-window.
        assert.equal(commands[0].startsWith("list-windows"), true);
        assert.equal(commands[1], `set-option -t sess ${TEMPLATE_SESSION_OPTION} dev`, "awareness option is set FIRST (before any window)");
        assert.ok(commands[2].startsWith("new-window"), commands[2]);
        assert.ok(commands[2].includes("-n editor"), commands[2]);
        assert.equal(commands[commands.length - 1], "kill-window -t @0", "initial window killed LAST");
        assert.equal(commands.filter((c) => c.startsWith("split-window")).length, 0);
        assert.equal(commands.filter((c) => c.startsWith("select-layout")).length, 0);
        assert.equal(outcome.windows.length, 1);
        assert.deepEqual(outcome.windows[0].paneIds, ["%1"]);
        assert.equal(outcome.windows[0].name, "editor");
    });
    it("unnamed (inline) template does NOT stamp @tmuxcc-template", async () => {
        const { send, commands } = makeFake();
        const plan = compileTemplate({ windows: [{}] });
        await applyCompiledTemplate(send, plan, "sess");
        assert.equal(commands.some((c) => c.includes(TEMPLATE_SESSION_OPTION)), false, "no awareness stamp for an unnamed template");
    });
    it("multi-pane window: splits the previously-created pane, then one select-layout", async () => {
        const { send, commands } = makeFake();
        const plan = compileTemplate({
            windows: [
                {
                    geometry: {
                        kind: "hsplit",
                        children: [{ kind: "pane" }, { kind: "pane" }, { kind: "pane" }],
                    },
                },
            ],
        });
        const outcome = await applyCompiledTemplate(send, plan, "sess");
        const splits = commands.filter((c) => c.startsWith("split-window"));
        assert.equal(splits.length, 2, "3 leaves ⇒ 1 new-window + 2 splits");
        // Each split targets the previously-created pane: %1 then %2.
        assert.ok(splits[0].includes("-t %1"), splits[0]);
        assert.ok(splits[1].includes("-t %2"), splits[1]);
        const layouts = commands.filter((c) => c.startsWith("select-layout"));
        assert.equal(layouts.length, 1);
        assert.ok(layouts[0].startsWith("select-layout -t @1 "), layouts[0]);
        // The layout string is a real checksummed body targeting this window's dims.
        assert.match(layouts[0], /select-layout -t @1 '[0-9a-f]{4},200x50,0,0/);
        assert.deepEqual(outcome.windows[0].paneIds, ["%1", "%2", "%3"]);
        assert.equal(commands[commands.length - 1], "kill-window -t @0");
    });
    it("bridges leaf command → shellCommand and cwd/env onto the creating verbs", async () => {
        const { send, commands } = makeFake();
        const plan = compileTemplate({
            windows: [
                {
                    geometry: {
                        kind: "vsplit",
                        children: [
                            { kind: "pane", cwd: "/work", command: "vim", env: { EDITOR: "vim" } },
                            { kind: "pane", command: "htop" },
                        ],
                    },
                },
            ],
        });
        await applyCompiledTemplate(send, plan, "sess");
        const nw = commands.find((c) => c.startsWith("new-window"));
        assert.ok(nw.includes("-c /work"), nw);
        assert.ok(nw.includes("-e EDITOR=vim"), nw);
        assert.ok(nw.endsWith(" vim"), nw);
        const split = commands.find((c) => c.startsWith("split-window"));
        assert.ok(split.endsWith(" htop"), split);
    });
    it("FAIL-LOUD: a rejected split stops the transaction, reports created-so-far, and does NOT roll back", async () => {
        // Reject the FIRST split-window.
        const { send, commands } = makeFake({
            override: (cmd) => (cmd.startsWith("split-window") ? err("create pane failed: pane too small") : null),
        });
        const plan = compileTemplate({
            windows: [
                { name: "w1", geometry: { kind: "hsplit", children: [{ kind: "pane" }, { kind: "pane" }] } },
            ],
        });
        await assert.rejects(() => applyCompiledTemplate(send, plan, "sess"), (e) => {
            assert.ok(e instanceof TemplateApplyError);
            assert.equal(e.code, "template.invalid");
            assert.equal(e.failedVerb, "split-pane");
            assert.match(e.tmuxMessage, /pane too small/);
            // created-so-far: the window + its first pane exist; NOT rolled back.
            assert.equal(e.created.windows.length, 1);
            assert.deepEqual(e.created.windows[0].paneIds, ["%1"]);
            assert.match(e.message, /created before failure/i);
            return true;
        });
        // No rollback: the applicator issues NO kill-pane / kill-window compensation,
        // and NEVER reaches the terminal kill-window of the initial window.
        assert.equal(commands.some((c) => c.startsWith("kill-pane")), false);
        assert.equal(commands.some((c) => c.startsWith("kill-window")), false);
    });
    it("FAIL-LOUD: a select-layout rejection is a loud error (not a warn-log)", async () => {
        const { send } = makeFake({
            override: (cmd) => (cmd.startsWith("select-layout") ? err("size mismatch after applying layout") : null),
        });
        const plan = compileTemplate({
            windows: [{ geometry: { kind: "hsplit", children: [{ kind: "pane" }, { kind: "pane" }] } }],
        });
        await assert.rejects(() => applyCompiledTemplate(send, plan, "sess"), (e) => {
            assert.ok(e instanceof TemplateApplyError);
            assert.equal(e.failedVerb, "select-layout");
            assert.match(e.tmuxMessage, /size mismatch/);
            // Both panes were created before the layout failed — reported, not rolled back.
            assert.deepEqual(e.created.windows[0].paneIds, ["%1", "%2"]);
            return true;
        });
    });
    it("FAIL-LOUD: an unparseable -P -F reply on a creating verb fails the contract", async () => {
        const { send } = makeFake({
            override: (cmd) => (cmd.startsWith("new-window") ? ok("garbage not-an-id") : null),
        });
        const plan = compileTemplate({ windows: [{ name: "w" }] });
        await assert.rejects(() => applyCompiledTemplate(send, plan, "sess"), (e) => {
            assert.ok(e instanceof TemplateApplyError);
            assert.equal(e.failedVerb, "open-window");
            assert.match(e.tmuxMessage, /unparseable/);
            return true;
        });
    });
    it("multi-window template creates each window then kills the initial once", async () => {
        const { send, commands } = makeFake();
        const plan = compileTemplate({ name: "multi", windows: [{ name: "a" }, { name: "b" }, { name: "c" }] });
        const outcome = await applyCompiledTemplate(send, plan, "sess");
        assert.equal(outcome.windows.length, 3);
        assert.equal(commands.filter((c) => c.startsWith("new-window")).length, 3);
        assert.equal(commands.filter((c) => c === "kill-window -t @0").length, 1);
    });
});
//# sourceMappingURL=apply.test.js.map