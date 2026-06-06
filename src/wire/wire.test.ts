/**
 * Control-plane wire schema tests.
 *
 * These tests verify:
 *   1. Representative control messages can be constructed with correct shapes.
 *   2. Type guards (isControlMessage, isDaemonMessage, isClientMessage) narrow
 *      correctly at runtime.
 *   3. The discriminated union covers all expected message types.
 *
 * Full encode/decode round-trip across a transport is tc-fwb's job. The tests
 * here focus on structural correctness and type-guard behaviour.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WIRE_PROTOCOL_VERSION,
  paneId,
  windowId,
  sessionId,
  isControlMessage,
  isDaemonMessage,
  isClientMessage,
} from "./index.js";

import type {
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  LayoutUpdatedMessage,
  FocusChangedMessage,
  DaemonCapabilitiesMessage,
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  ControlMessage,
  WindowLayout,
  // New types
  SnapshotMessage,
  PaneModeChangedMessage,
  WindowAddedMessage,
  WindowClosedMessage,
  WindowRenamedMessage,
  DaemonSessionRenamedMessage,
  // Backward-compat aliases (still exported for caller migration)
  CommandRequestMessage,
  CommandResponseMessage,
  ErrorMessage,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const P0 = paneId("p0");
const P1 = paneId("p1");
const W0 = windowId("w0");
const S0 = sessionId("s0");

/** A minimal window layout for testing layout messages. */
const sampleLayout: WindowLayout = {
  cols: 80,
  rows: 24,
  root: {
    kind: "hsplit",
    rect: { x: 0, y: 0, cols: 80, rows: 24 },
    children: [
      { kind: "pane", paneId: P0, rect: { x: 0, y: 0, cols: 40, rows: 24 } },
      { kind: "pane", paneId: P1, rect: { x: 40, y: 0, cols: 40, rows: 24 } },
    ],
  },
};

// ---------------------------------------------------------------------------
// WIRE_PROTOCOL_VERSION
// ---------------------------------------------------------------------------

describe("WIRE_PROTOCOL_VERSION", () => {
  it("is a positive integer", () => {
    assert.strictEqual(typeof WIRE_PROTOCOL_VERSION, "number");
    assert.ok(WIRE_PROTOCOL_VERSION >= 1);
  });
});

// ---------------------------------------------------------------------------
// PaneId / WindowId / SessionId construction
// ---------------------------------------------------------------------------

describe("id constructors", () => {
  it("paneId() round-trips through string comparison", () => {
    const id = paneId("p42");
    // Branded type — underlying value is the string
    assert.strictEqual(id as string, "p42");
  });

  it("windowId() and sessionId() are distinct brands (structural)", () => {
    const w = windowId("w1");
    const s = sessionId("s1");
    assert.strictEqual(w as string, "w1");
    assert.strictEqual(s as string, "s1");
  });
});

// ---------------------------------------------------------------------------
// Daemon → Client message construction
// ---------------------------------------------------------------------------

describe("PaneOpenedMessage", () => {
  it("constructs correctly", () => {
    const msg: PaneOpenedMessage = {
      type: "pane.opened",
      seq: 1,
      paneId: P0,
      windowId: W0,
      cols: 80,
      rows: 24,
      active: true,
    };
    assert.strictEqual(msg.type, "pane.opened");
    assert.strictEqual(msg.cols, 80);
    assert.strictEqual(msg.rows, 24);
    assert.strictEqual(msg.active, true);
    assert.strictEqual(msg.paneId as string, "p0");
  });
});

describe("PaneClosedMessage", () => {
  it("constructs correctly", () => {
    const msg: PaneClosedMessage = {
      type: "pane.closed",
      seq: 2,
      paneId: P0,
      windowId: W0,
    };
    assert.strictEqual(msg.type, "pane.closed");
  });
});

describe("PaneResizedMessage", () => {
  it("constructs correctly", () => {
    const msg: PaneResizedMessage = {
      type: "pane.resized",
      seq: 3,
      paneId: P0,
      cols: 120,
      rows: 40,
    };
    assert.strictEqual(msg.type, "pane.resized");
    assert.strictEqual(msg.cols, 120);
  });
});

describe("LayoutUpdatedMessage", () => {
  it("constructs with a structured layout tree", () => {
    const msg: LayoutUpdatedMessage = {
      type: "layout.updated",
      seq: 4,
      windowId: W0,
      layout: sampleLayout,
    };
    assert.strictEqual(msg.type, "layout.updated");
    assert.strictEqual(msg.layout.root.kind, "hsplit");
    // Narrowing the layout tree
    const root = msg.layout.root;
    assert.ok(root.kind === "hsplit");
    assert.strictEqual(root.children.length, 2);
    const left = root.children[0];
    assert.ok(left !== undefined && left.kind === "pane");
    assert.strictEqual(left.paneId as string, "p0");
  });
});

describe("FocusChangedMessage", () => {
  it("constructs with a paneId", () => {
    const msg: FocusChangedMessage = {
      type: "focus.changed",
      seq: 5,
      paneId: P1,
      windowId: W0,
    };
    assert.strictEqual(msg.type, "focus.changed");
    assert.strictEqual(msg.paneId as string, "p1");
  });

  it("constructs with null paneId when no pane is active", () => {
    const msg: FocusChangedMessage = {
      type: "focus.changed",
      seq: 6,
      paneId: null,
      windowId: null,
    };
    assert.strictEqual(msg.paneId, null);
  });
});

describe("DaemonCapabilitiesMessage", () => {
  it("constructs with protocol version and features", () => {
    const msg: DaemonCapabilitiesMessage = {
      type: "daemon.capabilities",
      seq: 7,
      capabilities: {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
      },
    };
    assert.strictEqual(msg.capabilities.protocolVersion, WIRE_PROTOCOL_VERSION);
    assert.ok(msg.capabilities.features.includes("pane-lifecycle"));
  });
});

// ---------------------------------------------------------------------------
// Client → Daemon message construction
// ---------------------------------------------------------------------------

describe("InputMessage", () => {
  it("constructs with UTF-8 data string", () => {
    const msg: InputMessage = {
      type: "input",
      seq: 1,
      paneId: P0,
      data: "ls -la\r",
    };
    assert.strictEqual(msg.type, "input");
    assert.strictEqual(msg.data, "ls -la\r");
  });

  it("can carry escape sequences as string data", () => {
    const msg: InputMessage = {
      type: "input",
      seq: 2,
      paneId: P0,
      data: "\x1b[A", // cursor up — pre-encoded by client
    };
    assert.strictEqual(msg.data, "\x1b[A");
  });
});

describe("ResizeRequestMessage", () => {
  it("constructs correctly", () => {
    const msg: ResizeRequestMessage = {
      type: "resize.request",
      seq: 3,
      paneId: P0,
      cols: 132,
      rows: 50,
    };
    assert.strictEqual(msg.type, "resize.request");
    assert.strictEqual(msg.cols, 132);
  });
});

describe("ClientCapabilitiesMessage", () => {
  it("constructs correctly", () => {
    const msg: ClientCapabilitiesMessage = {
      type: "client.capabilities",
      seq: 1,
      capabilities: {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        features: ["pane-lifecycle", "input-forwarding"],
      },
    };
    assert.strictEqual(msg.type, "client.capabilities");
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe("isControlMessage", () => {
  it("accepts a valid daemon message", () => {
    const msg: ControlMessage = {
      type: "pane.opened",
      seq: 1,
      paneId: P0,
      windowId: W0,
      cols: 80,
      rows: 24,
      active: false,
    };
    assert.strictEqual(isControlMessage(msg), true);
  });

  it("rejects null", () => {
    assert.strictEqual(isControlMessage(null), false);
  });

  it("rejects objects missing type", () => {
    assert.strictEqual(isControlMessage({ seq: 1 }), false);
  });

  it("rejects objects with non-string type", () => {
    assert.strictEqual(isControlMessage({ type: 42, seq: 1 }), false);
  });

  it("rejects objects missing seq", () => {
    assert.strictEqual(isControlMessage({ type: "pane.opened" }), false);
  });
});

describe("isDaemonMessage / isClientMessage", () => {
  it("identifies daemon→client messages", () => {
    const daemonTypes = [
      "pane.opened",
      "pane.closed",
      "pane.resized",
      "layout.updated",
      "focus.changed",
      "daemon.capabilities",
    ] as const;

    for (const t of daemonTypes) {
      const msg = { type: t, seq: 1 } as ControlMessage;
      assert.strictEqual(isDaemonMessage(msg), true, `${t} should be daemon message`);
      assert.strictEqual(isClientMessage(msg), false, `${t} should not be client message`);
    }
  });

  it("identifies client→daemon messages", () => {
    const clientTypes = ["input", "resize.request", "client.capabilities", "resync.request"] as const;

    for (const t of clientTypes) {
      const msg = { type: t, seq: 1 } as ControlMessage;
      assert.strictEqual(isClientMessage(msg), true, `${t} should be client message`);
      assert.strictEqual(isDaemonMessage(msg), false, `${t} should not be daemon message`);
    }
  });
});

// ---------------------------------------------------------------------------
// SnapshotMessage
// ---------------------------------------------------------------------------

describe("SnapshotMessage", () => {
  it("constructs a full-state snapshot with session, windows, panes, focus (v3 single-session)", () => {
    const W1 = windowId("w1");
    const msg: SnapshotMessage = {
      type: "snapshot",
      seq: 2,
      session: { sessionId: S0, name: "main" },
      windows: [
        {
          windowId: W0,
          name: "editor",
          active: true,
          synchronizePanes: false,
          layout: sampleLayout,
        },
      ],
      panes: [
        { paneId: P0, windowId: W0, cols: 40, rows: 24 },
        { paneId: P1, windowId: W0, cols: 40, rows: 24 },
      ],
      focus: { paneId: P0, windowId: W0 },
    };
    assert.strictEqual(msg.type, "snapshot");
    assert.strictEqual(msg.session.sessionId as string, "s0");
    assert.strictEqual(msg.windows.length, 1);
    assert.strictEqual(msg.panes.length, 2);
    assert.strictEqual(msg.focus.paneId as string, "p0");
    void W1;
  });

  it("allows null focus when no pane is active", () => {
    const msg: SnapshotMessage = {
      type: "snapshot",
      seq: 2,
      session: { sessionId: S0, name: "main" },
      windows: [],
      panes: [],
      focus: { paneId: null, windowId: null },
    };
    assert.strictEqual(msg.focus.paneId, null);
  });

  it("is recognized as a daemon message by isDaemonMessage", () => {
    const msg = { type: "snapshot", seq: 1 } as ControlMessage;
    assert.strictEqual(isDaemonMessage(msg), true);
    assert.strictEqual(isClientMessage(msg), false);
  });
});

// ---------------------------------------------------------------------------
// Window delta messages
// ---------------------------------------------------------------------------

describe("WindowAddedMessage", () => {
  it("constructs correctly", () => {
    const msg: WindowAddedMessage = {
      type: "window.added",
      seq: 10,
      windowId: W0,
      name: "vim",
      active: false,
    };
    assert.strictEqual(msg.type, "window.added");
    assert.strictEqual(msg.name, "vim");
    assert.strictEqual(msg.active, false);
  });

  it("is a daemon message", () => {
    const msg = { type: "window.added", seq: 1 } as ControlMessage;
    assert.strictEqual(isDaemonMessage(msg), true);
  });
});

describe("WindowClosedMessage", () => {
  it("constructs correctly", () => {
    const msg: WindowClosedMessage = {
      type: "window.closed",
      seq: 11,
      windowId: W0,
    };
    assert.strictEqual(msg.type, "window.closed");
    assert.strictEqual(msg.windowId as string, "w0");
  });
});

describe("WindowRenamedMessage", () => {
  it("constructs correctly", () => {
    const msg: WindowRenamedMessage = {
      type: "window.renamed",
      seq: 12,
      windowId: W0,
      newName: "server",
    };
    assert.strictEqual(msg.type, "window.renamed");
    assert.strictEqual(msg.newName, "server");
  });
});

// ---------------------------------------------------------------------------
// Session delta messages (v3: only session.renamed on daemon wire)
// ---------------------------------------------------------------------------

describe("DaemonSessionRenamedMessage", () => {
  it("constructs correctly (no sessionId field in v3)", () => {
    const msg: DaemonSessionRenamedMessage = {
      type: "session.renamed",
      seq: 23,
      newName: "prod",
    };
    assert.strictEqual(msg.type, "session.renamed");
    assert.strictEqual(msg.newName, "prod");
    // v3: no sessionId field — the bound session is implicit
    assert.ok(!("sessionId" in msg));
  });

  it("is a daemon message", () => {
    const msg = { type: "session.renamed", seq: 1 } as ControlMessage;
    assert.strictEqual(isDaemonMessage(msg), true);
  });
});

// ---------------------------------------------------------------------------
// PaneModeChangedMessage
// ---------------------------------------------------------------------------

describe("PaneModeChangedMessage", () => {
  it("constructs with 'copy' mode", () => {
    const msg: PaneModeChangedMessage = {
      type: "pane.mode-changed",
      seq: 30,
      paneId: P0,
      mode: "copy",
    };
    assert.strictEqual(msg.type, "pane.mode-changed");
    assert.strictEqual(msg.mode, "copy");
  });

  it("constructs with 'normal' mode (returning from copy mode)", () => {
    const msg: PaneModeChangedMessage = {
      type: "pane.mode-changed",
      seq: 31,
      paneId: P0,
      mode: "normal",
    };
    assert.strictEqual(msg.mode, "normal");
  });

  it("accepts an unknown future mode string", () => {
    const msg: PaneModeChangedMessage = {
      type: "pane.mode-changed",
      seq: 32,
      paneId: P0,
      mode: "some-future-mode",
    };
    assert.strictEqual(msg.mode, "some-future-mode");
  });

  it("is a daemon message", () => {
    const msg = { type: "pane.mode-changed", seq: 1 } as ControlMessage;
    assert.strictEqual(isDaemonMessage(msg), true);
  });
});

// ---------------------------------------------------------------------------
// Command request / response
// ---------------------------------------------------------------------------

describe("CommandRequestMessage", () => {
  it("constructs an open-window command", () => {
    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: 1,
      correlationId: "req-001",
      command: { kind: "open-window", name: "logs" },
    };
    assert.strictEqual(msg.type, "command.request");
    assert.strictEqual(msg.correlationId, "req-001");
    assert.strictEqual(msg.command.kind, "open-window");
  });

  it("constructs a split-pane command", () => {
    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: 2,
      correlationId: "req-002",
      command: { kind: "split-pane", paneId: P0, direction: "horizontal" },
    };
    assert.ok(msg.command.kind === "split-pane");
    assert.strictEqual(msg.command.direction, "horizontal");
  });

  it("constructs a close-pane command", () => {
    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: 3,
      correlationId: "req-003",
      command: { kind: "close-pane", paneId: P0 },
    };
    assert.ok(msg.command.kind === "close-pane");
    assert.strictEqual(msg.command.paneId as string, "p0");
  });

  it("constructs a rename-window command", () => {
    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: 4,
      correlationId: "req-004",
      command: { kind: "rename-window", windowId: W0, name: "editor" },
    };
    assert.ok(msg.command.kind === "rename-window");
    assert.strictEqual(msg.command.name, "editor");
  });

  it("constructs a select-pane command", () => {
    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: 5,
      correlationId: "req-005",
      command: { kind: "select-pane", paneId: P1 },
    };
    assert.ok(msg.command.kind === "select-pane");
  });

  it("constructs a resize-pane command", () => {
    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: 6,
      correlationId: "req-006",
      command: { kind: "resize-pane", paneId: P0, cols: 100, rows: 30 },
    };
    assert.ok(msg.command.kind === "resize-pane");
    assert.strictEqual(msg.command.cols, 100);
  });

  it("is recognized as a client message", () => {
    const msg = { type: "command.request", seq: 1 } as ControlMessage;
    assert.strictEqual(isClientMessage(msg), true);
    assert.strictEqual(isDaemonMessage(msg), false);
  });
});

describe("CommandResponseMessage — success", () => {
  it("constructs a successful response with payload", () => {
    const W1 = windowId("w1");
    const msg: CommandResponseMessage = {
      type: "command.response",
      seq: 10,
      correlationId: "req-001",
      result: { ok: true, payload: { windowId: W1 } },
    };
    assert.strictEqual(msg.type, "command.response");
    assert.strictEqual(msg.correlationId, "req-001");
    assert.strictEqual(msg.result.ok, true);
  });

  it("constructs a successful response without payload", () => {
    const msg: CommandResponseMessage = {
      type: "command.response",
      seq: 11,
      correlationId: "req-005",
      result: { ok: true },
    };
    assert.strictEqual(msg.result.ok, true);
  });

  it("is recognized as a daemon message", () => {
    const msg = { type: "command.response", seq: 1 } as ControlMessage;
    assert.strictEqual(isDaemonMessage(msg), true);
  });
});

describe("CommandResponseMessage — failure", () => {
  it("constructs a failed response with error code and message", () => {
    const msg: CommandResponseMessage = {
      type: "command.response",
      seq: 12,
      correlationId: "req-003",
      result: { ok: false, code: "pane.not-found", message: "Pane p0 does not exist" },
    };
    assert.strictEqual(msg.result.ok, false);
    if (!msg.result.ok) {
      assert.strictEqual(msg.result.code, "pane.not-found");
      assert.ok(msg.result.message.length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// ErrorMessage
// ---------------------------------------------------------------------------

describe("ErrorMessage", () => {
  it("constructs an unsolicited protocol error", () => {
    const msg: ErrorMessage = {
      type: "error",
      seq: 100,
      code: "protocol.malformed",
      message: "Required field 'paneId' is missing",
    };
    assert.strictEqual(msg.type, "error");
    assert.strictEqual(msg.code, "protocol.malformed");
    assert.ok(!("correlationId" in msg));
  });

  it("constructs a correlated error (command aborted mid-flight)", () => {
    const msg: ErrorMessage = {
      type: "error",
      seq: 101,
      code: "session.unavailable",
      message: "Session s0 was destroyed before the command could complete",
      correlationId: "req-007",
    };
    assert.strictEqual(msg.correlationId, "req-007");
    assert.strictEqual(msg.code, "session.unavailable");
  });

  it("accepts an unknown future error code", () => {
    const msg: ErrorMessage = {
      type: "error",
      seq: 102,
      code: "future.error-kind",
      message: "Something unexpected happened",
    };
    assert.strictEqual(msg.code, "future.error-kind");
  });

  it("is recognized as a daemon message", () => {
    const msg = { type: "error", seq: 1 } as ControlMessage;
    assert.strictEqual(isDaemonMessage(msg), true);
    assert.strictEqual(isClientMessage(msg), false);
  });
});

// ---------------------------------------------------------------------------
// Guard coverage — all new daemon types
// ---------------------------------------------------------------------------

describe("isDaemonMessage covers all new daemon type strings", () => {
  // v3: session.added / session.closed / session.changed removed from daemon wire
  const newDaemonTypes = [
    "snapshot",
    "pane.mode-changed",
    "window.added",
    "window.closed",
    "window.renamed",
    "session.renamed",
    "command.response",
    "error",
  ] as const;

  for (const t of newDaemonTypes) {
    it(`isDaemonMessage returns true for "${t}"`, () => {
      const msg = { type: t, seq: 1 } as ControlMessage;
      assert.strictEqual(isDaemonMessage(msg), true, `${t} should be daemon message`);
      assert.strictEqual(isClientMessage(msg), false, `${t} should not be client message`);
    });
  }
});

describe("isClientMessage covers command.request", () => {
  it("returns true for command.request", () => {
    const msg = { type: "command.request", seq: 1 } as ControlMessage;
    assert.strictEqual(isClientMessage(msg), true);
    assert.strictEqual(isDaemonMessage(msg), false);
  });
});

// ---------------------------------------------------------------------------
// Invariant smoke test: no tmux vocabulary in message shapes
// ---------------------------------------------------------------------------

describe("wire invariant", () => {
  it("InputMessage uses string data, not tmux send-keys syntax", () => {
    // This is a documentation test: we verify that `data` is just a string
    // (the client is responsible for encoding — not tmux command syntax).
    const msg: InputMessage = { type: "input", seq: 1, paneId: P0, data: "hello" };
    assert.ok(typeof msg.data === "string");
    // No %output, no begin/end markers in any message type field names
    assert.ok(!("output" in msg));
    assert.ok(!("begin" in msg));
    assert.ok(!("end" in msg));
  });

  it("LayoutUpdatedMessage carries structured tree, not a tmux layout string", () => {
    const msg: LayoutUpdatedMessage = {
      type: "layout.updated",
      seq: 1,
      windowId: W0,
      layout: sampleLayout,
    };
    // layout.root is a LayoutNode, not a string
    assert.ok(typeof msg.layout.root === "object");
    assert.ok(!("layoutString" in msg.layout));
  });
});
