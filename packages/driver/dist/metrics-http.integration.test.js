/**
 * metrics-http.integration.test.ts — end-to-end tests for the server-proxy's
 * `/metrics` (+ `/info`) HTTP exposition and its THREE enablement paths
 * (tc-44u4.4):
 *
 *   M0. OFF by default — no listener bound, no metrics-http.sock on disk.
 *   M1. Startup flag/env (`metricsAddr` option, fed by --metrics-addr /
 *       TMUXCC_METRICS_ADDR) binds a unix listener; /metrics returns prom text.
 *   M2. Runtime wire toggle (`server-proxy.set-metrics-http`) binds, then
 *       unbinds — the PRIMARY no-restart path — and the off path removes the
 *       socket file.
 *   M3. SIGUSR2 (`toggleMetricsHttp`) binds the secure unix default, toggles
 *       off again.
 *   M4. Security: the unix socket is mode 0600; a non-loopback TCP bind is
 *       refused (result.ok=false), a loopback TCP bind is accepted.
 *   M5. With a live session (tmux), /metrics includes a session-registry
 *       metric namespaced by session="<id>".
 *
 * The wire toggle is driven by a hand-rolled client (per the scope boundary —
 * we do NOT depend on the tc-44u4.3 introspection lib).
 *
 * @module metrics-http.integration.test
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { createServerProxy, connectSocketTransport } from "./index.js";
import { metricsHttpSocketPath } from "./runtime-dir.js";
import { runClientHandshake, WIRE_PROTOCOL_VERSION, } from "@tmuxcc/protocol";
function tmuxAvailable() {
    const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
    return r.status === 0 && !r.error;
}
let counter = 0;
function nextSocketName() {
    return `tmuxcc-test-mhttp-${process.pid}-${++counter}-${Date.now()}`;
}
function makeRuntimeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-mhttpd-"));
}
const CLIENT_CAPS = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features: ["sessions-watch", "session-claim", "server-proxy-metrics-http"],
};
function getUnix(socketPath, reqPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath, path: reqPath, method: "GET" }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
    });
}
/**
 * A multiplexing wrapper around the transport's single (replace-last-wins)
 * onControl slot — mirrors server-proxy.test.ts's TransportMux so multiple
 * pending `sendCommand` calls don't clobber each other's handler.
 */
class TransportMux {
    transport;
    _handlers = [];
    constructor(transport) {
        this.transport = transport;
        transport.onControl((msg) => {
            for (const h of this._handlers.slice())
                h(msg);
        });
    }
    subscribe(handler) {
        this._handlers.push(handler);
        return () => { this._handlers = this._handlers.filter((h) => h !== handler); };
    }
}
/** Connect + handshake a hand-rolled client to the server-proxy control socket. */
async function connectClient(endpoint) {
    const transport = await connectSocketTransport(endpoint);
    // The control socket's server-side handshake purpose is
    // "server-proxy.capabilities" (NOT "client.capabilities").
    await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
    const mux = new TransportMux(transport);
    return { mux, seq: { value: 1 }, close: () => transport.close() };
}
/** Issue one server-proxy command and await its correlated response. */
function sendCommand(client, command, timeoutMs = 5_000) {
    const correlationId = `c${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("command timeout")), timeoutMs);
        if (timer.unref)
            timer.unref();
        const unsub = client.mux.subscribe((msg) => {
            const m = msg;
            if (m.type === "command.response" && m.correlationId === correlationId) {
                clearTimeout(timer);
                unsub();
                resolve(m);
            }
        });
        client.mux.transport.sendControl({
            type: "command.request",
            seq: client.seq.value++,
            correlationId,
            command,
        });
    });
}
describe("server-proxy metrics-HTTP exposition (tc-44u4.4)", () => {
    let serverProxy = null;
    let runtimeDir = null;
    beforeEach(() => {
        runtimeDir = makeRuntimeDir();
    });
    afterEach(async () => {
        if (serverProxy !== null) {
            try {
                await serverProxy.shutdown();
            }
            catch { /* ignore */ }
            serverProxy = null;
        }
        if (runtimeDir !== null) {
            fs.rmSync(runtimeDir, { recursive: true, force: true });
            runtimeDir = null;
        }
    });
    it("M0: OFF by default — no listener, no socket file", async () => {
        const socketName = nextSocketName();
        serverProxy = createServerProxy({ socketName, runtimeDir: runtimeDir, idleExitMs: 60_000 });
        await serverProxy.start();
        assert.deepEqual(serverProxy.metricsHttpState(), { enabled: false, address: null });
        assert.equal(fs.existsSync(metricsHttpSocketPath(socketName, { runtimeDir: runtimeDir })), false);
    });
    it("M1: startup flag (metricsAddr) binds a unix listener; /metrics returns prom text", async () => {
        const socketName = nextSocketName();
        serverProxy = createServerProxy({
            socketName,
            runtimeDir: runtimeDir,
            idleExitMs: 60_000,
            metricsAddr: "unix",
        });
        await serverProxy.start();
        const state = serverProxy.metricsHttpState();
        assert.equal(state.enabled, true);
        const sockPath = metricsHttpSocketPath(socketName, { runtimeDir: runtimeDir });
        assert.equal(state.address, sockPath);
        const res = await getUnix(sockPath, "/metrics");
        assert.equal(res.status, 200);
        // server-proxy registry metric is always present.
        assert.match(res.body, /server_proxy_connections_total/);
    });
    it("M2: runtime wire toggle binds then unbinds (PRIMARY no-restart path)", async () => {
        const socketName = nextSocketName();
        serverProxy = createServerProxy({ socketName, runtimeDir: runtimeDir, idleExitMs: 60_000 });
        await serverProxy.start();
        const client = await connectClient(serverProxy.endpoint());
        // Enable.
        const onResp = await sendCommand(client, { kind: "server-proxy.set-metrics-http", enabled: true });
        assert.equal(onResp.result.ok, true);
        const onPayload = onResp.result.ok ? onResp.result.payload?.metricsHttp : undefined;
        assert.equal(onPayload?.enabled, true);
        const sockPath = onPayload?.address ?? "";
        assert.equal(sockPath, metricsHttpSocketPath(socketName, { runtimeDir: runtimeDir }));
        const probe = await getUnix(sockPath, "/metrics");
        assert.equal(probe.status, 200);
        // Disable — listener gone, socket file removed.
        const offResp = await sendCommand(client, { kind: "server-proxy.set-metrics-http", enabled: false });
        assert.equal(offResp.result.ok, true);
        const offPayload = offResp.result.ok ? offResp.result.payload?.metricsHttp : undefined;
        assert.deepEqual(offPayload, { enabled: false, address: null });
        assert.equal(serverProxy.metricsHttpState().enabled, false);
        assert.equal(fs.existsSync(sockPath), false);
        client.close();
    });
    it("M3: SIGUSR2 path (toggleMetricsHttp) binds the secure unix default, then off", async () => {
        const socketName = nextSocketName();
        serverProxy = createServerProxy({ socketName, runtimeDir: runtimeDir, idleExitMs: 60_000 });
        await serverProxy.start();
        const on = await serverProxy.toggleMetricsHttp();
        assert.equal(on.enabled, true);
        assert.equal(on.address, metricsHttpSocketPath(socketName, { runtimeDir: runtimeDir }));
        const res = await getUnix(on.address, "/info");
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.body).socketName, socketName);
        const off = await serverProxy.toggleMetricsHttp();
        assert.deepEqual(off, { enabled: false, address: null });
    });
    it("M4: unix socket is 0600; non-loopback TCP refused; loopback TCP accepted", async () => {
        const socketName = nextSocketName();
        serverProxy = createServerProxy({ socketName, runtimeDir: runtimeDir, idleExitMs: 60_000 });
        await serverProxy.start();
        const on = await serverProxy.setMetricsHttp(true);
        assert.equal(fs.statSync(on.address).mode & 0o777, 0o600);
        await serverProxy.setMetricsHttp(false);
        await assert.rejects(() => serverProxy.setMetricsHttp(true, "0.0.0.0:0"), /metrics\.bind-invalid/);
        // Still off after the rejected bind.
        assert.equal(serverProxy.metricsHttpState().enabled, false);
        const tcp = await serverProxy.setMetricsHttp(true, "127.0.0.1:0");
        assert.match(tcp.address, /^127\.0\.0\.1:\d+$/);
        await serverProxy.setMetricsHttp(false);
    });
    it("M5: /metrics includes a session-namespaced registry metric (tmux)", { skip: !tmuxAvailable() }, async () => {
        const socketName = nextSocketName();
        serverProxy = createServerProxy({ socketName, runtimeDir: runtimeDir, idleExitMs: 60_000 });
        await serverProxy.start();
        const client = await connectClient(serverProxy.endpoint());
        // Claim a session so a per-session registry exists.
        const claim = await sendCommand(client, { kind: "session.claim", name: "mhttp-m5" });
        assert.equal(claim.result.ok, true);
        const sessionId = claim.result.ok ? claim.result.payload?.sessionId : undefined;
        assert.ok(sessionId, "claim returned a sessionId");
        const on = await serverProxy.setMetricsHttp(true);
        const res = await getUnix(on.address, "/metrics");
        assert.equal(res.status, 200);
        // A session-registry family namespaced by the claimed session id.
        assert.match(res.body, new RegExp(`correlator_pending_slot_max_age_seconds\\{session="${sessionId}"\\}`));
        // Clean up the tmux session.
        await sendCommand(client, { kind: "session.destroy", sessionId });
        client.close();
    });
});
//# sourceMappingURL=metrics-http.integration.test.js.map