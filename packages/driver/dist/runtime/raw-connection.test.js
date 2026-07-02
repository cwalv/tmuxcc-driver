/**
 * tc-295a.21 — raw/unhandshaked UDS connection must not crash the session-proxy.
 *
 * # Problem
 *
 * The session-proxy entry point accepts UDS connections in a loop and calls
 * `sessionProxy.addClient(transport)` with `void`, discarding the returned
 * Promise. When a raw (unhandshaked / garbage-bytes / instant-close)
 * connection arrives the handshake inside `addClient` rejects with a
 * `HandshakeError`. Without a `.catch()` the rejected Promise becomes an
 * UNHANDLED PROMISE REJECTION — and in Node ≥ 22 the process exits on the
 * first unhandled rejection. That takes down every session the daemon is
 * serving (a single malformed connection is a denial-of-service).
 *
 * # Fix
 *
 * The entry point's UDS accept loop (`session-proxy-entry.ts`) must catch the
 * `addClient` rejection and log it per-connection. The catch must be specific
 * to the connection path — not a silent global catch-all — so real errors
 * (pipeline failures, etc.) still surface.
 *
 * # Tests
 *
 * U1. A raw (instant-close) transport causes `addClient` to reject with
 *     `HandshakeError{code: "transport.closed"}`.
 * U2. After a bad connection's rejection, the ControlServer's client count
 *     is 0 — the bad connection was NOT added to the client set.
 * U3. A good client can still connect successfully after a bad one rejects —
 *     the server is unaffected.
 * U4. Per-connection error catch (the fix pattern) swallows only the
 *     `HandshakeError` from the bad connection and does not affect a concurrent
 *     good client's handshake.
 *
 * # Transport timing note
 *
 * The in-memory transport fires close synchronously. The handshake
 * (`runServerHandshake`) registers its `onClose` handler synchronously in its
 * first synchronous turn (before the deferred send). Therefore:
 *
 *   const addPromise = server.addClient(dt);   // registers onClose handler
 *   ct.close();                                // fires onClose → HandshakeError
 *   await addPromise;                          // → rejects with HandshakeError
 *
 * This is the correct sequence — start `addClient` FIRST, then close the
 * transport.
 *
 * @module runtime/raw-connection.test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createControlServer } from "./serve.js";
import { createInMemoryTransportPair, HandshakeError, runClientHandshake, WIRE_PROTOCOL_VERSION, } from "@tmuxcc/protocol";
import { emptyModel } from "../state/model.js";
import { createPaneBufferStore } from "../state/scrollback.js";
function createStubPipeline() {
    let model = emptyModel();
    const handlers = new Set();
    const buffers = createPaneBufferStore();
    const stub = {
        getModel: () => model,
        onModelChange: (h) => {
            handlers.add(h);
            return () => { handlers.delete(h); };
        },
        start: () => Promise.resolve(),
        stop: () => { },
        isLive: () => false,
        buffers,
        // Stub no-ops for methods ControlServer never calls at runtime beyond
        // subscribing (onPaneNotify is subscribed in the ControlServer ctor, tc-76m8.1).
        onNotification: () => () => { },
        onPaneNotify: () => () => { },
        injectNotification: () => { },
        patchModel: () => { },
        send: () => Promise.resolve({ ok: true, output: "" }),
        sendBatch: () => [],
        refreshCorrelatorPendingGauge: () => { },
    };
    return stub;
}
const CLIENT_CAPS = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features: [
        "pane-lifecycle",
        "layout-updates",
        "focus-events",
        "input-forwarding",
    ],
};
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("tc-295a.21: raw/unhandshaked connection — per-connection rejection, server survives", () => {
    // -------------------------------------------------------------------------
    // U1. Instant-close transport → addClient rejects with HandshakeError
    //
    // The in-memory transport fires close synchronously.  The handshake
    // registers its onClose handler in its first synchronous turn (before the
    // first await / microtask-deferred send), so closing the transport AFTER
    // starting addClient triggers the HandshakeError path correctly.
    // -------------------------------------------------------------------------
    it("U1: addClient rejects with HandshakeError when the client closes without handshaking", { timeout: 10_000 }, async () => {
        const pipeline = createStubPipeline();
        const server = createControlServer(pipeline);
        const { sessionProxy: dt, client: ct } = createInMemoryTransportPair();
        // Start addClient FIRST (registers the handshake onClose handler
        // synchronously), THEN close the client side — simulating a raw/
        // unhandshaked connection (e.g. a port scanner, health probe, or a
        // process that connects and immediately disconnects).
        const addPromise = server.addClient(dt);
        ct.close(); // close after addClient starts → triggers HandshakeError
        let caught;
        try {
            await addPromise;
            assert.fail("addClient must reject for a raw/instant-close connection");
        }
        catch (err) {
            caught = err;
        }
        assert.ok(caught instanceof HandshakeError, `expected HandshakeError, got: ${String(caught)}`);
        assert.equal(caught.code, "transport.closed", `expected code "transport.closed", got: ${caught.code}`);
    });
    // -------------------------------------------------------------------------
    // U2. Bad connection is NOT added to the client set
    // -------------------------------------------------------------------------
    it("U2: clientCount remains 0 after a bad connection's addClient rejection", { timeout: 10_000 }, async () => {
        const pipeline = createStubPipeline();
        const server = createControlServer(pipeline);
        const { sessionProxy: dt, client: ct } = createInMemoryTransportPair();
        // Start addClient, then close the client side without handshaking.
        const addPromise = server.addClient(dt);
        ct.close();
        // Swallow the rejection — this is the per-connection catch pattern (the fix).
        await addPromise.catch((_err) => { });
        assert.equal(server.clientCount(), 0, "bad connection must not be counted in clientCount after rejection");
    });
    // -------------------------------------------------------------------------
    // U3. Good client can connect after a bad connection rejects
    // -------------------------------------------------------------------------
    it("U3: a good client can still connect successfully after a bad connection rejects", { timeout: 10_000 }, async () => {
        const pipeline = createStubPipeline();
        const server = createControlServer(pipeline);
        // 1. Simulate bad connection: start addClient, then close without handshaking.
        const { sessionProxy: dtBad, client: ctBad } = createInMemoryTransportPair();
        // Fire-and-forget with per-connection catch — this is the fix pattern.
        // Without the catch this would be an unhandled rejection and crash the process.
        const badP = server.addClient(dtBad).catch((_err) => {
            // Per-connection rejection — log in production; swallow in test.
        });
        ctBad.close(); // triggers HandshakeError inside badP
        await badP; // wait for the bad connection to finish
        assert.equal(server.clientCount(), 0, "bad connection must not be tracked");
        // 2. Good client connects and completes the handshake.
        const { sessionProxy: dtGood, client: ctGood } = createInMemoryTransportPair();
        const addGood = server.addClient(dtGood);
        await runClientHandshake(ctGood, CLIENT_CAPS);
        await addGood;
        assert.equal(server.clientCount(), 1, "good client must be counted after successful handshake");
        // Clean up.
        ctGood.close();
        assert.equal(server.clientCount(), 0, "clientCount must drop after good client closes");
    });
    // -------------------------------------------------------------------------
    // U4. Per-connection catch (fix pattern) does not affect a concurrent good client
    // -------------------------------------------------------------------------
    it("U4: concurrent bad + good connections — bad rejects, good succeeds", { timeout: 10_000 }, async () => {
        const pipeline = createStubPipeline();
        const server = createControlServer(pipeline);
        // Start both connections.
        const { sessionProxy: dtBad, client: ctBad } = createInMemoryTransportPair();
        const { sessionProxy: dtGood, client: ctGood } = createInMemoryTransportPair();
        // Fire both concurrently — the bad one rejects, the good one succeeds.
        // Per-connection catch on the bad one is the fix that prevents an
        // unhandled rejection from crashing the process.
        const badCaught = [];
        const badP = server.addClient(dtBad).catch((err) => {
            if (err instanceof HandshakeError) {
                badCaught.push(err);
            }
        });
        // Wire the good client's handshake concurrently.
        const goodP = server.addClient(dtGood);
        await runClientHandshake(ctGood, CLIENT_CAPS);
        // Close the bad connection AFTER both addClient calls (both have registered
        // their onClose handlers by now).
        ctBad.close();
        // Wait for both to settle.
        await Promise.all([badP, goodP]);
        // Bad connection: caught, not added.
        assert.equal(badCaught.length, 1, "bad connection must produce exactly one HandshakeError");
        const caughtErr = badCaught[0];
        assert.ok(caughtErr !== undefined, "badCaught[0] must be defined");
        assert.equal(caughtErr.code, "transport.closed");
        // Good connection: tracked.
        assert.equal(server.clientCount(), 1, "good client must be tracked after handshake");
        // Clean up.
        ctGood.close();
    });
});
//# sourceMappingURL=raw-connection.test.js.map