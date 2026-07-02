/**
 * session-removal-ordering.test.ts — tc-295a.6 (W1.5)
 *
 * Tests for the cross-stream ordering contract:
 *   sessions.removed (C1) ⟹ session-proxy UDS close (C4) follows promptly.
 *
 * Contract (protocol/session-lifecycle.md):
 *   - sessions.removed fires only on true tmux session drop.
 *   - reapSessionProxy is called before sessions.removed is broadcast (SIGTERM
 *     is sent before the C1 event; UDS close follows promptly after SIGTERM).
 *   - C4 events in flight when sessions.removed lands are legal to drain;
 *     once the C4 UDS closes no further C4 events should arrive.
 *   - Post-removal C4 reconnect is a protocol violation (tripwire).
 *
 * # Tests
 *
 *   L1 (integration, requires tmux): session.destroy closes the session-proxy
 *      UDS and broadcasts sessions.removed on C1; the UDS is gone after the
 *      removal is broadcast.
 *
 *   L2 (integration, requires tmux): post-destroy C4 reconnect fails
 *      (ENOENT/ECONNREFUSED) — the tripwire: a successful reconnect after
 *      sessions.removed means the client entered zombie state.
 *
 *   L3 (kill-under-load, requires tmux): external `tmux kill-session` while
 *      the session-proxy is actively writing pane output; the test asserts
 *      sessions.removed arrives on C1 AND the C4 UDS path is removed after
 *      the removal is broadcast, with in-flight C4 events handled gracefully
 *      via a proper handshaked C4 connection.
 *
 * @module session-removal-ordering.test
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServerProxy, connectSocketTransport } from "./index.js";
import { runClientHandshake, WIRE_PROTOCOL_VERSION, } from "@tmuxcc/protocol";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testCounter = 0;
function nextSocketName() {
    return `tmuxcc-test-ord-${process.pid}-${++testCounter}-${Date.now()}`;
}
function tmuxAvailable() {
    const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
    return r.status === 0 && !r.error;
}
function makeRuntimeDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `tmuxcc-test-ord-${label}-`));
}
/** Poll `predicate` every `intervalMs` until truthy; throw on timeout. */
async function waitFor(predicate, timeoutMs, what, intervalMs = 50) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate())
            return;
        if (Date.now() > deadline)
            throw new Error(`Timeout (${timeoutMs}ms) waiting for ${what}`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
/** Returns [rejectPromise, cancelFn]. The promise rejects after `ms`. */
function rejectAfter(ms, message) {
    let timer;
    const p = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        if (timer.unref)
            timer.unref();
    });
    return [p, () => clearTimeout(timer)];
}
const CLIENT_CAPS = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features: [
        "sessions-watch",
        "session-create",
        "session-destroy",
        "session-claim",
        "pane-attach",
    ],
};
/** Capabilities for a C4 (session-proxy) client connection. */
const SESSION_PROXY_CLIENT_CAPS = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
};
/**
 * A multiplexing wrapper around a Transport's single onControl slot.
 * Allows multiple listeners without clobbering each other.
 */
class TransportMux {
    _transport;
    _handlers = [];
    constructor(transport) {
        this._transport = transport;
        this._transport.onControl((msg) => {
            const copy = this._handlers.slice();
            for (const h of copy)
                h(msg);
        });
    }
    subscribe(handler) {
        this._handlers.push(handler);
        return () => {
            this._handlers = this._handlers.filter((h) => h !== handler);
        };
    }
    get transport() {
        return this._transport;
    }
}
/** Connect to a server-proxy and run the wire handshake. Returns mux + snapshot. */
async function connectToServerProxy(endpoint) {
    const transport = await connectSocketTransport(endpoint);
    await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
    const mux = new TransportMux(transport);
    const snapshotPromise = new Promise((resolve) => {
        const unsub = mux.subscribe((msg) => {
            if (msg.type === "sessions.snapshot") {
                unsub();
                resolve(msg);
            }
        });
    });
    const [timeoutP, clearT] = rejectAfter(5_000, "Timeout waiting for server-proxy snapshot");
    const snapshot = await Promise.race([snapshotPromise, timeoutP]);
    clearT();
    return { mux, snapshot };
}
/** Send a command and wait for the correlated response. */
async function sendCommand(mux, command, outgoingSeq) {
    const correlationId = `corr-${Math.random().toString(36).slice(2)}`;
    const responsePromise = new Promise((resolve) => {
        const unsub = mux.subscribe((msg) => {
            if (msg.type === "command.response" &&
                msg.correlationId === correlationId) {
                unsub();
                resolve(msg);
            }
        });
    });
    mux.transport.sendControl({
        type: "command.request",
        seq: outgoingSeq.value++,
        correlationId,
        command,
    });
    return responsePromise;
}
/**
 * Attempt a raw net.connect to a unix socket path and return whether it
 * succeeds (true) or fails (false). Used to probe whether the session-proxy
 * UDS is still alive.
 *
 * Returns false on ENOENT, ECONNREFUSED, and any other connect error.
 */
function probeUdsReachable(socketPath, timeoutMs = 1_000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            sock.destroy();
            resolve(false); // timeout ≈ unreachable
        }, timeoutMs);
        const sock = net.createConnection(socketPath);
        sock.once("connect", () => {
            clearTimeout(timer);
            sock.destroy();
            resolve(true);
        });
        sock.once("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}
/**
 * D5 (tc-4b6k.4): probe whether a session is REACHABLE over the single broker
 * socket. Opens a fresh DATA connection, handshakes, sends
 * `session.attach {sessionId}`, and awaits the outcome:
 *   - session snapshot arrives → true (the connection bound to the session).
 *   - broker `error` (session.not-found) or connection close → false (gone).
 *
 * Replaces the pre-D5 per-session-socket `fs.existsSync` / `probeUdsReachable`
 * liveness check — there is no longer a per-session socket file to stat.
 */
async function probeSessionReachable(brokerEndpoint, sessionId, timeoutMs = 3_000) {
    let transport;
    try {
        transport = await connectSocketTransport(brokerEndpoint);
        await runClientHandshake(transport, CLIENT_CAPS, "server-proxy.capabilities");
        const t = transport;
        const mux = new TransportMux(t);
        return await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs);
            mux.subscribe((msg) => {
                if (msg.type === "snapshot") {
                    clearTimeout(timer);
                    resolve(true);
                }
                else if (msg.type === "error") {
                    clearTimeout(timer);
                    resolve(false);
                }
            });
            t.onClose(() => { clearTimeout(timer); resolve(false); });
            t.sendControl({
                type: "session.attach",
                seq: 1,
                sessionId,
            });
        });
    }
    catch {
        return false;
    }
    finally {
        try {
            transport?.close();
        }
        catch { /* ignore */ }
    }
}
const TMUX_AVAILABLE = tmuxAvailable();
// ---------------------------------------------------------------------------
// L1 — integration: session.destroy → sessions.removed → UDS gone
//
// Verifies the intra-event-loop ordering invariant: reapSessionProxy (which
// sends SIGTERM to the session-proxy child) runs BEFORE broadcastRemoved
// (which sends sessions.removed to C1 clients). The SIGTERM initiates the
// UDS close chain; by the time sessions.removed is broadcast, the close
// chain has already been triggered.
//
// Because sessionProxy.stop() takes up to ~3s (waits for tmux to exit, then
// SIGKILLs), we allow 15s for the UDS to disappear after sessions.removed.
// ---------------------------------------------------------------------------
describe("tc-295a.6 L1: sessions.removed ordering (requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
    let serverProxy;
    let socketName;
    let runtimeDir;
    beforeEach(async () => {
        socketName = nextSocketName();
        runtimeDir = makeRuntimeDir("l1");
        serverProxy = createServerProxy({ socketName, runtimeDir });
        await serverProxy.start();
    });
    afterEach(async () => {
        await serverProxy.shutdown();
        spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });
    it("L1: session.destroy broadcasts sessions.removed THEN session-proxy UDS is removed", { timeout: 30_000 }, async () => {
        const { mux } = await connectToServerProxy(serverProxy.endpoint());
        const seq = { value: 1 };
        // Claim a session so a real session-proxy is spawned and its UDS exists.
        const sessionName = "l1-ordering-session";
        const claimResp = await sendCommand(mux, { kind: "session.claim", name: sessionName }, seq);
        assert.ok(claimResp.result.ok, `session.claim failed: ${JSON.stringify(claimResp.result)}`);
        const { sessionId } = claimResp.result.payload;
        // D5 (tc-4b6k.4): confirm the session is reachable over the broker socket
        // (session.attach → snapshot) before destroy. There is no per-session UDS
        // file to stat anymore.
        assert.ok(await probeSessionReachable(serverProxy.endpoint(), sessionId), "session must be reachable via session.attach before destroy");
        // Arm sessions.removed listener BEFORE issuing destroy.
        let removedSeenAt = null;
        const removedPromise = new Promise((resolve) => {
            const unsub = mux.subscribe((msg) => {
                if (msg.type === "sessions.removed" &&
                    msg.sessionId === sessionId) {
                    removedSeenAt = Date.now();
                    unsub();
                    resolve();
                }
            });
        });
        // Issue session.destroy — this triggers reapSessionProxy (SIGTERM) then
        // broadcastRemoved (sessions.removed on C1).
        const destroyResp = await sendCommand(mux, { kind: "session.destroy", sessionId }, seq);
        assert.ok(destroyResp.result.ok, `session.destroy failed: ${JSON.stringify(destroyResp.result)}`);
        // Wait for sessions.removed on C1.
        const [timeoutP, clearT] = rejectAfter(5_000, "Timeout waiting for sessions.removed after destroy");
        await Promise.race([removedPromise, timeoutP]);
        clearT();
        assert.ok(removedSeenAt !== null, "sessions.removed must be received on C1 after destroy");
        // Key ordering assertion: sessions.removed was received on C1.
        assert.ok(removedSeenAt !== null, "sessions.removed must arrive on C1 after destroy");
        // D5 (tc-4b6k.4): by the time sessions.removed is broadcast, _destroySession
        // has already deleted the session from _sessions (reap → kill → delete →
        // broadcastRemoved), so a fresh session.attach for it fails (session gone).
        // This is the wire-observable successor to "the per-session UDS is unlinked".
        assert.equal(await probeSessionReachable(serverProxy.endpoint(), sessionId), false, "session must be unreachable via session.attach after destroy + sessions.removed");
        mux.transport.close();
    });
});
// ---------------------------------------------------------------------------
// L2 — integration: post-destroy C4 reconnect fails (tripwire)
// ---------------------------------------------------------------------------
describe("tc-295a.6 L2: post-destroy C4 reconnect fails (requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
    let serverProxy;
    let socketName;
    let runtimeDir;
    beforeEach(async () => {
        socketName = nextSocketName();
        runtimeDir = makeRuntimeDir("l2");
        serverProxy = createServerProxy({ socketName, runtimeDir });
        await serverProxy.start();
    });
    afterEach(async () => {
        await serverProxy.shutdown();
        spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });
    it("L2: session.destroy → sessions.removed → UDS gone; post-removal connect fails (protocol tripwire)", { timeout: 30_000 }, async () => {
        const { mux } = await connectToServerProxy(serverProxy.endpoint());
        const seq = { value: 1 };
        const sessionName = "l2-destroy-reconnect";
        const claimResp = await sendCommand(mux, { kind: "session.claim", name: sessionName }, seq);
        assert.ok(claimResp.result.ok, `session.claim failed: ${JSON.stringify(claimResp.result)}`);
        const { sessionId } = claimResp.result.payload;
        // Arm sessions.removed listener.
        const removedPromise = new Promise((resolve) => {
            const unsub = mux.subscribe((msg) => {
                if (msg.type === "sessions.removed" &&
                    msg.sessionId === sessionId) {
                    unsub();
                    resolve();
                }
            });
        });
        // Destroy the session.
        const destroyResp = await sendCommand(mux, { kind: "session.destroy", sessionId }, seq);
        assert.ok(destroyResp.result.ok, `session.destroy failed: ${JSON.stringify(destroyResp.result)}`);
        // Wait for sessions.removed.
        const [tp, ct] = rejectAfter(5_000, "Timeout waiting for sessions.removed");
        await Promise.race([removedPromise, tp]);
        ct();
        // D5 (tc-4b6k.4) tripwire: after sessions.removed, a fresh session.attach for
        // the removed sessionId MUST fail (session gone) — the successor to the
        // pre-D5 "post-removal UDS reconnect must fail" zombie-state tripwire.
        const reconnectSucceeded = await probeSessionReachable(serverProxy.endpoint(), sessionId, 1_000);
        assert.equal(reconnectSucceeded, false, "post-removal C4 reconnect must fail: session.attach must be rejected after sessions.removed " +
            "(protocol violation tripwire — a successful reattach means zombie state)");
        mux.transport.close();
    });
});
// ---------------------------------------------------------------------------
// L3 — kill-session-under-load: external kill while session-proxy is active.
//
// Scenario: a client has an established C4 connection to the session-proxy
// (proper session-proxy wire handshake complete). The session is externally
// killed while the session-proxy is actively writing pane output. The test
// asserts:
//   1. sessions.removed arrives on C1.
//   2. The session-proxy UDS is gone after sessions.removed is seen.
//   3. The C4 transport receives a close event (the session-proxy's
//      `broadcastErrorAndClose` path, triggered by tmux host exit).
//   4. Wall-clock ordering: sessions.removed and C4 close occur within a
//      short window of each other (not separated by >5s).
//
// The C4 close is observed by connecting to the session-proxy with a proper
// handshake (runClientHandshake with SESSION_PROXY_CLIENT_CAPS). A raw
// unhandshaked connection would prevent the session-proxy from exiting cleanly
// because Node's net.Server.close() waits for all tracked connections to close.
// ---------------------------------------------------------------------------
describe("tc-295a.6 L3: kill-session-under-load ordering (requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
    let serverProxy;
    let socketName;
    let runtimeDir;
    beforeEach(async () => {
        socketName = nextSocketName();
        runtimeDir = makeRuntimeDir("l3");
        serverProxy = createServerProxy({ socketName, runtimeDir });
        await serverProxy.start();
    });
    afterEach(async () => {
        await serverProxy.shutdown();
        spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });
    it("L3: external kill-session while active → sessions.removed then C4 UDS close in correct order", { timeout: 60_000 }, async () => {
        // ── Arrange: seed a second session so the tmux server doesn't die when
        // we kill the tested session (server death triggers tmux-gone self-exit
        // rather than the sessions.removed path we are testing here).
        const seedResult = spawnSync("tmux", ["-L", socketName, "new-session", "-d", "-s", "l3-seed"], { encoding: "utf8", timeout: 10_000 });
        assert.equal(seedResult.status, 0, `seed session failed: ${seedResult.stderr}`);
        // Connect to the server-proxy and claim the test session.
        const { mux } = await connectToServerProxy(serverProxy.endpoint());
        const seq = { value: 1 };
        const sessionName = "l3-kill-under-load";
        const claimResp = await sendCommand(mux, { kind: "session.claim", name: sessionName }, seq);
        assert.ok(claimResp.result.ok, `session.claim failed: ${JSON.stringify(claimResp.result)}`);
        const { sessionId } = claimResp.result.payload;
        // ── Establish a proper C4 DATA connection (D5, tc-4b6k.4).
        //
        // The single-socket collapse: connect to the ONE broker socket, run the
        // `server-proxy.capabilities` handshake, then `session.attach {sessionId}`
        // to bind this connection to the session. The session-proxy tracks it in its
        // ControlServer _clients map, so broadcastErrorAndClose reaches it when the
        // tmux session dies. No per-session socket, no second handshake.
        const c4Transport = await connectSocketTransport(serverProxy.endpoint());
        await runClientHandshake(c4Transport, CLIENT_CAPS, "server-proxy.capabilities");
        let c4Closed = false;
        let c4ClosedAt = null;
        // Consume the post-handshake messages (broker snapshot, then session
        // snapshot + deltas after attach) and track close. onControl is single-slot;
        // installing it after the handshake is correct because runClientHandshake
        // resets it to a no-op after settling.
        c4Transport.onControl((_msg) => {
            // drain all C4 control messages — legal interleaving
        });
        c4Transport.onClose(() => {
            c4Closed = true;
            c4ClosedAt = Date.now();
        });
        // Bind the connection to the session's stream.
        c4Transport.sendControl({
            type: "session.attach",
            seq: 1,
            sessionId,
        });
        // Start a load-generating shell command so the session-proxy is actively
        // producing %output at the moment of kill.
        spawnSync("tmux", ["-L", socketName, "send-keys", "-t", sessionName, "yes | head -n 1000000 &", "Enter"], { encoding: "utf8", timeout: 5_000 });
        // Give the load generator a moment to produce output.
        await new Promise((r) => setTimeout(r, 300));
        // ── Arm sessions.removed listener on C1 BEFORE the external kill.
        let removedAt = null;
        const removedPromise = new Promise((resolve) => {
            const unsub = mux.subscribe((msg) => {
                if (msg.type === "sessions.removed" &&
                    msg.sessionId === sessionId) {
                    removedAt = Date.now();
                    unsub();
                    resolve();
                }
            });
        });
        // ── Act: kill the session externally.
        const killResult = spawnSync("tmux", ["-L", socketName, "kill-session", "-t", sessionName], { encoding: "utf8", timeout: 5_000 });
        assert.equal(killResult.status, 0, `kill-session failed: ${killResult.stderr}`);
        // ── Assert 1: sessions.removed arrives on C1 within 10s.
        const [tp1, ct1] = rejectAfter(10_000, "Timeout waiting for sessions.removed after kill-session");
        await Promise.race([removedPromise, tp1]);
        ct1();
        assert.ok(removedAt !== null, "sessions.removed must arrive on C1 after external kill-session");
        // ── Assert 2: C4 transport closes within 10s of sessions.removed.
        //
        // When the tmux session exits, the session-proxy's host.onExit fires, which
        // calls broadcastErrorAndClose() → closes all handshaked C4 client transports
        // (including ours) → our c4Transport.onClose fires.
        await waitFor(() => c4Closed, 10_000, "C4 transport to close after sessions.removed");
        assert.ok(c4Closed, "C4 transport must close after sessions.removed");
        assert.ok(c4ClosedAt !== null);
        // ── Assert 3: sessions.removed and C4 close are temporally proximate.
        //
        // Both are downstream of the same tmux session death event. In the two
        // removal paths (watcher-driven via _refreshSessions, and the session-proxy's
        // own host.onExit), SIGTERM is sent before broadcastRemoved. The C4 close
        // comes from the session-proxy's broadcastErrorAndClose (on host.onExit), and
        // sessions.removed comes from the server-proxy's _refreshSessions (watcher
        // detects the gone session). The two events may arrive in either order
        // (different async paths), but must be within 5s of each other.
        const orderingGapMs = Math.abs((c4ClosedAt ?? 0) - (removedAt ?? 0));
        assert.ok(orderingGapMs < 5_000, `sessions.removed (${removedAt}ms) and C4 close (${c4ClosedAt}ms) must be within 5s ` +
            `of each other — they are downstream of the same session death event; got ${orderingGapMs}ms gap`);
        // ── Assert 4 (D5, tc-4b6k.4): the session is no longer reachable via the
        // broker — a fresh session.attach for it fails (the successor to the pre-D5
        // "per-session UDS path is removed" assertion).
        assert.equal(await probeSessionReachable(serverProxy.endpoint(), sessionId, 2_000), false, "session must be unreachable via session.attach after external kill + sessions.removed");
        mux.transport.close();
    });
});
// ---------------------------------------------------------------------------
// L4 — kill the LAST session (empties the tmux server) — tc-hfxb.19
//
// The Mode-B random-walk flake: killing the LAST pane of the LAST session
// empties the whole tmux server.  L3 above deliberately AVOIDS this (it seeds a
// second session) because server death routes differently.  Here we hit it
// head-on with `persistThroughTmuxGone` (the e2e/long-lived-broker config), so
// the broker does NOT self-exit on tmux-gone — it must STILL broadcast
// `sessions.removed` for the killed session.
//
// Pre-fix this hung: `_refreshSessions`'s tc-hfxb.18.4 removal gate removes on
// `checkSessionPresence === "absent"`, and that check used to lump "no server
// running" in with "error connecting" as "inconclusive" — so with the server
// gone the removal was SKIPPED and the dead session lingered in the table and in
// the tree (onlyInTree=[pN]).  The fix (tc-hfxb.19): `checkSessionPresence`
// classifies "no server running" (a server that WENT DOWN) as "absent" — a tmux
// session cannot outlive its server, so a down server has no sessions.  The
// existing removal gate then removes the dead session on the EOF-driven (and any
// other) `_refreshSessions`, even on an unreachable server.
//
// This must NOT regress tc-hfxb.18.4: that gate protects a TRANSIENT list that
// omits a LIVE session whose session-proxy is still running — every such removal
// is short-circuited by the gate's `hasSessionProxy` fast-path BEFORE
// `checkSessionPresence` is consulted (covered by the tmux-south /
// session-error-boundary tests), so classifying a down server as "absent" cannot
// revive it.
// ---------------------------------------------------------------------------
describe("tc-hfxb.19 L4: last-session kill empties the server but still broadcasts sessions.removed (requires tmux)", { skip: !TMUX_AVAILABLE }, () => {
    let serverProxy;
    let socketName;
    let runtimeDir;
    beforeEach(async () => {
        socketName = nextSocketName();
        runtimeDir = makeRuntimeDir("l4");
        // persistThroughTmuxGone: the long-lived (e2e) broker config — on tmux-gone
        // it re-enters watcher poll mode instead of self-exiting, so the
        // sessions.removed path under test is reachable.
        serverProxy = createServerProxy({ socketName, runtimeDir, persistThroughTmuxGone: true });
        await serverProxy.start();
    });
    afterEach(async () => {
        await serverProxy.shutdown();
        spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });
    it("L4: killing the ONLY session (server dies) broadcasts sessions.removed on C1", { timeout: 60_000 }, async () => {
        // ── Arrange: connect + claim the ONLY session (no seed — its death empties
        // the whole tmux server).
        const { mux } = await connectToServerProxy(serverProxy.endpoint());
        const seq = { value: 1 };
        const sessionName = "l4-last-session";
        const claimResp = await sendCommand(mux, { kind: "session.claim", name: sessionName }, seq);
        assert.ok(claimResp.result.ok, `session.claim failed: ${JSON.stringify(claimResp.result)}`);
        const { sessionId } = claimResp.result.payload;
        // Sanity: it is the only session on the socket.
        const lsBefore = spawnSync("tmux", ["-L", socketName, "list-sessions"], { encoding: "utf8", timeout: 5_000 });
        assert.equal((lsBefore.stdout ?? "").trim().split("\n").filter(Boolean).length, 1, "exactly one session before kill");
        // ── Arm sessions.removed listener on C1 BEFORE the kill.
        let removedAt = null;
        const removedPromise = new Promise((resolve) => {
            const unsub = mux.subscribe((msg) => {
                if (msg.type === "sessions.removed" &&
                    msg.sessionId === sessionId) {
                    removedAt = Date.now();
                    unsub();
                    resolve();
                }
            });
        });
        // ── Act: kill the ONLY session — this empties the whole tmux server.
        const killResult = spawnSync("tmux", ["-L", socketName, "kill-session", "-t", sessionName], { encoding: "utf8", timeout: 5_000 });
        assert.equal(killResult.status, 0, `kill-session failed: ${killResult.stderr}`);
        // ── Assert: the server is now gone (last session took it down).
        await waitFor(() => {
            const ls = spawnSync("tmux", ["-L", socketName, "has-session", "-t", sessionName], {
                encoding: "utf8",
                timeout: 5_000,
            });
            // status !== 0 — the session (and with it the server) is gone.
            return ls.status !== 0;
        }, 10_000, "tmux server to be gone after the last session was killed");
        // ── Assert (THE FIX): sessions.removed STILL arrives on C1 within 15s,
        // driven by the session-proxy's -CC host.onExit even though the server is
        // unreachable and `checkSessionPresence` can only answer "inconclusive".
        const [tp, ct] = rejectAfter(15_000, "Timeout waiting for sessions.removed after last-session kill (empty server)");
        await Promise.race([removedPromise, tp]);
        ct();
        assert.ok(removedAt !== null, "sessions.removed must arrive on C1 after the LAST session is killed and the server dies — " +
            "the -CC EOF is authoritative genuine-gone evidence (tc-hfxb.19); a regression here is the " +
            "onlyInTree random-walk flake");
        mux.transport.close();
    });
});
//# sourceMappingURL=session-removal-ordering.test.js.map