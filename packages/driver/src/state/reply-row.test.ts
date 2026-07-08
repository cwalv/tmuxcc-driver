/**
 * Tests for the schema-derived reply-row codec (tc-mysc).
 *
 * The keystone is the schema-derived ROUND-TRIP property test: it is the test
 * that would have caught tc-pqb4 at introduction time. Iterating the schema, it
 * renders a row through `fixtureLine`, parses it back, and asserts every field
 * survives — so a canonical field added to the schema is covered the day it is
 * declared, and a format/parser/type disagreement is impossible to ship green.
 *
 * @module state/reply-row.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ReplyShapeError,
  FieldDecodeError,
  ReplyCodecError,
  SANITIZE_TAB_PATTERN,
} from "./reply-row.js";
import {
  WINDOWS_ROW,
  PANES_ROW,
  BOOTSTRAP_WINDOWS_FORMAT,
  BOOTSTRAP_PANES_FORMAT,
  buildInitialModel,
  type WindowsReplyRow,
  type PanesReplyRow,
} from "./bootstrap.js";
import { windowId, paneId } from "./model.js";

const ENC = new TextEncoder();

// Distinct, NON-default values for every field — a transposition of two
// same-typed fields or a dropped column fails the deep-equality round-trip.
const WINDOW_OVERRIDE: WindowsReplyRow = {
  tmuxSessionId: 3,
  sessionName: "sess-x",
  tmuxWindowId: 7,
  name: "win-y",
  layoutString: "bbbb,90x30,0,0,5",
  active: true,
  synchronizePanes: true,
  monitorActivity: false,
  monitorSilence: 42,
};
const PANE_OVERRIDE: PanesReplyRow = {
  tmuxPaneId: 9,
  tmuxWindowId: 4,
  tmuxSessionId: 2,
  cols: 100,
  rows: 50,
  active: true,
  dead: true,
  exitCode: 137,
  label: "my-label",
  detach: "kill",
  icon: "term",
  paneTitle: "live-title",
};

describe("reply-row codec: schema-derived round-trip", () => {
  it("WINDOWS_ROW: every field survives fixtureLine → parse", () => {
    const line = ENC.encode(WINDOWS_ROW.fixtureBody([WINDOW_OVERRIDE]));
    const parsed = WINDOWS_ROW.parse(line);
    assert.equal(parsed.length, 1);
    assert.deepStrictEqual(parsed[0], WINDOW_OVERRIDE);
  });

  it("PANES_ROW: every field survives fixtureLine → parse", () => {
    const line = ENC.encode(PANES_ROW.fixtureBody([PANE_OVERRIDE]));
    const parsed = PANES_ROW.parse(line);
    assert.equal(parsed.length, 1);
    assert.deepStrictEqual(parsed[0], PANE_OVERRIDE);
  });

  it("fixtureRow defaults also round-trip (unset options decode to undefined)", () => {
    for (const row of [WINDOWS_ROW, PANES_ROW]) {
      const expected = row.fixtureRow();
      const parsed = row.parse(ENC.encode(row.fixtureBody([{}])));
      assert.deepStrictEqual(parsed[0], expected);
    }
  });

  it("a rendered wire row has exactly one column per schema field", () => {
    // NB: the FORMAT string itself carries interior tab bytes inside the two
    // `#{s/<TAB>/ /:...}` sanitizer patterns — those are consumed by tmux's
    // format evaluator, not emitted — so column count is asserted on the wire
    // form (fixtureLine), not on the format string.
    assert.equal(WINDOWS_ROW.fixtureLine({}).split("\t").length, WINDOWS_ROW.keys.length);
    assert.equal(PANES_ROW.fixtureLine({}).split("\t").length, PANES_ROW.keys.length);
    // Dead fields deleted (tc-mysc): 9 window fields. Pane fields: 11 after
    // tc-mysc + paneTitle (tc-mysc.2) = 12.
    assert.equal(WINDOWS_ROW.keys.length, 9);
    assert.equal(PANES_ROW.keys.length, 12);
  });
});

describe("reply-row codec: buildInitialModel field survival", () => {
  it("row-derived fields reach the model (the tc-pqb4 clobber class)", () => {
    const model = buildInitialModel(
      [WINDOW_OVERRIDE],
      [{ ...PANE_OVERRIDE, tmuxWindowId: 7, tmuxSessionId: 3 }],
    );
    const win = model.windows.get(windowId("w7"));
    assert.ok(win);
    assert.equal(win.name, "win-y");
    assert.equal(win.synchronizePanes, true);
    assert.equal(win.monitorActivity, false);
    assert.equal(win.monitorSilence, 42);
    const pane = model.panes.get(paneId("p9"));
    assert.ok(pane);
    assert.equal(pane.cols, 100);
    assert.equal(pane.rows, 50);
    assert.equal(pane.label, "my-label");
    assert.equal(pane.detach, "kill");
    assert.equal(pane.icon, "term");
    assert.equal(pane.dead, true);
    assert.equal(pane.exitCode, 137);
    // tc-mysc.2: the format-backed live title reaches the model verbatim via the
    // canonical Pick, so a model rebuilt by a requery carries titles (the
    // regression fix — pre-format, every requery dropped paneTitle to undefined).
    assert.equal(pane.paneTitle, "live-title");
  });
});

describe("reply-row codec: strict parse is fail-loud", () => {
  it("throws ReplyShapeError on a wrong field count", () => {
    assert.throws(() => WINDOWS_ROW.parse(ENC.encode("$0\tonly\ttwo\n")), ReplyShapeError);
    // Every ReplyShapeError is a ReplyCodecError (the coalescer routes on the base).
    assert.throws(() => WINDOWS_ROW.parse(ENC.encode("$0\tonly\ttwo\n")), ReplyCodecError);
  });

  it("throws FieldDecodeError on an undecodable field", () => {
    // Correct column count, but the session id is not a `$N` sigil id.
    const bad = ["NOPE", "s", "@1", "w", "aaaa,80x24,0,0,1", "1", "0", "1", "0"].join("\t") + "\n";
    assert.throws(() => WINDOWS_ROW.parse(ENC.encode(bad)), FieldDecodeError);
  });

  it("does NOT trim() — a live pane row ending in empty option fields keeps its columns", () => {
    // The pre-schema bug: parsePanesReply did line.trim() before splitting, so a
    // real pane row ending `...\t\t\t\t` (empty label/detach/icon) lost columns
    // and the defensive `parts[i] ?? ""` defaults were load-bearing against the
    // parser itself. The strict parse strips only a trailing \r.
    const line =
      PANES_ROW.fixtureLine({
        tmuxPaneId: 1,
        tmuxWindowId: 1,
        tmuxSessionId: 0,
        label: undefined,
        detach: undefined,
        icon: undefined,
      }) + "\n";
    assert.ok(line.includes("\t\t"), "fixture line must actually end in empty option columns");
    const parsed = PANES_ROW.parse(ENC.encode(line));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.label, undefined);
    assert.equal(parsed[0]!.detach, undefined);
    assert.equal(parsed[0]!.icon, undefined);
  });

  it("strips a trailing \\r but never an interior tab", () => {
    const parsed = PANES_ROW.parse(
      ENC.encode(PANES_ROW.fixtureLine({ tmuxPaneId: 2, tmuxWindowId: 1, tmuxSessionId: 0 }) + "\r\n"),
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.tmuxPaneId, 2);
  });

  it("a raw NEWLINE in the pane_title column shatters the row → ReplyShapeError (tc-mysc amendment 4)", () => {
    // Defense-in-depth contract, consistent with names: a raw newline in a field
    // splits the row so the strict parser throws rather than misparsing. Real
    // tmux never emits one — `screen_set_title` strips C0 control bytes from the
    // title at the source (verified live in reply-row-tmux.test.ts) — but the
    // parser bounds-throws if a future tmux ever changed that.
    const line = PANES_ROW.fixtureLine({
      tmuxPaneId: 1,
      tmuxWindowId: 1,
      tmuxSessionId: 0,
      paneTitle: "a\nb",
    });
    assert.ok(line.includes("\n"), "fixture line must actually carry a raw newline in the title");
    assert.throws(() => PANES_ROW.parse(ENC.encode(line)), ReplyShapeError);
  });
});

describe("reply-row codec: literal-TAB sanitizer pin (tc-mysc amendment 3)", () => {
  it("SANITIZE_TAB_PATTERN is a real 0x09 byte, not the 2-char escape", () => {
    assert.equal(SANITIZE_TAB_PATTERN, "\t");
    assert.equal(SANITIZE_TAB_PATTERN.length, 1);
    assert.equal(SANITIZE_TAB_PATTERN.charCodeAt(0), 9);
  });

  it("the derived panes format sanitizes user options with a literal tab", () => {
    // A two-char `\t` pattern would match the LETTER t and leave tabs intact
    // (verified live, tmux 3.4). Pin that the format carries a real 0x09.
    assert.ok(
      BOOTSTRAP_PANES_FORMAT.includes("#{s/\t/ /:@tmuxcc_label}"),
      "@tmuxcc_label must be wrapped in an s/// with a real tab byte",
    );
    assert.ok(
      BOOTSTRAP_PANES_FORMAT.includes("#{s/\t/ /:@tmuxcc-icon}"),
      "@tmuxcc-icon must be wrapped in an s/// with a real tab byte",
    );
    assert.ok(
      // tc-mysc.2: the live pane title is user-controlled free text, sanitized
      // like the other free-text fields (defense-in-depth; tmux 3.4 already
      // strips control chars at the title-set path — see reply-row-tmux.test.ts).
      BOOTSTRAP_PANES_FORMAT.includes("#{s/\t/ /:pane_title}"),
      "pane_title must be wrapped in an s/// with a real tab byte",
    );
    assert.ok(
      !BOOTSTRAP_PANES_FORMAT.includes("s/\\t/"),
      "must NOT use the two-char backslash-t pattern (matches the letter t, not tabs)",
    );
  });

  it("names are read PLAIN (tmux escapes their tabs natively; no s/// needed)", () => {
    assert.ok(BOOTSTRAP_WINDOWS_FORMAT.includes("#{window_name}"));
    assert.ok(BOOTSTRAP_WINDOWS_FORMAT.includes("#{session_name}"));
    assert.ok(!BOOTSTRAP_WINDOWS_FORMAT.includes("s/"), "no sanitizer on name fields");
  });
});
