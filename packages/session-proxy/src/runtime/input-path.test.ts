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

  it("throws TypeError for non-'p' prefix ids", () => {
    assert.throws(
      () => defaultPaneIdToTmux(paneId("x5")),
      (err: unknown) => err instanceof TypeError && /p<N>/.test((err as TypeError).message),
    );
    assert.throws(
      () => defaultPaneIdToTmux(paneId("")),
      TypeError,
    );
  });

  it("throws TypeError for tmux-format pane id '%1' (wrong format)", () => {
    // The tmux wire format uses "%N" prefixes; the internal model format uses "p<N>".
    // Passing a tmux-format id is a programming error that should surface loudly.
    assert.throws(
      () => defaultPaneIdToTmux(paneId("%1")),
      (err: unknown) =>
        err instanceof TypeError &&
        /%1/.test((err as TypeError).message),
    );
  });
});

describe("defaultWindowIdToTmux", () => {
  it("strips 'w' prefix and returns numeric id", () => {
    assert.equal(defaultWindowIdToTmux(windowId("w0")), 0);
    assert.equal(defaultWindowIdToTmux(windowId("w3")), 3);
    assert.equal(defaultWindowIdToTmux(windowId("w99")), 99);
  });

  it("throws TypeError for non-'w' prefix ids", () => {
    assert.throws(
      () => defaultWindowIdToTmux(windowId("p3")),
      (err: unknown) => err instanceof TypeError && /w<N>/.test((err as TypeError).message),
    );
  });

  it("throws TypeError for tmux-format window id '@9' (wrong format)", () => {
    // The tmux wire format uses "@N" prefixes; the internal model format uses "w<N>".
    // Passing a tmux-format id is a programming error that should surface loudly.
    assert.throws(
      () => defaultWindowIdToTmux(windowId("@9")),
      (err: unknown) =>
        err instanceof TypeError &&
        /@9/.test((err as TypeError).message),
    );
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

  it("invalid pane id throws TypeError", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const badMsg: InputMessage = {
      type: "input",
      seq: nextSeq(),
      paneId: paneId("BADID"),
      data: "hello",
    };
    assert.throws(
      () => path.handleClientMessage(badMsg),
      (err: unknown) => err instanceof TypeError && /p<N>/.test((err as TypeError).message),
    );
    assert.equal(host.writes.length, 0, "no partial write on bad pane id");
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

  // tc-zna.3: managed-window resize transaction.
  it("resize-managed-window → set-window-option manual + resize-window + per-pane resize-pane (batched)", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c-mw1",
      command: {
        kind: "resize-managed-window",
        windowId: windowId("w3"),
        cols: 201,
        rows: 50,
        panes: [
          { paneId: paneId("p1"), cols: 100, rows: 50 },
          { paneId: paneId("p2"), cols: 100, rows: 50 },
        ],
      },
    };
    path.handleClientMessage(msg);

    // Single host.write batch — assertion on contents in order.
    assert.equal(host.writes.length, 1, "managed-window resize must be one batched write");
    const lines = host.writes[0]!.split("\n").filter((l) => l.length > 0);
    assert.deepEqual(lines, [
      "set-window-option -t @3 window-size manual",
      "resize-window -t @3 -x 201 -y 50",
      "resize-pane -t %1 -x 100 -y 50",
      "resize-pane -t %2 -x 100 -y 50",
    ]);
  });

  it("resize-managed-window with one pane emits the single resize-pane line", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c-mw2",
      command: {
        kind: "resize-managed-window",
        windowId: windowId("w7"),
        cols: 120,
        rows: 40,
        panes: [{ paneId: paneId("p9"), cols: 120, rows: 40 }],
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 1);
    const lines = host.writes[0]!.split("\n").filter((l) => l.length > 0);
    assert.deepEqual(lines, [
      "set-window-option -t @7 window-size manual",
      "resize-window -t @7 -x 120 -y 40",
      "resize-pane -t %9 -x 120 -y 40",
    ]);
  });

  it("resize-managed-window with zero panes still emits manual + resize-window", () => {
    // Defensive: factory should never send an empty pane list, but the
    // protocol should not blow up if it happens (e.g. race where panes were
    // all closed between aggregation and dispatch).
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c-mw3",
      command: {
        kind: "resize-managed-window",
        windowId: windowId("w0"),
        cols: 80,
        rows: 24,
        panes: [],
      },
    };
    path.handleClientMessage(msg);

    assert.equal(host.writes.length, 1);
    const lines = host.writes[0]!.split("\n").filter((l) => l.length > 0);
    assert.deepEqual(lines, [
      "set-window-option -t @0 window-size manual",
      "resize-window -t @0 -x 80 -y 24",
    ]);
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
      paneIdToTmux: (id) => {
        if (id === paneId("p1")) return 100;
        throw new TypeError(`custom mapper: unrecognized pane id "${id as string}"`);
      },
    });

    path.handleClientMessage(makeInput("1", "x"));

    assert.ok(host.lastWrite?.includes("-t %100"), `expected -t %100, got: ${host.lastWrite}`);
  });

  it("throws when custom mapping throws for unrecognized id", () => {
    const host = makeFakeHost();
    const path = createInputPath(host, {
      paneIdToTmux: () => { throw new TypeError("custom mapper: unknown id"); },
    });

    assert.throws(
      () => path.handleClientMessage(makeInput("1", "x")),
      TypeError,
    );
    assert.equal(host.writes.length, 0, "no partial write on bad pane id");
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

  it("invalid pane id throws TypeError", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "bp-bad",
      command: { kind: "break-pane", paneId: paneId("INVALID") },
    };
    assert.throws(
      () => path.handleClientMessage(msg),
      (err: unknown) => err instanceof TypeError && /p<N>/.test((err as TypeError).message),
    );
    assert.equal(host.writes.length, 0, "no partial write on bad pane id");
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

  it("swap-pane with invalid source throws TypeError", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sp-bad",
      command: { kind: "swap-pane", paneId: paneId("BAD") },
    };
    assert.throws(
      () => path.handleClientMessage(msg),
      (err: unknown) => err instanceof TypeError && /p<N>/.test((err as TypeError).message),
    );
    assert.equal(host.writes.length, 0, "no partial write on bad pane id");
  });

  it("swap-pane with invalid target throws TypeError", () => {
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
    assert.throws(
      () => path.handleClientMessage(msg),
      (err: unknown) => err instanceof TypeError && /p<N>/.test((err as TypeError).message),
    );
    assert.equal(host.writes.length, 0, "no partial write on bad target pane id");
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

  it("rename-pane with invalid pane id throws TypeError", () => {
    const host = makeFakeHost();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp-bad",
      command: { kind: "rename-pane", paneId: paneId("BAD"), title: "test" },
    };
    assert.throws(
      () => path.handleClientMessage(msg),
      (err: unknown) => err instanceof TypeError && /p<N>/.test((err as TypeError).message),
    );
    assert.equal(host.writes.length, 0, "no partial write on bad pane id");
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

  it("set-monitor-activity with invalid window id throws TypeError", () => {
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
    assert.throws(
      () => path.handleClientMessage(msg),
      (err: unknown) => err instanceof TypeError && /w<N>/.test((err as TypeError).message),
    );
    assert.equal(host.writes.length, 0, "no partial write on bad window id");
    assert.equal(dispatched.length, 0, "no optimistic dispatch on bad window id");
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

  it("set-monitor-silence with invalid window id throws TypeError", () => {
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
    assert.throws(
      () => path.handleClientMessage(msg),
      (err: unknown) => err instanceof TypeError && /w<N>/.test((err as TypeError).message),
    );
    assert.equal(host.writes.length, 0, "no partial write on bad window id");
    assert.equal(dispatched.length, 0, "no optimistic dispatch on bad window id");
  });
});

// ---------------------------------------------------------------------------
// Suite: tc-7xv.37 — optimistic-update error reversal
//
// The 3 set-* window-option commands (sync, monitor-activity, monitor-silence)
// each fire an optimistic synthetic event immediately, then await the tmux
// command result via the correlator.  On %error, input-path dispatches a
// compensating synthetic carrying the captured before-value so the model
// re-converges with tmux truth.
//
// These tests drive a fake `expectCommand` Promise + fake `getModel` snapshot
// to verify reversal happens (or doesn't, when ok=true).
// ---------------------------------------------------------------------------

import {
  emptyModel,
  addSession,
  addWindow,
  addPane,
  paneId as makePaneId,
  windowId as makeWindowId,
  sessionId as makeSessionId,
} from "../state/model.js";
import type { SessionModel, Session, Window, Pane } from "../state/model.js";
import type { PaneId as MPaneId, WindowId as MWindowId, SessionId as MSessionId } from "../wire/ids.js";
import type { InputPathCommandResult } from "./input-path.js";

/**
 * Build a one-window/one-pane model fixture with explicit before-values
 * for the three window options under test.
 */
function makeReversalModel(opts: {
  windowSuffix: string;
  synchronizePanes: boolean;
  monitorActivity: boolean;
  monitorSilence: number;
}): SessionModel {
  const sid: MSessionId = makeSessionId("s0");
  const wid: MWindowId = makeWindowId("w" + opts.windowSuffix);
  const pid: MPaneId = makePaneId("p" + opts.windowSuffix + "00");

  const session: Session = { sessionId: sid, name: "sess", windowIds: [wid], activeWindowId: wid };
  const window: Window = {
    windowId: wid,
    sessionId: sid,
    name: "win",
    paneIds: [pid],
    activePaneId: pid,
    layout: null,
    synchronizePanes: opts.synchronizePanes,
    monitorActivity: opts.monitorActivity,
    monitorSilence: opts.monitorSilence,
  };
  const pane: Pane = {
    paneId: pid,
    windowId: wid,
    sessionId: sid,
    cols: 80,
    rows: 24,
    mode: "normal",
    scrollbackHandle: undefined,
  };

  let m = emptyModel();
  m = addSession(m, session);
  m = addWindow(m, window);
  m = addPane(m, pane);
  return m;
}

/**
 * Deferred Promise helper: returns a Promise + resolver so the test can
 * decide when (and how) tmux's reply arrives.
 */
function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createInputPath — tc-7xv.37 reversal: set-synchronize-panes", () => {
  it("on %error reverts to captured before-value (was off, requested on, tmux rejected)", async () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w42");

    // Initial model: synchronizePanes = false.
    const before = makeReversalModel({
      windowSuffix: "42",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
      expectCommand: () => d.promise,
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sync-revert-1",
      command: { kind: "set-synchronize-panes", windowId: wid, on: true },
    });

    // The optimistic apply fires synchronously with the requested on:true.
    assert.equal(host.lastWrite, "set-option -wt @42 synchronize-panes on\n");
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], { kind: "internal:set-window-sync", windowId: wid, on: true });

    // tmux rejects.
    d.resolve({ ok: false });
    // Allow microtask queue to drain.
    await Promise.resolve();

    // A compensating event is dispatched carrying the before-value (off).
    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[1], { kind: "internal:set-window-sync", windowId: wid, on: false });
  });

  it("on %end does NOT dispatch a compensating event (tmux accepted)", async () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w7");

    const before = makeReversalModel({
      windowSuffix: "7",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
      expectCommand: () => d.promise,
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sync-ok-1",
      command: { kind: "set-synchronize-panes", windowId: wid, on: true },
    });

    assert.equal(dispatched.length, 1);

    d.resolve({ ok: true });
    await Promise.resolve();

    // Only the optimistic dispatch — no reversal.
    assert.equal(dispatched.length, 1);
  });

  it("reversal is skipped when window has vanished from the before-snapshot", async () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w99");

    // Snapshot does NOT include w99.
    const before = makeReversalModel({
      windowSuffix: "1",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
      expectCommand: () => d.promise,
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sync-vanish-1",
      command: { kind: "set-synchronize-panes", windowId: wid, on: true },
    });

    d.resolve({ ok: false });
    await Promise.resolve();

    // The optimistic event still fired, but no compensating event because the
    // window isn't in the captured before-snapshot (reducer would no-op anyway).
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], { kind: "internal:set-window-sync", windowId: wid, on: true });
  });

  it("no expectCommand → fire-and-forget (no reversal even on tmux error)", () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w3");

    // expectCommand is omitted; behaviour should match pre-tc-7xv.37: optimistic
    // update fires, no observation of tmux %end/%error.
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sync-fnf-1",
      command: { kind: "set-synchronize-panes", windowId: wid, on: true },
    });

    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], { kind: "internal:set-window-sync", windowId: wid, on: true });
  });
});

describe("createInputPath — tc-7xv.37 reversal: set-monitor-activity", () => {
  it("on %error reverts to captured before-value (was on, requested off, tmux rejected)", async () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w11");

    const before = makeReversalModel({
      windowSuffix: "11",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
      expectCommand: () => d.promise,
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ma-revert-1",
      command: { kind: "set-monitor-activity", windowId: wid, on: false },
    });

    assert.equal(host.lastWrite, "set-option -wt @11 monitor-activity off\n");
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], {
      kind: "internal:set-window-monitor-activity",
      windowId: wid,
      on: false,
    });

    d.resolve({ ok: false });
    await Promise.resolve();

    // Reversal: monitor-activity restored to its before-value (true).
    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[1], {
      kind: "internal:set-window-monitor-activity",
      windowId: wid,
      on: true,
    });
  });

  it("on %end does NOT dispatch a compensating event", async () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w12");

    const before = makeReversalModel({
      windowSuffix: "12",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
      expectCommand: () => d.promise,
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ma-ok-1",
      command: { kind: "set-monitor-activity", windowId: wid, on: false },
    });

    d.resolve({ ok: true });
    await Promise.resolve();

    assert.equal(dispatched.length, 1);
  });
});

describe("createInputPath — tc-7xv.37 reversal: set-monitor-silence", () => {
  it("on %error reverts to captured before-value (was 0, requested 30, tmux rejected)", async () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w20");

    // Initial model: monitor-silence = 0 (disabled).
    const before = makeReversalModel({
      windowSuffix: "20",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
      expectCommand: () => d.promise,
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms-revert-1",
      command: { kind: "set-monitor-silence", windowId: wid, seconds: 30 },
    });

    assert.equal(host.lastWrite, "set-option -wt @20 monitor-silence 30\n");
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], {
      kind: "internal:set-window-monitor-silence",
      windowId: wid,
      seconds: 30,
    });

    d.resolve({ ok: false });
    await Promise.resolve();

    // Reversal: silence restored to 0.
    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[1], {
      kind: "internal:set-window-monitor-silence",
      windowId: wid,
      seconds: 0,
    });
  });

  it("on %error reverts to captured before-value (was 60, requested null/0, tmux rejected)", async () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w21");

    // Initial model: monitor-silence = 60 (enabled with 60s threshold).
    const before = makeReversalModel({
      windowSuffix: "21",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 60,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
      expectCommand: () => d.promise,
      getModel: () => before,
    });

    // Client asks to disable (seconds: null normalises to 0).
    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms-revert-2",
      command: { kind: "set-monitor-silence", windowId: wid, seconds: null },
    });

    assert.equal(host.lastWrite, "set-option -wt @21 monitor-silence 0\n");
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], {
      kind: "internal:set-window-monitor-silence",
      windowId: wid,
      seconds: 0,
    });

    d.resolve({ ok: false });
    await Promise.resolve();

    // Reversal: restored to 60.
    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[1], {
      kind: "internal:set-window-monitor-silence",
      windowId: wid,
      seconds: 60,
    });
  });

  it("on %end does NOT dispatch a compensating event", async () => {
    const host = makeFakeHost();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w22");

    const before = makeReversalModel({
      windowSuffix: "22",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
      expectCommand: () => d.promise,
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "ms-ok-1",
      command: { kind: "set-monitor-silence", windowId: wid, seconds: 45 },
    });

    d.resolve({ ok: true });
    await Promise.resolve();

    assert.equal(dispatched.length, 1);
  });
});

describe("createInputPath — tc-7xv.37 expectCommand registration order", () => {
  it("expectCommand is called BEFORE host.write so the correlator FIFO stays in sync", () => {
    const host = makeFakeHost();
    const events: string[] = [];

    // Wrap host.write to record ordering.
    const origWrite = host.write.bind(host);
    (host as { write: (d: string | Uint8Array | Buffer) => void }).write = (data) => {
      events.push("write");
      origWrite(data);
    };

    const before = makeReversalModel({
      windowSuffix: "30",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    const path = createInputPath(host, {
      dispatchSynthetic: () => {},
      expectCommand: () => {
        events.push("expectCommand");
        return d.promise;
      },
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "order-1",
      command: { kind: "set-synchronize-panes", windowId: windowId("w30"), on: true },
    });

    assert.deepEqual(events, ["expectCommand", "write"], "expectCommand fires before host.write");
  });
});
