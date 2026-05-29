/**
 * Tests for src/state/bootstrap.ts (tc-835).
 *
 * Coverage:
 *   - bootstrapCommands() returns the correct command strings.
 *   - parseWindowsReply() + parsePanesReply(): parse real-format tmux output.
 *   - buildInitialModel(): 1 session, 2 windows, 3 panes — correct layout / focus.
 *   - checkInvariants() clean on built model.
 *   - BootstrapCoordinator cold attach: both replies feed a complete model.
 *   - Handoff / no dropped events: notification buffered during bootstrap →
 *     applied after replies arrive.
 *   - Event ordering preserved across buffer-and-replay.
 *   - Stays correct under deltas: live events after bootstrap apply correctly.
 *   - Idempotent/redundant: buffered window-add for a window already in the
 *     bootstrap snapshot doesn't corrupt the model.
 *   - %error replies: coordinator falls back gracefully to an empty model.
 *
 * @module state/bootstrap.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bootstrapCommands,
  BOOTSTRAP_WINDOWS_FORMAT,
  BOOTSTRAP_PANES_FORMAT,
  parseWindowsReply,
  parsePanesReply,
  buildInitialModel,
  BootstrapCoordinator,
} from "./bootstrap.js";
import type { WindowsReplyRow, PanesReplyRow } from "./bootstrap.js";
import { checkInvariants, paneId, windowId, sessionId } from "./model.js";
import type { SessionModel } from "./model.js";
import type { PaneId } from "../wire/ids.js";
import type { CommandResult } from "../parser/correlator.js";
import type { NotificationEvent } from "../parser/notifications.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class MemPaneBufferStore {
  private readonly _bufs = new Map<PaneId, Uint8Array>();

  append(id: PaneId, bytes: Uint8Array): void {
    const existing = this._bufs.get(id);
    if (existing === undefined) {
      this._bufs.set(id, new Uint8Array(bytes));
    } else {
      const merged = new Uint8Array(existing.length + bytes.length);
      merged.set(existing, 0);
      merged.set(bytes, existing.length);
      this._bufs.set(id, merged);
    }
  }

  getContents(id: PaneId): Uint8Array {
    return this._bufs.get(id) ?? new Uint8Array(0);
  }

  size(id: PaneId): number {
    return this._bufs.get(id)?.length ?? 0;
  }

  drop(id: PaneId): void {
    this._bufs.delete(id);
  }

  clear(): void {
    this._bufs.clear();
  }
}

function makeStore() {
  return new MemPaneBufferStore();
}

// ---------------------------------------------------------------------------
// Synthetic fixture helpers
//
// Fixtures match the EXACT format that real tmux 3.4 emits.
// Validated against real tmux output in comments below.
//
// Session: $0 "mysess"
//   Window @0 "zsh" (inactive, single pane %0)
//     layout: b25d,80x24,0,0,0
//   Window @1 "bash" (active, two panes %1 active + %2 inactive)
//     layout: 020a,80x24,0,0{40x24,0,0,1,39x24,41,0,2}
// ---------------------------------------------------------------------------

const WINDOWS_BODY_TEXT =
  // session_id  session_name  window_id  window_name  w    h    layout                                    flags  active
  "$0\tmysess\t@0\tzsh\t80\t24\tb25d,80x24,0,0,0\t-\t0\n" +
  "$0\tmysess\t@1\tbash\t80\t24\t020a,80x24,0,0{40x24,0,0,1,39x24,41,0,2}\t*\t1\n";

const PANES_BODY_TEXT =
  // pane_id  window_id  session_id  idx  w   h   top  left  active  pid      cmd
  "%0\t@0\t$0\t0\t80\t24\t0\t0\t1\t9001\tzsh\n" +
  "%1\t@1\t$0\t0\t40\t24\t0\t0\t0\t9002\tbash\n" +
  "%2\t@1\t$0\t1\t39\t24\t0\t41\t1\t9003\tvim\n";

function makeWindowsResult(ok = true): CommandResult {
  return {
    ok,
    commandNumber: 1,
    body: new TextEncoder().encode(WINDOWS_BODY_TEXT),
  };
}

function makePanesResult(ok = true): CommandResult {
  return {
    ok,
    commandNumber: 2,
    body: new TextEncoder().encode(PANES_BODY_TEXT),
  };
}

// Branded id helpers for assertions
const p0 = paneId("p0");
const p1 = paneId("p1");
const p2 = paneId("p2");
const w0 = windowId("w0");
const w1 = windowId("w1");
const s0 = sessionId("s0");

// ---------------------------------------------------------------------------
// bootstrapCommands()
// ---------------------------------------------------------------------------

describe("bootstrapCommands", () => {
  it("returns [listWindowsCmd, listPanesCmd] with correct formats and -a flag", () => {
    const [winCmd, paneCmd] = bootstrapCommands();

    // list-windows command includes the format string and -a
    assert.ok(winCmd.startsWith("list-windows"), `windows cmd: ${winCmd}`);
    assert.ok(winCmd.includes(BOOTSTRAP_WINDOWS_FORMAT) || winCmd.includes("-F"), `has -F: ${winCmd}`);
    assert.ok(winCmd.endsWith("-a"), `ends with -a: ${winCmd}`);

    // list-panes command includes the format string and -a
    assert.ok(paneCmd.startsWith("list-panes"), `panes cmd: ${paneCmd}`);
    assert.ok(paneCmd.endsWith("-a"), `ends with -a: ${paneCmd}`);
  });

  it("format strings contain expected tmux variables", () => {
    assert.ok(BOOTSTRAP_WINDOWS_FORMAT.includes("#{session_id}"));
    assert.ok(BOOTSTRAP_WINDOWS_FORMAT.includes("#{window_id}"));
    assert.ok(BOOTSTRAP_WINDOWS_FORMAT.includes("#{window_layout}"));
    assert.ok(BOOTSTRAP_WINDOWS_FORMAT.includes("#{?window_active,1,0}"));

    assert.ok(BOOTSTRAP_PANES_FORMAT.includes("#{pane_id}"));
    assert.ok(BOOTSTRAP_PANES_FORMAT.includes("#{window_id}"));
    assert.ok(BOOTSTRAP_PANES_FORMAT.includes("#{session_id}"));
    assert.ok(BOOTSTRAP_PANES_FORMAT.includes("#{?pane_active,1,0}"));
  });
});

// ---------------------------------------------------------------------------
// parseWindowsReply()
// ---------------------------------------------------------------------------

describe("parseWindowsReply", () => {
  it("parses 2-window synthetic fixture", () => {
    const rows = parseWindowsReply(new TextEncoder().encode(WINDOWS_BODY_TEXT));
    assert.strictEqual(rows.length, 2);

    const [r0, r1] = rows as [WindowsReplyRow, WindowsReplyRow];

    // Window @0
    assert.strictEqual(r0.tmuxSessionId, 0);
    assert.strictEqual(r0.sessionName, "mysess");
    assert.strictEqual(r0.tmuxWindowId, 0);
    assert.strictEqual(r0.windowName, "zsh");
    assert.strictEqual(r0.width, 80);
    assert.strictEqual(r0.height, 24);
    assert.strictEqual(r0.active, false);
    assert.ok(r0.layoutString.length > 0, "layoutString present");

    // Window @1 (active)
    assert.strictEqual(r1.tmuxWindowId, 1);
    assert.strictEqual(r1.windowName, "bash");
    assert.strictEqual(r1.active, true);
  });

  it("skips malformed lines", () => {
    const body = new TextEncoder().encode(
      "too\tshort\n" +             // only 2 fields
      WINDOWS_BODY_TEXT,
    );
    const rows = parseWindowsReply(body);
    assert.strictEqual(rows.length, 2); // only the 2 valid lines
  });

  it("handles empty body", () => {
    const rows = parseWindowsReply(new Uint8Array(0));
    assert.strictEqual(rows.length, 0);
  });

  it("handles trailing whitespace / blank lines", () => {
    const body = new TextEncoder().encode("\n" + WINDOWS_BODY_TEXT + "\n\n");
    const rows = parseWindowsReply(body);
    assert.strictEqual(rows.length, 2);
  });
});

// ---------------------------------------------------------------------------
// parsePanesReply()
// ---------------------------------------------------------------------------

describe("parsePanesReply", () => {
  it("parses 3-pane synthetic fixture", () => {
    const rows = parsePanesReply(new TextEncoder().encode(PANES_BODY_TEXT));
    assert.strictEqual(rows.length, 3);

    const [r0, r1, r2] = rows as [PanesReplyRow, PanesReplyRow, PanesReplyRow];

    // Pane %0 in window @0 — active (it's the only pane)
    assert.strictEqual(r0.tmuxPaneId, 0);
    assert.strictEqual(r0.tmuxWindowId, 0);
    assert.strictEqual(r0.tmuxSessionId, 0);
    assert.strictEqual(r0.width, 80);
    assert.strictEqual(r0.height, 24);
    assert.strictEqual(r0.active, true);

    // Pane %1 in window @1 — inactive
    assert.strictEqual(r1.tmuxPaneId, 1);
    assert.strictEqual(r1.tmuxWindowId, 1);
    assert.strictEqual(r1.active, false);

    // Pane %2 in window @1 — active (pane_active=1)
    assert.strictEqual(r2.tmuxPaneId, 2);
    assert.strictEqual(r2.tmuxWindowId, 1);
    assert.strictEqual(r2.active, true);
    assert.strictEqual(r2.paneLeft, 41); // right side of split
  });

  it("skips malformed lines", () => {
    const body = new TextEncoder().encode("bad\n" + PANES_BODY_TEXT);
    const rows = parsePanesReply(body);
    assert.strictEqual(rows.length, 3);
  });

  it("handles empty body", () => {
    const rows = parsePanesReply(new Uint8Array(0));
    assert.strictEqual(rows.length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildInitialModel()
// ---------------------------------------------------------------------------

describe("buildInitialModel", () => {
  it("cold attach: 1 session, 2 windows, 3 panes — entities present", () => {
    const windowRows = parseWindowsReply(new TextEncoder().encode(WINDOWS_BODY_TEXT));
    const paneRows = parsePanesReply(new TextEncoder().encode(PANES_BODY_TEXT));
    const model = buildInitialModel(windowRows, paneRows);

    // Session
    assert.strictEqual(model.sessions.size, 1);
    const sess = model.sessions.get(s0);
    assert.ok(sess, "session s0 present");
    assert.strictEqual(sess.name, "mysess");
    assert.strictEqual(sess.windowIds.length, 2);

    // Windows
    assert.strictEqual(model.windows.size, 2);
    assert.ok(model.windows.has(w0), "window w0 present");
    assert.ok(model.windows.has(w1), "window w1 present");

    const win0 = model.windows.get(w0)!;
    assert.strictEqual(win0.name, "zsh");
    assert.strictEqual(win0.paneIds.length, 1);

    const win1 = model.windows.get(w1)!;
    assert.strictEqual(win1.name, "bash");
    assert.strictEqual(win1.paneIds.length, 2);

    // Panes
    assert.strictEqual(model.panes.size, 3);
    assert.ok(model.panes.has(p0), "pane p0 present");
    assert.ok(model.panes.has(p1), "pane p1 present");
    assert.ok(model.panes.has(p2), "pane p2 present");

    const pane0 = model.panes.get(p0)!;
    assert.strictEqual(pane0.cols, 80);
    assert.strictEqual(pane0.rows, 24);
  });

  it("cold attach: correct layout on active window", () => {
    const windowRows = parseWindowsReply(new TextEncoder().encode(WINDOWS_BODY_TEXT));
    const paneRows = parsePanesReply(new TextEncoder().encode(PANES_BODY_TEXT));
    const model = buildInitialModel(windowRows, paneRows);

    // Window @0 has a simple single-pane layout
    const win0 = model.windows.get(w0)!;
    assert.ok(win0.layout !== null, "w0 has layout");
    assert.strictEqual(win0.layout!.cols, 80);
    assert.strictEqual(win0.layout!.rows, 24);

    // Window @1 has a hsplit layout (40+39 = 79 cols + separator)
    const win1 = model.windows.get(w1)!;
    assert.ok(win1.layout !== null, "w1 has layout");
    assert.strictEqual(win1.layout!.cols, 80);
    assert.strictEqual(win1.layout!.rows, 24);
    assert.strictEqual(win1.layout!.root.kind, "hsplit");
  });

  it("cold attach: focus set to active session → window → pane", () => {
    const windowRows = parseWindowsReply(new TextEncoder().encode(WINDOWS_BODY_TEXT));
    const paneRows = parsePanesReply(new TextEncoder().encode(PANES_BODY_TEXT));
    const model = buildInitialModel(windowRows, paneRows);

    // Active window is @1, active pane in @1 is %2
    assert.strictEqual(model.focus.sessionId, s0, "focus.sessionId = s0");
    assert.strictEqual(model.focus.windowId, w1, "focus.windowId = w1");
    assert.strictEqual(model.focus.paneId, p2, "focus.paneId = p2");

    // Active window pointer on session
    const sess = model.sessions.get(s0)!;
    assert.strictEqual(sess.activeWindowId, w1);

    // Active pane pointer on window @1
    const win1 = model.windows.get(w1)!;
    assert.strictEqual(win1.activePaneId, p2);
  });

  it("cold attach: checkInvariants clean", () => {
    const windowRows = parseWindowsReply(new TextEncoder().encode(WINDOWS_BODY_TEXT));
    const paneRows = parsePanesReply(new TextEncoder().encode(PANES_BODY_TEXT));
    const model = buildInitialModel(windowRows, paneRows);
    const violations = checkInvariants(model, { checkLayoutConsistency: true });
    assert.deepStrictEqual(violations, [], `violations: ${JSON.stringify(violations)}`);
  });

  it("empty windows+panes rows → empty model with null focus", () => {
    const model = buildInitialModel([], []);
    assert.strictEqual(model.sessions.size, 0);
    assert.strictEqual(model.windows.size, 0);
    assert.strictEqual(model.panes.size, 0);
    assert.strictEqual(model.focus.paneId, null);
    assert.strictEqual(model.focus.windowId, null);
    assert.strictEqual(model.focus.sessionId, null);
    const violations = checkInvariants(model);
    assert.deepStrictEqual(violations, []);
  });
});

// ---------------------------------------------------------------------------
// BootstrapCoordinator
// ---------------------------------------------------------------------------

describe("BootstrapCoordinator — cold attach", () => {
  it("starts in bootstrapping phase", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    assert.strictEqual(coord.phase(), "bootstrapping");
    assert.strictEqual(coord.isLive(), false);
  });

  it("transitions to live after both replies arrive (windows first)", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    coord.onWindowsResult(makeWindowsResult());
    assert.strictEqual(coord.phase(), "bootstrapping", "still bootstrapping after windows only");
    coord.onPanesResult(makePanesResult());
    assert.strictEqual(coord.phase(), "live");
    assert.strictEqual(coord.isLive(), true);
  });

  it("transitions to live after both replies arrive (panes first)", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    coord.onPanesResult(makePanesResult());
    assert.strictEqual(coord.phase(), "bootstrapping", "still bootstrapping after panes only");
    coord.onWindowsResult(makeWindowsResult());
    assert.strictEqual(coord.phase(), "live");
  });

  it("getModel() after bootstrap has all entities", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    coord.onWindowsResult(makeWindowsResult());
    coord.onPanesResult(makePanesResult());
    const model = coord.getModel();

    assert.strictEqual(model.sessions.size, 1);
    assert.strictEqual(model.windows.size, 2);
    assert.strictEqual(model.panes.size, 3);
    assert.strictEqual(model.focus.paneId, p2);
    assert.strictEqual(model.focus.windowId, w1);
    assert.strictEqual(model.focus.sessionId, s0);
  });

  it("checkInvariants clean on coordinator model after bootstrap", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    coord.onWindowsResult(makeWindowsResult());
    coord.onPanesResult(makePanesResult());
    const violations = checkInvariants(coord.getModel(), { checkLayoutConsistency: true });
    assert.deepStrictEqual(violations, []);
  });

  it("bootstrapCommands() returns two commands", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    const cmds = coord.bootstrapCommands();
    assert.strictEqual(cmds.length, 2);
    assert.ok(cmds[0].startsWith("list-windows"));
    assert.ok(cmds[1].startsWith("list-panes"));
  });
});

// ---------------------------------------------------------------------------
// BootstrapCoordinator — handoff / no dropped events
// ---------------------------------------------------------------------------

describe("BootstrapCoordinator — handoff / no dropped events", () => {
  /**
   * Simulate a window-renamed notification arriving DURING bootstrap (before
   * replies are processed). After bootstrap, the model should reflect the rename.
   */
  it("notification arriving during bootstrap is buffered, then applied", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });

    // Notification arrives while bootstrapping (before replies)
    const renameEvent: NotificationEvent = {
      kind: "window-renamed",
      windowId: 1, // tmux @1 → w1
      name: "renamed-window",
      unlinked: false,
    };
    coord.onNotification(renameEvent);
    assert.strictEqual(coord.phase(), "bootstrapping");

    // Now deliver the replies
    coord.onWindowsResult(makeWindowsResult());
    coord.onPanesResult(makePanesResult());
    assert.strictEqual(coord.phase(), "live");

    const model = coord.getModel();
    // The rename should be applied AFTER the bootstrap model was built
    const win1 = model.windows.get(w1);
    assert.ok(win1, "window w1 in model");
    assert.strictEqual(win1.name, "renamed-window", "rename was replayed");
    // Invariants still clean
    const violations = checkInvariants(model);
    assert.deepStrictEqual(violations, []);
  });

  it("multiple buffered notifications are applied in arrival order", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });

    // Two renames arrive in order: first "first-name", then "second-name"
    coord.onNotification({
      kind: "window-renamed",
      windowId: 0, // @0 → w0
      name: "first-name",
      unlinked: false,
    });
    coord.onNotification({
      kind: "window-renamed",
      windowId: 0,
      name: "second-name",
      unlinked: false,
    });

    coord.onWindowsResult(makeWindowsResult());
    coord.onPanesResult(makePanesResult());

    const model = coord.getModel();
    const win0 = model.windows.get(w0);
    // Second rename wins (order preserved)
    assert.strictEqual(win0?.name, "second-name");
  });

  it("notification for a NEW entity during bootstrap is buffered and applied", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });

    // A new window @99 is added during bootstrap (not in list-windows reply)
    coord.onNotification({
      kind: "window-add",
      windowId: 99,
      unlinked: false,
    });

    coord.onWindowsResult(makeWindowsResult());
    coord.onPanesResult(makePanesResult());

    const model = coord.getModel();
    const w99 = windowId("w99");
    assert.ok(model.windows.has(w99), "w99 added via buffered notification");
    const violations = checkInvariants(model);
    assert.deepStrictEqual(violations, []);
  });
});

// ---------------------------------------------------------------------------
// BootstrapCoordinator — stays correct under deltas after going live
// ---------------------------------------------------------------------------

describe("BootstrapCoordinator — live deltas after bootstrap", () => {
  function makeBootstrappedCoord(): BootstrapCoordinator {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    coord.onWindowsResult(makeWindowsResult());
    coord.onPanesResult(makePanesResult());
    return coord;
  }

  it("live window-renamed event updates model", () => {
    const coord = makeBootstrappedCoord();
    assert.strictEqual(coord.isLive(), true);

    coord.onNotification({
      kind: "window-renamed",
      windowId: 0,
      name: "live-rename",
      unlinked: false,
    });

    const win0 = coord.getModel().windows.get(w0);
    assert.strictEqual(win0?.name, "live-rename");
  });

  it("live window-close removes the window", () => {
    const coord = makeBootstrappedCoord();
    coord.onNotification({
      kind: "window-close",
      windowId: 0,
      unlinked: false,
    });

    const model = coord.getModel();
    assert.ok(!model.windows.has(w0), "w0 removed");
    // p0 was in w0, should also be gone
    assert.ok(!model.panes.has(p0), "p0 removed with w0");
    assert.deepStrictEqual(checkInvariants(model), []);
  });

  it("sequence of deltas leaves model invariant-clean", () => {
    const coord = makeBootstrappedCoord();

    // Rename w1, then close w0
    coord.onNotification({
      kind: "window-renamed",
      windowId: 1,
      name: "updated",
      unlinked: false,
    });
    coord.onNotification({
      kind: "window-close",
      windowId: 0,
      unlinked: false,
    });

    const model = coord.getModel();
    assert.strictEqual(model.windows.get(w1)?.name, "updated");
    assert.ok(!model.windows.has(w0));
    assert.deepStrictEqual(checkInvariants(model), []);
  });
});

// ---------------------------------------------------------------------------
// BootstrapCoordinator — idempotent/redundant buffered events
// ---------------------------------------------------------------------------

describe("BootstrapCoordinator — idempotent/redundant events", () => {
  it("buffered window-add for a window already in bootstrap snapshot is a no-op", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });

    // window-add for @1 arrives during bootstrap — @1 is already in list-windows reply
    coord.onNotification({
      kind: "window-add",
      windowId: 1, // same as w1 in fixture
      unlinked: false,
    });

    coord.onWindowsResult(makeWindowsResult());
    coord.onPanesResult(makePanesResult());

    const model = coord.getModel();
    // w1 still in model, exactly once
    assert.ok(model.windows.has(w1));
    // Session still has w1 in windowIds exactly once
    const sess = model.sessions.get(s0)!;
    const w1Count = sess.windowIds.filter((id) => id === w1).length;
    assert.strictEqual(w1Count, 1, "w1 appears exactly once in session.windowIds");
    assert.deepStrictEqual(checkInvariants(model), []);
  });

  it("buffered session-changed for existing session doesn't corrupt focus", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });

    // session-changed for $0 arrives during bootstrap (also in list-windows)
    coord.onNotification({
      kind: "session-changed",
      sessionId: 0,
      name: "mysess",
    });

    coord.onWindowsResult(makeWindowsResult());
    coord.onPanesResult(makePanesResult());

    const model = coord.getModel();
    assert.deepStrictEqual(checkInvariants(model), []);
    assert.strictEqual(model.sessions.size, 1, "still one session");
  });
});

// ---------------------------------------------------------------------------
// BootstrapCoordinator — error reply fallback
// ---------------------------------------------------------------------------

describe("BootstrapCoordinator — error reply fallback", () => {
  it("windows %error → empty model, still transitions to live after panes reply", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    coord.onWindowsResult(makeWindowsResult(false)); // %error
    coord.onPanesResult(makePanesResult(true));
    assert.strictEqual(coord.isLive(), true);
    const model = coord.getModel();
    // Windows reply failed → no sessions/windows (panes need a parent window to be added)
    assert.strictEqual(model.sessions.size, 0);
    assert.deepStrictEqual(checkInvariants(model), []);
  });

  it("panes %error → windows-only model (no panes)", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    coord.onWindowsResult(makeWindowsResult(true));
    coord.onPanesResult(makePanesResult(false)); // %error
    assert.strictEqual(coord.isLive(), true);
    const model = coord.getModel();
    // Sessions and windows exist, but no panes
    assert.ok(model.sessions.size > 0);
    assert.ok(model.windows.size > 0);
    assert.strictEqual(model.panes.size, 0);
    assert.deepStrictEqual(checkInvariants(model), []);
  });

  it("both %error → empty model, live", () => {
    const coord = new BootstrapCoordinator({ buffers: makeStore() });
    coord.onWindowsResult(makeWindowsResult(false));
    coord.onPanesResult(makePanesResult(false));
    assert.strictEqual(coord.isLive(), true);
    const model = coord.getModel();
    assert.strictEqual(model.sessions.size, 0);
    assert.deepStrictEqual(checkInvariants(model), []);
  });
});
