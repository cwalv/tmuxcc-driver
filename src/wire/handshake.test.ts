/**
 * Tests for the handshake sequence (src/wire/handshake.ts).
 *
 * Uses createInMemoryTransportPair() to exercise the full protocol flow
 * synchronously — both sides drive each other via the in-memory transport.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTransportPair } from "./transport.js";
import { WIRE_PROTOCOL_VERSION } from "./control.js";
import type { Capabilities } from "./control.js";
import {
  runDaemonHandshake,
  runClientHandshake,
  intersectFeatures,
  negotiateCapabilities,
  HandshakeError,
} from "./handshake.js";

// ---------------------------------------------------------------------------
// Capability helpers
// ---------------------------------------------------------------------------

function makeCaps(
  features: Capabilities["features"],
  version: number = WIRE_PROTOCOL_VERSION,
): Capabilities {
  // Cast needed because the type is branded as `typeof WIRE_PROTOCOL_VERSION`
  // but we deliberately test mismatched versions in some cases.
  return { protocolVersion: version as typeof WIRE_PROTOCOL_VERSION, features };
}

// ---------------------------------------------------------------------------
// Unit: intersectFeatures
// ---------------------------------------------------------------------------

describe("intersectFeatures", () => {
  it("returns intersection of two feature lists", () => {
    const result = intersectFeatures(
      ["pane-lifecycle", "layout-updates", "focus-events"],
      ["layout-updates", "focus-events", "input-forwarding"],
    );
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
    const result = intersectFeatures(
      ["focus-events", "pane-lifecycle", "layout-updates"],
      ["pane-lifecycle", "focus-events"],
    );
    assert.deepStrictEqual(result, ["focus-events", "pane-lifecycle"]);
  });

  it("handles unknown future features without crashing", () => {
    const result = intersectFeatures(
      ["pane-lifecycle", "future-feature-x"],
      ["pane-lifecycle", "future-feature-x"],
    );
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
    assert.throws(
      () => negotiateCapabilities(local, remote),
      (err: unknown) => {
        assert.ok(err instanceof HandshakeError);
        assert.equal(err.code, "protocol.version-mismatch");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: happy path — full handshake over in-memory transport pair
// ---------------------------------------------------------------------------

describe("runDaemonHandshake + runClientHandshake — happy path", () => {
  it("both sides arrive at the same negotiated version", async () => {
    const { daemon: daemonTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const daemonCaps = makeCaps([
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

    const [daemonSession, clientSession] = await Promise.all([
      runDaemonHandshake(daemonTransport, daemonCaps),
      runClientHandshake(clientTransport, clientCaps),
    ]);

    // Both sides agree on the protocol version
    assert.equal(daemonSession.protocolVersion, WIRE_PROTOCOL_VERSION);
    assert.equal(clientSession.protocolVersion, WIRE_PROTOCOL_VERSION);

    // Both sides compute the same feature intersection
    assert.deepStrictEqual(
      [...daemonSession.features].sort(),
      [...clientSession.features].sort(),
    );
  });

  it("negotiated features are the intersection of both sides' advertised sets", async () => {
    const { daemon: daemonTransport, client: clientTransport } =
      createInMemoryTransportPair();

    // Daemon: A, B, C;  Client: B, C, D  →  negotiated: B, C
    const daemonCaps = makeCaps(["pane-lifecycle", "layout-updates", "focus-events"]);
    const clientCaps = makeCaps(["layout-updates", "focus-events", "input-forwarding"]);

    const [daemonSession, clientSession] = await Promise.all([
      runDaemonHandshake(daemonTransport, daemonCaps),
      runClientHandshake(clientTransport, clientCaps),
    ]);

    const expectedFeatures = ["layout-updates", "focus-events"];
    assert.deepStrictEqual(
      [...daemonSession.features].sort(),
      [...expectedFeatures].sort(),
    );
    assert.deepStrictEqual(
      [...clientSession.features].sort(),
      [...expectedFeatures].sort(),
    );
  });

  it("succeeds with no overlapping features — negotiated set is empty", async () => {
    const { daemon: daemonTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const daemonCaps = makeCaps(["pane-lifecycle"]);
    const clientCaps = makeCaps(["input-forwarding"]);

    const [daemonSession, clientSession] = await Promise.all([
      runDaemonHandshake(daemonTransport, daemonCaps),
      runClientHandshake(clientTransport, clientCaps),
    ]);

    assert.deepStrictEqual(daemonSession.features, []);
    assert.deepStrictEqual(clientSession.features, []);
  });

  it("succeeds when both sides advertise the same full feature set", async () => {
    const { daemon: daemonTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const allFeatures: Capabilities["features"] = [
      "pane-lifecycle",
      "layout-updates",
      "focus-events",
      "input-forwarding",
    ];
    const daemonCaps = makeCaps(allFeatures);
    const clientCaps = makeCaps(allFeatures);

    const [daemonSession, clientSession] = await Promise.all([
      runDaemonHandshake(daemonTransport, daemonCaps),
      runClientHandshake(clientTransport, clientCaps),
    ]);

    assert.deepStrictEqual([...daemonSession.features].sort(), [...allFeatures].sort());
    assert.deepStrictEqual([...clientSession.features].sort(), [...allFeatures].sort());
  });
});

// ---------------------------------------------------------------------------
// Integration: version mismatch — handshake fails cleanly (no hang)
// ---------------------------------------------------------------------------

describe("runDaemonHandshake + runClientHandshake — version mismatch", () => {
  it("both sides reject with HandshakeError when client has a different version", async () => {
    const { daemon: daemonTransport, client: clientTransport } =
      createInMemoryTransportPair();

    // Force version=2 on client side to simulate a future/mismatched client.
    const daemonCaps = makeCaps(["pane-lifecycle"], 1);
    const clientCaps = makeCaps(["pane-lifecycle"], 2);

    const [daemonResult, clientResult] = await Promise.allSettled([
      runDaemonHandshake(daemonTransport, daemonCaps),
      runClientHandshake(clientTransport, clientCaps),
    ]);

    // Daemon sees the client's version=2 and rejects
    assert.equal(daemonResult.status, "rejected");
    if (daemonResult.status === "rejected") {
      assert.ok(
        daemonResult.reason instanceof HandshakeError,
        `expected HandshakeError, got ${daemonResult.reason}`,
      );
      assert.equal(
        (daemonResult.reason as HandshakeError).code,
        "protocol.version-mismatch",
      );
    }

    // Client computes the mismatch locally (or the transport closes) and rejects too.
    // (The in-memory transport delivers synchronously, so the client side also
    // rejects with version-mismatch before the transport is torn down.)
    assert.equal(clientResult.status, "rejected");
    if (clientResult.status === "rejected") {
      assert.ok(
        clientResult.reason instanceof HandshakeError,
        `expected HandshakeError, got ${clientResult.reason}`,
      );
      assert.equal(
        (clientResult.reason as HandshakeError).code,
        "protocol.version-mismatch",
      );
    }
  });

  it("daemon rejects with version-mismatch when daemon has a different version", async () => {
    const { daemon: daemonTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const daemonCaps = makeCaps(["pane-lifecycle"], 2);
    const clientCaps = makeCaps(["pane-lifecycle"], 1);

    const [daemonResult, clientResult] = await Promise.allSettled([
      runDaemonHandshake(daemonTransport, daemonCaps),
      runClientHandshake(clientTransport, clientCaps),
    ]);

    assert.equal(daemonResult.status, "rejected");
    if (daemonResult.status === "rejected") {
      assert.ok(daemonResult.reason instanceof HandshakeError);
      assert.equal(
        (daemonResult.reason as HandshakeError).code,
        "protocol.version-mismatch",
      );
    }

    assert.equal(clientResult.status, "rejected");
    if (clientResult.status === "rejected") {
      assert.ok(clientResult.reason instanceof HandshakeError);
      assert.equal(
        (clientResult.reason as HandshakeError).code,
        "protocol.version-mismatch",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: transport closed before handshake completes
// ---------------------------------------------------------------------------

describe("handshake — transport closed early", () => {
  it("daemon rejects with transport.closed if transport closes before client responds", async () => {
    const { daemon: daemonTransport } = createInMemoryTransportPair();

    const daemonCaps = makeCaps(["pane-lifecycle"]);

    // Close the transport immediately after starting the handshake
    const daemonPromise = runDaemonHandshake(daemonTransport, daemonCaps);
    daemonTransport.close();

    const result = await daemonPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    assert.equal(result.ok, false);
    assert.ok(result.error instanceof HandshakeError);
    assert.equal((result.error as HandshakeError).code, "transport.closed");
  });

  it("client rejects with transport.closed if transport closes before daemon advertises", async () => {
    const { client: clientTransport } = createInMemoryTransportPair();

    const clientCaps = makeCaps(["pane-lifecycle"]);

    const clientPromise = runClientHandshake(clientTransport, clientCaps);
    clientTransport.close();

    const result = await clientPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    assert.equal(result.ok, false);
    assert.ok(result.error instanceof HandshakeError);
    assert.equal((result.error as HandshakeError).code, "transport.closed");
  });
});

// ---------------------------------------------------------------------------
// Integration: unexpected message type during handshake
// ---------------------------------------------------------------------------

describe("handshake — unexpected message type", () => {
  it("client rejects with unexpected-message if daemon sends wrong type first", async () => {
    const { daemon: daemonTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const clientCaps = makeCaps(["pane-lifecycle"]);
    const clientPromise = runClientHandshake(clientTransport, clientCaps);

    // Daemon sends a non-capabilities message instead
    daemonTransport.sendControl({
      type: "snapshot",
      seq: 1,
      sessions: [],
      windows: [],
      panes: [],
      focus: { paneId: null, windowId: null, sessionId: null },
    });

    const result = await clientPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    assert.equal(result.ok, false);
    assert.ok(result.error instanceof HandshakeError);
    assert.equal(
      (result.error as HandshakeError).code,
      "protocol.unexpected-message",
    );
  });

  it("daemon rejects with unexpected-message if client sends wrong type", async () => {
    const { daemon: daemonTransport, client: clientTransport } =
      createInMemoryTransportPair();

    const daemonCaps = makeCaps(["pane-lifecycle"]);
    const daemonPromise = runDaemonHandshake(daemonTransport, daemonCaps);

    // Client sends a non-capabilities message instead of responding
    clientTransport.sendControl({
      type: "input",
      seq: 1,
      paneId: "p0" as ReturnType<typeof import("./ids.js").paneId>,
      data: "oops",
    });

    const result = await daemonPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );

    assert.equal(result.ok, false);
    assert.ok(result.error instanceof HandshakeError);
    assert.equal(
      (result.error as HandshakeError).code,
      "protocol.unexpected-message",
    );
  });
});
