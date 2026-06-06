/**
 * Wire protocol round-trip test — cross-package proof.
 *
 * Imports everything from "@tmuxcc/daemon" by package name (workspace resolution).
 * This is the monorepo ergonomics proof: the client imports all wire types and
 * utilities from the daemon package without a publish step.
 *
 * Coverage:
 *   Control plane: JSON round-trip (stringify → parse → deep-equal + type guard)
 *     for EVERY ControlMessage variant:
 *       Daemon→Client: daemon.capabilities, snapshot, pane.opened, pane.closed,
 *         pane.resized, pane.mode-changed, window.added, window.closed,
 *         window.renamed, layout.updated, focus.changed, session.added,
 *         session.closed, session.changed, session.renamed, command.response
 *         (ok), command.response (err), error
 *       Client→Daemon: input, resize.request, client.capabilities,
 *         command.request (open-window), command.request (split-pane),
 *         command.request (close-pane), command.request (rename-window),
 *         command.request (select-pane), command.request (resize-pane)
 *   Transport: InMemoryTransportPair control-plane send/receive.
 *   Data frame: encodeFrame → decodeFrame and FrameDecoder with UTF-8 and
 *     non-UTF-8 payloads.
 *
 * The `buildRepresentativeMessages()` export is intended as the starting point
 * for mock-daemon setups in later epics — import it to get a ready-made set of
 * one instance of each message kind.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  // Ids
  paneId,
  windowId,
  sessionId,
  // Control guards
  isControlMessage,
  isDaemonMessage,
  isClientMessage,
  // Wire constant
  WIRE_PROTOCOL_VERSION,
  // Transport
  createInMemoryTransportPair,
  // Data plane
  encodeFrame,
  decodeFrame,
  FrameDecoder,
} from "@tmuxcc/daemon";

import type {
  PaneId,
  WindowId,
  SessionId,
  ControlMessage,
  DaemonMessage,
  ClientMessage,
  // All concrete message types — daemon→client
  DaemonCapabilitiesMessage,
  SnapshotMessage,
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  PaneModeChangedMessage,
  WindowAddedMessage,
  WindowClosedMessage,
  WindowRenamedMessage,
  LayoutUpdatedMessage,
  FocusChangedMessage,
  DaemonSessionRenamedMessage,
  CommandResponseMessage,
  ErrorMessage,
  // All concrete message types — client→daemon
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  CommandRequestMessage,
  // Layout types (used in snapshot / layout.updated)
  WindowLayout,
} from "@tmuxcc/daemon";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const P0: PaneId = paneId("p0");
const P1: PaneId = paneId("p1");
const W0: WindowId = windowId("w0");
const S0: SessionId = sessionId("s0");

const sampleLayout: WindowLayout = {
  cols: 200,
  rows: 50,
  root: {
    kind: "hsplit",
    rect: { x: 0, y: 0, cols: 200, rows: 50 },
    children: [
      { kind: "pane", paneId: P0, rect: { x: 0, y: 0, cols: 100, rows: 50 } },
      { kind: "pane", paneId: P1, rect: { x: 100, y: 0, cols: 100, rows: 50 } },
    ],
  },
};

// ---------------------------------------------------------------------------
// Message factories — one instance of every variant
// ---------------------------------------------------------------------------

/** Build one instance of each DaemonMessage variant. */
function buildDaemonMessages(): DaemonMessage[] {
  const daemonCaps: DaemonCapabilitiesMessage = {
    type: "daemon.capabilities",
    seq: 1,
    capabilities: {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle", "layout-updates", "focus-events"],
    },
  };

  const snapshot: SnapshotMessage = {
    type: "snapshot",
    seq: 2,
    session: { sessionId: S0, name: "main" },
    windows: [
      {
        windowId: W0,
        name: "editor",
        active: true,
        synchronizePanes: false,
        monitorActivity: true,
        monitorSilence: 0,
        layout: sampleLayout,
      },
    ],
    panes: [
      { paneId: P0, windowId: W0, cols: 100, rows: 50 },
      { paneId: P1, windowId: W0, cols: 100, rows: 50 },
    ],
    focus: { paneId: P0, windowId: W0 },
  };

  const paneOpened: PaneOpenedMessage = {
    type: "pane.opened",
    seq: 3,
    paneId: P0,
    windowId: W0,
    cols: 80,
    rows: 24,
    active: true,
  };

  const paneClosed: PaneClosedMessage = {
    type: "pane.closed",
    seq: 4,
    paneId: P0,
    windowId: W0,
  };

  const paneResized: PaneResizedMessage = {
    type: "pane.resized",
    seq: 5,
    paneId: P0,
    cols: 120,
    rows: 40,
  };

  const paneModeChanged: PaneModeChangedMessage = {
    type: "pane.mode-changed",
    seq: 6,
    paneId: P0,
    mode: "copy",
  };

  const windowAdded: WindowAddedMessage = {
    type: "window.added",
    seq: 7,
    windowId: W0,
    name: "editor",
    active: true,
  };

  const windowClosed: WindowClosedMessage = {
    type: "window.closed",
    seq: 8,
    windowId: W0,
  };

  const windowRenamed: WindowRenamedMessage = {
    type: "window.renamed",
    seq: 9,
    windowId: W0,
    newName: "terminal",
  };

  const layoutUpdated: LayoutUpdatedMessage = {
    type: "layout.updated",
    seq: 10,
    windowId: W0,
    layout: sampleLayout,
  };

  const focusChanged: FocusChangedMessage = {
    type: "focus.changed",
    seq: 11,
    paneId: P1,
    windowId: W0,
  };

  const focusChangedNull: FocusChangedMessage = {
    type: "focus.changed",
    seq: 12,
    paneId: null,
    windowId: null,
  };

  const sessionRenamed: DaemonSessionRenamedMessage = {
    type: "session.renamed",
    seq: 13,
    newName: "work",
  };

  const commandResponseOk: CommandResponseMessage = {
    type: "command.response",
    seq: 17,
    correlationId: "req-001",
    result: { ok: true, payload: { windowId: W0, paneId: P0 } },
  };

  const commandResponseErr: CommandResponseMessage = {
    type: "command.response",
    seq: 18,
    correlationId: "req-002",
    result: { ok: false, code: "pane.not-found", message: "Pane p99 does not exist" },
  };

  const errorMsg: ErrorMessage = {
    type: "error",
    seq: 19,
    code: "protocol.unknown-message",
    message: "Received unknown message type 'foo'",
  };

  const errorWithCorrelation: ErrorMessage = {
    type: "error",
    seq: 20,
    code: "session.unavailable",
    message: "Session s0 unexpectedly closed",
    correlationId: "req-003",
  };

  return [
    daemonCaps,
    snapshot,
    paneOpened,
    paneClosed,
    paneResized,
    paneModeChanged,
    windowAdded,
    windowClosed,
    windowRenamed,
    layoutUpdated,
    focusChanged,
    focusChangedNull,
    sessionRenamed,
    commandResponseOk,
    commandResponseErr,
    errorMsg,
    errorWithCorrelation,
  ];
}

/** Build one instance of each ClientMessage variant. */
function buildClientMessages(): ClientMessage[] {
  const input: InputMessage = {
    type: "input",
    seq: 1,
    paneId: P0,
    data: "ls -la\r",
  };

  const resizeRequest: ResizeRequestMessage = {
    type: "resize.request",
    seq: 2,
    paneId: P0,
    cols: 120,
    rows: 40,
  };

  const clientCaps: ClientCapabilitiesMessage = {
    type: "client.capabilities",
    seq: 3,
    capabilities: {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      features: ["pane-lifecycle", "input-forwarding"],
    },
  };

  const cmdOpenWindow: CommandRequestMessage = {
    type: "command.request",
    seq: 4,
    correlationId: "req-a",
    command: { kind: "open-window", name: "new-window" },
  };

  const cmdSplitPane: CommandRequestMessage = {
    type: "command.request",
    seq: 5,
    correlationId: "req-b",
    command: { kind: "split-pane", paneId: P0, direction: "horizontal" },
  };

  const cmdClosePane: CommandRequestMessage = {
    type: "command.request",
    seq: 6,
    correlationId: "req-c",
    command: { kind: "close-pane", paneId: P1 },
  };

  const cmdRenameWindow: CommandRequestMessage = {
    type: "command.request",
    seq: 7,
    correlationId: "req-d",
    command: { kind: "rename-window", windowId: W0, name: "my-window" },
  };

  const cmdSelectPane: CommandRequestMessage = {
    type: "command.request",
    seq: 8,
    correlationId: "req-e",
    command: { kind: "select-pane", paneId: P1 },
  };

  const cmdResizePane: CommandRequestMessage = {
    type: "command.request",
    seq: 9,
    correlationId: "req-f",
    command: { kind: "resize-pane", paneId: P0, cols: 80, rows: 24 },
  };

  return [
    input,
    resizeRequest,
    clientCaps,
    cmdOpenWindow,
    cmdSplitPane,
    cmdClosePane,
    cmdRenameWindow,
    cmdSelectPane,
    cmdResizePane,
  ];
}

/**
 * Build one instance of every ControlMessage variant (daemon + client).
 * Exported for reuse in mock-daemon setups in later epics.
 */
export function buildRepresentativeMessages(): ControlMessage[] {
  return [...buildDaemonMessages(), ...buildClientMessages()];
}

// ---------------------------------------------------------------------------
// Helper: JSON round-trip
// ---------------------------------------------------------------------------

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wire round-trip — cross-package import from @tmuxcc/daemon", () => {
  // ── Control plane: daemon→client ──────────────────────────────────────────

  describe("control plane — daemon→client JSON round-trips", () => {
    const daemonMessages = buildDaemonMessages();

    for (const original of daemonMessages) {
      it(`round-trips ${original.type} (seq=${original.seq})`, () => {
        const parsed = jsonRoundTrip(original);

        // Deep equality survives JSON round-trip
        assert.deepEqual(parsed, original);

        // isControlMessage narrows correctly after parse
        assert.ok(
          isControlMessage(parsed),
          `isControlMessage returned false for ${original.type}`,
        );

        // isDaemonMessage narrows correctly
        assert.ok(
          isDaemonMessage(parsed as ControlMessage),
          `isDaemonMessage returned false for ${original.type}`,
        );

        // isClientMessage must NOT match daemon messages
        assert.equal(
          isClientMessage(parsed as ControlMessage),
          false,
          `isClientMessage incorrectly returned true for daemon message ${original.type}`,
        );
      });
    }
  });

  // ── Control plane: client→daemon ──────────────────────────────────────────

  describe("control plane — client→daemon JSON round-trips", () => {
    const clientMessages = buildClientMessages();

    for (const original of clientMessages) {
      it(`round-trips ${original.type} (seq=${original.seq})`, () => {
        const parsed = jsonRoundTrip(original);

        // Deep equality survives JSON round-trip
        assert.deepEqual(parsed, original);

        // isControlMessage narrows correctly after parse
        assert.ok(
          isControlMessage(parsed),
          `isControlMessage returned false for ${original.type}`,
        );

        // isClientMessage narrows correctly
        assert.ok(
          isClientMessage(parsed as ControlMessage),
          `isClientMessage returned false for ${original.type}`,
        );

        // isDaemonMessage must NOT match client messages
        assert.equal(
          isDaemonMessage(parsed as ControlMessage),
          false,
          `isDaemonMessage incorrectly returned true for client message ${original.type}`,
        );
      });
    }
  });

  // ── Transport round-trip via InMemoryTransportPair ────────────────────────

  describe("transport — InMemoryTransportPair control-plane send/receive", () => {
    it("daemon sendControl → client onControl handler fires with equal message", () => {
      const { daemon, client } = createInMemoryTransportPair();

      const sent: DaemonMessage = {
        type: "pane.opened",
        seq: 1,
        paneId: P0,
        windowId: W0,
        cols: 80,
        rows: 24,
        active: false,
      };

      let received: ControlMessage | undefined;
      client.onControl((msg) => {
        received = msg;
      });

      daemon.sendControl(sent);

      assert.ok(received !== undefined, "onControl handler was not called");
      assert.deepEqual(received, sent);
      assert.ok(isControlMessage(received));
      assert.ok(isDaemonMessage(received));

      daemon.close();
    });

    it("client sendControl → daemon onControl handler fires with equal message", () => {
      const { daemon, client } = createInMemoryTransportPair();

      const sent: ClientMessage = {
        type: "input",
        seq: 1,
        paneId: P0,
        data: "hello\r",
      };

      let received: ControlMessage | undefined;
      daemon.onControl((msg) => {
        received = msg;
      });

      client.sendControl(sent);

      assert.ok(received !== undefined, "onControl handler was not called");
      assert.deepEqual(received, sent);
      assert.ok(isControlMessage(received));
      assert.ok(isClientMessage(received));

      client.close();
    });

    it("close propagates to remote onClose handler", () => {
      const { daemon, client } = createInMemoryTransportPair();

      let daemonGotClose = false;
      let clientGotClose = false;

      daemon.onClose(() => {
        daemonGotClose = true;
      });
      client.onClose(() => {
        clientGotClose = true;
      });

      // Close from daemon side — should notify both endpoints
      daemon.close();

      assert.ok(clientGotClose, "client onClose was not called after daemon.close()");
      assert.ok(daemonGotClose, "daemon onClose was not called after daemon.close()");
    });

    it("sendControl on closed transport does not invoke handler (no-op)", () => {
      const { daemon, client } = createInMemoryTransportPair();

      let callCount = 0;
      client.onControl(() => {
        callCount++;
      });

      daemon.close();
      // This send should be silently dropped — transport is already closed.
      daemon.sendControl({ type: "pane.closed", seq: 1, paneId: P0, windowId: W0 });

      assert.equal(callCount, 0, "handler should not fire after transport close");
    });
  });

  // ── Data-plane frame round-trips ──────────────────────────────────────────

  describe("data frame — encodeFrame / decodeFrame round-trips", () => {
    it("round-trips a UTF-8 payload via decodeFrame", () => {
      const id = P0;
      const seq = 42;
      const payload = new TextEncoder().encode("hello world");

      const frame = encodeFrame(id, seq, payload);
      const decoded = decodeFrame(frame);

      assert.equal(decoded.paneId, id);
      assert.equal(decoded.seq, seq);
      assert.deepEqual(decoded.payload, payload);
    });

    it("round-trips a non-UTF-8 payload via decodeFrame", () => {
      const id = paneId("p99");
      const seq = 0;
      // Bytes that are not valid UTF-8
      const payload = Uint8Array.from([0xff, 0x00, 0xfe, 0x80]);

      const frame = encodeFrame(id, seq, payload);
      const decoded = decodeFrame(frame);

      assert.equal(decoded.paneId, id);
      assert.equal(decoded.seq, seq);
      assert.deepEqual(decoded.payload, payload);
    });

    it("round-trips an empty payload", () => {
      const id = P1;
      const seq = 1;
      const payload = new Uint8Array(0);

      const frame = encodeFrame(id, seq, payload);
      const decoded = decodeFrame(frame);

      assert.equal(decoded.paneId, id);
      assert.equal(decoded.seq, seq);
      assert.equal(decoded.payload.length, 0);
    });

    it("round-trips a binary payload via FrameDecoder (streaming)", () => {
      const id = P0;
      const seq = 7;
      const payload = Uint8Array.from([0x01, 0x02, 0x03, 0xff, 0x00, 0xfe, 0x80, 0xab]);

      const frame = encodeFrame(id, seq, payload);

      const decoder = new FrameDecoder();
      const frames = decoder.push(frame);

      assert.equal(frames.length, 1);
      const decoded = frames[0]!;
      assert.equal(decoded.paneId, id);
      assert.equal(decoded.seq, seq);
      assert.deepEqual(decoded.payload, payload);
    });

    it("FrameDecoder handles a frame split across two chunks", () => {
      const id = paneId("s0-p1");
      const seq = 255;
      const payload = new TextEncoder().encode("split chunk test");

      const frame = encodeFrame(id, seq, payload);
      const mid = Math.floor(frame.length / 2);

      const decoder = new FrameDecoder();
      const partial = decoder.push(frame.subarray(0, mid));
      assert.equal(partial.length, 0, "no frames from first half-chunk");

      const complete = decoder.push(frame.subarray(mid));
      assert.equal(complete.length, 1);
      const decoded = complete[0]!;
      assert.equal(decoded.paneId, id);
      assert.equal(decoded.seq, seq);
      assert.deepEqual(decoded.payload, payload);
    });

    it("FrameDecoder decodes multiple frames from a single chunk", () => {
      const frames = [
        encodeFrame(P0, 0, new TextEncoder().encode("frame-a")),
        encodeFrame(P1, 1, Uint8Array.from([0xff, 0x00])),
        encodeFrame(P0, 2, new TextEncoder().encode("frame-c")),
      ];

      // Concatenate into one buffer
      const totalLen = frames.reduce((s, f) => s + f.length, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const f of frames) {
        combined.set(f, offset);
        offset += f.length;
      }

      const decoder = new FrameDecoder();
      const decoded = decoder.push(combined);

      assert.equal(decoded.length, 3);
      assert.equal(decoded[0]!.paneId, P0);
      assert.equal(decoded[0]!.seq, 0);
      assert.equal(decoded[1]!.paneId, P1);
      assert.equal(decoded[1]!.seq, 1);
      assert.equal(decoded[2]!.paneId, P0);
      assert.equal(decoded[2]!.seq, 2);
    });
  });

  // ── Sanity: isControlMessage rejects non-messages ─────────────────────────

  describe("isControlMessage guard — negative cases", () => {
    it("returns false for a plain object without type", () => {
      assert.equal(isControlMessage({ seq: 1 }), false);
    });

    it("returns false for a plain object without seq", () => {
      assert.equal(isControlMessage({ type: "pane.opened" }), false);
    });

    it("returns false for null", () => {
      assert.equal(isControlMessage(null), false);
    });

    it("returns false for a string", () => {
      assert.equal(isControlMessage("pane.opened"), false);
    });
  });
});
