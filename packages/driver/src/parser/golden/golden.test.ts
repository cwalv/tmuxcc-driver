/**
 * Golden corpus tests for the tmux -CC control-mode parser.
 *
 * Verifies that the full parser stack (ControlTokenizer → parseNotification →
 * decodeOutputPayload → CommandCorrelator) produces expected event sequences
 * for a set of committed corpus samples.
 *
 * # Corpus samples
 *
 * ## Real-captured (tmux 3.4, `-C` mode, machine: chost)
 *   tmux34-session.raw  — real byte stream captured 2026-05-29 from tmux 3.4
 *     using `tmux -L tcgolden -C attach` (single-C, no DCS wrapper; tmux 3.4
 *     is the version present on this machine).  The stream includes:
 *       - multiple %begin/%end command blocks (list-windows, new-window,
 *         split-window, list-panes, list-sessions)
 *       - %session-changed, %session-window-changed, %window-add,
 *         %window-pane-changed, %layout-change (→ unknown), %exit
 *       - many %output notifications including one line whose decoded payload
 *         contains real non-UTF-8 bytes (\xc0\xfe\xff) — passes through the
 *         octal codec without round-tripping through a string.
 *     NOTE: no DCS wrapper emitted by -C (single dash); for DCS wrapper
 *     coverage see the real -CC capture below.
 *
 * ## Cross-version real captures (added under tc-3y8.5, 2026-06-10)
 *   tmux32a-C.raw  — tmux 3.2a (pre-3.4) captured inside ubuntu:22.04 docker
 *     image.  Same script as tmux34-session.raw (list-windows, new-window,
 *     split-window, list-panes, list-sessions, printf non-UTF-8 bytes,
 *     select-layout, detach).
 *     Verified divergences vs. tmux 3.4: NONE.  %layout-change carries the
 *     visible/full/flags 4-token form, same as 3.4 and 3.5a.  All notification
 *     keywords are the same.
 *
 *   tmux35a-C.raw  — tmux 3.5a (post-3.4) captured inside debian:trixie docker
 *     image.  Same script.
 *     Verified divergences vs. tmux 3.4: 3.5a additionally emits
 *     %window-renamed events when shells inside a freshly-spawned window/pane
 *     set their automatic-rename title.  Parser already handles
 *     %window-renamed (parsed by notifications.ts).  %layout-change format is
 *     unchanged (still visible/full/flags).
 *
 *   tmux34-CC.raw  — tmux 3.4 with `-CC` (double dash, DCS-wrapped) captured
 *     on the host.  This is the mode the product actually uses in
 *     production.  Starts with `\x1bP1000p`, ends with `\x1b\` (ST).
 *     All inner lines terminated `\r\n`.  Closes the previously-zero
 *     real-capture coverage on the DCS-wrapped path.
 *
 * ## Hand-authored fixtures (realistic, based on tmux protocol documentation)
 *   dcs-wrapper — minimal DCS-wrapped session with one command block and exit.
 *   older-session-renamed — older tmux format: %session-renamed <name> (no $id).
 *   non-utf8-output — %output line whose decoded payload is NOT valid UTF-8.
 *   block-error — command block that terminates with %error (not %end).
 *
 * ## Capture provenance / reproduction
 *   Capture driver: bin/golden-capture.py inside this directory's sibling
 *   tooling (kept off-tree; transient docker run).  Each capture used a
 *   per-run socket `tmuxcc-test-3y85-<n>` and the following script:
 *     1. `list-windows`           → response data, no notifications
 *     2. `new-window`             → %session-window-changed, %window-add
 *     3. `split-window -h`        → %window-pane-changed, %layout-change
 *     4. `list-panes`             → response data
 *     5. `list-sessions`          → response data
 *     6. `send-keys ... printf '\xc0\xfe\xff test bytes\n' Enter`
 *                                  → %output containing raw non-UTF-8 bytes
 *     7. `select-layout even-horizontal` → second %layout-change
 *     8. `detach-client`          → %exit and end of stream
 *
 *   Reproduction (in throwaway docker):
 *     docker run --rm -v <work>:/work -w /work <image> bash -c '
 *       apt-get update && apt-get install -y tmux python3
 *       python3 capture.py tmuxcc-test-3y85-<n> <C|CC> /work/<out>.raw
 *       tmux -L tmuxcc-test-3y85-<n> kill-server'
 *
 *   Images used:
 *     tmux32a-C.raw         : ubuntu:22.04  → tmux 3.2a-4ubuntu0.2
 *     tmux35a-C.raw         : debian:trixie → tmux 3.5a-3
 *     tmux34-C.raw          : host (Ubuntu 24.04) → tmux 3.4-1ubuntu0.1
 *     tmux34-CC.raw         : host (Ubuntu 24.04) → tmux 3.4-1ubuntu0.1
 *
 * # Cross-version notes
 * Older-format variants (%session-renamed without $id, etc.) are covered by
 * the hand-authored fixtures; see notifications.ts for the older-format
 * spec.  No version we captured emitted that older form (3.2a through 3.5a
 * all use `$<id>`-prefixed %session-renamed).
 *
 * # Acceptance criteria verified here
 * ✓ Parser output matches expected for each corpus sample.
 * ✓ Non-UTF-8 bytes preserved byte-exact (never round-tripped through a string).
 * ✓ Streaming invariance: byte-by-byte feed produces the same tokens as one-shot.
 * ✓ Real captures for pre-3.4 (tmux 3.2a), post-3.4 (tmux 3.5a), and
 *   `-CC` DCS-wrapped (tmux 3.4) modes — closes hand-authored-only coverage.
 * ✓ Golden corpus runs in CI under `npm test -w @tmuxcc/session-proxy`.
 *
 * @module parser/golden/golden.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ControlTokenizer,
  tokenizeBuffer,
  type ControlToken,
} from "../tokenizer.js";
import { parseNotification } from "../notifications.js";
import { decodeOutputPayload, parseOutputNotification } from "../output-codec.js";
import { CommandCorrelator, type CommandResult } from "../correlator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixtureBytes(name: string): Uint8Array {
  const p = path.join(__dirname, name);
  return new Uint8Array(readFileSync(p));
}

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

/** Feed a buffer one byte at a time; return all tokens. */
function byteByByte(buf: Uint8Array): ControlToken[] {
  const tok = new ControlTokenizer();
  const out: ControlToken[] = [];
  for (let i = 0; i < buf.length; i++) {
    out.push(...tok.push(buf.subarray(i, i + 1)));
  }
  return out;
}

/** Pull notification tokens from a token list; assert their event kinds. */
function notificationKinds(tokens: ControlToken[]): string[] {
  return tokens
    .filter((t) => t.kind === "notification")
    .map((t) => {
      if (t.kind !== "notification") return "";
      return parseNotification(t).kind;
    });
}

/** Count tokens of a given kind. */
function countKind(tokens: ControlToken[], kind: ControlToken["kind"]): number {
  return tokens.filter((t) => t.kind === kind).length;
}

// ---------------------------------------------------------------------------
// SAMPLE 1 — real tmux 3.4 capture (tmux34-session.raw)
// ---------------------------------------------------------------------------

describe("golden: tmux34-session.raw (real tmux 3.4 -C capture)", () => {
  const rawBuf = fixtureBytes("tmux34-session.raw");

  it("tokenizes one-shot to a non-empty token list", () => {
    const tokens = tokenizeBuffer(rawBuf);
    assert.ok(tokens.length > 0, "expected at least one token");
  });

  it("produces correct token kind counts from real capture", () => {
    const tokens = tokenizeBuffer(rawBuf);
    // The capture has no DCS wrapper (-C mode), so no dcs-open/dcs-close.
    assert.equal(countKind(tokens, "dcs-open"), 0, "no dcs-open expected");
    assert.equal(countKind(tokens, "dcs-close"), 0, "no dcs-close expected");

    // 5 commands were sent (list-windows, new-window, split-window, list-panes, list-sessions)
    // The first empty block (cmdnum 272) + 5 explicit commands = 6 begin/end pairs total
    const begins = countKind(tokens, "block-begin");
    const ends = countKind(tokens, "block-end");
    assert.ok(begins >= 5, `expected ≥5 block-begin, got ${begins}`);
    assert.equal(begins, ends, "block-begin count must match block-end count");

    // Notifications: session-changed, session-window-changed, window-add,
    // window-pane-changed, layout-change, many %output, %exit.
    const notifCount = countKind(tokens, "notification");
    assert.ok(notifCount > 10, `expected >10 notifications, got ${notifCount}`);
  });

  it("parses session-changed notification from real capture", () => {
    const tokens = tokenizeBuffer(rawBuf);
    const sessionChangedToken = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "session-changed",
    );
    assert.ok(sessionChangedToken !== undefined, "%session-changed not found in capture");
    if (sessionChangedToken?.kind !== "notification") return;
    const event = parseNotification(sessionChangedToken);
    assert.equal(event.kind, "session-changed");
    if (event.kind !== "session-changed") return;
    assert.equal(event.sessionId, 0, "sessionId should be 0");
    assert.equal(event.name, "s0", "session name should be s0");
  });

  it("parses window-add notification from real capture", () => {
    const tokens = tokenizeBuffer(rawBuf);
    const tok = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "window-add",
    );
    assert.ok(tok !== undefined, "%window-add not found");
    if (tok?.kind !== "notification") return;
    const ev = parseNotification(tok);
    assert.equal(ev.kind, "window-add");
    if (ev.kind !== "window-add") return;
    assert.equal(ev.windowId, 1);
    assert.equal(ev.unlinked, false);
  });

  it("parses window-pane-changed from real capture", () => {
    const tokens = tokenizeBuffer(rawBuf);
    const tok = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "window-pane-changed",
    );
    assert.ok(tok !== undefined, "%window-pane-changed not found");
    if (tok?.kind !== "notification") return;
    const ev = parseNotification(tok);
    assert.equal(ev.kind, "window-pane-changed");
    if (ev.kind !== "window-pane-changed") return;
    assert.equal(ev.windowId, 1);
    assert.equal(ev.paneId, 2);
  });

  it("parses session-window-changed from real capture", () => {
    const tokens = tokenizeBuffer(rawBuf);
    const tok = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "session-window-changed",
    );
    assert.ok(tok !== undefined, "%session-window-changed not found");
    if (tok?.kind !== "notification") return;
    const ev = parseNotification(tok);
    assert.equal(ev.kind, "session-window-changed");
    if (ev.kind !== "session-window-changed") return;
    assert.equal(ev.sessionId, 0);
    assert.equal(ev.windowId, 1);
  });

  it("%layout-change is emitted as unknown notification (not in notifications.ts vocabulary)", () => {
    const tokens = tokenizeBuffer(rawBuf);
    const tok = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "layout-change",
    );
    assert.ok(tok !== undefined, "%layout-change not found in real capture");
    if (tok?.kind !== "notification") return;
    const ev = parseNotification(tok);
    assert.equal(ev.kind, "unknown", "%layout-change should parse as unknown");
    if (ev.kind !== "unknown") return;
    assert.equal(ev.keyword, "layout-change");
  });

  it("parses %exit notification from real capture", () => {
    const tokens = tokenizeBuffer(rawBuf);
    const tok = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "exit",
    );
    assert.ok(tok !== undefined, "%exit not found in capture");
    if (tok?.kind !== "notification") return;
    const ev = parseNotification(tok);
    assert.equal(ev.kind, "exit");
    if (ev.kind !== "exit") return;
    assert.equal(ev.reason, null, "exit with no reason");
  });

  it("decodes %output notifications with all-ASCII payload", () => {
    const tokens = tokenizeBuffer(rawBuf);
    // Find an output token with simple ASCII payload
    const outputToken = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "output",
    );
    assert.ok(outputToken !== undefined, "expected at least one %output notification");
    if (outputToken?.kind !== "notification") return;
    const parsed = parseOutputNotification(outputToken);
    assert.ok(parsed !== null, "parseOutputNotification returned null");
    assert.ok(parsed!.paneId >= 0);
    assert.ok(parsed!.bytes.length > 0);
  });

  // -------------------------------------------------------------------------
  // Non-UTF-8 preservation (acceptance criterion)
  // -------------------------------------------------------------------------

  it("NON-UTF-8: %output payload with \\xc0\\xfe\\xff bytes preserved byte-exact", () => {
    // The capture has a line: %output %0 \xc0\xfe\xff test bytes\015\012
    // The bytes \xc0, \xfe, \xff are > 0x20 and not backslash, so tmux emits
    // them literally (not octal-escaped). The decoder must pass them through
    // as raw bytes without round-tripping through a string.
    const tokens = tokenizeBuffer(rawBuf);
    const outputTokens = tokens.filter(
      (t) => t.kind === "notification" && t.keyword === "output",
    );

    let found = false;
    for (const tok of outputTokens) {
      if (tok.kind !== "notification") continue;
      const parsed = parseOutputNotification(tok);
      if (parsed === null) continue;
      // Look for the token whose decoded bytes contain \xc0\xfe\xff
      const decoded = parsed.bytes;
      for (let i = 0; i < decoded.length - 2; i++) {
        if (decoded[i] === 0xc0 && decoded[i + 1] === 0xfe && decoded[i + 2] === 0xff) {
          found = true;
          // Verify these are raw Uint8Array bytes, not round-tripped through string
          assert.ok(decoded instanceof Uint8Array, "decoded must be Uint8Array");
          // Confirm the bytes are preserved exactly
          assert.equal(decoded[i], 0xc0);
          assert.equal(decoded[i + 1], 0xfe);
          assert.equal(decoded[i + 2], 0xff);
          break;
        }
      }
      if (found) break;
    }
    assert.ok(found, "expected to find %output token containing non-UTF-8 bytes 0xc0,0xfe,0xff");
  });

  // -------------------------------------------------------------------------
  // Streaming invariance (acceptance criterion)
  // -------------------------------------------------------------------------

  it("STREAMING: byte-by-byte feed yields same tokens as one-shot on real capture", () => {
    const oneShotTokens = tokenizeBuffer(rawBuf);
    const streamTokens = byteByByte(rawBuf);

    assert.equal(
      streamTokens.length,
      oneShotTokens.length,
      `one-shot: ${oneShotTokens.length} tokens, byte-by-byte: ${streamTokens.length} tokens`,
    );

    // Compare kinds
    for (let i = 0; i < oneShotTokens.length; i++) {
      const a = oneShotTokens[i]!;
      const b = streamTokens[i]!;
      assert.equal(b.kind, a.kind, `token[${i}] kind mismatch`);

      if (a.kind === "block-begin" && b.kind === "block-begin") {
        assert.equal(b.commandNumber, a.commandNumber, `token[${i}] commandNumber mismatch`);
        assert.equal(b.timestamp, a.timestamp, `token[${i}] timestamp mismatch`);
        assert.equal(b.flags, a.flags, `token[${i}] flags mismatch`);
      }
      if (a.kind === "block-end" && b.kind === "block-end") {
        assert.equal(b.commandNumber, a.commandNumber, `token[${i}] commandNumber mismatch`);
      }
      if (a.kind === "notification" && b.kind === "notification") {
        assert.equal(b.keyword, a.keyword, `token[${i}] keyword mismatch`);
        assert.deepEqual(
          Array.from(b.rawLine),
          Array.from(a.rawLine),
          `token[${i}] rawLine mismatch`,
        );
      }
      if (a.kind === "block-body" && b.kind === "block-body") {
        assert.deepEqual(
          Array.from(b.bytes),
          Array.from(a.bytes),
          `token[${i}] body bytes mismatch`,
        );
      }
    }
  });

  // -------------------------------------------------------------------------
  // CommandCorrelator integration
  // -------------------------------------------------------------------------

  it("CommandCorrelator resolves command blocks from real capture", async () => {
    const tokens = tokenizeBuffer(rawBuf);
    const notifications: string[] = [];
    const corr = new CommandCorrelator({
      onNotification: (tok) => {
        notifications.push(tok.keyword);
      },
    });

    // Count the number of user-command block-begin tokens (flags != 0) to know
    // how many expectCommand() slots to register. The startup block (flags=0)
    // is silently discarded by the correlator and must NOT get a slot.
    const beginCount = tokens.filter(
      (t) => t.kind === "block-begin" && t.flags !== 0,
    ).length;
    const promises: Promise<CommandResult>[] = [];
    for (let i = 0; i < beginCount; i++) {
      promises.push(corr.expectCommand());
    }

    for (const tok of tokens) {
      corr.push(tok);
    }

    const results = await Promise.all(promises);

    // All blocks in the real capture end with %end (not %error)
    for (const result of results) {
      assert.equal(result.ok, true, `command ${result.commandNumber} should be ok`);
    }

    // Notifications should include session-changed, window-add, layout-change, exit
    assert.ok(notifications.includes("session-changed"), "session-changed notification expected");
    assert.ok(notifications.includes("window-add"), "window-add notification expected");
    assert.ok(notifications.includes("exit"), "exit notification expected");
  });
});

// ---------------------------------------------------------------------------
// SAMPLE 2 — hand-authored: DCS-wrapped minimal session
// ---------------------------------------------------------------------------
// Real tmux -CC (double dash) wraps the stream in \x1bP1000p ... \x1b\
// This fixture ensures the DCS open/close tokens are emitted correctly.

describe("golden: hand-authored DCS wrapper", () => {
  // \x1bP1000p = DCS intro; \x1b\ = ST
  const DCS_INTRO = new Uint8Array([0x1b, 0x50, 0x31, 0x30, 0x30, 0x30, 0x70]);
  const ST = new Uint8Array([0x1b, 0x5c]);

  const sessionContent = bytes(
    [
      "%begin 1700000001 1 0",
      "hello world",
      "%end 1700000001 1 0",
      "%session-changed $3 my-session",
      "%exit",
    ].join("\n") + "\n",
  );

  const dcsBuf = concat(DCS_INTRO, sessionContent, ST);

  it("emits dcs-open at start", () => {
    const tokens = tokenizeBuffer(dcsBuf);
    assert.equal(tokens[0]?.kind, "dcs-open", "first token should be dcs-open");
  });

  it("emits dcs-close at end", () => {
    const tokens = tokenizeBuffer(dcsBuf);
    assert.equal(tokens[tokens.length - 1]?.kind, "dcs-close", "last token should be dcs-close");
  });

  it("token sequence: dcs-open, block-begin, block-body, block-end, notification×2, dcs-close", () => {
    const tokens = tokenizeBuffer(dcsBuf);
    const kinds = tokens.map((t) => t.kind);
    assert.deepEqual(kinds, [
      "dcs-open",
      "block-begin",
      "block-body",
      "block-end",
      "notification", // %session-changed
      "notification", // %exit
      "dcs-close",
    ]);
  });

  it("block-begin has correct fields", () => {
    const tokens = tokenizeBuffer(dcsBuf);
    const begin = tokens.find((t) => t.kind === "block-begin");
    assert.ok(begin !== undefined);
    if (begin?.kind !== "block-begin") return;
    assert.equal(begin.timestamp, 1700000001);
    assert.equal(begin.commandNumber, 1);
    assert.equal(begin.flags, 0);
  });

  it("block-body contains the correct bytes", () => {
    const tokens = tokenizeBuffer(dcsBuf);
    const body = tokens.find((t) => t.kind === "block-body");
    assert.ok(body !== undefined);
    if (body?.kind !== "block-body") return;
    assert.deepEqual(Array.from(body.bytes), Array.from(bytes("hello world")));
  });

  it("session-changed notification parses correctly", () => {
    const tokens = tokenizeBuffer(dcsBuf);
    const tok = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "session-changed",
    );
    assert.ok(tok !== undefined);
    if (tok?.kind !== "notification") return;
    const ev = parseNotification(tok);
    assert.equal(ev.kind, "session-changed");
    if (ev.kind !== "session-changed") return;
    assert.equal(ev.sessionId, 3);
    assert.equal(ev.name, "my-session");
  });

  it("STREAMING: byte-by-byte matches one-shot for DCS fixture", () => {
    const oneShot = tokenizeBuffer(dcsBuf);
    const streamed = byteByByte(dcsBuf);
    assert.equal(streamed.length, oneShot.length, "token count must match");
    for (let i = 0; i < oneShot.length; i++) {
      assert.equal(streamed[i]!.kind, oneShot[i]!.kind, `kind mismatch at ${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// SAMPLE 3 — hand-authored: older tmux format (%session-renamed without $id)
// ---------------------------------------------------------------------------
// Pre-3.x tmux emitted %session-renamed <name> without the $<id> prefix.
// notifications.ts handles this gracefully (sessionId: null).

describe("golden: cross-version — older %session-renamed (no $id)", () => {
  const fixture = bytes(
    [
      // Modern: %session-renamed $2 new-name
      "%session-renamed $2 new-name",
      // Older tmux (pre-3.x): %session-renamed old-style-name
      "%session-renamed old-style-name",
      // Older with space in name (rest-of-line):
      "%session-renamed my old session",
      "%exit",
    ].join("\n") + "\n",
  );

  const tokens = tokenizeBuffer(fixture);
  const notifTokens = tokens.filter((t) => t.kind === "notification");

  it("modern format: sessionId + name parsed", () => {
    const tok = notifTokens[0];
    assert.ok(tok?.kind === "notification");
    const ev = parseNotification(tok!);
    assert.equal(ev.kind, "session-renamed");
    if (ev.kind !== "session-renamed") return;
    assert.equal(ev.sessionId, 2);
    assert.equal(ev.name, "new-name");
  });

  it("older format (no $id): sessionId is null, name is the full arg", () => {
    const tok = notifTokens[1];
    assert.ok(tok?.kind === "notification");
    const ev = parseNotification(tok!);
    assert.equal(ev.kind, "session-renamed");
    if (ev.kind !== "session-renamed") return;
    assert.equal(ev.sessionId, null);
    assert.equal(ev.name, "old-style-name");
  });

  it("older format with space in name: entire rest-of-line is the name", () => {
    const tok = notifTokens[2];
    assert.ok(tok?.kind === "notification");
    const ev = parseNotification(tok!);
    assert.equal(ev.kind, "session-renamed");
    if (ev.kind !== "session-renamed") return;
    assert.equal(ev.sessionId, null);
    assert.equal(ev.name, "my old session");
  });
});

// ---------------------------------------------------------------------------
// SAMPLE 4 — hand-authored: non-UTF-8 %output payload (explicit codec test)
// ---------------------------------------------------------------------------
// The %output octal-escape rule: bytes < 0x20 or == 0x5c are \NNN-encoded;
// bytes 0x80–0xFF pass through literally. This sample verifies that such a
// payload is decoded to the exact original bytes without lossy string conversion.

describe("golden: non-UTF-8 %output payload (byte-exact preservation)", () => {
  // Build a synthetic %output line with:
  //   - 0xc0, 0xc1: invalid UTF-8 continuation bytes
  //   - 0xfe, 0xff: bytes invalid in UTF-8 entirely
  //   - 0x00 (NUL) and 0x0a (LF) and 0x5c (backslash): must be octal-escaped by tmux
  // Simulate what tmux would emit:
  //   0x00 → \000, 0x0a → \012, 0x5c → \134, 0xc0/0xfe/0xff pass through literally
  const payloadRaw = new Uint8Array([0x00, 0x0a, 0x5c, 0xc0, 0xc1, 0xfe, 0xff]);

  // Build the encoded %output line (as tmux would emit it)
  // \000 \012 \134 then raw bytes 0xc0 0xc1 0xfe 0xff
  const encodedPayload = new Uint8Array([
    // \000
    0x5c, 0x30, 0x30, 0x30,
    // \012
    0x5c, 0x30, 0x31, 0x32,
    // \134
    0x5c, 0x31, 0x33, 0x34,
    // 0xc0, 0xc1, 0xfe, 0xff literal
    0xc0, 0xc1, 0xfe, 0xff,
  ]);

  const header = bytes("%output %7 ");
  const lineBytes = concat(header, encodedPayload);

  it("decodeOutputPayload returns exact original bytes", () => {
    const decoded = decodeOutputPayload(encodedPayload);
    assert.deepEqual(Array.from(decoded), Array.from(payloadRaw));
  });

  it("decoded result is Uint8Array, not a string", () => {
    const decoded = decodeOutputPayload(encodedPayload);
    assert.ok(decoded instanceof Uint8Array, "must be Uint8Array");
  });

  it("parseOutputNotification extracts paneId and decodes bytes", () => {
    const rawLine = lineBytes;
    const tok = { kind: "notification" as const, keyword: "output", rawLine };
    const result = parseOutputNotification(tok);
    assert.ok(result !== null);
    assert.equal(result!.paneId, 7);
    assert.deepEqual(Array.from(result!.bytes), Array.from(payloadRaw));
  });

  it("full pipeline: tokenize → parseOutputNotification → byte-exact decode", () => {
    // Wrap the line in a minimal stream with a newline.
    const stream = concat(lineBytes, bytes("\n%exit\n"));
    const tokens = tokenizeBuffer(stream);
    const outTok = tokens.find((t) => t.kind === "notification" && t.keyword === "output");
    assert.ok(outTok !== undefined, "expected output notification token");
    if (outTok?.kind !== "notification") return;
    const result = parseOutputNotification(outTok);
    assert.ok(result !== null);
    assert.deepEqual(Array.from(result!.bytes), Array.from(payloadRaw));
  });

  it("STREAMING: byte-by-byte feed preserves non-UTF-8 bytes in rawLine", () => {
    const stream = concat(lineBytes, bytes("\n%exit\n"));
    const oneShotTokens = tokenizeBuffer(stream);
    const streamedTokens = byteByByte(stream);

    const oneShotOut = oneShotTokens.find(
      (t) => t.kind === "notification" && t.keyword === "output",
    );
    const streamedOut = streamedTokens.find(
      (t) => t.kind === "notification" && t.keyword === "output",
    );

    assert.ok(oneShotOut !== undefined && streamedOut !== undefined);
    if (oneShotOut?.kind !== "notification" || streamedOut?.kind !== "notification") return;

    assert.deepEqual(
      Array.from(streamedOut.rawLine),
      Array.from(oneShotOut.rawLine),
      "rawLine must be identical between one-shot and byte-by-byte",
    );
  });
});

// ---------------------------------------------------------------------------
// SAMPLE 5 — hand-authored: %error block terminator
// ---------------------------------------------------------------------------

describe("golden: %error command block", () => {
  // flags=1 → user-command response (real tmux protocol)
  const fixture = bytes(
    [
      "%begin 1700000100 5 1",
      "unknown command: foobar",
      "%error 1700000100 5 1",
      "%exit",
    ].join("\n") + "\n",
  );

  it("emits block-error (not block-end) for failed commands", () => {
    const tokens = tokenizeBuffer(fixture);
    const kinds = tokens.map((t) => t.kind);
    assert.ok(kinds.includes("block-error"), "expected block-error token");
    assert.ok(!kinds.includes("block-end"), "should not have block-end");
  });

  it("block-error has correct fields", () => {
    const tokens = tokenizeBuffer(fixture);
    const errToken = tokens.find((t) => t.kind === "block-error");
    assert.ok(errToken !== undefined);
    if (errToken?.kind !== "block-error") return;
    assert.equal(errToken.timestamp, 1700000100);
    assert.equal(errToken.commandNumber, 5);
    assert.equal(errToken.flags, 1);
  });

  it("CommandCorrelator resolves error block as ok=false", async () => {
    const tokens = tokenizeBuffer(fixture);
    const notifications: string[] = [];
    const corr = new CommandCorrelator({
      onNotification: (tok) => notifications.push(tok.keyword),
    });
    const p = corr.expectCommand();
    for (const tok of tokens) corr.push(tok);
    const result = await p;
    assert.equal(result.ok, false, "error block should resolve with ok=false");
    assert.equal(result.commandNumber, 5);
    // Body contains the error message line
    const bodyStr = new TextDecoder().decode(result.body);
    assert.ok(bodyStr.includes("unknown command"), "body should contain error message");
    assert.ok(notifications.includes("exit"), "exit notification forwarded");
  });
});

// ---------------------------------------------------------------------------
// SAMPLE 6 — hand-authored: %-line inside a block is NOT a notification
// ---------------------------------------------------------------------------

describe("golden: percent-line inside block is block-body, not notification", () => {
  // flags=1 → user-command response (real tmux protocol)
  const fixture = bytes(
    [
      "%begin 1700000200 10 1",
      "%this-looks-like-a-notification",
      "%another-percent-line with args",
      "%end 1700000200 10 1",
    ].join("\n") + "\n",
  );

  it("lines starting with % inside a block become block-body tokens", () => {
    const tokens = tokenizeBuffer(fixture);
    const bodyTokens = tokens.filter((t) => t.kind === "block-body");
    assert.equal(bodyTokens.length, 2, "expected 2 block-body tokens");
  });

  it("no spurious notification tokens emitted for percent-lines inside block", () => {
    const tokens = tokenizeBuffer(fixture);
    // Only block-begin, block-body×2, block-end — no notifications
    const notifTokens = tokens.filter((t) => t.kind === "notification");
    assert.equal(notifTokens.length, 0, "expected 0 notifications");
  });

  it("body content is preserved verbatim", () => {
    const tokens = tokenizeBuffer(fixture);
    const bodies = tokens
      .filter((t) => t.kind === "block-body")
      .map((t) => (t.kind === "block-body" ? new TextDecoder().decode(t.bytes) : ""));
    assert.deepEqual(bodies, [
      "%this-looks-like-a-notification",
      "%another-percent-line with args",
    ]);
  });
});

// ---------------------------------------------------------------------------
// SAMPLE 7 — hand-authored: multi-block sequential session
// ---------------------------------------------------------------------------

describe("golden: sequential command blocks (realistic pipeline)", () => {
  // Simulates a client sending 3 commands in sequence.
  // flags=1 for all user-command replies (real tmux protocol).
  const fixture = bytes(
    [
      "%session-changed $0 main",
      "%begin 1700001000 1 1",
      "window0",
      "%end 1700001000 1 1",
      "%window-add @5",
      "%begin 1700001001 2 1",
      "%end 1700001001 2 1",
      "%begin 1700001002 3 1",
      "pane0",
      "pane1",
      "%end 1700001002 3 1",
      "%exit",
    ].join("\n") + "\n",
  );

  it("tokenizes to expected sequence", () => {
    const tokens = tokenizeBuffer(fixture);
    const kinds = tokens.map((t) => t.kind);
    assert.deepEqual(kinds, [
      "notification", // session-changed
      "block-begin",
      "block-body",  // window0
      "block-end",
      "notification", // window-add
      "block-begin",
      "block-end",   // empty block
      "block-begin",
      "block-body",  // pane0
      "block-body",  // pane1
      "block-end",
      "notification", // exit
    ]);
  });

  it("notification kinds are correct", () => {
    const tokens = tokenizeBuffer(fixture);
    const kinds = notificationKinds(tokens);
    assert.deepEqual(kinds, ["session-changed", "window-add", "exit"]);
  });

  it("correlator resolves all 3 commands in order", async () => {
    const tokens = tokenizeBuffer(fixture);
    const corr = new CommandCorrelator({ onNotification: () => {} });
    const p1 = corr.expectCommand();
    const p2 = corr.expectCommand();
    const p3 = corr.expectCommand();
    for (const tok of tokens) corr.push(tok);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1!.commandNumber, 1);
    assert.equal(r2!.commandNumber, 2);
    assert.equal(r3!.commandNumber, 3);
    assert.equal(new TextDecoder().decode(r1!.body), "window0");
    assert.equal(new TextDecoder().decode(r2!.body), "");
    // tc-fx4: CommandResult.body joins lines with \n (line-oriented parsers
    // — bootstrap, window-add layout reconcile — split on \n).
    assert.equal(new TextDecoder().decode(r3!.body), "pane0\npane1");
  });

  it("STREAMING: chunk-by-chunk (3 bytes) matches one-shot", () => {
    const oneShotTokens = tokenizeBuffer(fixture);

    const tok = new ControlTokenizer();
    const streamedTokens: ControlToken[] = [];
    for (let i = 0; i < fixture.length; i += 3) {
      streamedTokens.push(...tok.push(fixture.subarray(i, i + 3)));
    }

    assert.equal(streamedTokens.length, oneShotTokens.length, "token count must match");
    for (let i = 0; i < oneShotTokens.length; i++) {
      assert.equal(streamedTokens[i]!.kind, oneShotTokens[i]!.kind, `kind mismatch at ${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// SAMPLE 8 — cross-version real captures (tc-3y8.5)
// ---------------------------------------------------------------------------
// Each capture exercises the same script in -C mode (no DCS wrapper):
//   list-windows, new-window, split-window, list-panes, list-sessions,
//   printf '\xc0\xfe\xff test bytes\n', select-layout, detach.
// We run the same shape of assertions on every capture so a regression in
// any tmux-version-specific format would surface as a concrete diff.
//
// Implementation note (tc-3y8.5): each real capture is asserted via a
// shared helper rather than copy-pasting test bodies; the helper covers:
//   - non-empty token stream
//   - %session-changed parses with sessionId 0, name "s0"
//   - %window-add parses with windowId 1, unlinked false
//   - %window-pane-changed parses with windowId 1, paneId 2
//   - %layout-change emits as an unknown notification (no version yet
//     promotes it to a typed event), and its rawLine starts "@1 "
//   - %exit parses with reason null
//   - %output for pane 0 contains the raw bytes 0xc0 0xfe 0xff
//   - byte-by-byte streaming equals one-shot tokenization
//   - CommandCorrelator resolves every user-command (flags!=0) block as ok

interface RealCaptureExpectations {
  /** Lower bound on user-command (flags!=0) %begin/%end pairs. */
  readonly minBeginCount: number;
  /** Whether the capture is DCS-wrapped (-CC vs -C). */
  readonly dcs: boolean;
}

function assertRealCapture(
  rawBuf: Uint8Array,
  exp: RealCaptureExpectations,
): { tokens: ControlToken[] } {
  const tokens = tokenizeBuffer(rawBuf);
  assert.ok(tokens.length > 0, "expected at least one token");

  // DCS framing matches the mode.
  const dcsOpens = countKind(tokens, "dcs-open");
  const dcsCloses = countKind(tokens, "dcs-close");
  if (exp.dcs) {
    assert.equal(dcsOpens, 1, "expected exactly one dcs-open in -CC capture");
    assert.equal(dcsCloses, 1, "expected exactly one dcs-close in -CC capture");
    // dcs-open must be the first token, dcs-close the last.
    assert.equal(tokens[0]!.kind, "dcs-open", "first token must be dcs-open");
    assert.equal(
      tokens[tokens.length - 1]!.kind,
      "dcs-close",
      "last token must be dcs-close",
    );
  } else {
    assert.equal(dcsOpens, 0, "no dcs-open in -C capture");
    assert.equal(dcsCloses, 0, "no dcs-close in -C capture");
  }

  // Block framing: equal counts, lower-bounded for user commands.
  const beginCount = countKind(tokens, "block-begin");
  const endCount = countKind(tokens, "block-end");
  assert.equal(beginCount, endCount, "block-begin/end counts must match");
  // Every block in our scripts succeeds; we should never see %error.
  assert.equal(countKind(tokens, "block-error"), 0, "no block-error expected");
  // User-command blocks (flags != 0).  The first block flags=0 is the
  // implicit startup block and is not counted toward the user-command quota.
  const userBlocks = tokens.filter(
    (t) => t.kind === "block-begin" && t.flags !== 0,
  ).length;
  assert.ok(
    userBlocks >= exp.minBeginCount,
    `expected ≥${exp.minBeginCount} user-command blocks, got ${userBlocks}`,
  );

  // Required notifications, parsed with expected fields.
  const findNotif = (kw: string): ControlToken | undefined =>
    tokens.find((t) => t.kind === "notification" && t.keyword === kw);

  const scTok = findNotif("session-changed");
  assert.ok(scTok !== undefined, "%session-changed missing");
  if (scTok!.kind === "notification") {
    const ev = parseNotification(scTok!);
    assert.equal(ev.kind, "session-changed");
    if (ev.kind === "session-changed") {
      assert.equal(ev.sessionId, 0);
      assert.equal(ev.name, "s0");
    }
  }

  const waTok = findNotif("window-add");
  assert.ok(waTok !== undefined, "%window-add missing");
  if (waTok!.kind === "notification") {
    const ev = parseNotification(waTok!);
    assert.equal(ev.kind, "window-add");
    if (ev.kind === "window-add") {
      assert.equal(ev.windowId, 1);
      assert.equal(ev.unlinked, false);
    }
  }

  const wpcTok = findNotif("window-pane-changed");
  assert.ok(wpcTok !== undefined, "%window-pane-changed missing");
  if (wpcTok!.kind === "notification") {
    const ev = parseNotification(wpcTok!);
    assert.equal(ev.kind, "window-pane-changed");
    if (ev.kind === "window-pane-changed") {
      assert.equal(ev.windowId, 1);
      assert.equal(ev.paneId, 2);
    }
  }

  const lcTok = findNotif("layout-change");
  assert.ok(lcTok !== undefined, "%layout-change missing");
  if (lcTok!.kind === "notification") {
    const ev = parseNotification(lcTok!);
    assert.equal(
      ev.kind,
      "unknown",
      "%layout-change should be parsed as unknown",
    );
    // The rawLine includes the `%keyword` prefix; after that it's the
    // window id followed by a layout string.
    const rl = new TextDecoder().decode(lcTok!.rawLine);
    assert.ok(
      rl.startsWith("%layout-change @1 "),
      `%layout-change rawLine should start with "%layout-change @1 ", got ${JSON.stringify(rl.slice(0, 32))}`,
    );
  }

  const exitTok = findNotif("exit");
  assert.ok(exitTok !== undefined, "%exit missing");
  if (exitTok!.kind === "notification") {
    const ev = parseNotification(exitTok!);
    assert.equal(ev.kind, "exit");
    if (ev.kind === "exit") {
      assert.equal(ev.reason, null);
    }
  }

  // Non-UTF-8 byte preservation: the printf injected 0xc0 0xfe 0xff into
  // pane 0; tmux emits %output %0 with the bytes literally (>= 0x80 isn't
  // octal-escaped).  We look across every %output token's decoded payload.
  let nonUtf8Found = false;
  for (const tok of tokens) {
    if (tok.kind !== "notification" || tok.keyword !== "output") continue;
    const parsed = parseOutputNotification(tok);
    if (parsed === null) continue;
    const b = parsed.bytes;
    for (let i = 0; i <= b.length - 3; i++) {
      if (b[i] === 0xc0 && b[i + 1] === 0xfe && b[i + 2] === 0xff) {
        nonUtf8Found = true;
        assert.ok(b instanceof Uint8Array, "decoded must be Uint8Array");
        break;
      }
    }
    if (nonUtf8Found) break;
  }
  assert.ok(
    nonUtf8Found,
    "expected one %output token to contain raw bytes 0xc0 0xfe 0xff",
  );

  // Streaming invariance.
  const streamedTokens = byteByByte(rawBuf);
  assert.equal(
    streamedTokens.length,
    tokens.length,
    "byte-by-byte must yield same token count as one-shot",
  );
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    const b = streamedTokens[i]!;
    assert.equal(b.kind, a.kind, `token[${i}] kind mismatch`);
    if (a.kind === "notification" && b.kind === "notification") {
      assert.equal(b.keyword, a.keyword, `token[${i}] keyword mismatch`);
      assert.deepEqual(
        Array.from(b.rawLine),
        Array.from(a.rawLine),
        `token[${i}] rawLine mismatch`,
      );
    }
    if (a.kind === "block-begin" && b.kind === "block-begin") {
      assert.equal(b.commandNumber, a.commandNumber);
      assert.equal(b.flags, a.flags);
    }
    if (a.kind === "block-body" && b.kind === "block-body") {
      assert.deepEqual(Array.from(b.bytes), Array.from(a.bytes));
    }
  }

  return { tokens };
}

async function assertCorrelatorResolvesAll(tokens: ControlToken[]): Promise<void> {
  const corr = new CommandCorrelator({ onNotification: () => {} });
  const beginCount = tokens.filter(
    (t) => t.kind === "block-begin" && t.flags !== 0,
  ).length;
  const promises: Promise<CommandResult>[] = [];
  for (let i = 0; i < beginCount; i++) promises.push(corr.expectCommand());
  for (const tok of tokens) corr.push(tok);
  const results = await Promise.all(promises);
  for (const r of results) {
    assert.equal(r.ok, true, `command ${r.commandNumber} should be ok`);
  }
}

describe("golden: tmux32a-C.raw (real tmux 3.2a, pre-3.4, -C, ubuntu:22.04)", () => {
  const rawBuf = fixtureBytes("tmux32a-C.raw");
  let tokens: ControlToken[] | undefined;

  it("parser stack accepts the capture and parses expected events", () => {
    tokens = assertRealCapture(rawBuf, { minBeginCount: 5, dcs: false }).tokens;
  });

  it("CommandCorrelator resolves every user-command block as ok", async () => {
    if (!tokens) tokens = tokenizeBuffer(rawBuf);
    await assertCorrelatorResolvesAll(tokens);
  });
});

describe("golden: tmux35a-C.raw (real tmux 3.5a, post-3.4, -C, debian:trixie)", () => {
  const rawBuf = fixtureBytes("tmux35a-C.raw");
  let tokens: ControlToken[] | undefined;

  it("parser stack accepts the capture and parses expected events", () => {
    tokens = assertRealCapture(rawBuf, { minBeginCount: 5, dcs: false }).tokens;
  });

  it("%window-renamed is parsed (3.5a emits it on shell auto-rename)", () => {
    // 3.5a is the first version in our corpus that emits %window-renamed
    // during this script.  Make sure notifications.ts still parses it.
    if (!tokens) tokens = tokenizeBuffer(rawBuf);
    const wrTok = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "window-renamed",
    );
    assert.ok(wrTok !== undefined, "expected %window-renamed in 3.5a capture");
    if (wrTok!.kind === "notification") {
      const ev = parseNotification(wrTok!);
      assert.equal(ev.kind, "window-renamed");
      if (ev.kind === "window-renamed") {
        assert.ok(ev.windowId >= 0);
        assert.ok(ev.name.length > 0);
      }
    }
  });

  it("CommandCorrelator resolves every user-command block as ok", async () => {
    if (!tokens) tokens = tokenizeBuffer(rawBuf);
    await assertCorrelatorResolvesAll(tokens);
  });
});

describe("golden: tmux34-CC.raw (real tmux 3.4, -CC DCS-wrapped, host)", () => {
  const rawBuf = fixtureBytes("tmux34-CC.raw");
  let tokens: ControlToken[] | undefined;

  it("parser stack accepts the capture; DCS wrapper bookends the stream", () => {
    tokens = assertRealCapture(rawBuf, { minBeginCount: 5, dcs: true }).tokens;
  });

  it("CommandCorrelator resolves every user-command block as ok", async () => {
    if (!tokens) tokens = tokenizeBuffer(rawBuf);
    await assertCorrelatorResolvesAll(tokens);
  });

  it("inner lines use CRLF (\\r\\n) — control-mode over a real pty", () => {
    // -CC traffic comes off a tmux pty; line endings are CR-LF.  The
    // tokenizer must not include the CR in the rawLine for notifications
    // (it strips the trailing \r before the \n).  Spot-check %exit.
    if (!tokens) tokens = tokenizeBuffer(rawBuf);
    const exitTok = tokens.find(
      (t) => t.kind === "notification" && t.keyword === "exit",
    );
    assert.ok(exitTok !== undefined);
    if (exitTok!.kind === "notification") {
      // The rawLine should be empty for `%exit` with no reason, regardless
      // of CR — i.e. the tokenizer correctly stripped the trailing \r.
      const rl = new TextDecoder().decode(exitTok!.rawLine);
      assert.ok(
        !rl.includes("\r"),
        `%exit rawLine must not contain CR, got ${JSON.stringify(rl)}`,
      );
    }
  });
});
