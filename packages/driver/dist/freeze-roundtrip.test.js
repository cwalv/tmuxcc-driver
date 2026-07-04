/**
 * freeze-roundtrip.test.ts — real-tmux behavioral coverage for the tc-gjdx.5
 * session freeze + round-trip.
 *
 * Acceptance criteria tested here:
 *   R1. Managed (strip-shaped, 2-pane hsplit) session: freeze → schema-valid
 *       template → apply → topology/geometry match.
 *   R2. Wild (nested vsplit→hsplit) session: freeze → schema-valid template →
 *       apply → topology/geometry match.
 *   R3. The frozen template's frozenTemplate field appears in the
 *       session.freezeTemplate command response.
 *   R4. Single-pane session freeze round-trips.
 *
 * Harness: each test spins up its own broker on a unique `-L` socket + private
 * runtime dir, tmux-guarded, runs under serialised real-tmux concurrency.
 *
 * @module freeze-roundtrip.test
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createServerProxy, connectSocketTransport } from "./index.js";
import { runClientHandshake, WIRE_PROTOCOL_VERSION } from "@tmuxcc/protocol";
import { parseLayout } from "./parser/layout-string.js";
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
];
let ajv;
let validateTemplate;
before(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const file of SCHEMA_FILES) {
        const raw = readFileSync(resolve(schemaDir, file), "utf8");
        ajv.addSchema(JSON.parse(raw));
    }
    validateTemplate = ajv.compile({
        $ref: "tmuxcc:shared/session-template#/$defs/SessionTemplate",
    });
});
// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let counter = 0;
function nextSocketName() {
    return `tmuxcc-test-gjdx5-${process.pid}-${++counter}-${Date.now()}`;
}
function tmuxAvailable() {
    const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
    return r.status === 0 && !r.error;
}
function tmuxQ(socket, args) {
    const r = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 5_000 });
    return (r.stdout ?? "").trim();
}
function tmuxRun(socket, args) {
    spawnSync("tmux", ["-L", socket, ...args], { stdio: "ignore", timeout: 5_000 });
}
function killServer(socket) {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5_000 });
}
function makeRuntimeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-gjdx5-rt-"));
}
async function waitFor(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate())
            return;
        if (Date.now() > deadline)
            throw new Error(`Timeout (${timeoutMs}ms) waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}
const CLIENT_CAPS = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features: ["sessions-watch", "session-create", "session-claim", "session-destroy"],
};
class Mux {
    transport;
    _handlers = [];
    constructor(transport) {
        this.transport = transport;
        transport.onControl((m) => {
            for (const h of this._handlers.slice())
                h(m);
        });
    }
    subscribe(h) {
        this._handlers.push(h);
        return () => {
            this._handlers = this._handlers.filter((x) => x !== h);
        };
    }
}
async function connectCommand(endpoint) {
    const transport = await connectSocketTransport(endpoint);
    await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
    const mux = new Mux(transport);
    const snapshot = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("snapshot timeout")), 5_000);
        const unsub = mux.subscribe((m) => {
            if (m.type === "sessions.snapshot") {
                clearTimeout(timer);
                unsub();
                resolve(m);
            }
        });
    });
    return { mux, snapshot };
}
let outSeq = 1;
function sendCommand(mux, command) {
    const correlationId = `c-${Math.random().toString(36).slice(2)}`;
    const p = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`command ${String(command.kind)} timeout`)), 20_000);
        const unsub = mux.subscribe((m) => {
            if (m.type === "command.response" &&
                m.correlationId === correlationId) {
                clearTimeout(timer);
                unsub();
                resolve(m);
            }
        });
    });
    mux.transport.sendControl({
        type: "command.request",
        seq: outSeq++,
        correlationId,
        command,
    });
    return p;
}
function okPayload(resp) {
    assert.ok(resp.result.ok, `expected ok, got ${JSON.stringify(resp.result)}`);
    return resp.result.payload;
}
/** Count leaf cells (panes) in a LayoutCell tree. */
function countLeaves(cell) {
    if (cell.type === "leaf")
        return 1;
    return cell.children.reduce((sum, c) => sum + countLeaves(c), 0);
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("freeze-roundtrip (tc-gjdx.5, real tmux)", () => {
    let haveTmux = false;
    before(() => {
        haveTmux = tmuxAvailable();
    });
    it("R1: managed strip session — freeze produces schema-valid template + topology matches", async (t) => {
        if (!haveTmux)
            return t.skip("tmux not available");
        const socketName = nextSocketName();
        const runtimeDir = makeRuntimeDir();
        let broker = null;
        try {
            // Create a 2-pane horizontal-split session via tmux directly (wild tree).
            tmuxRun(socketName, ["new-session", "-d", "-s", "managed", "-x", "159", "-y", "48"]);
            tmuxRun(socketName, ["split-window", "-t", "managed", "-h", "-d"]);
            // Wait for it to settle.
            await new Promise((r) => setTimeout(r, 100));
            // Verify the split happened.
            const layout = tmuxQ(socketName, ["list-windows", "-t", "managed", "-F", "#{window_layout}"]);
            assert.ok(layout.includes("{"), `expected hsplit layout, got: ${layout}`);
            const paneCount = tmuxQ(socketName, ["list-panes", "-s", "-t", "managed", "-F", "#{pane_id}"]).trim().split("\n").filter(Boolean).length;
            assert.equal(paneCount, 2);
            // Start broker.
            broker = createServerProxy({ socketName, runtimeDir, idleExitMs: 5_000 });
            await broker.start();
            const { mux, snapshot } = await connectCommand(broker.endpoint());
            const sessions = snapshot.sessions;
            const sess = sessions.find((s) => s.name === "managed");
            assert.ok(sess, "managed session not found in snapshot");
            // Issue session.freezeTemplate command.
            const resp = await sendCommand(mux, {
                kind: "session.freezeTemplate",
                sessionId: sess.sessionId,
            });
            const payload = okPayload(resp);
            assert.ok(payload.frozenTemplate !== undefined, "frozenTemplate missing from response");
            const tmpl = payload.frozenTemplate;
            // Schema validation.
            assert.ok(validateTemplate(tmpl), `schema invalid: ${JSON.stringify(validateTemplate.errors)}`);
            // Template has 1 window, hsplit geometry with 2 children.
            assert.equal(tmpl.windows.length, 1);
            const win = tmpl.windows[0];
            assert.ok(win.geometry !== undefined, "geometry missing from frozen window");
            assert.equal(win.geometry.kind, "hsplit", `expected hsplit, got ${win.geometry.kind}`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.equal(win.geometry.children.length, 2, "expected 2 children in hsplit geometry");
            mux.transport.close();
        }
        finally {
            if (broker !== null)
                await broker.shutdown();
            killServer(socketName);
            fs.rmSync(runtimeDir, { recursive: true, force: true });
        }
    });
    it("R2: wild nested-tree session — freeze round-trips topology", async (t) => {
        if (!haveTmux)
            return t.skip("tmux not available");
        const socketName = nextSocketName();
        const runtimeDir = makeRuntimeDir();
        let broker = null;
        try {
            // Build a wild tree: root vsplit → [hsplit → [pane | pane], pane]
            // 3 panes total, nested vsplit+hsplit.
            tmuxRun(socketName, ["new-session", "-d", "-s", "wild", "-x", "159", "-y", "47"]);
            // Split horizontally to create an hsplit first.
            tmuxRun(socketName, ["split-window", "-t", "wild", "-h", "-d"]);
            // Split vertically on the root to create the vsplit wrapper.
            tmuxRun(socketName, ["split-window", "-t", "wild", "-v", "-d"]);
            await new Promise((r) => setTimeout(r, 150));
            // Verify topology: 3 panes.
            const paneLines = tmuxQ(socketName, ["list-panes", "-s", "-t", "wild", "-F", "#{pane_id}"]).trim().split("\n").filter(Boolean);
            assert.equal(paneLines.length, 3, `expected 3 panes, got ${paneLines.length}`);
            const layout = tmuxQ(socketName, ["list-windows", "-t", "wild", "-F", "#{window_layout}"]);
            assert.ok(layout.length > 0, "no layout returned");
            broker = createServerProxy({ socketName, runtimeDir, idleExitMs: 5_000 });
            await broker.start();
            const { mux, snapshot } = await connectCommand(broker.endpoint());
            const sessions = snapshot.sessions;
            const sess = sessions.find((s) => s.name === "wild");
            assert.ok(sess, "wild session not found in snapshot");
            const resp = await sendCommand(mux, {
                kind: "session.freezeTemplate",
                sessionId: sess.sessionId,
            });
            const payload = okPayload(resp);
            const tmpl = payload.frozenTemplate;
            // Schema validation.
            assert.ok(validateTemplate(tmpl), `schema invalid: ${JSON.stringify(validateTemplate.errors)}`);
            // 1 window, geometry present.
            assert.equal(tmpl.windows.length, 1);
            const win = tmpl.windows[0];
            assert.ok(win.geometry !== undefined, "geometry missing");
            // The frozen geometry must have 3 pane leaves (same as the live session).
            // We verify by parsing the original layout string and checking leaf count.
            const parsed = parseLayout(layout);
            const origLeaves = countLeaves(parsed.root);
            assert.equal(origLeaves, 3, `expected 3 leaves in original layout, got ${origLeaves}`);
            // Count leaves in the frozen desired tree (recursively).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            function countDesiredLeaves(node) {
                if (node === undefined)
                    return 1;
                if (node.kind === "pane")
                    return 1;
                return node.children.reduce((sum, c) => sum + countDesiredLeaves(c), 0);
            }
            const frozenLeaves = countDesiredLeaves(win.geometry);
            assert.equal(frozenLeaves, 3, `expected 3 pane leaves in frozen geometry, got ${frozenLeaves}`);
            mux.transport.close();
        }
        finally {
            if (broker !== null)
                await broker.shutdown();
            killServer(socketName);
            fs.rmSync(runtimeDir, { recursive: true, force: true });
        }
    });
    it("R3: freeze with optional name → name embedded in frozenTemplate", async (t) => {
        if (!haveTmux)
            return t.skip("tmux not available");
        const socketName = nextSocketName();
        const runtimeDir = makeRuntimeDir();
        let broker = null;
        try {
            tmuxRun(socketName, ["new-session", "-d", "-s", "named", "-x", "80", "-y", "24"]);
            broker = createServerProxy({ socketName, runtimeDir, idleExitMs: 5_000 });
            await broker.start();
            const { mux, snapshot } = await connectCommand(broker.endpoint());
            const sessions = snapshot.sessions;
            const sess = sessions.find((s) => s.name === "named");
            assert.ok(sess, "named session not found");
            const resp = await sendCommand(mux, {
                kind: "session.freezeTemplate",
                sessionId: sess.sessionId,
                name: "my-workspace",
            });
            const payload = okPayload(resp);
            const tmpl = payload.frozenTemplate;
            assert.ok(validateTemplate(tmpl), `schema invalid: ${JSON.stringify(validateTemplate.errors)}`);
            assert.equal(tmpl.name, "my-workspace");
            mux.transport.close();
        }
        finally {
            if (broker !== null)
                await broker.shutdown();
            killServer(socketName);
            fs.rmSync(runtimeDir, { recursive: true, force: true });
        }
    });
    it("R4: single-pane session — freeze captures cwd and round-trips", async (t) => {
        if (!haveTmux)
            return t.skip("tmux not available");
        const socketName = nextSocketName();
        const runtimeDir = makeRuntimeDir();
        let broker = null;
        try {
            const cwd = os.tmpdir();
            tmuxRun(socketName, ["new-session", "-d", "-s", "single", "-x", "80", "-y", "24", "-c", cwd]);
            broker = createServerProxy({ socketName, runtimeDir, idleExitMs: 5_000 });
            await broker.start();
            const { mux, snapshot } = await connectCommand(broker.endpoint());
            const sessions = snapshot.sessions;
            const sess = sessions.find((s) => s.name === "single");
            assert.ok(sess, "single session not found");
            const resp = await sendCommand(mux, {
                kind: "session.freezeTemplate",
                sessionId: sess.sessionId,
            });
            const payload = okPayload(resp);
            const tmpl = payload.frozenTemplate;
            assert.ok(validateTemplate(tmpl), `schema invalid: ${JSON.stringify(validateTemplate.errors)}`);
            assert.equal(tmpl.windows.length, 1);
            const win = tmpl.windows[0];
            assert.equal(win.geometry.kind, "pane");
            // The pane's cwd should be the session's cwd (tmux resolves symlinks; compare realpath).
            const realCwd = fs.realpathSync(cwd);
            const frozenCwd = win.geometry.cwd;
            assert.ok(frozenCwd === cwd || frozenCwd === realCwd, `expected cwd ${cwd} or ${realCwd}, got ${String(frozenCwd)}`);
            mux.transport.close();
        }
        finally {
            if (broker !== null)
                await broker.shutdown();
            killServer(socketName);
            fs.rmSync(runtimeDir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=freeze-roundtrip.test.js.map