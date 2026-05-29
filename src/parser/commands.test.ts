/**
 * Tests for the outbound tmux command serializer (tc-zb6).
 *
 * Acceptance criterion: "Emitted commands are valid tmux syntax;
 * send-keys -H encodes arbitrary bytes correctly."
 *
 * Test strategy:
 *   - Exact string assertions on all command functions.
 *   - Round-trip test for send-keys -H: parse hex tokens back to bytes and
 *     verify they match the original Uint8Array.
 *   - Edge cases: NUL byte, 0xFF, C0 control chars, 0x7F, multi-byte sequence.
 *   - Quoting: window name with a space → single-quoted in output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sendKeysHex,
  refreshClientSize,
  refreshClientWindowSize,
  refreshClientFlow,
  listWindows,
  listPanes,
  capturePane,
  newWindow,
  splitWindow,
  LIST_WINDOWS_DEFAULT_FORMAT,
  LIST_PANES_DEFAULT_FORMAT,
  type PaneFlowState,
} from "./commands.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the hex tokens from a `send-keys -H` command back to a Uint8Array. */
function parseHexTokens(cmd: string): Uint8Array {
  // Strip the fixed prefix "send-keys -H -t %<id>" then parse remaining tokens.
  const match = cmd.match(/^send-keys -H -t %\d+(?: (.+))?$/);
  assert.ok(match !== null, `Command did not match expected pattern: ${cmd}`);
  if (!match[1]) {
    return new Uint8Array(0);
  }
  const tokens = match[1].split(" ");
  return new Uint8Array(tokens.map((t) => parseInt(t, 16)));
}

// ---------------------------------------------------------------------------
// send-keys -H
// ---------------------------------------------------------------------------

describe("sendKeysHex", () => {
  it("encodes a simple ASCII string correctly", () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    const cmd = sendKeysHex(1, bytes);
    assert.equal(cmd, "send-keys -H -t %1 68 65 6c 6c 6f");
  });

  it("encodes NUL byte (0x00) correctly", () => {
    const bytes = new Uint8Array([0x00]);
    const cmd = sendKeysHex(2, bytes);
    assert.equal(cmd, "send-keys -H -t %2 00");
  });

  it("encodes 0xFF correctly", () => {
    const bytes = new Uint8Array([0xff]);
    const cmd = sendKeysHex(3, bytes);
    assert.equal(cmd, "send-keys -H -t %3 ff");
  });

  it("encodes C0 control characters correctly", () => {
    // ESC (0x1b), BEL (0x07), BS (0x08), TAB (0x09), LF (0x0a), CR (0x0d)
    const bytes = new Uint8Array([0x1b, 0x07, 0x08, 0x09, 0x0a, 0x0d]);
    const cmd = sendKeysHex(0, bytes);
    assert.equal(cmd, "send-keys -H -t %0 1b 07 08 09 0a 0d");
  });

  it("encodes DEL (0x7f) correctly", () => {
    const bytes = new Uint8Array([0x7f]);
    const cmd = sendKeysHex(5, bytes);
    assert.equal(cmd, "send-keys -H -t %5 7f");
  });

  it("encodes a mixed arbitrary byte array: NUL, 0xFF, control, ASCII", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x01, 0x41, 0x7f]);
    const cmd = sendKeysHex(7, bytes);
    assert.equal(cmd, "send-keys -H -t %7 00 ff 01 41 7f");
  });

  it("round-trips: hex tokens parse back to the original bytes", () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    const cmd = sendKeysHex(10, original);
    const recovered = parseHexTokens(cmd);
    assert.deepEqual(recovered, original);
  });

  it("uses lowercase hex digits", () => {
    const bytes = new Uint8Array([0xab, 0xcd, 0xef]);
    const cmd = sendKeysHex(1, bytes);
    assert.ok(
      cmd.includes("ab cd ef"),
      `Expected lowercase hex, got: ${cmd}`,
    );
  });

  it("always pads to two digits", () => {
    // 0x0a → "0a" not "a"
    const bytes = new Uint8Array([0x0a, 0x0f]);
    const cmd = sendKeysHex(1, bytes);
    assert.ok(cmd.includes("0a 0f"), `Expected zero-padded, got: ${cmd}`);
  });

  it("uses the correct pane target format -%N", () => {
    const bytes = new Uint8Array([0x41]);
    const cmd = sendKeysHex(42, bytes);
    assert.ok(cmd.startsWith("send-keys -H -t %42 "), cmd);
  });

  it("handles an empty byte array", () => {
    const bytes = new Uint8Array(0);
    const cmd = sendKeysHex(1, bytes);
    // No hex tokens; pane target still present.
    assert.equal(cmd, "send-keys -H -t %1");
  });
});

// ---------------------------------------------------------------------------
// refresh-client -C (size)
// ---------------------------------------------------------------------------

describe("refreshClientSize", () => {
  it("emits WxH format", () => {
    assert.equal(refreshClientSize(220, 50), "refresh-client -C 220x50");
  });

  it("handles small sizes", () => {
    assert.equal(refreshClientSize(80, 24), "refresh-client -C 80x24");
  });

  it("handles 1x1 (minimum tmux accepts is 2, but we serialize it)", () => {
    assert.equal(refreshClientSize(1, 1), "refresh-client -C 1x1");
  });
});

describe("refreshClientWindowSize", () => {
  it("emits @<window>:<W>x<H> form", () => {
    assert.equal(
      refreshClientWindowSize(2, 159, 48),
      "refresh-client -C @2:159x48",
    );
  });
});

// ---------------------------------------------------------------------------
// refresh-client -A (flow control)
// ---------------------------------------------------------------------------

describe("refreshClientFlow", () => {
  const cases: Array<[PaneFlowState, string]> = [
    ["on", "refresh-client -A '%5:on'"],
    ["off", "refresh-client -A '%5:off'"],
    ["pause", "refresh-client -A '%5:pause'"],
    ["continue", "refresh-client -A '%5:continue'"],
  ];

  for (const [state, expected] of cases) {
    it(`state=${state} → correct command`, () => {
      assert.equal(refreshClientFlow(5, state), expected);
    });
  }

  it("pane 0 still produces valid output", () => {
    assert.equal(refreshClientFlow(0, "pause"), "refresh-client -A '%0:pause'");
  });
});

// ---------------------------------------------------------------------------
// list-windows
// ---------------------------------------------------------------------------

describe("listWindows", () => {
  it("uses the default format when none is provided", () => {
    const cmd = listWindows();
    assert.ok(
      cmd.startsWith("list-windows -F "),
      `Expected 'list-windows -F ...', got: ${cmd}`,
    );
    assert.ok(
      cmd.includes("window_id"),
      "Default format should include window_id",
    );
  });

  it("includes a custom format string", () => {
    const fmt = "#{window_id} #{window_name}";
    const cmd = listWindows(fmt);
    // Format is quoted because it contains spaces.
    assert.equal(cmd, `list-windows -F '${fmt}'`);
  });

  it("includes session target when sessionId is given", () => {
    const cmd = listWindows(undefined, 3);
    assert.ok(cmd.endsWith(" -t $3"), `Expected -t $3 suffix, got: ${cmd}`);
  });

  it("default format contains expected fields", () => {
    const fmt = LIST_WINDOWS_DEFAULT_FORMAT;
    for (const field of [
      "session_name",
      "window_id",
      "window_name",
      "window_width",
      "window_height",
      "window_layout",
      "window_flags",
      "window_active",
    ]) {
      assert.ok(fmt.includes(field), `Missing field ${field} in default format`);
    }
  });
});

// ---------------------------------------------------------------------------
// list-panes
// ---------------------------------------------------------------------------

describe("listPanes", () => {
  it("uses the default format when none is provided", () => {
    const cmd = listPanes();
    assert.ok(
      cmd.startsWith("list-panes"),
      `Expected 'list-panes ...', got: ${cmd}`,
    );
    assert.ok(cmd.includes("pane_id"), "Default format should include pane_id");
  });

  it("includes target when given", () => {
    const cmd = listPanes("@2");
    assert.ok(cmd.includes("-t @2"), `Expected -t @2, got: ${cmd}`);
  });

  it("includes a custom format", () => {
    const fmt = "#{pane_id}\t#{pane_width}";
    const cmd = listPanes(undefined, fmt);
    assert.ok(cmd.includes(fmt), `Expected format in output, got: ${cmd}`);
  });

  it("default format contains expected fields", () => {
    const fmt = LIST_PANES_DEFAULT_FORMAT;
    for (const field of [
      "pane_id",
      "window_id",
      "pane_width",
      "pane_height",
      "pane_active",
    ]) {
      assert.ok(fmt.includes(field), `Missing field ${field} in default format`);
    }
  });
});

// ---------------------------------------------------------------------------
// capture-pane
// ---------------------------------------------------------------------------

describe("capturePane", () => {
  it("emits basic -t %N -p form", () => {
    assert.equal(capturePane(3), "capture-pane -t %3 -p");
  });

  it("adds -e flag when escapes=true", () => {
    assert.equal(capturePane(3, { escapes: true }), "capture-pane -t %3 -p -e");
  });

  it("adds -S flag for startLine", () => {
    assert.equal(
      capturePane(3, { startLine: -100 }),
      "capture-pane -t %3 -p -S -100",
    );
  });

  it("adds -E flag for endLine", () => {
    assert.equal(
      capturePane(3, { endLine: 0 }),
      "capture-pane -t %3 -p -E 0",
    );
  });

  it("combines all options", () => {
    assert.equal(
      capturePane(7, { escapes: true, startLine: -200, endLine: -1 }),
      "capture-pane -t %7 -p -e -S -200 -E -1",
    );
  });
});

// ---------------------------------------------------------------------------
// new-window
// ---------------------------------------------------------------------------

describe("newWindow", () => {
  it("emits bare new-window with no options", () => {
    assert.equal(newWindow(), "new-window");
  });

  it("includes -n flag for window name", () => {
    assert.equal(newWindow({ name: "scratch" }), "new-window -n scratch");
  });

  it("quotes window name with a space", () => {
    assert.equal(
      newWindow({ name: "my window" }),
      "new-window -n 'my window'",
    );
  });

  it("quotes window name with single quote inside", () => {
    const cmd = newWindow({ name: "it's mine" });
    // Must be properly shell-escaped.
    assert.ok(
      cmd.includes("it'\\''s"),
      `Expected escaped single quote, got: ${cmd}`,
    );
  });

  it("includes -c for startDirectory", () => {
    assert.equal(
      newWindow({ startDirectory: "/tmp" }),
      "new-window -c /tmp",
    );
  });

  it("includes shell command as trailing argument", () => {
    assert.equal(
      newWindow({ name: "srv", shellCommand: "bash" }),
      "new-window -n srv bash",
    );
  });
});

// ---------------------------------------------------------------------------
// split-window
// ---------------------------------------------------------------------------

describe("splitWindow", () => {
  it("horizontal split uses -h flag", () => {
    const cmd = splitWindow(3, "horizontal");
    assert.ok(cmd.includes("-h"), `Expected -h flag, got: ${cmd}`);
    assert.ok(!cmd.includes("-v"), `Unexpected -v flag in: ${cmd}`);
  });

  it("vertical split uses -v flag", () => {
    const cmd = splitWindow(3, "vertical");
    assert.ok(cmd.includes("-v"), `Expected -v flag, got: ${cmd}`);
    assert.ok(!cmd.includes("-h"), `Unexpected -h flag in: ${cmd}`);
  });

  it("includes pane target -t %N", () => {
    const cmd = splitWindow(5, "horizontal");
    assert.ok(cmd.includes("-t %5"), `Expected -t %5, got: ${cmd}`);
  });

  it("horizontal exact output", () => {
    assert.equal(splitWindow(3, "horizontal"), "split-window -h -t %3");
  });

  it("vertical exact output", () => {
    assert.equal(splitWindow(3, "vertical"), "split-window -v -t %3");
  });

  it("includes -p percentage", () => {
    assert.equal(
      splitWindow(3, "vertical", { percent: 30 }),
      "split-window -v -t %3 -p 30",
    );
  });

  it("includes -c startDirectory", () => {
    assert.equal(
      splitWindow(1, "horizontal", { startDirectory: "/home/user" }),
      "split-window -h -t %1 -c /home/user",
    );
  });

  it("includes shell command", () => {
    assert.equal(
      splitWindow(2, "vertical", { shellCommand: "htop" }),
      "split-window -v -t %2 htop",
    );
  });
});
