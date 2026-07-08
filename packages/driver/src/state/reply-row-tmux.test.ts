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

/**
 * Layer-A (real tmux 3.4): pin `#{pane_title}` control-char behavior for BOTH
 * read paths (tc-mysc.2 amendment 4) — the `list-panes` REQUERY format and the
 * `title-watch` SUBSCRIPTION format. Verified live: tmux's title-set path
 * (`screen_set_title`, reached by the shell's OSC-0/2) STRIPS every C0 control
 * byte (TAB, NEWLINE, CR) from the title at the SOURCE, so `#{pane_title}` never
 * emits a raw tab or newline on either path. The requery row therefore cannot
 * shatter, the `%subscription-changed` notification line cannot be split, and —
 * because both paths expand the same control-char-free value — they cannot
 * disagree and churn a spurious `pane.title-changed`.
 */
describe("pane_title Layer-A: control-char policy on both read paths (tc-mysc.2)", { skip: !hasTmux }, () => {
  // A title carrying every framing hazard: TAB (row split), NEWLINE (row +
  // notification-line split), CR. tmux stores the printable remainder "XYZW".
  const HAZARD_OSC = `printf '\\033]2;X\\tY\\nZ\\rW\\007'; sleep 30`;
  const EXPECTED = "XYZW";

  function sleepMs(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  before(() => {
    // A pane that emits the hazardous OSC title once, then idles.
    tmuxBytes(["new-session", "-d", "-s", "titleprobe", "-x", "80", "-y", "24", HAZARD_OSC]);
    // Poll until tmux has processed the OSC and stored the (stripped) title.
    for (let i = 0; i < 50; i++) {
      const t = tmuxText(["list-panes", "-t", "titleprobe", "-F", "#{pane_title}"]).replace(/\n+$/, "");
      if (t === EXPECTED) break;
      sleepMs(100);
    }
  });
  after(() => {
    tmuxBytes(["kill-server"]);
  });

  it("requery path: an OSC title with TAB/NEWLINE/CR parses cleanly, control chars stripped at source", () => {
    // No throw: because tmux strips the control chars, the derived format the
    // driver ships never carries a raw tab/newline in the title column.
    const rows = PANES_ROW.parse(tmuxBytes(["list-panes", "-a", "-F", BOOTSTRAP_PANES_FORMAT]));
    const row = rows.find((r) => r.paneTitle === EXPECTED);
    assert.ok(row, `expected the title-probe pane with the stripped title ${JSON.stringify(EXPECTED)}`);
    assert.ok(
      !/[\t\n\r]/.test(row.paneTitle ?? ""),
      "pane_title carries no raw control byte (tmux stripped it at the title-set path)",
    );
  });

  it("subscription path: %subscription-changed title-watch delivers the same value on ONE clean line", () => {
    // Drive a real control-mode client: subscribe to the exact title-watch
    // format the pipeline ships, then read the initial notification (the pane's
    // current title). Keep stdin open ~3s so the subscription's ~1s timer fires.
    const sub = spawnSync(
      "sh",
      [
        "-c",
        `{ printf '%s\\n' 'refresh-client -B "title-watch:%*:#{pane_title}"'; sleep 3; } | ` +
          `tmux -L ${SOCK} -C attach -t titleprobe 2>&1`,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    const line = (sub.stdout ?? "")
      .split("\n")
      .find((l) => l.includes("subscription-changed title-watch"));
    assert.ok(line, `captured a title-watch notification; got: ${JSON.stringify(sub.stdout)}`);
    // A single intact line ending in the full stripped value proves both that
    // the value is control-char-free AND that no newline split the framing (a
    // leaked newline would truncate the value or split the line).
    assert.ok(
      line.endsWith(`: ${EXPECTED}`),
      `subscription value must be the stripped title on one line: ${JSON.stringify(line)}`,
    );
  });
});
