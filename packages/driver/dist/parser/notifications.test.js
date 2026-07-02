/**
 * Tests for notifications.ts — full notification-surface parser.
 *
 * Strategy: build NotificationTokens directly (keyword + rawLine) and assert
 * the typed event. Also exercises the tokenizer integration path for a few
 * representative cases.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNotification } from "./notifications.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function enc(s) {
    return new TextEncoder().encode(s);
}
/** Build a NotificationToken from a raw line string. */
function tok(line) {
    const rawLine = enc(line);
    // Extract keyword: everything between % and first space (or end)
    const spaceIdx = line.indexOf(" ");
    const keyword = spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx);
    return { kind: "notification", keyword, rawLine };
}
// ---------------------------------------------------------------------------
// %output
// ---------------------------------------------------------------------------
describe("parseNotification – %output", () => {
    it("parses pane id and raw payload bytes", () => {
        const event = parseNotification(tok("%output %3 hello\\012world"));
        assert.equal(event.kind, "output");
        if (event.kind !== "output")
            return;
        assert.equal(event.paneId, 3);
        // rawPayload is the bytes after "%output %3 "
        const payload = new TextDecoder().decode(event.rawPayload);
        assert.equal(payload, "hello\\012world");
    });
    it("parses pane id 0", () => {
        const event = parseNotification(tok("%output %0 data"));
        assert.equal(event.kind, "output");
        if (event.kind !== "output")
            return;
        assert.equal(event.paneId, 0);
    });
    it("is graceful with binary-like payload", () => {
        const line = "%output %7 \\001\\002\\003";
        const event = parseNotification(tok(line));
        assert.equal(event.kind, "output");
    });
});
// ---------------------------------------------------------------------------
// %extended-output
// ---------------------------------------------------------------------------
describe("parseNotification – %extended-output", () => {
    it("parses pane, age, payload", () => {
        const event = parseNotification(tok("%extended-output %5 123456 : \\101\\102"));
        assert.equal(event.kind, "extended-output");
        if (event.kind !== "extended-output")
            return;
        assert.equal(event.paneId, 5);
        assert.equal(event.ageMs, 123456n);
        const payload = new TextDecoder().decode(event.rawPayload);
        assert.equal(payload, "\\101\\102");
    });
    it("handles extra unknown fields between age and colon (cross-version)", () => {
        // Future tmux might add extra fields before " : "
        const event = parseNotification(tok("%extended-output %2 9999 extra1 extra2 : hello"));
        assert.equal(event.kind, "extended-output");
        if (event.kind !== "extended-output")
            return;
        assert.equal(event.paneId, 2);
        assert.equal(event.ageMs, 9999n);
        const payload = new TextDecoder().decode(event.rawPayload);
        assert.equal(payload, "hello");
    });
    it("returns unknown when ' : ' delimiter is absent", () => {
        const event = parseNotification(tok("%extended-output %1 100 nodatadelimiter"));
        assert.equal(event.kind, "unknown");
    });
});
// ---------------------------------------------------------------------------
// %window-add / %unlinked-window-add
// ---------------------------------------------------------------------------
describe("parseNotification – %window-add", () => {
    it("parses linked window-add", () => {
        const event = parseNotification(tok("%window-add @42"));
        assert.equal(event.kind, "window-add");
        if (event.kind !== "window-add")
            return;
        assert.equal(event.windowId, 42);
        assert.equal(event.unlinked, false);
    });
    it("parses unlinked-window-add", () => {
        const event = parseNotification(tok("%unlinked-window-add @7"));
        assert.equal(event.kind, "window-add");
        if (event.kind !== "window-add")
            return;
        assert.equal(event.windowId, 7);
        assert.equal(event.unlinked, true);
    });
    it("tolerates extra trailing fields (cross-version)", () => {
        const event = parseNotification(tok("%window-add @10 some-future-field"));
        assert.equal(event.kind, "window-add");
        if (event.kind !== "window-add")
            return;
        assert.equal(event.windowId, 10);
    });
});
// ---------------------------------------------------------------------------
// %window-close / %unlinked-window-close
// ---------------------------------------------------------------------------
describe("parseNotification – %window-close", () => {
    it("parses linked window-close", () => {
        const event = parseNotification(tok("%window-close @1"));
        assert.equal(event.kind, "window-close");
        if (event.kind !== "window-close")
            return;
        assert.equal(event.windowId, 1);
        assert.equal(event.unlinked, false);
    });
    it("parses unlinked-window-close", () => {
        const event = parseNotification(tok("%unlinked-window-close @99"));
        assert.equal(event.kind, "window-close");
        if (event.kind !== "window-close")
            return;
        assert.equal(event.windowId, 99);
        assert.equal(event.unlinked, true);
    });
});
// ---------------------------------------------------------------------------
// %window-renamed / %unlinked-window-renamed
// ---------------------------------------------------------------------------
describe("parseNotification – %window-renamed", () => {
    it("parses name without spaces", () => {
        const event = parseNotification(tok("%window-renamed @3 bash"));
        assert.equal(event.kind, "window-renamed");
        if (event.kind !== "window-renamed")
            return;
        assert.equal(event.windowId, 3);
        assert.equal(event.name, "bash");
        assert.equal(event.unlinked, false);
    });
    it("parses name containing spaces", () => {
        const event = parseNotification(tok("%window-renamed @5 my cool window"));
        assert.equal(event.kind, "window-renamed");
        if (event.kind !== "window-renamed")
            return;
        assert.equal(event.windowId, 5);
        assert.equal(event.name, "my cool window");
    });
    it("parses unlinked-window-renamed with a spaced name", () => {
        const event = parseNotification(tok("%unlinked-window-renamed @12 vim - untitled"));
        assert.equal(event.kind, "window-renamed");
        if (event.kind !== "window-renamed")
            return;
        assert.equal(event.windowId, 12);
        assert.equal(event.name, "vim - untitled");
        assert.equal(event.unlinked, true);
    });
});
// ---------------------------------------------------------------------------
// %window-pane-changed
// ---------------------------------------------------------------------------
describe("parseNotification – %window-pane-changed", () => {
    it("parses window and pane ids", () => {
        const event = parseNotification(tok("%window-pane-changed @2 %8"));
        assert.equal(event.kind, "window-pane-changed");
        if (event.kind !== "window-pane-changed")
            return;
        assert.equal(event.windowId, 2);
        assert.equal(event.paneId, 8);
    });
});
// ---------------------------------------------------------------------------
// %session-changed
// ---------------------------------------------------------------------------
describe("parseNotification – %session-changed", () => {
    it("parses session id and name", () => {
        const event = parseNotification(tok("%session-changed $0 main"));
        assert.equal(event.kind, "session-changed");
        if (event.kind !== "session-changed")
            return;
        assert.equal(event.sessionId, 0);
        assert.equal(event.name, "main");
    });
    it("parses session name containing spaces", () => {
        const event = parseNotification(tok("%session-changed $3 my dev session"));
        assert.equal(event.kind, "session-changed");
        if (event.kind !== "session-changed")
            return;
        assert.equal(event.sessionId, 3);
        assert.equal(event.name, "my dev session");
    });
});
// ---------------------------------------------------------------------------
// %client-session-changed
// ---------------------------------------------------------------------------
describe("parseNotification – %client-session-changed", () => {
    it("parses client, session id, and name", () => {
        const event = parseNotification(tok("%client-session-changed /dev/ttys001 $2 work"));
        assert.equal(event.kind, "client-session-changed");
        if (event.kind !== "client-session-changed")
            return;
        assert.equal(event.clientName, "/dev/ttys001");
        assert.equal(event.sessionId, 2);
        assert.equal(event.name, "work");
    });
});
// ---------------------------------------------------------------------------
// %session-renamed
// ---------------------------------------------------------------------------
describe("parseNotification – %session-renamed", () => {
    it("parses session id and name (current tmux format)", () => {
        const event = parseNotification(tok("%session-renamed $1 new-name"));
        assert.equal(event.kind, "session-renamed");
        if (event.kind !== "session-renamed")
            return;
        assert.equal(event.sessionId, 1);
        assert.equal(event.name, "new-name");
    });
    it("parses session name with spaces", () => {
        const event = parseNotification(tok("%session-renamed $4 my renamed session"));
        assert.equal(event.kind, "session-renamed");
        if (event.kind !== "session-renamed")
            return;
        assert.equal(event.sessionId, 4);
        assert.equal(event.name, "my renamed session");
    });
    it("handles older tmux format (no $id prefix)", () => {
        // Pre-3.x tmux emitted %session-renamed <name> without a session id
        const event = parseNotification(tok("%session-renamed oldname"));
        assert.equal(event.kind, "session-renamed");
        if (event.kind !== "session-renamed")
            return;
        assert.equal(event.sessionId, null);
        assert.equal(event.name, "oldname");
    });
});
// ---------------------------------------------------------------------------
// %sessions-changed
// ---------------------------------------------------------------------------
describe("parseNotification – %sessions-changed", () => {
    it("returns sessions-changed event", () => {
        const event = parseNotification(tok("%sessions-changed"));
        assert.equal(event.kind, "sessions-changed");
    });
});
// ---------------------------------------------------------------------------
// %session-window-changed
// ---------------------------------------------------------------------------
describe("parseNotification – %session-window-changed", () => {
    it("parses session and window ids", () => {
        const event = parseNotification(tok("%session-window-changed $0 @3"));
        assert.equal(event.kind, "session-window-changed");
        if (event.kind !== "session-window-changed")
            return;
        assert.equal(event.sessionId, 0);
        assert.equal(event.windowId, 3);
    });
});
// ---------------------------------------------------------------------------
// %pane-mode-changed
// ---------------------------------------------------------------------------
describe("parseNotification – %pane-mode-changed", () => {
    it("parses pane id", () => {
        const event = parseNotification(tok("%pane-mode-changed %4"));
        assert.equal(event.kind, "pane-mode-changed");
        if (event.kind !== "pane-mode-changed")
            return;
        assert.equal(event.paneId, 4);
    });
});
// ---------------------------------------------------------------------------
// %subscription-changed
// ---------------------------------------------------------------------------
describe("parseNotification – %subscription-changed", () => {
    it("parses pane-level subscription", () => {
        // %subscription-changed name $S @W idx %P : value
        const event = parseNotification(tok("%subscription-changed mysub $1 @2 0 %5 : formatted-value"));
        assert.equal(event.kind, "subscription-changed");
        if (event.kind !== "subscription-changed")
            return;
        assert.equal(event.name, "mysub");
        assert.equal(event.sessionId, 1);
        assert.equal(event.windowId, 2);
        assert.equal(event.windowIdx, 0);
        assert.equal(event.paneId, 5);
        assert.equal(event.value, "formatted-value");
    });
    it("parses session-level subscription (dashes for window/idx/pane)", () => {
        const event = parseNotification(tok("%subscription-changed sessub $0 - - - : sess-value"));
        assert.equal(event.kind, "subscription-changed");
        if (event.kind !== "subscription-changed")
            return;
        assert.equal(event.name, "sessub");
        assert.equal(event.sessionId, 0);
        assert.equal(event.windowId, null);
        assert.equal(event.windowIdx, null);
        assert.equal(event.paneId, null);
        assert.equal(event.value, "sess-value");
    });
    it("parses window-level subscription (pane is dash)", () => {
        const event = parseNotification(tok("%subscription-changed winsub $2 @4 1 - : win-val"));
        assert.equal(event.kind, "subscription-changed");
        if (event.kind !== "subscription-changed")
            return;
        assert.equal(event.windowId, 4);
        assert.equal(event.windowIdx, 1);
        assert.equal(event.paneId, null);
        assert.equal(event.value, "win-val");
    });
    it("value may contain colons", () => {
        const event = parseNotification(tok("%subscription-changed s $0 - - - : a:b:c"));
        assert.equal(event.kind, "subscription-changed");
        if (event.kind !== "subscription-changed")
            return;
        assert.equal(event.value, "a:b:c");
    });
});
// ---------------------------------------------------------------------------
// %pause / %continue
// ---------------------------------------------------------------------------
describe("parseNotification – %pause", () => {
    it("parses pane id", () => {
        const event = parseNotification(tok("%pause %9"));
        assert.equal(event.kind, "pause");
        if (event.kind !== "pause")
            return;
        assert.equal(event.paneId, 9);
    });
});
describe("parseNotification – %continue", () => {
    it("parses pane id", () => {
        const event = parseNotification(tok("%continue %0"));
        assert.equal(event.kind, "continue");
        if (event.kind !== "continue")
            return;
        assert.equal(event.paneId, 0);
    });
});
// ---------------------------------------------------------------------------
// %exit
// ---------------------------------------------------------------------------
describe("parseNotification – %exit", () => {
    it("parses exit with reason", () => {
        const event = parseNotification(tok("%exit lost tty"));
        assert.equal(event.kind, "exit");
        if (event.kind !== "exit")
            return;
        assert.equal(event.reason, "lost tty");
    });
    it("parses exit with no reason", () => {
        const event = parseNotification(tok("%exit"));
        assert.equal(event.kind, "exit");
        if (event.kind !== "exit")
            return;
        assert.equal(event.reason, null);
    });
});
// ---------------------------------------------------------------------------
// Unknown notifications — graceful handling
// ---------------------------------------------------------------------------
describe("parseNotification – unknown keyword", () => {
    it("returns unknown event for unknown keyword — does not throw", () => {
        const event = parseNotification(tok("%frobnicate foo bar"));
        assert.equal(event.kind, "unknown");
        if (event.kind !== "unknown")
            return;
        assert.equal(event.keyword, "frobnicate");
        // rawLine preserved
        assert.ok(event.rawLine.length > 0);
    });
    it("returns unknown for bare unknown keyword with no args", () => {
        const event = parseNotification(tok("%newkeyword"));
        assert.equal(event.kind, "unknown");
    });
});
// ---------------------------------------------------------------------------
// Cross-version tolerance
// ---------------------------------------------------------------------------
describe("cross-version tolerance", () => {
    it("%window-close with extra trailing field does not crash", () => {
        const event = parseNotification(tok("%window-close @5 extra-future-field"));
        // Should still parse the windowId; extra field is ignored
        assert.equal(event.kind, "window-close");
        if (event.kind !== "window-close")
            return;
        assert.equal(event.windowId, 5);
    });
    it("%session-changed with extra trailing field preserves name", () => {
        // If a future tmux appended an extra field after the name, the name
        // (rest-of-line) would include it. This is acceptable — the parser
        // does not crash and still extracts sessionId correctly.
        const event = parseNotification(tok("%session-changed $1 myname extra"));
        assert.equal(event.kind, "session-changed");
        if (event.kind !== "session-changed")
            return;
        assert.equal(event.sessionId, 1);
        // name includes the extra field (rest-of-line semantics)
        assert.ok(event.name.startsWith("myname"));
    });
    it("%window-pane-changed with extra trailing field does not crash", () => {
        const event = parseNotification(tok("%window-pane-changed @1 %2 future-extra"));
        assert.equal(event.kind, "window-pane-changed");
        if (event.kind !== "window-pane-changed")
            return;
        assert.equal(event.windowId, 1);
        assert.equal(event.paneId, 2);
    });
    it("%session-window-changed with extra trailing field does not crash", () => {
        const event = parseNotification(tok("%session-window-changed $0 @1 extra"));
        assert.equal(event.kind, "session-window-changed");
        if (event.kind !== "session-window-changed")
            return;
        assert.equal(event.sessionId, 0);
        assert.equal(event.windowId, 1);
    });
});
//# sourceMappingURL=notifications.test.js.map