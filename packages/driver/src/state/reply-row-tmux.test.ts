/**
 * Layer-A (real tmux 3.4): the schema-derived BOOTSTRAP_*_FORMAT + the
 * user-option TAB sanitizer round-trip through ACTUAL tmux, and the pinned
 * tab/newline emission policy (tc-mysc amendments 2, 3, 4).
 *
 * This is the backstop that a probe-only design would lack: it drives real
 * tmux with the exact derived format the driver ships and parses the reply with
 * the real `PANES_ROW.parse` / `WINDOWS_ROW.parse`, so the sanitizer, the field
 * membership, and the strict-count invariant are validated end-to-end.
 *
 * @module state/reply-row-tmux.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  BOOTSTRAP_PANES_FORMAT,
  BOOTSTRAP_WINDOWS_FORMAT,
  PANES_ROW,
  WINDOWS_ROW,
} from "./bootstrap.js";
import { ReplyShapeError } from "./reply-row.js";

const SOCK = `tmuxcc-test-replyrow-${process.pid}`;

function tmuxBytes(args: string[]): Uint8Array {
  const r = spawnSync("tmux", ["-L", SOCK, ...args], { encoding: "buffer" });
  return r.stdout ?? new Uint8Array(0);
}
function tmuxText(args: string[]): string {
  const r = spawnSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });
  return r.stdout ?? "";
}

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

describe("reply-row Layer-A: real tmux round-trip + sanitizer", { skip: !hasTmux }, () => {
  before(() => {
    tmuxBytes(["new-session", "-d", "-s", "probe", "-x", "80", "-y", "24"]);
  });
  after(() => {
    tmuxBytes(["kill-server"]);
  });

  it("amendment 3: a @tmuxcc_label with a TAB and the letter 't' round-trips tab→space only", () => {
    const pane = tmuxText(["list-panes", "-F", "#{pane_id}"]).trim();
    // A raw tab in a user option is the shipped footgun; the value also carries
    // 't's, which a two-char `\t` pattern would have destroyed.
    tmuxBytes(["set-option", "-p", "-t", pane, "@tmuxcc_label", "ta\tbel_t"]);

    const rows = PANES_ROW.parse(tmuxBytes(["list-panes", "-a", "-F", BOOTSTRAP_PANES_FORMAT]));
    const row = rows.find((r) => r.label !== undefined);
    assert.ok(row, "the labelled pane parsed");
    assert.equal(row.label, "ta bel_t", "tab replaced by a space, every 't' preserved");
  });

  it("amendment 2: a window_name with a TAB does NOT shatter (tmux escapes name tabs)", () => {
    tmuxBytes(["rename-window", "na\tme"]);
    // No throw: names read plain because tmux emits the tab as a 2-char `\t`.
    const rows = WINDOWS_ROW.parse(tmuxBytes(["list-windows", "-F", BOOTSTRAP_WINDOWS_FORMAT]));
    assert.ok(rows.length >= 1);
  });

  it("amendment 4: a NEWLINE in a name shatters the row → ReplyShapeError (bounded-throw)", () => {
    // Verified live: tmux emits an embedded newline RAW. This is the pathological
    // case the strict parser surfaces loudly instead of misparsing.
    tmuxBytes(["new-window", "-n", "a\nb"]);
    assert.throws(
      () => WINDOWS_ROW.parse(tmuxBytes(["list-windows", "-F", BOOTSTRAP_WINDOWS_FORMAT])),
      ReplyShapeError,
    );
  });
});
