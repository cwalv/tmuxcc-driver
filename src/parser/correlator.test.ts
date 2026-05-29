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

describe("FIFO correlation: two sequential commands", () => {
  it("resolves each command with its own body in registration order", async () => {
    const corr = new CommandCorrelator();

    // Register two commands (FIFO order matches reply order).
    const p1 = corr.expectCommand();
    const p2 = corr.expectCommand();

    const input = bytes(
      "%begin 1000 1 0\nfirst body\n%end 1000 1 0\n" +
        "%begin 2000 2 0\nsecond body\n%end 2000 2 0\n",
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
        "%begin 10 10 0\nalpha\n%end 10 10 0\n" +
          "%begin 20 11 0\nbeta\n%end 20 11 0\n",
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
      "%begin 100 1 0\nbody-one\n%end 100 1 0\n" +
        "%output %1 hello\n" + // notification between blocks
        "%begin 200 2 0\nbody-two\n%end 200 2 0\n",
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
        "%begin 1 1 0\na\n%end 1 1 0\n" +
          "%sessions-changed\n" +
          "%window-add @1\n" +
          "%begin 2 2 0\nb\n%end 2 2 0\n",
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
          "%begin 1 5 0\nresult\n%end 1 5 0\n",
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
    const input = bytes("%begin 500 2 0\n%output %1 some text\n%end 500 2 0\n");
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
        "%begin 1 1 0\n" +
          "%session-changed foo\n" +
          "%window-add @99\n" +
          "%end 1 1 0\n",
      ),
    );

    const r1 = await p1;
    assert.deepStrictEqual(captured, [], "no notifications from body lines");

    // Both % lines are accumulated into body (concatenated, no separator)
    const expectedBody = concat(
      bytes("%session-changed foo"),
      bytes("%window-add @99"),
    );
    assertBytesEqual(r1.body, expectedBody, "concatenated % body lines");
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
      bytes("%begin 9999 3 0\nbad command\n%error 9999 3 0\n"),
    );

    const r1 = await p1;
    assert.strictEqual(r1.ok, false, "ok should be false on %error");
    assert.strictEqual(r1.commandNumber, 3, "commandNumber");
    assertBytesEqual(r1.body, bytes("bad command"), "error body");
  });

  it("empty body on %error", async () => {
    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();

    feedBuffer(corr, bytes("%begin 1 1 0\n%error 1 1 0\n"));

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
        "%begin 1 1 0\ngood\n%end 1 1 0\n" +
          "%begin 2 2 0\nbad\n%error 2 2 0\n",
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
      bytes("%begin 1 1 0\n"),
      nonUtf8,
      bytes("\n"),
      bytes("%end 1 1 0\n"),
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
      bytes("%begin 1 1 0\n"),
      withNull,
      bytes("\n"),
      bytes("%end 1 1 0\n"),
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

    const input = bytes("%begin 42 7 0\nhello world\n%end 42 7 0\n");

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

    const tokens = tokenizeBuffer(bytes("%begin 1 1 0\ndata\n%end 1 1 0\n"));
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
      "%begin 1 1 0\nblock-one\n%end 1 1 0\n" +
        "%window-add @1\n" +
        "%begin 2 2 0\nblock-two\n%end 2 2 0\n" +
        "%sessions-changed\n" +
        "%begin 3 3 0\nblock-three\n%error 3 3 0\n",
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

    feedBuffer(corr, bytes("%begin 1 1 0\n%end 1 1 0\n"));

    const r1 = await p1;
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.body.length, 0, "empty body");
  });

  it("multi-line body accumulates all lines concatenated", async () => {
    const corr = new CommandCorrelator();
    const p1 = corr.expectCommand();

    feedBuffer(
      corr,
      bytes("%begin 1 1 0\nline-a\nline-b\nline-c\n%end 1 1 0\n"),
    );

    const r1 = await p1;
    // Each block-body token's bytes are the line content (no trailing newline).
    // Correlator concatenates them directly.
    const expected = concat(bytes("line-a"), bytes("line-b"), bytes("line-c"));
    assertBytesEqual(r1.body, expected, "multi-line body concatenated");
  });
});
