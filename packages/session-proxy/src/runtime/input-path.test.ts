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
 * All tests use a FakeDeps that captures send() / sendBatch() calls — no real
 * tmux process (tc-3si.1).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createInputPath, defaultPaneIdToTmux, defaultWindowIdToTmux } from "./input-path.js";
import type { InputPath, InputPathDeps, VerbResult } from "./input-path.js";
import type { CommandResult } from "../parser/correlator.js";
import type {
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  CommandRequestMessage,
} from "../wire/index.js";
import { paneId, windowId, sessionId, WIRE_PROTOCOL_VERSION } from "../wire/index.js";

// ---------------------------------------------------------------------------
// FakeDeps — captures sent commands for assertion (tc-3si.1)
//
// The input path's only command-write seam is `send` / `sendBatch` (the atomic
// slot+write callbacks supplied by the pipeline in production). This fake
// captures one entry per emitted command line WITH the trailing "\n" — same
// shape the previous `host.write` capture used, so the existing assertions
// (e.g. "send-keys -H -t %1 ...\n") continue to match.
// ---------------------------------------------------------------------------

interface FakeDeps extends InputPathDeps {
  readonly writes: string[];
  readonly lastWrite: string | undefined;
  /**
   * Queue a Promise to be returned by the NEXT `send()` call (FIFO across
   * multiple queued promises). Used by the tc-7xv.37 reversal tests to wire a
   * deferred resolution that the test controls. Accepts `Promise<{ ok, body? }>`
   * because input-path reads `ok` everywhere and `body` only for the
   * tc-ozk.1 creating-verb effect-id path — the test doesn't have to mock
   * commandNumber.
   */
  enqueueSendResult(promise: Promise<{ ok: boolean; body?: Uint8Array }>): void;
}

function makeFakeDeps(): FakeDeps {
  const writes: string[] = [];
  const queue: Promise<{ ok: boolean; body?: Uint8Array }>[] = [];
  // Default: when no test-supplied Promise is queued, `send` returns a
  // never-resolving stub so the test isn't forced to await it.
  const stubPromise = (): Promise<CommandResult> => new Promise<CommandResult>(() => {});
  // Cast: input-path treats the resolved shape as InputPathCommandResult
  // (`{ ok, body? }`), so a `{ ok, body? }`-shaped Promise is structurally
  // compatible for the test's purposes even though the formal CommandResult
  // adds commandNumber.
  const cast = (p: Promise<{ ok: boolean; body?: Uint8Array }>): Promise<CommandResult> => p as Promise<CommandResult>;
  const deps: FakeDeps = {
    writes,
    get lastWrite() { return writes[writes.length - 1]; },
    send(command: string): Promise<CommandResult> {
      writes.push(command + "\n");
      const queued = queue.shift();
      return queued !== undefined ? cast(queued) : stubPromise();
    },
    sendBatch(commands: readonly string[]): Promise<CommandResult>[] {
      writes.push(commands.map((c) => c + "\n").join(""));
      return commands.map(() => {
        const queued = queue.shift();
        return queued !== undefined ? cast(queued) : stubPromise();
      });
    },
    enqueueSendResult(promise: Promise<{ ok: boolean; body?: Uint8Array }>): void {
      queue.push(promise);
    },
  };

  return deps;
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
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "hello"));

    // "hello" in UTF-8: 68 65 6c 6c 6f
    assert.equal(host.writes.length, 1);
    assert.equal(host.lastWrite, "send-keys -H -t %1 68 65 6c 6c 6f\n");
  });

  it("pane id 'p3' maps to %3 in the command", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("3", "hi"));

    assert.ok(host.lastWrite?.includes("-t %3"), `expected -t %3, got: ${host.lastWrite}`);
  });

  it("pane id 'p0' maps to %0", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("0", "a"));

    assert.ok(host.lastWrite?.includes("-t %0"), `expected -t %0, got: ${host.lastWrite}`);
  });

  it("pane id 'p42' maps to %42", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("42", "x"));

    assert.ok(host.lastWrite?.includes("-t %42"), `expected -t %42, got: ${host.lastWrite}`);
  });

  it("single ASCII character 'a' → hex '61'", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "a"));

    assert.equal(host.lastWrite, "send-keys -H -t %1 61\n");
  });

  it("empty data string produces send-keys -H with no byte args", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", ""));

    // sendKeysHex with empty bytes: "send-keys -H -t %1" (no trailing space)
    assert.equal(host.lastWrite, "send-keys -H -t %1\n");
  });

  it("newline character → 0a", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "\n"));

    assert.equal(host.lastWrite, "send-keys -H -t %1 0a\n");
  });

  it("ESC character → 1b", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("2", "\x1b"));

    assert.equal(host.lastWrite, "send-keys -H -t %2 1b\n");
  });

  it("multibyte UTF-8 char '€' (U+20AC, 3 bytes) → e2 82 ac", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    // '€' encodes as: 0xE2 0x82 0xAC in UTF-8
    path.handleClientMessage(makeInput("1", "€"));

    assert.equal(host.lastWrite, "send-keys -H -t %1 e2 82 ac\n");
  });

  it("4-byte emoji '😀' (U+1F600) → f0 9f 98 80", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("5", "😀"));

    assert.equal(host.lastWrite, "send-keys -H -t %5 f0 9f 98 80\n");
  });

  it("mixed ASCII + multibyte: 'hi€' → correct hex sequence", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    // 'h'=68 'i'=69 '€'=e2 82 ac
    path.handleClientMessage(makeInput("1", "hi€"));

    assert.equal(host.lastWrite, "send-keys -H -t %1 68 69 e2 82 ac\n");
  });

  it("each input message is a separate write() call", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "a"));
    path.handleClientMessage(makeInput("2", "b"));

    assert.equal(host.writes.length, 2);
    assert.ok(host.writes[0]?.includes("-t %1"));
    assert.ok(host.writes[1]?.includes("-t %2"));
  });

  it("invalid pane id throws TypeError", () => {
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeResize("1", 80, 24));

    assert.equal(host.lastWrite, "refresh-client -C 80x24\n");
  });

  it("220x50 → refresh-client -C 220x50", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeResize("2", 220, 50));

    assert.equal(host.lastWrite, "refresh-client -C 220x50\n");
  });

  it("resize uses cols × rows from the message (not the pane id)", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    // paneId is irrelevant to the output command (refresh-client -C is client-wide)
    path.handleClientMessage(makeResize("99", 132, 43));

    assert.equal(host.lastWrite, "refresh-client -C 132x43\n");
    // Confirm pane number does NOT appear in the command
    assert.ok(!host.lastWrite?.includes("%99"), "pane id should not appear in refresh-client output");
  });

  it("produces exactly one write per resize message", () => {
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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

    // tc-ozk.1: split-window now prints its effect ids via -P -F so the daemon
    // can RETURN them in the VerbResult.
    assert.equal(host.lastWrite, "split-window -h -t %3 -P -F '#{pane_id} #{window_id}'\n");
  });

  it("split-pane vertical → split-window -v -t %5", () => {
    const host = makeFakeDeps();
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

    assert.equal(host.lastWrite, "split-window -v -t %5 -P -F '#{pane_id} #{window_id}'\n");
  });

  it("open-window without name → new-window", () => {
    const host = makeFakeDeps();
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

    // tc-ozk.1: new-window prints its effect ids via -P -F (placed before -n).
    assert.equal(host.lastWrite, "new-window -P -F '#{pane_id} #{window_id}'\n");
  });

  it("open-window with name → new-window -n <name>", () => {
    const host = makeFakeDeps();
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

    assert.equal(host.lastWrite, "new-window -P -F '#{pane_id} #{window_id}' -n editor\n");
  });

  it("close-pane → kill-pane -t %2", () => {
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
// Suite: release-managed-window — strip teardown (tc-pizl.9)
// ---------------------------------------------------------------------------

describe("createInputPath — release-managed-window (tc-pizl.9)", () => {
  it("release-managed-window → set-window-option -u window-size (single fire-and-forget write)", () => {
    // When a managed 2-pane strip drops to 1 pane, the vscode factory sends
    // `release-managed-window` to reset `window-size manual` so the surviving
    // pane resumes auto-tracking its client dimensions.
    //
    // Expected tmux command: set-window-option -u -t @<N> window-size
    const host = makeFakeDeps();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "c-rmw1",
      command: {
        kind: "release-managed-window",
        windowId: windowId("w5"),
      },
    };
    path.handleClientMessage(msg);

    // Must be a single synchronous (non-batched) send — no window resize,
    // no pane resize lines.
    assert.equal(host.lastWrite, "set-window-option -u -t @5 window-size\n");
    assert.equal(host.writes.length, 1, "release-managed-window must produce exactly one write");
  });
});

// ---------------------------------------------------------------------------
// Suite: client.capabilities is silently ignored
// ---------------------------------------------------------------------------

describe("createInputPath — client.capabilities", () => {
  it("does not write anything to the host", () => {
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
  it("break-pane → break-pane -d -P -F '#{pane_id} #{window_id}' -t %<N>", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "bp1",
      command: { kind: "break-pane", paneId: paneId("p3") },
    };
    path.handleClientMessage(msg);

    // tc-ozk.1: break-pane now prints its effect ids via -P -F.
    assert.equal(host.lastWrite, "break-pane -d -P -F '#{pane_id} #{window_id}' -t %3\n");
  });

  it("invalid pane id throws TypeError", () => {
    const host = makeFakeDeps();
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

// ---------------------------------------------------------------------------
// Suite: tc-ozk.1 — creating verbs RETURN their effect ids + %error mapping
// ---------------------------------------------------------------------------

describe("createInputPath — creating verbs return effect ids (tc-ozk.1)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("split-pane: %end with -P body → respond ok with newPaneId/newWindowId", async () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    // tmux prints "%5 @2" into the reply body for the created pane/window.
    host.enqueueSendResult(Promise.resolve({ ok: true, body: enc("%5 @2") }));

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "v1",
        command: { kind: "split-pane", paneId: paneId("p3"), direction: "horizontal" },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    // The -P -F command was written.
    assert.equal(host.lastWrite, "split-window -h -t %3 -P -F '#{pane_id} #{window_id}'\n");

    // Let the awaited send result resolve.
    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.equal(results[0]!.correlationId, "v1");
    assert.deepEqual(results[0]!.result, {
      ok: true,
      newPaneId: paneId("p5"),
      newWindowId: windowId("w2"),
    });
  });

  it("open-window: %end with -P body → respond ok with the created ids", async () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(Promise.resolve({ ok: true, body: enc("%9 @4") }));

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "v2",
        command: { kind: "open-window", name: "logs" },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    assert.equal(host.lastWrite, "new-window -P -F '#{pane_id} #{window_id}' -n logs\n");

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.deepEqual(results[0]!.result, {
      ok: true,
      newPaneId: paneId("p9"),
      newWindowId: windowId("w4"),
    });
  });

  it("break-pane: %end with -P body → respond ok with the re-homed pane + new window", async () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(Promise.resolve({ ok: true, body: enc("%3 @7") }));

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "v3",
        command: { kind: "break-pane", paneId: paneId("p3") },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.deepEqual(results[0]!.result, {
      ok: true,
      newPaneId: paneId("p3"),
      newWindowId: windowId("w7"),
    });
  });

  it("%error → respond ok=false (the +B5b %error mapping)", async () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(Promise.resolve({ ok: false }));

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "v4",
        command: { kind: "split-pane", paneId: paneId("p3"), direction: "vertical" },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.ok, false);
    if (results[0]!.result.ok === false) {
      assert.equal(results[0]!.result.code, "verb.failed");
      assert.ok(results[0]!.result.message.includes("split-pane"));
    }
  });

  it("tc-yudx: %error with a body → respond ok=false carrying the VERBATIM tmux refusal text", async () => {
    // A real tmux split refusal (window too small to divide) emits its reason
    // as the %begin…%error block body, e.g. "create pane failed: pane too
    // small".  The correlator accumulates that into CommandResult.body for
    // error blocks; the verb must surface it VERBATIM so the host can show the
    // user WHY tmux refused — NOT a generic "tmux rejected" (tc-yudx) and NOT
    // a vague transport timeout.
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(
      Promise.resolve({ ok: false, body: enc("create pane failed: pane too small") }),
    );

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "v4b",
        command: { kind: "split-pane", paneId: paneId("p3"), direction: "vertical" },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.ok, false);
    if (results[0]!.result.ok === false) {
      assert.equal(results[0]!.result.code, "verb.failed");
      // The EXACT tmux text, not a synthesized generic message.
      assert.equal(results[0]!.result.message, "create pane failed: pane too small");
    }
  });

  it("%end but unparseable -P body → respond ok=false (fail-loud, not silent ok)", async () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(Promise.resolve({ ok: true, body: enc("garbage-not-ids") }));

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "v5",
        command: { kind: "split-pane", paneId: paneId("p3"), direction: "horizontal" },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.ok, false);
    if (results[0]!.result.ok === false) {
      assert.equal(results[0]!.result.code, "verb.no-effect-ids");
    }
  });

  it("no responder wired → command still issued with -P -F, no throw", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    // No respond callback — fire-and-forget path.
    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "v6",
      command: { kind: "split-pane", paneId: paneId("p3"), direction: "horizontal" },
    });

    assert.equal(host.lastWrite, "split-window -h -t %3 -P -F '#{pane_id} #{window_id}'\n");
  });
});

describe("createInputPath — swap-pane command (tc-7xv.9)", () => {
  it("swap-pane without target → swap-pane -D -t %<N>", () => {
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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

// tc-1a8z: rename-pane is the DURABLE-name channel. It sets ONLY the per-pane
// @tmuxcc_label user-option (set-option -pt %N), NEVER select-pane -T — so the
// shell cannot clobber it. These tests pin that contract.
describe("createInputPath — rename-pane command (tc-1a8z durable name)", () => {
  it("rename-pane → set-option -pt %<N> @tmuxcc_label <name>", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp1",
      command: { kind: "rename-pane", paneId: paneId("p5"), title: "build" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -pt %5 @tmuxcc_label build\n");
  });

  it("rename-pane NEVER issues select-pane -T (durable channel, not the title)", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp-no-title",
      command: { kind: "rename-pane", paneId: paneId("p5"), title: "build" },
    });

    for (const w of host.writes) {
      assert.ok(!w.includes("select-pane"), `must not push select-pane; got: ${w}`);
      assert.ok(!w.includes("pane_title"), `must not touch pane_title; got: ${w}`);
    }
  });

  it("rename-pane with empty title clears the durable name (set-option ... '')", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp2",
      command: { kind: "rename-pane", paneId: paneId("p1"), title: "" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -pt %1 @tmuxcc_label ''\n");
  });

  it("rename-pane with a name containing single quotes escapes them", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp3",
      command: { kind: "rename-pane", paneId: paneId("p2"), title: "it's" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -pt %2 @tmuxcc_label 'it'\\''s'\n");
  });

  it("rename-pane with a name containing spaces works correctly", () => {
    const host = makeFakeDeps();
    const path = createInputPath(host);

    const msg: CommandRequestMessage = {
      type: "command.request",
      seq: nextSeq(),
      correlationId: "rp4",
      command: { kind: "rename-pane", paneId: paneId("p3"), title: "my server" },
    };
    path.handleClientMessage(msg);

    assert.equal(host.lastWrite, "set-option -pt %3 @tmuxcc_label 'my server'\n");
  });

  it("rename-pane with invalid pane id throws TypeError", () => {
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
    const host = makeFakeDeps();
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
// These tests drive a fake `send` Promise (via FakeDeps.enqueueSendResult) +
// fake `getModel` snapshot to verify reversal happens (or doesn't, when ok=true).
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
    dead: false,
    exitCode: undefined,
    label: undefined,
    // scrollbackHandle and paneTitle are optional — omit to avoid
    // exactOptionalPropertyTypes TS2375 when passing undefined explicitly.
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
    const host = makeFakeDeps();
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
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
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
    const host = makeFakeDeps();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w7");

    const before = makeReversalModel({
      windowSuffix: "7",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
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
    const host = makeFakeDeps();
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
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
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

  it("no getModel → fire-and-forget (no reversal even on tmux error)", async () => {
    const host = makeFakeDeps();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w3");

    // tc-3si.1: getModel is omitted, so no before-snapshot is captured; the
    // optimistic update still fires but reversal is skipped on %error.
    const d = defer<InputPathCommandResult>();
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "sync-fnf-1",
      command: { kind: "set-synchronize-panes", windowId: wid, on: true },
    });

    d.resolve({ ok: false });
    await Promise.resolve();

    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], { kind: "internal:set-window-sync", windowId: wid, on: true });
  });
});

describe("createInputPath — tc-7xv.37 reversal: set-monitor-activity", () => {
  it("on %error reverts to captured before-value (was on, requested off, tmux rejected)", async () => {
    const host = makeFakeDeps();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w11");

    const before = makeReversalModel({
      windowSuffix: "11",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
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
    const host = makeFakeDeps();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w12");

    const before = makeReversalModel({
      windowSuffix: "12",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
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
    const host = makeFakeDeps();
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
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
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
    const host = makeFakeDeps();
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
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
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
    const host = makeFakeDeps();
    const dispatched: NotificationEvent[] = [];
    const wid = windowId("w22");

    const before = makeReversalModel({
      windowSuffix: "22",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: (ev) => { dispatched.push(ev); },
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

describe("createInputPath — tc-3si.1 atomic slot+write contract", () => {
  it("send is the single atomic seam: input path emits exactly one send() per command", () => {
    // Pre-tc-3si.1, input-path called `expectCommand()` and then `host.write()`
    // as two separate steps; the test asserted ordering between them. After
    // tc-3si.1 those collapse into a single `send(cmd)` call on the correlator
    // (slot registration and the host write happen atomically inside `send`),
    // so the ordering invariant becomes structural: there is no way to
    // express a write without a slot. This test now asserts the count instead
    // — one send per command — which is the property the pre-tc-3si.1
    // ordering test was a proxy for.
    const host = makeFakeDeps();
    const sendCalls: string[] = [];
    const wrappedSend = host.send.bind(host);
    (host as { send: (cmd: string) => Promise<CommandResult> }).send = (cmd) => {
      sendCalls.push(cmd);
      return wrappedSend(cmd);
    };

    const before = makeReversalModel({
      windowSuffix: "30",
      synchronizePanes: false,
      monitorActivity: true,
      monitorSilence: 0,
    });

    const d = defer<InputPathCommandResult>();
    host.enqueueSendResult(d.promise);
    const path = createInputPath(host, {
      dispatchSynthetic: () => {},
      getModel: () => before,
    });

    path.handleClientMessage({
      type: "command.request",
      seq: nextSeq(),
      correlationId: "order-1",
      command: { kind: "set-synchronize-panes", windowId: windowId("w30"), on: true },
    });

    assert.deepEqual(sendCalls, ["set-option -wt @30 synchronize-panes on"]);
  });
});

// ---------------------------------------------------------------------------
// Suite: tc-n4ct — send-keys -H chunking for large input
//
// tmux's control-mode command-line length limit is empirically ~5447 bytes.
// The session-proxy must chunk large byte arrays into ≤5000-byte segments,
// each emitted as a separate send-keys -H call, in order.
//
// Boundary cases:
//   - Exactly 5000 bytes  → 1 chunk (fast path)
//   - Exactly 5001 bytes  → 2 chunks (first boundary crossing)
//   - 51200 bytes (50KB)  → 11 chunks (the original bug payload)
//
// Each test resolves each send() Promise immediately so the async chain
// completes before we assert.
// ---------------------------------------------------------------------------

/**
 * Build a fake deps where every send() immediately resolves with ok=true.
 * This lets us await the full async chain in the test.
 */
function makeResolvingFakeDeps(): FakeDeps {
  const base = makeFakeDeps();
  // Override send() to resolve immediately instead of returning a stub Promise.
  const originalSend = base.send.bind(base);
  (base as unknown as { send: (cmd: string) => Promise<CommandResult> }).send = (cmd: string) => {
    const p = originalSend(cmd);
    // The base send() already pushed to writes; return a resolved Promise.
    void p; // discard the stub
    return Promise.resolve({ ok: true } as unknown as CommandResult);
  };
  return base;
}

describe("createInputPath — tc-n4ct send-keys -H chunking", () => {
  it("payload of exactly 5000 bytes (boundary) emits exactly 1 send-keys -H chunk", async () => {
    const host = makeResolvingFakeDeps();
    const path = createInputPath(host);

    // 5000 ASCII bytes = 5000 UTF-8 bytes → should stay in the fast path.
    const data = "a".repeat(5000);
    path.handleClientMessage(makeInput("1", data));

    // Allow the async chain to complete.
    await Promise.resolve();

    assert.equal(host.writes.length, 1, "5000-byte input must produce exactly 1 chunk");
    // The single chunk should start with the correct command prefix.
    assert.ok(
      host.writes[0]?.startsWith("send-keys -H -t %1 "),
      `expected send-keys -H -t %1 …, got: ${host.writes[0]?.slice(0, 40)}`,
    );
    // 5000 bytes × 3 chars each = 15 000 hex token chars + (5000-1) spaces = 19 999
    // total hex section.  Verify length indirectly: count space-separated tokens.
    const tokens = host.writes[0]!
      .replace("send-keys -H -t %1 ", "")
      .trim()
      .split(" ");
    assert.equal(tokens.length, 5000, "should be 5000 hex tokens in the single chunk");
  });

  it("payload of exactly 5001 bytes (first boundary crossing) emits exactly 2 chunks", async () => {
    const host = makeResolvingFakeDeps();
    const path = createInputPath(host);

    // 5001 ASCII bytes — first byte past the chunk boundary.
    const data = "b".repeat(5001);
    path.handleClientMessage(makeInput("2", data));

    // Allow the full async chain (2 awaited send() calls) to complete.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(host.writes.length, 2, "5001-byte input must produce exactly 2 chunks");
    // Chunk 1: 5000 tokens.
    const chunk1Tokens = host.writes[0]!
      .replace("send-keys -H -t %2 ", "")
      .trim()
      .split(" ");
    assert.equal(chunk1Tokens.length, 5000, "chunk 1 should contain 5000 hex tokens");
    // Chunk 2: 1 token.
    const chunk2Tokens = host.writes[1]!
      .replace("send-keys -H -t %2 ", "")
      .trim()
      .split(" ");
    assert.equal(chunk2Tokens.length, 1, "chunk 2 should contain the 1 remaining byte");
    // Verify pane target is preserved in both chunks.
    assert.ok(host.writes[0]!.includes("-t %2"), "chunk 1 pane target");
    assert.ok(host.writes[1]!.includes("-t %2"), "chunk 2 pane target");
  });

  it("51200-byte payload (original bug: 50KB paste) emits 11 ordered chunks", async () => {
    const host = makeResolvingFakeDeps();
    const path = createInputPath(host);

    // Replicate the bug payload: 25600 random bytes → 51200 hex chars.
    // For predictability use a fixed ASCII pattern (0x61 = 'a').
    const PAYLOAD_BYTES = 51200;
    const data = "a".repeat(PAYLOAD_BYTES); // ASCII: 1 byte/char, 51200 UTF-8 bytes.
    path.handleClientMessage(makeInput("1", data));

    // Drain: ceil(51200 / 5000) = 11 chunks → 11 await ticks.
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }

    // ceil(51200 / 5000) = 11 (10 × 5000 + 1 × 1200).
    const expectedChunks = Math.ceil(PAYLOAD_BYTES / 5000); // 11
    assert.equal(
      host.writes.length,
      expectedChunks,
      `51200-byte input must produce ${expectedChunks} chunks, got ${host.writes.length}`,
    );

    // Verify chunk sizes: chunks 0..9 → 5000 tokens each; chunk 10 → 1200.
    for (let i = 0; i < 10; i++) {
      const tokens = host.writes[i]!
        .replace(/^send-keys -H -t %\d+ /, "")
        .trim()
        .split(" ");
      assert.equal(tokens.length, 5000, `chunk ${i} should have 5000 hex tokens`);
    }
    const lastTokens = host.writes[10]!
      .replace(/^send-keys -H -t %\d+ /, "")
      .trim()
      .split(" ");
    assert.equal(lastTokens.length, 1200, "last chunk should have 1200 hex tokens (51200 mod 5000)");

    // Verify all chunks target the same pane.
    for (let i = 0; i < expectedChunks; i++) {
      assert.ok(host.writes[i]!.includes("-t %1"), `chunk ${i} must target -t %1`);
    }
  });

  it("byte order is preserved across chunk boundaries (sequential hex content)", async () => {
    const host = makeResolvingFakeDeps();
    const path = createInputPath(host);

    // 10001 bytes with a known pattern: bytes 0..255 repeated.
    const PAYLOAD_BYTES = 10001;
    const rawBytes = new Uint8Array(PAYLOAD_BYTES);
    for (let i = 0; i < PAYLOAD_BYTES; i++) {
      rawBytes[i] = i % 256;
    }
    // Encode to a string via latin-1 (byte values 0-255 map to code points 0-255).
    // TextEncoder will re-encode code points > 127 as multi-byte UTF-8.  Use only
    // bytes 0..127 (pure ASCII) to keep the test predictable: 10001 ASCII chars =
    // 10001 UTF-8 bytes.
    const asciiBytes = new Uint8Array(PAYLOAD_BYTES);
    for (let i = 0; i < PAYLOAD_BYTES; i++) {
      asciiBytes[i] = i % 128; // 0x00..0x7F → single-byte UTF-8.
    }
    // Build the string from ASCII code points.
    const data = Array.from(asciiBytes, (b) => String.fromCharCode(b)).join("");

    path.handleClientMessage(makeInput("3", data));

    // 3 chunks: [5000, 5000, 1]
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }

    assert.equal(host.writes.length, 3, "10001-byte input must produce 3 chunks");

    // Reconstruct the hex tokens from all chunks and verify order.
    const allTokens: string[] = [];
    for (const w of host.writes) {
      const hexSection = w.replace(/^send-keys -H -t %\d+ /, "").trim();
      allTokens.push(...hexSection.split(" "));
    }

    assert.equal(allTokens.length, PAYLOAD_BYTES, "total token count should equal payload byte count");

    // Verify each token matches the expected byte value.
    for (let i = 0; i < PAYLOAD_BYTES; i++) {
      const expected = (i % 128).toString(16).padStart(2, "0");
      assert.equal(
        allTokens[i],
        expected,
        `token at position ${i}: expected ${expected}, got ${allTokens[i]}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: tc-n4ct — cross-message input ordering while a chunked send is in
// flight (review hardening).
//
// Pre-chunking, every input message's command was written synchronously at
// arrival, so arrival order == write order across messages. The chunk loop
// yields between chunks (awaiting tmux's reply), so a later input message
// must QUEUE behind the in-flight chain rather than write into the gap.
// ---------------------------------------------------------------------------

describe("createInputPath — tc-n4ct cross-message ordering", () => {
  /** Drain microtasks until the expected number of writes (bounded). */
  async function drainUntil(host: FakeDeps, expected: number): Promise<void> {
    for (let i = 0; i < 100 && host.writes.length < expected; i++) {
      await Promise.resolve();
    }
  }

  it("input arriving during a multi-chunk send queues behind it (no interleave)", async () => {
    const host = makeResolvingFakeDeps();
    const path = createInputPath(host);

    // 5001 bytes → 2 chunks; chunk 1 writes synchronously, chunk 2 after a tick.
    path.handleClientMessage(makeInput("1", "a".repeat(5001)));
    // Arrives while chunk 2 is still pending — must NOT write between chunks.
    path.handleClientMessage(makeInput("1", "X"));

    await drainUntil(host, 3);
    assert.equal(host.writes.length, 3, "expected 2 chunks + 1 queued input");

    const tokens = (w: string) =>
      w.replace(/^send-keys -H -t %\d+ /, "").trim().split(" ");
    assert.equal(tokens(host.writes[0]!).length, 5000, "chunk 1 first");
    assert.equal(tokens(host.writes[1]!).length, 1, "chunk 2 second");
    // "X" = 0x58 — must come AFTER both chunks of the first message.
    assert.deepEqual(tokens(host.writes[2]!), ["58"], "queued input written last");
  });

  it("single-chunk input with no in-flight chain writes synchronously (fast path)", () => {
    const host = makeResolvingFakeDeps();
    const path = createInputPath(host);

    path.handleClientMessage(makeInput("1", "hi"));
    // No await: the write must already have happened at arrival.
    assert.equal(host.writes.length, 1, "fast path must write synchronously");
  });

  it("a %error chunk aborts the remainder of THAT message but not queued ones", async () => {
    const host = makeFakeDeps();
    // Message A: 3 chunks (10001 bytes). Chunk 1 rejected by tmux (%error).
    const d1 = defer<InputPathCommandResult>();
    host.enqueueSendResult(d1.promise);
    // Message B's single send resolves ok.
    const d2 = defer<InputPathCommandResult>();
    host.enqueueSendResult(d2.promise);

    const path = createInputPath(host);
    path.handleClientMessage(makeInput("1", "a".repeat(10001)));
    path.handleClientMessage(makeInput("1", "X"));

    assert.equal(host.writes.length, 1, "only chunk 1 of A written so far");
    d1.resolve({ ok: false }); // tmux rejects chunk 1 → A's chunks 2..3 abort.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(host.writes.length, 2, "A aborted after chunk 1; B still sent");
    const tokens = (w: string) =>
      w.replace(/^send-keys -H -t %\d+ /, "").trim().split(" ");
    assert.deepEqual(tokens(host.writes[1]!), ["58"], "B's byte follows the abort");
    d2.resolve({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Suite: tc-u7cu.8 — runAckVerb ACK path (non-creating verb %error / %end)
//
// Covers the driver-layer wiring for non-creating verbs routed through
// runAckVerb: %error → sendCommandError (ok=false, verbatim tmux body);
//            %end  → {ok:true} ACK with no effect ids.
// ---------------------------------------------------------------------------

describe("createInputPath — runAckVerb ACK path (tc-u7cu.8)", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("close-pane + %error → respond ok=false with verbatim tmux error body", async () => {
    // A real tmux refusal for kill-pane puts the reason in the %begin…%error
    // block body; the correlator accumulates it into CommandResult.body.  The
    // driver must surface it VERBATIM — not a generic "tmux rejected" string.
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(
      Promise.resolve({ ok: false, body: enc("can't find pane: %99") }),
    );

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "ack-err-1",
        command: { kind: "close-pane", paneId: paneId("p99") },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    // The tmux command was written synchronously before the promise settled.
    assert.equal(host.lastWrite, "kill-pane -t %99\n");

    // Let the awaited send result propagate.
    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1, "exactly one respond() call");
    assert.equal(results[0]!.correlationId, "ack-err-1");
    assert.equal(results[0]!.result.ok, false);
    if (results[0]!.result.ok === false) {
      assert.equal(results[0]!.result.code, "verb.failed");
      // Verbatim tmux text, not a synthesized generic message.
      assert.equal(results[0]!.result.message, "can't find pane: %99");
    }
  });

  it("close-pane + %error with no body → respond ok=false with generic message", async () => {
    // When tmux emits an empty body for the %error block, the driver falls back
    // to a generic "tmux rejected <verbKind>" message rather than an empty string.
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(Promise.resolve({ ok: false }));

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "ack-err-2",
        command: { kind: "close-pane", paneId: paneId("p3") },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.ok, false);
    if (results[0]!.result.ok === false) {
      assert.equal(results[0]!.result.code, "verb.failed");
      assert.ok(
        results[0]!.result.message.includes("close-pane"),
        `generic fallback message should mention the verb kind; got: ${results[0]!.result.message}`,
      );
    }
  });

  it("close-pane + %end → respond ok=true with no effect ids", async () => {
    // %end on a non-creating verb: the ACK carries {ok:true} with no pane/window
    // ids (distinct from runCreatingVerb which always returns ids on %end).
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(Promise.resolve({ ok: true }));

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "ack-ok-1",
        command: { kind: "close-pane", paneId: paneId("p2") },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    assert.equal(host.lastWrite, "kill-pane -t %2\n");

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1, "exactly one respond() call");
    assert.equal(results[0]!.correlationId, "ack-ok-1");
    // {ok:true} with no newPaneId / newWindowId — non-creating verb ACK.
    assert.deepEqual(results[0]!.result, { ok: true });
  });

  it("kill-session + %error → respond ok=false with verbatim body", async () => {
    // Verify runAckVerb is wired for another non-creating verb (kill-session).
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(
      Promise.resolve({ ok: false, body: enc("can't find session: =nosuchsession") }),
    );

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "ack-ks-err",
        command: { kind: "kill-session", sessionName: "nosuchsession" },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    assert.equal(host.lastWrite, "kill-session -t =nosuchsession\n");

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.equal(results[0]!.result.ok, false);
    if (results[0]!.result.ok === false) {
      assert.equal(results[0]!.result.code, "verb.failed");
      assert.equal(results[0]!.result.message, "can't find session: =nosuchsession");
    }
  });

  it("rename-window + %end → respond ok=true ACK with no effect ids", async () => {
    // %end for a rename-window (also routed through runAckVerb): confirms the
    // same {ok:true, no ids} shape applies across all non-creating verbs.
    const host = makeFakeDeps();
    const path = createInputPath(host);
    const results: Array<{ correlationId: string; result: VerbResult }> = [];

    host.enqueueSendResult(Promise.resolve({ ok: true }));

    path.handleClientMessage(
      {
        type: "command.request",
        seq: nextSeq(),
        correlationId: "ack-rw-ok",
        command: { kind: "rename-window", windowId: windowId("w3"), name: "devserver" },
      },
      (correlationId, result) => results.push({ correlationId, result }),
    );

    assert.equal(host.lastWrite, "rename-window -t @3 'devserver'\n");

    await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(results.length, 1);
    assert.deepEqual(results[0]!.result, { ok: true });
  });
});
