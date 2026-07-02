/**
 * Tests for the handshake sequence (src/wire/handshake.ts).
 *
 * Uses createInMemoryTransportPair() to exercise the full protocol flow
 * synchronously — both sides drive each other via the in-memory transport.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryTransportPair } from "./transport.js";
import { WIRE_PROTOCOL_VERSION } from "./envelope.js";
import { runSessionProxyHandshake, runClientHandshake, intersectFeatures, negotiateCapabilities, HandshakeError, } from "./handshake.js";
// ---------------------------------------------------------------------------
// Capability helpers
// ---------------------------------------------------------------------------
function makeCaps(features, version = WIRE_PROTOCOL_VERSION) {
    // Cast needed because the type is branded as `typeof WIRE_PROTOCOL_VERSION`
    // but we deliberately test mismatched versions in some cases.
    return { protocolVersion: version, features };
}
// ---------------------------------------------------------------------------
// Unit: intersectFeatures
// ---------------------------------------------------------------------------
describe("intersectFeatures", () => {
    it("returns intersection of two feature lists", () => {
        const result = intersectFeatures(["pane-lifecycle", "layout-updates", "focus-events"], ["layout-updates", "focus-events", "input-forwarding"]);
        assert.deepStrictEqual(result, ["layout-updates", "focus-events"]);
    });
    it("returns empty array when no overlap", () => {
        const result = intersectFeatures(["pane-lifecycle"], ["input-forwarding"]);
        assert.deepStrictEqual(result, []);
    });
    it("returns empty array when either list is empty", () => {
        assert.deepStrictEqual(intersectFeatures([], ["pane-lifecycle"]), []);
        assert.deepStrictEqual(intersectFeatures(["pane-lifecycle"], []), []);
    });
    it("preserves order from the first list", () => {
        const result = intersectFeatures(["focus-events", "pane-lifecycle", "layout-updates"], ["pane-lifecycle", "focus-events"]);
        assert.deepStrictEqual(result, ["focus-events", "pane-lifecycle"]);
    });
    it("handles unknown future features without crashing", () => {
        const result = intersectFeatures(["pane-lifecycle", "future-feature-x"], ["pane-lifecycle", "future-feature-x"]);
        assert.deepStrictEqual(result, ["pane-lifecycle", "future-feature-x"]);
    });
});
// ---------------------------------------------------------------------------
// Unit: negotiateCapabilities
// ---------------------------------------------------------------------------
describe("negotiateCapabilities", () => {
    it("returns NegotiatedSession with agreed version and intersected features", () => {
        const local = makeCaps(["pane-lifecycle", "layout-updates", "focus-events"]);
        const remote = makeCaps(["layout-updates", "focus-events", "input-forwarding"]);
        const session = negotiateCapabilities(local, remote);
        assert.equal(session.protocolVersion, WIRE_PROTOCOL_VERSION);
        assert.deepStrictEqual(session.features, ["layout-updates", "focus-events"]);
    });
    it("throws HandshakeError on version mismatch", () => {
        const local = makeCaps(["pane-lifecycle"], 1);
        const remote = makeCaps(["pane-lifecycle"], 2);
        assert.throws(() => negotiateCapabilities(local, remote), (err) => {
            assert.ok(err instanceof HandshakeError);
            assert.equal(err.code, "protocol.version-mismatch");
            return true;
        });
    });
});
// ---------------------------------------------------------------------------
// Integration: happy path — full handshake over in-memory transport pair
// ---------------------------------------------------------------------------
describe("runSessionProxyHandshake + runClientHandshake — happy path", () => {
    it("both sides arrive at the same negotiated version", async () => {
        const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
        const sessionProxyCaps = makeCaps([
            "pane-lifecycle",
            "layout-updates",
            "focus-events",
            "input-forwarding",
        ]);
        const clientCaps = makeCaps([
            "pane-lifecycle",
            "focus-events",
            "input-forwarding",
        ]);
        const [sessionProxySession, clientSession] = await Promise.all([
            runSessionProxyHandshake(sessionProxyTransport, sessionProxyCaps),
            runClientHandshake(clientTransport, clientCaps),
        ]);
        // Both sides agree on the protocol version
        assert.equal(sessionProxySession.protocolVersion, WIRE_PROTOCOL_VERSION);
        assert.equal(clientSession.protocolVersion, WIRE_PROTOCOL_VERSION);
        // Both sides compute the same feature intersection
        assert.deepStrictEqual([...sessionProxySession.features].sort(), [...clientSession.features].sort());
    });
    it("negotiated features are the intersection of both sides' advertised sets", async () => {
        const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
        // SessionProxy: A, B, C;  Client: B, C, D  →  negotiated: B, C
        const sessionProxyCaps = makeCaps(["pane-lifecycle", "layout-updates", "focus-events"]);
        const clientCaps = makeCaps(["layout-updates", "focus-events", "input-forwarding"]);
        const [sessionProxySession, clientSession] = await Promise.all([
            runSessionProxyHandshake(sessionProxyTransport, sessionProxyCaps),
            runClientHandshake(clientTransport, clientCaps),
        ]);
        const expectedFeatures = ["layout-updates", "focus-events"];
        assert.deepStrictEqual([...sessionProxySession.features].sort(), [...expectedFeatures].sort());
        assert.deepStrictEqual([...clientSession.features].sort(), [...expectedFeatures].sort());
    });
    it("succeeds with no overlapping features — negotiated set is empty", async () => {
        const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
        const sessionProxyCaps = makeCaps(["pane-lifecycle"]);
        const clientCaps = makeCaps(["input-forwarding"]);
        const [sessionProxySession, clientSession] = await Promise.all([
            runSessionProxyHandshake(sessionProxyTransport, sessionProxyCaps),
            runClientHandshake(clientTransport, clientCaps),
        ]);
        assert.deepStrictEqual(sessionProxySession.features, []);
        assert.deepStrictEqual(clientSession.features, []);
    });
    it("succeeds when both sides advertise the same full feature set", async () => {
        const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
        const allFeatures = [
            "pane-lifecycle",
            "layout-updates",
            "focus-events",
            "input-forwarding",
        ];
        const sessionProxyCaps = makeCaps(allFeatures);
        const clientCaps = makeCaps(allFeatures);
        const [sessionProxySession, clientSession] = await Promise.all([
            runSessionProxyHandshake(sessionProxyTransport, sessionProxyCaps),
            runClientHandshake(clientTransport, clientCaps),
        ]);
        assert.deepStrictEqual([...sessionProxySession.features].sort(), [...allFeatures].sort());
        assert.deepStrictEqual([...clientSession.features].sort(), [...allFeatures].sort());
    });
});
// ---------------------------------------------------------------------------
// Integration: version mismatch — handshake fails cleanly (no hang)
// ---------------------------------------------------------------------------
describe("runSessionProxyHandshake + runClientHandshake — version mismatch", () => {
    it("both sides reject with HandshakeError when client has a different version", async () => {
        const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
        // Force version=2 on client side to simulate a future/mismatched client.
        const sessionProxyCaps = makeCaps(["pane-lifecycle"], 1);
        const clientCaps = makeCaps(["pane-lifecycle"], 2);
        const [sessionProxyResult, clientResult] = await Promise.allSettled([
            runSessionProxyHandshake(sessionProxyTransport, sessionProxyCaps),
            runClientHandshake(clientTransport, clientCaps),
        ]);
        // SessionProxy sees the client's version=2 and rejects
        assert.equal(sessionProxyResult.status, "rejected");
        if (sessionProxyResult.status === "rejected") {
            assert.ok(sessionProxyResult.reason instanceof HandshakeError, `expected HandshakeError, got ${sessionProxyResult.reason}`);
            assert.equal(sessionProxyResult.reason.code, "protocol.version-mismatch");
        }
        // Client computes the mismatch locally (or the transport closes) and rejects too.
        // (The in-memory transport delivers synchronously, so the client side also
        // rejects with version-mismatch before the transport is torn down.)
        assert.equal(clientResult.status, "rejected");
        if (clientResult.status === "rejected") {
            assert.ok(clientResult.reason instanceof HandshakeError, `expected HandshakeError, got ${clientResult.reason}`);
            assert.equal(clientResult.reason.code, "protocol.version-mismatch");
        }
    });
    it("session-proxy rejects with version-mismatch when session-proxy has a different version", async () => {
        const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
        const sessionProxyCaps = makeCaps(["pane-lifecycle"], 2);
        const clientCaps = makeCaps(["pane-lifecycle"], 1);
        const [sessionProxyResult, clientResult] = await Promise.allSettled([
            runSessionProxyHandshake(sessionProxyTransport, sessionProxyCaps),
            runClientHandshake(clientTransport, clientCaps),
        ]);
        assert.equal(sessionProxyResult.status, "rejected");
        if (sessionProxyResult.status === "rejected") {
            assert.ok(sessionProxyResult.reason instanceof HandshakeError);
            assert.equal(sessionProxyResult.reason.code, "protocol.version-mismatch");
        }
        assert.equal(clientResult.status, "rejected");
        if (clientResult.status === "rejected") {
            assert.ok(clientResult.reason instanceof HandshakeError);
            assert.equal(clientResult.reason.code, "protocol.version-mismatch");
        }
    });
});
// ---------------------------------------------------------------------------
// Integration: transport closed before handshake completes
// ---------------------------------------------------------------------------
describe("handshake — transport closed early", () => {
    it("session-proxy rejects with transport.closed if transport closes before client responds", async () => {
        const { sessionProxy: sessionProxyTransport } = createInMemoryTransportPair();
        const sessionProxyCaps = makeCaps(["pane-lifecycle"]);
        // Close the transport immediately after starting the handshake
        const sessionProxyPromise = runSessionProxyHandshake(sessionProxyTransport, sessionProxyCaps);
        sessionProxyTransport.close();
        const result = await sessionProxyPromise.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e }));
        assert.equal(result.ok, false);
        assert.ok(result.error instanceof HandshakeError);
        assert.equal(result.error.code, "transport.closed");
    });
    it("client rejects with transport.closed if transport closes before session-proxy advertises", async () => {
        const { client: clientTransport } = createInMemoryTransportPair();
        const clientCaps = makeCaps(["pane-lifecycle"]);
        const clientPromise = runClientHandshake(clientTransport, clientCaps);
        clientTransport.close();
        const result = await clientPromise.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e }));
        assert.equal(result.ok, false);
        assert.ok(result.error instanceof HandshakeError);
        assert.equal(result.error.code, "transport.closed");
    });
});
// ---------------------------------------------------------------------------
// Integration: unexpected message type during handshake
// ---------------------------------------------------------------------------
describe("handshake — unexpected message type", () => {
    it("client rejects with unexpected-message if session-proxy sends wrong type first", async () => {
        const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
        const clientCaps = makeCaps(["pane-lifecycle"]);
        const clientPromise = runClientHandshake(clientTransport, clientCaps);
        // SessionProxy sends a non-capabilities message instead
        sessionProxyTransport.sendControl({
            type: "snapshot",
            seq: 1,
            session: { sessionId: "s0", name: "s0" },
            windows: [],
            panes: [],
            focus: { paneId: null, windowId: null },
        });
        const result = await clientPromise.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e }));
        assert.equal(result.ok, false);
        assert.ok(result.error instanceof HandshakeError);
        assert.equal(result.error.code, "protocol.unexpected-message");
    });
    it("session-proxy rejects with unexpected-message if client sends wrong type", async () => {
        const { sessionProxy: sessionProxyTransport, client: clientTransport } = createInMemoryTransportPair();
        const sessionProxyCaps = makeCaps(["pane-lifecycle"]);
        const sessionProxyPromise = runSessionProxyHandshake(sessionProxyTransport, sessionProxyCaps);
        // Client sends a non-capabilities message instead of responding
        clientTransport.sendControl({
            type: "input",
            seq: 1,
            paneId: "p0",
            data: "oops",
        });
        const result = await sessionProxyPromise.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e }));
        assert.equal(result.ok, false);
        assert.ok(result.error instanceof HandshakeError);
        assert.equal(result.error.code, "protocol.unexpected-message");
    });
});
//# sourceMappingURL=handshake.test.js.map