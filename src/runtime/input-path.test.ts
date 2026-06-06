/**
 * Tests for the client→tmux input path (tc-kvk).
 *
 * Acceptance criteria:
 *   - Input wire messages produce correct `send-keys -H` on tmux stdin.
 *   - Resize maps to `refresh-client -C WxH`.
 *   - Id mapping: PaneId "p<N>" → tmux target %<N>.
 *   - Command.request messages map to the correct tmux serializer output.
 *   - Unknown / handshake messages are silently ignored (no throw).
 *
 * All tests use a FakeHost that captures write() calls — no real tmux process.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInputPath, defaultPaneIdToTmux, defaultWindowIdToTmux } from "./input-path.js";
import type { InputPath } from "./input-path.js";
import type { TmuxHost } from "./tmux-host.js";
import type {
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  CommandRequestMessage,
} from "../wire/index.js";
import { paneId, windowId, sessionId, WIRE_PROTOCOL_VERSION } from "../wire/index.js";

// ---------------------------------------------------------------------------
// FakeHost — captures write() calls for assertion
// ---------------------------------------------------------------------------

interface FakeHost extends TmuxHost {
  readonly writes: string[];
  readonly lastWrite: string | undefined;
}

function makeFakeHost(): FakeHost {
  const writes: string[] = [];

  const host: FakeHost = {
    writes,
    get lastWrite() { return writes[writes.length - 1]; },

    // InputPath only uses write() — stub the rest of TmuxHost.
    write(data: string | Uint8Array | Buffer): void {
      if (typeof data === "string") {
        writes.push(data);
      } else {
        writes.push(Buffer.from(data).toString("utf8"));
      }
    },
    start(): Promise<void> { return Promise.resolve(); },
    onData() { return () => {}; },
    onExit() { return () => {}; },
    onError() { return () => {}; },
    onStderr() { return () => {}; },
    stop(): Promise<void> { return Promise.resolve(); },
    kill() {},
    get pid(): number | undefined { return undefined; },
    get exited(): boolean { return false; },
  };

  return host;
}

// ---------------------------------------------------------------------------
// Message factory helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function nextSeq() { return ++_seq; }

function makeInput(
  paneSuffix: string,
  data: string,
): InputMessage {
  return {
    type: "input",
    seq: nextSeq(),
    paneId: paneId("p" + paneSuffix),
    data,
  };
}

function makeResize(
  paneSuffix: string,
  cols: number,
  rows: number,
): ResizeRequestMessage {
  return {
    type: "resize.request",
    seq: nextSeq(),
    paneId: paneId("p" + paneSuffix),
    cols,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Suite: id mapping helpers
// ---------------------------------------------------------------------------

describe("defaultPaneIdToTmux", () => {
  it("strips 'p' prefix and returns numeric id", () => {
    assert.equal(defaultPaneIdToTmux(paneId("p0")), 0);
    assert.equal(defaultPaneIdToTmux(paneId("p1")), 1);
    assert.equal(defaultPaneIdToTmux(paneId("p42")), 42);
  });

  it("returns NaN for non-'p' prefix ids", () => {
    assert.ok(Number.isNaN(defaultPaneIdToTmux(paneId("x5"))));
    assert.ok(Number.isNaN(defaultPaneIdToTmux(paneId(""))));
  });
});

describe("defaultWindowIdToTmux", () => {
  it("strips 'w' prefix and returns numeric id", () => {
    assert.equal(defaultWindowIdToTmux(windowId("w0")), 0);
    assert.equal(defaultWindowIdToTmux(windowId("w3")), 3);
    assert.equal(defaultWindowIdToTmux(windowId("w99")), 99);
  });

  it("returns NaN for non-'w' prefix ids", () => {
    assert.ok(Number.isNaN(defaultWindowIdToTmux(windowId("p3"))));
  });
});

// ---------------------------------------------------------------------------
// Suite: InputMessage → send-keys -H
// ---------------------------------------------------------------------------

describe("createInputPath — InputMessage", () => {
  it("ASCII 'hello' produces correct send-keys -H hex for pane p1", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "hello"));

    // "hello" in UTF-8: 68 65 6c 6c 6f
    assert.equal(host.writes.length, 1);
    assert.equal(host.lastWrite, "send-keys -H -t %1 68 65 6c 6c 6f\n");
  });

  it("pane id 'p3' maps to %3 in the command", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("3", "hi"));

    assert.ok(host.lastWrite?.includes("-t %3"), `expected -t %3, got: ${host.lastWrite}`);
  });

  it("pane id 'p0' maps to %0", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("0", "a"));

    assert.ok(host.lastWrite?.includes("-t %0"), `expected -t %0, got: ${host.lastWrite}`);
  });

  it("pane id 'p42' maps to %42", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("42", "x"));

    assert.ok(host.lastWrite?.includes("-t %42"), `expected -t %42, got: ${host.lastWrite}`);
  });

  it("single ASCII character 'a' → hex '61'", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "a"));

    assert.equal(host.lastWrite, "send-keys -H -t %1 61\n");
  });

  it("empty data string produces send-keys -H with no byte args", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", ""));

    // sendKeysHex with empty bytes: "send-keys -H -t %1" (no trailing space)
    assert.equal(host.lastWrite, "send-keys -H -t %1\n");
  });

  it("newline character → 0a", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "\n"));

    assert.equal(host.lastWrite, "send-keys -H -t %1 0a\n");
  });

  it("ESC character → 1b", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("2", "\x1b"));

    assert.equal(host.lastWrite, "send-keys -H -t %2 1b\n");
  });

  it("multibyte UTF-8 char '€' (U+20AC, 3 bytes) → e2 82 ac", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    // '€' encodes as: 0xE2 0x82 0xAC in UTF-8
    path.handleClientMessage(makeInput("1", "€"));

    assert.equal(host.lastWrite, "send-keys -H -t %1 e2 82 ac\n");
  });

  it("4-byte emoji '😀' (U+1F600) → f0 9f 98 80", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("5", "😀"));

    assert.equal(host.lastWrite, "send-keys -H -t %5 f0 9f 98 80\n");
  });

  it("mixed ASCII + multibyte: 'hi€' → correct hex sequence", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    // 'h'=68 'i'=69 '€'=e2 82 ac
    path.handleClientMessage(makeInput("1", "hi€"));

    assert.equal(host.lastWrite, "send-keys -H -t %1 68 69 e2 82 ac\n");
  });

  it("each input message is a separate write() call", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "a"));
    path.handleClientMessage(makeInput("2", "b"));

    assert.equal(host.writes.length, 2);
    assert.ok(host.writes[0]?.includes("-t %1"));
    assert.ok(host.writes[1]?.includes("-t %2"));
  });

  it("invalid pane id drops the message (no write)", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const badMsg: InputMessage = {
      type: "input",
      seq: nextSeq(),
      paneId: paneId("BADID"),
      data: "hello",
    };
    path.handleClientMessage(badMsg);

    assert.equal(host.writes.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: ResizeRequestMessage → refresh-client -C
// ---------------------------------------------------------------------------

describe("createInputPath — ResizeRequestMessage", () => {
  it("80x24 → refresh-client -C 80x24", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeResize("1", 80, 24));

    assert.equal(host.lastWrite, "refresh-client -C 80x24\n");
  });

  it("220x50 → refresh-client -C 220x50", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeResize("2", 220, 50));

    assert.equal(host.lastWrite, "refresh-client -C 220x50\n");
  });

  it("resize uses cols × rows from the message (not the pane id)", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    // paneId is irrelevant to the output command (refresh-client -C is client-wide)
    path.handleClientMessage(makeResize("99", 132, 43));

    assert.equal(host.lastWrite, "refresh-client -C 132x43\n");
    // Confirm pane number does NOT appear in the command
    assert.ok(!host.lastWrite?.includes("%99"), "pane id should not appear in refresh-client output");
  });

  it("produces exactly one write per resize message", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeResize("1", 80, 24));
    path.handleClientMessage(makeResize("1", 160, 48));

    assert.equal(host.writes.length, 2);
    assert.equal(host.writes[0], "refresh-client -C 80x24\n");
    assert.equal(host.writes[1], "refresh-client -C 160x48\n");
  });
});

// ---------------------------------------------------------------------------
// Suite: CommandRequestMessage → tmux commands
// ---------------------------------------------------------------------------

describe("createInputPath — CommandRequestMessage", () => {
  it("split-pane horizontal → split-window -h -t %3", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c1",
      command: {
        kind: "split-pane",
        paneId: paneId("p3"),
        direction: "horizontal",
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "split-window -h -t %3\n");
  });

  it("split-pane vertical → split-window -v -t %5", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c2",
      command: {
        kind: "split-pane",
        paneId: paneId("p5"),
        direction: "vertical",
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "split-window -v -t %5\n");
  });

  it("open-window without name → new-window", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c3",
      command: {
        kind: "open-window",
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "new-window\n");
  });

  it("open-window with name → new-window -n <name>", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c4",
      command: {
        kind: "open-window",
        name: "editor",
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "new-window -n editor\n");
  });

  it("close-pane → kill-pane -t %2", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c5",
      command: {
        kind: "close-pane",
        paneId: paneId("p2"),
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "kill-pane -t %2\n");
  });

  it("rename-window → rename-window -t @<N> <name>", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c6",
      command: {
        kind: "rename-window",
        windowId: windowId("w4"),
        name: "mywin",
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "rename-window -t @4 'mywin'\n");
  });

  it("select-pane → select-pane -t %7", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c7",
      command: {
        kind: "select-pane",
        paneId: paneId("p7"),
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "select-pane -t %7\n");
  });

  it("resize-pane → refresh-client -C <cols>x<rows>", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c8",
      command: {
        kind: "resize-pane",
        paneId: paneId("p1"),
        cols: 100,
        rows: 30,
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "refresh-client -C 100x30\n");
  });
});

// ---------------------------------------------------------------------------
// Suite: client.capabilities is silently ignored
// ---------------------------------------------------------------------------

describe("createInputPath — client.capabilities", () => {
  it("does not write anything to the host", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: ClientCapabilitiesMessage = {
      type: "client.capabilities",
      seq: nextSeq(),
      capabilities: {
        protocolVersion: WIRE_PROTOCOL_VERSION,
        features: ["input-forwarding"],
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 0, "capabilities message should produce no writes");
  });
});

// ---------------------------------------------------------------------------
// Suite: custom paneIdToTmux override
// ---------------------------------------------------------------------------

describe("createInputPath — custom paneIdToTmux option", () => {
  it("uses the provided mapping function instead of the default", () => {
    const host = makeFakeHost();
    // Registry-style: "p1" → tmux pane 100
    const path = createInputPath(host, {
      paneIdToTmux: (id) => (id === paneId("p1") ? 100 : NaN),
    });

    path.handleClientMessage(makeInput("1", "x"));

    assert.ok(host.lastWrite?.includes("-t %100"), `expected -t %100, got: ${host.lastWrite}`);
  });

  it("drops message when custom mapping returns NaN", () => {
    const host = makeFakeHost();
    const path = createInputPath(host, {
      paneIdToTmux: () => NaN,
    });

    path.handleClientMessage(makeInput("1", "x"));

    assert.equal(host.writes.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: kill-session command (tc-91o)
// ---------------------------------------------------------------------------

describe("createInputPath — kill-session command", () => {
  it("kill-session → kill-session -t =<sessionName>", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ks1",
      command: {
        kind: "kill-session",
        sessionName: "myworkspace",
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "kill-session -t =myworkspace\n");
  });

  it("kill-session with name containing hyphens passes through correctly", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ks2",
      command: {
        kind: "kill-session",
        sessionName: "my-project-dev",
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "kill-session -t =my-project-dev\n");
  });
});

// ---------------------------------------------------------------------------
// Suite: mixed messages in sequence
// ---------------------------------------------------------------------------

describe("createInputPath — mixed message sequence", () => {
  it("processes input then resize then input correctly", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "ab"));
    path.handleClientMessage(makeResize("1", 80, 24));
    path.handleClientMessage(makeInput("2", "c"));

    assert.equal(host.writes.length, 3);
    assert.equal(host.writes[0], "send-keys -H -t %1 61 62\n");
    assert.equal(host.writes[1], "refresh-client -C 80x24\n");
    assert.equal(host.writes[2], "send-keys -H -t %2 63\n");
  });
});

// ---------------------------------------------------------------------------
// Suite: tc-7xv.9 pane verb commands — break-pane, swap-pane, rename-pane
// ---------------------------------------------------------------------------

describe("createInputPath — break-pane command (tc-7xv.9)", () => {
  it("break-pane → break-pane -d -t %<N>", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "bp1",
      command: { kind: "break-pane", paneId: paneId("p3") },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "break-pane -d -t %3\n");
  });

  it("invalid pane id drops the message (no write)", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "bp-bad",
      command: { kind: "break-pane", paneId: paneId("INVALID") },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 0);
  });
});

describe("createInputPath — swap-pane command (tc-7xv.9)", () => {
  it("swap-pane without target → swap-pane -D -t %<N>", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sp1",
      command: { kind: "swap-pane", paneId: paneId("p2") },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "swap-pane -D -t %2\n");
  });

  it("swap-pane with explicit target → swap-pane -s %<src> -t %<tgt>", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sp2",
      command: {
        kind: "swap-pane",
        paneId: paneId("p1"),
        targetPaneId: paneId("p4"),
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "swap-pane -s %1 -t %4\n");
  });

  it("swap-pane with invalid source drops the message", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sp-bad",
      command: { kind: "swap-pane", paneId: paneId("BAD") },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 0);
  });

  it("swap-pane with invalid target drops the message", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sp-bad2",
      command: {
        kind: "swap-pane",
        paneId: paneId("p1"),
        targetPaneId: paneId("BAD"),
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 0);
  });
});

describe("createInputPath — rename-pane command (tc-7xv.9)", () => {
  it("rename-pane → select-pane -T '<title>' -t %<N>", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp1",
      command: { kind: "rename-pane", paneId: paneId("p5"), title: "build" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "select-pane -T 'build' -t %5\n");
  });

  it("rename-pane with empty title clears the tmux title", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp2",
      command: { kind: "rename-pane", paneId: paneId("p1"), title: "" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "select-pane -T '' -t %1\n");
  });

  it("rename-pane with title containing single quotes escapes them", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp3",
      command: { kind: "rename-pane", paneId: paneId("p2"), title: "it's" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "select-pane -T 'it'\\''s' -t %2\n");
  });

  it("rename-pane with title containing spaces works correctly", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp4",
      command: { kind: "rename-pane", paneId: paneId("p3"), title: "my server" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "select-pane -T 'my server' -t %3\n");
  });

  it("rename-pane with invalid pane id drops the message", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp-bad",
      command: { kind: "rename-pane", paneId: paneId("BAD"), title: "test" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: tc-7xv.15 — set-monitor-activity / set-monitor-silence commands
// ---------------------------------------------------------------------------

import type { NotificationEvent } from "../parser/notifications.js";

describe("createInputPath — set-monitor-activity (tc-7xv.15)", () => {
  it("set-monitor-activity on → set-option -wt @<N> monitor-activity on", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ma1",
      command: { kind: "set-monitor-activity", windowId: windowId("w3"), on: true },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -wt @3 monitor-activity on\n");
  });

  it("set-monitor-activity off → set-option -wt @<N> monitor-activity off", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ma2",
      command: { kind: "set-monitor-activity", windowId: windowId("w5"), on: false },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -wt @5 monitor-activity off\n");
  });

  it("set-monitor-activity dispatches synthetic internal event", () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
    });

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ma3",
      command: { kind: "set-monitor-activity", windowId: windowId("w7"), on: true },
    };
    path.handleClientMessage(msg);

    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], {
      kind: "internal:set-window-monitor-activity",
      windowId: windowId("w7"),
      on: true,
    });
  });

  it("set-monitor-activity with invalid window id drops the message", () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
    });

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ma-bad",
      command: { kind: "set-monitor-activity", windowId: windowId("BAD"), on: true },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 0);
    assert.equal(dispatched.length, 0);
  });
});

describe("createInputPath — set-monitor-silence (tc-7xv.15)", () => {
  it("set-monitor-silence 30 → set-option -wt @<N> monitor-silence 30", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms1",
      command: { kind: "set-monitor-silence", windowId: windowId("w2"), seconds: 30 },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -wt @2 monitor-silence 30\n");
  });

  it("set-monitor-silence null → set-option -wt @<N> monitor-silence 0 (disable)", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms2",
      command: { kind: "set-monitor-silence", windowId: windowId("w4"), seconds: null },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -wt @4 monitor-silence 0\n");
  });

  it("set-monitor-silence 0 → set-option -wt @<N> monitor-silence 0 (disable)", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms3",
      command: { kind: "set-monitor-silence", windowId: windowId("w1"), seconds: 0 },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -wt @1 monitor-silence 0\n");
  });

  it("set-monitor-silence dispatches synthetic internal event with normalised seconds", () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
    });

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms4",
      command: { kind: "set-monitor-silence", windowId: windowId("w6"), seconds: 60 },
    };
    path.handleClientMessage(msg);

    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], {
      kind: "internal:set-window-monitor-silence",
      windowId: windowId("w6"),
      seconds: 60,
    });
  });

  it("set-monitor-silence null dispatches synthetic event with seconds=0", () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
    });

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms5",
      command: { kind: "set-monitor-silence", windowId: windowId("w8"), seconds: null },
    };
    path.handleClientMessage(msg);

    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], {
      kind: "internal:set-window-monitor-silence",
      windowId: windowId("w8"),
      seconds: 0,
    });
  });

  it("set-monitor-silence with invalid window id drops the message", () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
    });

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms-bad",
      command: { kind: "set-monitor-silence", windowId: windowId("BAD"), seconds: 30 },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 0);
    assert.equal(dispatched.length, 0);
  });
});
