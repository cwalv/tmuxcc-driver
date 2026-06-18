/**
 * Input / resize API tests — acceptance for tc-6jf.
 *
 * Acceptance criteria:
 *   - sendInput(paneId, data) emits a correct InputMessage (type, paneId, data,
 *     seq starting at 1) via the sender.
 *   - resizePane(paneId, cols, rows) emits a correct ResizeRequestMessage.
 *   - Ordering: a sequence of sendInput calls arrives in order.
 *   - Coalescing (default enabled): rapid resizes for one pane → only the latest
 *     sent after flush; the final value is never dropped.
 *   - No-coalesce mode: every resize goes through immediately.
 *   - Input with multi-byte / special-char sequences encodes correctly.
 *   - seq increments monotonically across calls.
 *   - sendInput calls in the same synchronous frame as resizePane calls are
 *     dispatched before the coalesced resize (ordering guarantee).
 *
 * Test strategy: use a mock InputSender (captures messages into an array)
 * rather than a full SessionProxyConnection so tests are fast and deterministic.
 * Coalesce tests use flush() for synchronous draining instead of awaiting
 * microtasks.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { paneId } from "@tmuxcc/session-proxy";
import type { InputMessage, ResizeRequestMessage, PaneAttachMessage, PaneId } from "@tmuxcc/session-proxy";

import { createInputApi } from "./input.js";
import type { InputApi, InputSender } from "./input.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type SentMessage = InputMessage | ResizeRequestMessage | PaneAttachMessage;

/** Capture-sender: records every sent message in order. */
function makeSender(): { sender: InputSender; messages: SentMessage[] } {
  const messages: SentMessage[] = [];
  const sender: InputSender = {
    send(msg) {
      messages.push(msg as SentMessage);
    },
  };
  return { sender, messages };
}

const P0: PaneId = paneId("p0");
const P1: PaneId = paneId("p1");

// ---------------------------------------------------------------------------
// 1. sendInput — basic shape
// ---------------------------------------------------------------------------

describe("sendInput — basic shape", () => {
  it("emits an InputMessage with correct type, paneId, data, and seq=1", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.sendInput(P0, "hello");

    assert.equal(messages.length, 1);
    const msg = messages[0] as InputMessage;
    assert.equal(msg.type, "input");
    assert.equal(msg.paneId, P0);
    assert.equal(msg.data, "hello");
    assert.equal(msg.seq, 1);
  });

  it("sends immediately — does not buffer", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.sendInput(P0, "a");
    assert.equal(messages.length, 1);

    api.sendInput(P0, "b");
    assert.equal(messages.length, 2);
  });
});

// ---------------------------------------------------------------------------
// 2. resizePane (no-coalesce) — basic shape
// ---------------------------------------------------------------------------

describe("resizePane — basic shape (coalescing disabled)", () => {
  it("emits a ResizeRequestMessage with correct type, paneId, cols, rows", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender, { coalesceResizes: false });

    api.resizePane(P0, 80, 24);

    assert.equal(messages.length, 1);
    const msg = messages[0] as ResizeRequestMessage;
    assert.equal(msg.type, "resize.request");
    assert.equal(msg.paneId, P0);
    assert.equal(msg.cols, 80);
    assert.equal(msg.rows, 24);
    assert.equal(msg.seq, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Ordering — multiple sendInput calls arrive in order
// ---------------------------------------------------------------------------

describe("sendInput — ordering", () => {
  it("a sequence of inputs arrives in the order they were sent", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    const inputs = ["a", "b", "c", "d", "e"];
    for (const ch of inputs) {
      api.sendInput(P0, ch);
    }

    assert.equal(messages.length, inputs.length);
    for (let i = 0; i < inputs.length; i++) {
      const msg = messages[i] as InputMessage;
      assert.equal(msg.type, "input");
      assert.equal(msg.data, inputs[i]);
    }
  });

  it("seq increments monotonically across sendInput calls", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.sendInput(P0, "x");
    api.sendInput(P0, "y");
    api.sendInput(P0, "z");

    assert.equal(messages.length, 3);
    assert.equal(messages[0]!.seq, 1);
    assert.equal(messages[1]!.seq, 2);
    assert.equal(messages[2]!.seq, 3);
  });
});

// ---------------------------------------------------------------------------
// 4. Coalescing — rapid resizes for one pane
// ---------------------------------------------------------------------------

describe("resizePane — coalescing (default enabled)", () => {
  it("multiple rapid resizes for the same pane → only the latest is sent after flush", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender); // coalesceResizes: true (default)

    api.resizePane(P0, 80, 24);
    api.resizePane(P0, 81, 24);
    api.resizePane(P0, 82, 24);

    // Nothing sent yet — still buffered.
    assert.equal(messages.length, 0);

    // Flush synchronously.
    api.flush();

    assert.equal(messages.length, 1);
    const msg = messages[0] as ResizeRequestMessage;
    assert.equal(msg.type, "resize.request");
    assert.equal(msg.paneId, P0);
    assert.equal(msg.cols, 82);
    assert.equal(msg.rows, 24);
  });

  it("the FINAL resize is never dropped", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.resizePane(P0, 100, 40);
    api.flush();

    assert.equal(messages.length, 1);
    const msg = messages[0] as ResizeRequestMessage;
    assert.equal(msg.cols, 100);
    assert.equal(msg.rows, 40);
  });

  it("resizes for different panes are coalesced independently", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.resizePane(P0, 80, 24);
    api.resizePane(P1, 120, 30);
    api.resizePane(P0, 90, 25); // overrides P0
    api.flush();

    assert.equal(messages.length, 2);

    // Find the two messages by paneId (order is Map insertion order).
    const byPane = new Map(
      (messages as ResizeRequestMessage[]).map((m) => [m.paneId, m]),
    );
    const m0 = byPane.get(P0)!;
    const m1 = byPane.get(P1)!;

    assert.ok(m0, "P0 resize present");
    assert.equal(m0.cols, 90);
    assert.equal(m0.rows, 25);

    assert.ok(m1, "P1 resize present");
    assert.equal(m1.cols, 120);
    assert.equal(m1.rows, 30);
  });
});

// ---------------------------------------------------------------------------
// 4b. markDisconnected — stop deferred resize sends on disconnect (p8lh)
// ---------------------------------------------------------------------------

/**
 * Sender that THROWS on send() once flipped "closed" — models
 * SessionProxyConnection.send() after connection.close() (connection.ts:367,
 * the intentional close-state tripwire).
 */
function makeClosableSender(): {
  sender: InputSender;
  messages: SentMessage[];
  close: () => void;
} {
  const messages: SentMessage[] = [];
  let closed = false;
  const sender: InputSender = {
    send(msg) {
      if (closed) {
        throw new Error(
          'SessionProxyConnection.send() called in state "closed"; must be "ready"',
        );
      }
      messages.push(msg as SentMessage);
    },
  };
  return { sender, messages, close: () => { closed = true; } };
}

describe("resizePane — markDisconnected stops deferred sends (p8lh)", () => {
  it("a coalesced resize scheduled then markDisconnected never reaches send()", async () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender); // coalesce default true

    api.resizePane(P0, 80, 24); // buffers + schedules microtask flush
    assert.equal(messages.length, 0, "resize must still be buffered (not yet sent)");

    api.markDisconnected(); // disconnect-time drain

    // Let the previously-scheduled microtask run — it must be a no-op now.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      messages.length,
      0,
      "drained resize must NOT be sent by the deferred microtask flush",
    );
  });

  it("the already-buffered flush does NOT send() on a sender closed after markDisconnected (the p8lh throw)", async () => {
    // RED-before (without markDisconnected wired into disconnect): the microtask
    // flush would call send() on the closed sender and THROW
    // `SessionProxyConnection.send() ... in state "closed"` as a floating
    // unhandled rejection.  GREEN-after: markDisconnected drops the pending
    // resize so the microtask is a no-op and nothing is sent on the closed
    // connection.
    const { sender, messages, close } = makeClosableSender();
    const api = createInputApi(sender);

    api.resizePane(P0, 120, 40); // schedules the deferred flush
    api.markDisconnected(); // disconnect drains it BEFORE close
    close(); // connection.close() → send() now throws

    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      messages.length,
      0,
      "no resize must be sent after markDisconnected + close (no throw on the closed sender)",
    );
  });

  it("a resize arriving AFTER markDisconnected is a no-op (the post-teardown setDimensions path)", async () => {
    // VS Code fires pty.setDimensions asynchronously — including AFTER the spawn
    // was disposed (disconnect already ran).  Such a late resizePane must be
    // dropped at the door so it never schedules a fresh deferred send that would
    // call send() on the closed connection.
    const { sender, messages, close } = makeClosableSender();
    const api = createInputApi(sender);

    api.markDisconnected(); // disconnect happened first
    close();                // connection now closed → send() throws

    api.resizePane(P0, 90, 25); // late setDimensions → must NOT schedule a send
    api.flush();                // even an explicit flush stays a no-op (nothing buffered)

    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(
      messages.length,
      0,
      "a resize after markDisconnected must be dropped (no send on the closed connection)",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. No-coalesce mode — every resize goes through immediately
// ---------------------------------------------------------------------------

describe("resizePane — coalescing disabled", () => {
  it("each resize call produces an immediate wire message", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender, { coalesceResizes: false });

    api.resizePane(P0, 80, 24);
    assert.equal(messages.length, 1);

    api.resizePane(P0, 81, 24);
    assert.equal(messages.length, 2);

    api.resizePane(P0, 82, 24);
    assert.equal(messages.length, 3);

    const last = messages[2] as ResizeRequestMessage;
    assert.equal(last.cols, 82);
  });
});

// ---------------------------------------------------------------------------
// 6. Input + resize ordering (same synchronous frame)
// ---------------------------------------------------------------------------

describe("ordering — input before coalesced resize", () => {
  it("sendInput dispatched before coalesced resize when called in the same frame", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    // sendInput is synchronous; resizePane is buffered.
    api.resizePane(P0, 80, 24);
    api.sendInput(P0, "typed-before-flush");
    api.flush();

    // Order: input first (synchronous), resize second (flushed after).
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.type, "input");
    assert.equal(messages[1]!.type, "resize.request");
  });
});

// ---------------------------------------------------------------------------
// 7. seq increments across mixed sendInput / resizePane calls
// ---------------------------------------------------------------------------

describe("seq — monotonically increasing across message types", () => {
  it("seq increments correctly across sendInput and resizePane (no-coalesce)", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender, { coalesceResizes: false });

    api.sendInput(P0, "a");       // seq 1
    api.resizePane(P0, 80, 24);   // seq 2
    api.sendInput(P0, "b");       // seq 3
    api.resizePane(P0, 81, 25);   // seq 4

    assert.equal(messages.length, 4);
    assert.equal(messages[0]!.seq, 1);
    assert.equal(messages[1]!.seq, 2);
    assert.equal(messages[2]!.seq, 3);
    assert.equal(messages[3]!.seq, 4);
  });

  it("seq increments across sendInput and coalesced resizePane (flush path)", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.sendInput(P0, "x");      // seq 1 — synchronous
    api.resizePane(P0, 80, 24);  // buffered
    api.flush();                 // seq 2 — flush assigns seq

    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.seq, 1);
    assert.equal(messages[1]!.seq, 2);
  });
});

// ---------------------------------------------------------------------------
// 8. Multi-byte / special-char input encoding
// ---------------------------------------------------------------------------

describe("sendInput — encoding", () => {
  it("sends emoji (multi-byte UTF-8) as-is in the data field", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    const emoji = "🦀";
    api.sendInput(P0, emoji);

    const msg = messages[0] as InputMessage;
    assert.equal(msg.data, emoji);
  });

  it("sends ANSI escape sequences (arrow-up) as-is", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    const arrowUp = "\x1b[A";
    api.sendInput(P0, arrowUp);

    const msg = messages[0] as InputMessage;
    assert.equal(msg.data, arrowUp);
  });

  it("sends Ctrl-C (ETX) correctly", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.sendInput(P0, "\x03");

    const msg = messages[0] as InputMessage;
    assert.equal(msg.data, "\x03");
  });

  it("sends mixed ASCII + escape sequence as a single message", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    const complex = "ls\r\n\x1b[A"; // "ls", Enter, LF, Arrow-up
    api.sendInput(P0, complex);

    assert.equal(messages.length, 1);
    const msg = messages[0] as InputMessage;
    assert.equal(msg.data, complex);
  });
});

// ---------------------------------------------------------------------------
// 9. flush() is a no-op when nothing is pending
// ---------------------------------------------------------------------------

describe("flush — no-op when nothing pending", () => {
  it("flush() with no pending resizes sends nothing", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.flush();
    assert.equal(messages.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 10. attachPane — pane.attach request (tc-295a.8)
// ---------------------------------------------------------------------------

describe("attachPane — pane.attach request shape", () => {
  it("emits a pane.attach message with the target paneId and a seq", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.attachPane(P0);

    assert.equal(messages.length, 1);
    const msg = messages[0] as PaneAttachMessage;
    assert.equal(msg.type, "pane.attach");
    assert.equal(msg.paneId, P0);
    assert.equal(msg.seq, 1);
  });

  it("is not coalesced — each call produces exactly one message", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender);

    api.attachPane(P0);
    api.attachPane(P1);
    api.attachPane(P0);

    assert.equal(messages.length, 3);
    assert.deepEqual(
      messages.map((m) => (m as PaneAttachMessage).paneId),
      [P0, P1, P0],
    );
  });

  it("shares the monotonic seq counter with input/resize/command", () => {
    const { sender, messages } = makeSender();
    const api = createInputApi(sender, { coalesceResizes: false });

    api.sendInput(P0, "x");   // seq 1
    api.attachPane(P0);       // seq 2
    api.resizePane(P0, 80, 24); // seq 3

    assert.deepEqual(messages.map((m) => m.seq), [1, 2, 3]);
  });
});
