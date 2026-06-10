/**
 * Tests for CommandCorrelator (tc-82a).
 *
 * Acceptance criteria:
 *   - Interleaved notifications + command blocks resolve to the right command.
 *   - Body lines are not misparsed (a body line starting with % stays body).
 *   - %error resolves the command as failed.
 *   - Raw/non-UTF-8 bytes in body are preserved.
 *   - Integration: uses the real ControlTokenizer → CommandCorrelator pipeline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ControlTokenizer, tokenizeBuffer } from "./tokenizer.js";
import {
  CommandCorrelator,
  type CommandResult,
  type NotificationHandler,
} from "./correlator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, msg?: string): void {
  assert.strictEqual(
    actual.length,
    expected.length,
    `${msg ?? "bytes"}: length mismatch (actual=${actual.length}, expected=${expected.length})`,
  );
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(actual[i], expected[i], `${msg ?? "bytes"}: mismatch at byte ${i}`);
  }
}

/**
 * Feed a raw byte buffer through the tokenizer and push each token into the
 * correlator. Returns all collected notification tokens for inspection.
 */
function feedBuffer(
  corr: CommandCorrelator,
  buf: Uint8Array,
): void {
  const tok = new ControlTokenizer();
  for (const token of tok.push(buf)) {
    corr.push(token);
  }
}

// ---------------------------------------------------------------------------
// 1. Two commands in FIFO order — each resolves with its own body
// ---------------------------------------------------------------------------
//
// NOTE on flags values: real tmux uses flags=0 for the implicit startup block
// (emitted once at session open, before any user commands) and flags=1 for
// every user-command reply.  Tests that simulate command replies must use
// flags=1 so the correlator correctly binds them to pending expectCommand()
// slots.

describe("FIFO correlation: two sequential commands", () => {
  it("resolves each command with its own body in registration order", async () => {
    const corr = new CommandCorrelator();

    // Register two commands (FIFO order matches reply order).
    const p1 = corr.expectCommand();
    const p2 = corr.expectCommand();

    // flags=1 → user-command reply (as real tmux sends for bootstrap commands)
    const input = bytes(
      "%begin 1000 1 1\nfirst body\n%end 1000 1 1\n" +
        "%begin 2000 2 1\nsecond body\n%end 2000 2 1\n",
    );
    feedBuffer(corr, input);

    const r1 = await p1;
    const r2 = await p2;

    assert.strictEqual(r1.ok, true, "cmd 1: ok");
    assert.strictEqual(r1.commandNumber, 1, "cmd 1: commandNumber");
    assertBytesEqual(r1.body, bytes("first body"), "cmd 1: body");

    assert.strictEqual(r2.ok, true, "cmd 2: ok");
    assert.strictEqual(r2.commandNumber, 2, "cmd 2: commandNumber");
    assertBytesEqual(r2.body, bytes("second body"), "cmd 2: body");
  });

  it("resolves in FIFO order regardless of which promise is awaited first", async () => {
    const corr = new CommandCorrelator();

    const p1 = corr.expectCommand();
    const p2 = corr.expectCommand();

    feedBuffer(
      corr,
      bytes(
        "%begin 10 10 1\nalpha\n%end 10 10 1\n" +
          "%begin 20 11 1\nbeta\n%end 20 11 1\n",
      ),
    );

    // Await in reverse order — should still get right bodies
    const r2 = await p2;
    const r1 = await p1;

    assert.strictEqual(r1.commandNumber, 10, "cmd 1 cmdnum");
    assertBytesEqual(r1.body, bytes("alpha"), "cmd 1 body");
    assert.strictEqual(r2.commandNumber, 11, "cmd 2 cmdnum");
    assertBytesEqual(r2.body, bytes("beta"), "cmd 2 body");
  });
});

// ---------------------------------------------------------------------------
// 2. Interleaved notifications between blocks
// ---------------------------------------------------------------------------

describe("notifications interleaved between command blocks", () => {
  it("forwards notifications and still resolves commands correctly", async () => {
    const captured: string[] = [];
    const corr = new CommandCorrelator({
      onNotification(token) {
        captured.push(token.keyword);
      },
    });

    const p1 = corr.expectCommand();
    const p2 = corr.expectCommand();

    const input = bytes(
      "%begin 100 1 1\nbody-one\n%end 100 1 1\n" +
        "%output %1 hello\n" + // notification between blocks
        "%begin 200 2 1\nbody-two\n%end 200 2 1\n",
    );
    feedBuffer(corr, input);

    const r1 = await p1;
    const r2 = await p2;

    // Notification forwarded
    assert.deepStrictEqual(captured, ["output"], "notification keywords");

    // Commands resolved correctly
    assert.strictEqual(r1.ok, true);
    assertBytesEqual(r1.body, bytes("body-one"), "cmd 1 body");
    assert.strictEqual(r2.ok, true);
    assertBytesEqual(r2.body, bytes("body-two"), "cmd 2 body");
  });

  it("multiple notifications between two blocks are all forwarded", async () => {
    const captured: string[] = [];
    const corr = new CommandCorrelator({
      onNotification(t) { captured.push(t.keyword); },
    });

    const p1 = corr.expectCommand();
    const p2 = corr.expectCommand();

    feedBuffer(
      corr,
      bytes(
        "%begin 1 1 1\na\n%end 1 1 1\n" +
          "%sessions-changed\n" +
          "%window-add @1\n" +
          "%begin 2 2 1\nb\n%end 2 2 1\n",
      ),
    );

    await p1;
    await p2;

    assert.deepStrictEqual(captured, ["sessions-changed", "window-add"]);
  });

  it("notifications before any block are forwarded", async () => {
    const captured: string[] = [];
    const corr = new CommandCorrelator({
      onNotification(t) { captured.push(t.keyword); },
    });

    const p1 = corr.expectCommand();

    feedBuffer(
      corr,
      bytes(
        "%sessions-changed\n" +
          "%begin 1 5 1\nresult\n%end 1 5 1\n",
      ),
    );

    const r1 = await p1;
    assert.deepStrictEqual(captured, ["sessions-changed"]);
    assertBytesEqual(r1.body, bytes("result"));
  });
});

// ---------------------------------------------------------------------------
// 3. Body line starting with % is included in body, not treated as notification
// ---------------------------------------------------------------------------

describe("block-body: % lines inside a block are body, not notifications", () => {
  it("a body line starting with %output is raw body bytes", async () => {
    const captured: string[] = [];
    const corr = new CommandCorrelator({
      onNotification(t) { captured.push(t.keyword); },
    });

    const p1 = corr.expectCommand();

    // The tokenizer guarantees body lines start life as block-body tokens.
    // This test exercises the full tokenizer→correlator pipeline.
    const input = bytes("%begin 500 2 1\n%output %1 some text\n%end 500 2 1\n");
    feedBuffer(corr, input);

    const r1 = await p1;

    // The %output line in the body must be in r1.body, NOT in captured.
    assert.deepStrictEqual(captured, [], "no notifications emitted for body lines");
    assertBytesEqual(r1.body, bytes("%output %1 some text"), "% body line preserved");
  });

  it("multiple % body lines accumulate correctly and none become notifications", async () => {
    const captured: string[] = [];
    const corr = new CommandCorrelator({
      onNotification(t) { captured.push(t.keyword); },
    });

    const p1 = corr.expectCommand();

    feedBuffer(
      corr,
      bytes(
        "%begin 1 1 1\n" +
          "%session-changed foo\n" +
          "%window-add @99\n" +
          "%end 1 1 1\n",
      ),
    );

    const r1 = await p1;
    assert.deepStrictEqual(captured, [], "no notifications from body lines");

    // Both % lines are accumulated into body, joined by \n (tc-fx4: the
    // CommandResult.body contract — line-oriented parsers split on \n).
    const expectedBody = concat(
      bytes("%session-changed foo"),
      bytes("\n"),
      bytes("%window-add @99"),
    );
    assertBytesEqual(r1.body, expectedBody, "newline-joined % body lines");
  });
});

// ---------------------------------------------------------------------------
// 4. %error block → resolves command as failed
// ---------------------------------------------------------------------------

describe("%error block resolves command as failed", () => {
  it("ok=false on %error, body accumulated", async () => {
    const corr = new CommandCorrelator();

    const p1 = corr.expectCommand();

    feedBuffer(
      corr,
      bytes("%begin 9999 3 1\nbad command\n%error 9999 3 1\n"),
    );

    const r1 = await p1;
    assert.strictEqual(r1.ok, false, "ok should be false on %error");
    assert.strictEqual(r1.commandNumber, 3, "commandNumber");
    assertBytesEqual(r1.body, bytes("bad command"), "error body");
  });

  it("empty body on %error", async () => {
    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();

    feedBuffer(corr, bytes("%begin 1 1 1\n%error 1 1 1\n"));

    const r1 = await p1;
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.body.length, 0, "empty body");
  });

  it("mixed: first command succeeds, second fails", async () => {
    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();
    const p2 = corr.expectCommand();

    feedBuffer(
      corr,
      bytes(
        "%begin 1 1 1\ngood\n%end 1 1 1\n" +
          "%begin 2 2 1\nbad\n%error 2 2 1\n",
      ),
    );

    const r1 = await p1;
    const r2 = await p2;

    assert.strictEqual(r1.ok, true, "cmd1 ok");
    assertBytesEqual(r1.body, bytes("good"), "cmd1 body");
    assert.strictEqual(r2.ok, false, "cmd2 failed");
    assertBytesEqual(r2.body, bytes("bad"), "cmd2 error body");
  });
});

// ---------------------------------------------------------------------------
// 5. Raw/non-UTF-8 bytes in body are preserved
// ---------------------------------------------------------------------------

describe("non-UTF-8 body bytes preserved", () => {
  it("arbitrary binary bytes in body survive the full tokenizer→correlator pipeline", async () => {
    const nonUtf8 = new Uint8Array([0x80, 0xff, 0x00, 0xfe, 0xc3, 0x28]);

    const input = concat(
      bytes("%begin 1 1 1\n"),
      nonUtf8,
      bytes("\n"),
      bytes("%end 1 1 1\n"),
    );

    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();
    feedBuffer(corr, input);

    const r1 = await p1;
    assertBytesEqual(r1.body, nonUtf8, "binary body bytes");
  });

  it("body with null bytes preserved", async () => {
    const withNull = new Uint8Array([0x61, 0x00, 0x62]); // "a\0b"

    const input = concat(
      bytes("%begin 1 1 1\n"),
      withNull,
      bytes("\n"),
      bytes("%end 1 1 1\n"),
    );

    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();
    feedBuffer(corr, input);

    const r1 = await p1;
    assertBytesEqual(r1.body, withNull, "null-byte body");
  });
});

// ---------------------------------------------------------------------------
// 6. Integration: real tokenizer → correlator
// ---------------------------------------------------------------------------

describe("integration: ControlTokenizer → CommandCorrelator", () => {
  it("streaming feed (byte-by-byte) resolves correctly", async () => {
    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();

    const input = bytes("%begin 42 7 1\nhello world\n%end 42 7 1\n");

    // Feed byte-by-byte through the tokenizer
    const tok = new ControlTokenizer();
    for (let i = 0; i < input.length; i++) {
      for (const token of tok.push(input.subarray(i, i + 1))) {
        corr.push(token);
      }
    }

    const r1 = await p1;
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.commandNumber, 7);
    assertBytesEqual(r1.body, bytes("hello world"));
  });

  it("tokenizeBuffer shortcut also works", async () => {
    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();

    const tokens = tokenizeBuffer(bytes("%begin 1 1 1\ndata\n%end 1 1 1\n"));
    for (const token of tokens) {
      corr.push(token);
    }

    const r1 = await p1;
    assertBytesEqual(r1.body, bytes("data"));
  });

  it("multi-block streaming with interleaved notifications", async () => {
    const captured: string[] = [];
    const corr = new CommandCorrelator({
      onNotification(t) { captured.push(t.keyword); },
    });

    const p1 = corr.expectCommand();
    const p2 = corr.expectCommand();
    const p3 = corr.expectCommand();

    const input = bytes(
      "%begin 1 1 1\nblock-one\n%end 1 1 1\n" +
        "%window-add @1\n" +
        "%begin 2 2 1\nblock-two\n%end 2 2 1\n" +
        "%sessions-changed\n" +
        "%begin 3 3 1\nblock-three\n%error 3 3 1\n",
    );

    feedBuffer(corr, input);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // Notifications
    assert.deepStrictEqual(captured, ["window-add", "sessions-changed"]);

    // Results
    assert.strictEqual(r1.ok, true);
    assertBytesEqual(r1.body, bytes("block-one"), "r1 body");

    assert.strictEqual(r2.ok, true);
    assertBytesEqual(r2.body, bytes("block-two"), "r2 body");

    assert.strictEqual(r3.ok, false, "r3 failed");
    assertBytesEqual(r3.body, bytes("block-three"), "r3 body");
  });

  it("empty body block resolves with zero-length body", async () => {
    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();

    feedBuffer(corr, bytes("%begin 1 1 1\n%end 1 1 1\n"));

    const r1 = await p1;
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.body.length, 0, "empty body");
  });

  it("multi-line body accumulates all lines joined by \\n", async () => {
    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();

    feedBuffer(
      corr,
      bytes("%begin 1 1 1\nline-a\nline-b\nline-c\n%end 1 1 1\n"),
    );

    const r1 = await p1;
    // Each block-body token's bytes are the line content (no trailing newline).
    // tc-fx4: the correlator joins lines with \n (no trailing \n) so that
    // line-oriented reply parsers (bootstrap, window-add layout reconcile)
    // can recover the rows.
    const expected = bytes("line-a\nline-b\nline-c");
    assertBytesEqual(r1.body, expected, "multi-line body newline-joined");
  });
});

// ---------------------------------------------------------------------------
// 7. Startup block (flags=0) is NOT bound to pending expectCommand() slots
// ---------------------------------------------------------------------------
//
// Real tmux sends one implicit startup block (%begin ... 0 / %end ... 0) at
// the very beginning of a -CC session, before any user commands. This block
// must NOT consume an expectCommand() slot, otherwise the bootstrap command
// sequence (list-windows, list-panes) gets corrupted.

describe("startup block (flags=0) does not consume expectCommand() slots", () => {
  it("startup block before user commands is silently discarded", async () => {
    const corr = new CommandCorrelator();

    // Register a slot for a real command reply
    const p1 = corr.expectCommand();

    // Simulate: startup block (flags=0) arrives first, then the real command reply (flags=1)
    feedBuffer(
      corr,
      bytes(
        "%begin 1000 272 0\n%end 1000 272 0\n" +   // startup block (flags=0) → discard
          "%begin 1000 277 1\nmy result\n%end 1000 277 1\n", // real reply (flags=1) → slot 1
      ),
    );

    const r1 = await p1;
    assert.strictEqual(r1.ok, true, "real command resolved");
    assert.strictEqual(r1.commandNumber, 277, "correct cmdnum");
    assertBytesEqual(r1.body, bytes("my result"), "correct body");
  });

  it("bootstrap sequence: startup + list-windows + list-panes all resolve correctly", async () => {
    const corr = new CommandCorrelator();

    // Register two slots (like pipeline.ts bootstrap)
    const winP = corr.expectCommand();
    const paneP = corr.expectCommand();

    // Simulate exact tmux startup sequence from golden fixture
    feedBuffer(
      corr,
      bytes(
        // startup block (flags=0) — must NOT consume winP
        "%begin 1000 272 0\n%end 1000 272 0\n" +
          // list-windows reply (flags=1) — must resolve winP
          "%begin 1000 277 1\n0: zsh* [80x24]\n%end 1000 277 1\n" +
          // list-panes reply (flags=1) — must resolve paneP
          "%begin 1000 278 1\n0: [80x24] %0\n%end 1000 278 1\n",
      ),
    );

    const winResult = await winP;
    const paneResult = await paneP;

    assert.strictEqual(winResult.ok, true, "list-windows ok");
    assert.strictEqual(winResult.commandNumber, 277, "list-windows cmdnum");
    assertBytesEqual(winResult.body, bytes("0: zsh* [80x24]"), "list-windows body");

    assert.strictEqual(paneResult.ok, true, "list-panes ok");
    assert.strictEqual(paneResult.commandNumber, 278, "list-panes cmdnum");
    assertBytesEqual(paneResult.body, bytes("0: [80x24] %0"), "list-panes body");
  });

  it("startup block with no pending slots is silently discarded", async () => {
    // No expectCommand() registered — startup block should not throw
    const corr = new CommandCorrelator();
    assert.doesNotThrow(() => {
      feedBuffer(corr, bytes("%begin 1000 272 0\n%end 1000 272 0\n"));
    }, "startup block with no pending slots is silently discarded");
  });
});
