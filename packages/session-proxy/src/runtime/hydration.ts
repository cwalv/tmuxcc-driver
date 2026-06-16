/**
 * tc-5quo: clear-then-replay hydration.
 *
 * Unified hydration contract for ALL client bind paths (first attach, warm
 * rebind, reconnect): on every `addClient`, after the snapshot is sent and
 * the demux is attached, replay each known pane's tmux scrollback into the
 * freshly-attached transport so the client's terminal buffer ends up
 * identical to tmux's view (bounded by the pane's `history-limit`).
 *
 * Before this module, the recapture-on-bind contract referenced in
 * output-demux's prose was implemented only for the pre-topology staging
 * buffer (bytes that arrived for unknown panes).  A warm-rebind / reconnect
 * goes through `addClient` against an already-bound pane, skipping that
 * flush, and the disconnection gap's output was silently absent from the
 * client.  This module is the single chokepoint that fixes that for every
 * bind path: the per-transport hydration runs once per attach.
 *
 * # Sequence (per pane)
 *
 * 1. Build the canonical full-history command:
 *      `capture-pane -t %N -p -e -S - -E -`
 *    (`-S -` / `-E -` are tmux's "everything you've retained" sentinels.)
 * 2. Route through `pipeline.send` so the correlator slot is registered
 *    atomically with the host write (tc-3si.1).
 * 3. On success, build a single `Uint8Array` containing
 *      `\x1b[H\x1b[2J\x1b[3J`  (cursor home + erase screen + erase scrollback)
 *    followed by the capture body with `\n` translated to `\r\n` (tmux
 *    capture-pane uses bare LF; xterm-style terminals expect CRLF).
 * 4. Deliver via `transport.sendData(paneId, ...)`.
 *
 * # Race trade-off
 *
 * Live `%output` for the same pane may interleave with the capture-pane
 * round-trip (~1 RTT to tmux).  The clear escape wipes pre-reply fan-out
 * from this transport; the capture body re-includes any bytes tmux saw
 * before processing the command.  Post-reply bytes are not in the capture
 * body and stream live afterwards.  The worst-case visible artefact is a
 * few duplicated lines at the bottom for panes producing output at the
 * instant of attach — accepted in exchange for a single contract that
 * works for every bind path.
 *
 * # Error handling
 *
 * Per-pane errors are swallowed: a pane that died mid-capture or whose
 * `capture-pane` returns `%error` must not block hydration of sibling
 * panes.  Hydration runs concurrently across panes (`Promise.all`) so
 * total wall time is one RTT, not N RTTs.
 *
 * @module runtime/hydration
 */

import type { PaneId } from "../wire/ids.js";
import type { Transport } from "../wire/transport.js";
import type { CommandResult } from "../parser/correlator.js";
import { capturePane } from "../parser/commands.js";

/**
 * Cursor home + erase entire screen + erase scrollback.
 *
 * Sequence (bytes):
 *   ESC [ H        cursor to row 1 col 1
 *   ESC [ 2 J      erase entire visible region
 *   ESC [ 3 J      erase scrollback buffer (xterm extension; honoured by
 *                  every modern terminal emulator including xterm.js, the
 *                  VS Code terminal renderer)
 *
 * Exported so tests can assert exact byte content on the recording
 * transport.
 */
export const CLEAR_AND_SCROLLBACK: Uint8Array = new Uint8Array([
  0x1b, 0x5b, 0x48,           // ESC [ H
  0x1b, 0x5b, 0x32, 0x4a,     // ESC [ 2 J
  0x1b, 0x5b, 0x33, 0x4a,     // ESC [ 3 J
]);

/**
 * Minimal pipeline shape the hydrator depends on.
 *
 * Kept narrow so this module does not bring the full `RuntimePipeline`
 * symbol graph into test fixtures (and so a future split of `pipeline.ts`
 * does not ripple through here).
 */
export interface HydrationPipeline {
  send(command: string): Promise<CommandResult>;
}

/**
 * tc-295a.9: per-pane hydration sentinels + the no-interleave queue gate.
 *
 * Supplied by `session-proxy.ts` so the hydrator can frame each pane's
 * clear-then-replay data frame with `pane.hydration.begin` / `.end` control
 * messages AND tell the demux to queue live `%output` for that pane during the
 * window (the no-interleave DRIVER guarantee).
 *
 * Ordering per pane (the contract the bead pins):
 *   1. `begin(paneId)`            — emit pane.hydration.begin; start queueing
 *                                   live bytes for this (transport, pane).
 *   2. capture-pane round-trip    — live bytes arriving here are queued.
 *   3. deliver clear+replay frame — via transport.sendData (bypasses the queue).
 *   4. `end(paneId)`              — flush queued live bytes, then emit
 *                                   pane.hydration.end; resume live pass-through.
 *
 * `begin` and `end` are always paired: if the capture fails (pane vanished
 * mid-hydration), `end` still fires to drain the queue and close the window so
 * a transient queue does not strand live bytes.
 */
export interface HydrationSentinels {
  /** Open the hydration window for `paneId` (emit begin + start queueing). */
  begin(paneId: PaneId): void;
  /** Close the window for `paneId` (flush queue + emit end). */
  end(paneId: PaneId): void;
}

/**
 * Hydrate `transport` with clear-then-replay for each pane in `paneIds`.
 *
 * Concurrent across panes; resolves when every pane's round-trip has
 * settled.  Per-pane errors are swallowed (best-effort hydration).
 *
 * @param pipeline   The slotted pipeline (used to send capture-pane).
 * @param transport  The freshly-attached client transport.  Each pane's
 *                   `(clear + capture body)` is delivered via
 *                   `transport.sendData(paneId, ...)`.
 * @param paneIds    The set of panes currently in the model.  The caller
 *                   typically passes `pipeline.getModel().panes.keys()`.
 */
export function hydrateTransport(
  pipeline: HydrationPipeline,
  transport: Transport,
  paneIds: Iterable<PaneId>,
  sentinels?: HydrationSentinels,
): Promise<void> {
  const tasks: Promise<boolean>[] = [];
  for (const pid of paneIds) {
    tasks.push(_hydrateOnePane(pipeline, transport, pid, sentinels));
  }
  return Promise.all(tasks).then(() => undefined);
}

/**
 * tc-295a.8: hydrate a SINGLE pane on `transport`, returning whether the pane
 * was found (capture-pane succeeded). Used by the `pane.attach` request path so
 * the caller can emit `pane.attach.failed{pane.not-found}` when the pane is gone
 * — the fail-loud, named-error contract the bead requires.
 *
 * Wraps the same `_hydrateOnePane` body the bulk path uses, so the sentinel +
 * no-interleave queueing behaviour is identical.
 *
 * @returns `true` if the pane hydrated (clear+replay delivered); `false` if the
 *          pane was not found / capture refused (caller surfaces pane.not-found).
 */
export function hydratePane(
  pipeline: HydrationPipeline,
  transport: Transport,
  pid: PaneId,
  sentinels?: HydrationSentinels,
): Promise<boolean> {
  return _hydrateOnePane(pipeline, transport, pid, sentinels);
}

/**
 * tc-295a.11 (W3.3): one-shot pane text capture, returned as a string.
 *
 * REUSES the same `capturePane` command the hydration path uses
 * (`capture-pane -t %N -p -e -S - -E -`), but delivers the raw UTF-8 text as
 * a string instead of piping it through the clear-then-replay data-plane path.
 * No transport.sendData, no clear escape, no LF→CRLF translation — the caller
 * receives the text exactly as tmux emits it (rows separated by bare LF `\n`).
 *
 * This is the foundation that kills C15's out-of-band `tmux capture-pane`
 * shell-out: instead of forking a tmux client from the extension, the extension
 * can issue a `pane.capture` command.request over the existing wire connection
 * (E3.2 wires the extension switch; this bead adds the driver machinery only).
 *
 * @param pipeline  The slotted pipeline (used to send capture-pane).
 * @param pid       Wire PaneId whose text is requested.
 * @returns         `{ ok: true, text }` — the captured UTF-8 text; or
 *                  `{ ok: false }` — the pane was not found / capture refused.
 *                  Never rejects; the caller is responsible for surfacing
 *                  pane.not-found loudly.
 */
export async function captureText(
  pipeline: HydrationPipeline,
  pid: PaneId,
): Promise<{ ok: true; text: string } | { ok: false }> {
  // PaneId convention (ids.ts): "p" + tmux pane number. Mirror of _hydrateOnePane.
  const s = pid as unknown as string;
  if (s.length < 2 || s.charCodeAt(0) !== 0x70 /* 'p' */) return { ok: false };
  const tmuxN = parseInt(s.slice(1), 10);
  if (!Number.isFinite(tmuxN)) return { ok: false };

  const cmd = capturePane(tmuxN, { escapes: true, startLine: "-", endLine: "-" });
  let result: CommandResult;
  try {
    result = await pipeline.send(cmd);
  } catch {
    // Host dead or pipeline torn down.
    return { ok: false };
  }
  if (!result.ok) {
    // Pane gone or capture-pane refused (e.g. pane closed mid-command).
    return { ok: false };
  }

  // Decode the raw bytes as UTF-8. tmux emits scrollback rows separated by
  // bare LF; the caller receives the text as-is (no LF→CRLF here — that is a
  // rendering concern, not a wire concern).
  const text = new TextDecoder().decode(result.body);
  return { ok: true, text };
}

async function _hydrateOnePane(
  pipeline: HydrationPipeline,
  transport: Transport,
  pid: PaneId,
  sentinels?: HydrationSentinels,
): Promise<boolean> {
  // PaneId convention (ids.ts): "p" + tmux pane number.  Inverse for the
  // capture-pane target.  Defensive: skip any pane whose id does not
  // match — a misformed id is a bug elsewhere, but it must not break
  // hydration of well-formed siblings.
  const s = pid as unknown as string;
  if (s.length < 2 || s.charCodeAt(0) !== 0x70 /* 'p' */) return false;
  const tmuxN = parseInt(s.slice(1), 10);
  if (!Number.isFinite(tmuxN)) return false;

  // tc-295a.9: open the hydration window BEFORE the capture round-trip so live
  // bytes arriving during the ~1 RTT are queued, not interleaved. Paired with
  // the `end` in the finally below so a vanished pane never strands the queue.
  sentinels?.begin(pid);
  try {
    const cmd = capturePane(tmuxN, { escapes: true, startLine: "-", endLine: "-" });
    let result: CommandResult;
    try {
      result = await pipeline.send(cmd);
    } catch {
      // Host dead or pipeline torn down — nothing we can do.  Hydration is
      // best-effort.
      return false;
    }
    if (!result.ok) {
      // Pane gone or capture-pane refused for some reason (e.g. closed mid-
      // hydration).  Skip silently — the live stream will catch up if/when
      // a new pane.opened reaches the client.
      return false;
    }

    return await _deliverReplay(transport, pid, result.body);
  } finally {
    // Always close the window: flush whatever live bytes were queued and emit
    // pane.hydration.end. On a found pane this lands after the clear+replay
    // frame; on a vanished pane it just drains the (usually empty) queue.
    sentinels?.end(pid);
  }
}

async function _deliverReplay(
  transport: Transport,
  pid: PaneId,
  body: Uint8Array,
): Promise<boolean> {
  // tc-pizl.2: drop the empty viewport tail BEFORE the CRLF fixup. `-E -` makes
  // tmux capture the whole pane-height grid down to the bottom visible row, so a
  // FRESH pane (prompt near the top, the rest of the viewport blank) comes back
  // with a pane-height block of trailing blank lines. Replayed verbatim those
  // newlines drive xterm's cursor past the bottom of the viewport, scrolling the
  // prompt up and leaving it bottom-anchored above a full-pane-height block of
  // blanks (the bead's `bufferLines = 50 blanks + prompt-at-bottom`). Trimming
  // the all-blank tail keeps a fresh pane top-anchored; a pane WITH scrollback
  // has real content filling down to the cursor, so it has NO trailing blank
  // lines and is byte-unchanged here (p2's 592-line hydration is untouched).
  const replay = lfToCrlf(trimTrailingBlankLines(body));
  const combined = new Uint8Array(CLEAR_AND_SCROLLBACK.length + replay.length);
  combined.set(CLEAR_AND_SCROLLBACK, 0);
  combined.set(replay, CLEAR_AND_SCROLLBACK.length);
  try {
    const sent = transport.sendData(pid, combined);
    if (sent !== undefined && typeof (sent as Promise<void>).then === "function") {
      await (sent as Promise<void>);
    }
  } catch {
    // Transport closed during hydration — caller will tear down via
    // onClose; nothing to do here.
  }
  // The clear+replay frame was delivered (or the transport closed under us);
  // either way the pane existed and was captured — report success so the
  // attach path does NOT emit pane.not-found.
  return true;
}

/**
 * Translate bare `\n` (0x0a) bytes to `\r\n` (0x0d, 0x0a).
 *
 * `tmux capture-pane` emits scrollback rows joined by single LF; xterm-
 * style terminals expect CRLF for "cursor to column 1 + next row".
 * Without this fixup the replay would render as a left-edge cascade.
 *
 * Bare CRs in the body are preserved (a CR not followed by LF is a valid
 * carriage return in its own right).  A CR-then-LF pair is preserved as
 * CRLF unchanged.
 *
 * Exported for direct unit testing.
 */
export function lfToCrlf(src: Uint8Array): Uint8Array {
  // Count LFs to size the output exactly (no growth-realloc).
  let lfCount = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (b === 0x0a) {
      if (i === 0 || src[i - 1] !== 0x0d) lfCount++;
    }
  }
  if (lfCount === 0) return src;
  const out = new Uint8Array(src.length + lfCount);
  let j = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (b === 0x0a && (i === 0 || src[i - 1] !== 0x0d)) {
      out[j++] = 0x0d;
    }
    out[j++] = b;
  }
  return out;
}

/**
 * tc-pizl.2: strip a trailing run of blank lines from a capture body.
 *
 * # Why
 *
 * `capture-pane -t %N -p -e -S - -E -` captures down to the bottom row of the
 * VISIBLE viewport (`bottom = hsize + sy - 1`, cmd-capture-pane.c), so a fresh
 * pane whose prompt sits near the top returns the prompt followed by a
 * pane-height block of empty viewport rows — one `\n` per blank row.  Delivered
 * verbatim to xterm those newlines push the cursor past the bottom of the
 * viewport and scroll the prompt up, leaving it bottom-anchored under a
 * full-pane-height block of blanks (the artefact this fixes).
 *
 * Stripping the all-blank TAIL keeps a fresh pane top-anchored.  A pane WITH
 * scrollback has real content filling down to the cursor/prompt, so its last
 * captured line is non-blank and the body is returned byte-for-byte unchanged.
 *
 * # Definition of "blank line"
 *
 * Lines are split on bare LF (`\n`, 0x0a) — the separator tmux emits.  A line
 * is blank iff every byte is an ASCII space (0x20) or CR (0x0d), or it is
 * empty.  tmux's `GRID_STRING_TRIM_SPACES` already strips trailing spaces
 * within a row, so blank viewport rows arrive byte-empty; the space/CR
 * tolerance is belt-and-braces.  Only the contiguous trailing run of blank
 * lines is removed — interior and leading blanks (legitimate scrollback) are
 * preserved.  The separator newline BEFORE each stripped blank line is removed
 * with it, so the last surviving line carries NO trailing newline: the cursor
 * lands on the prompt row (where live input echoes), matching tmux's cursor_y.
 *
 * Operates on the RAW capture body (bare LF), BEFORE `lfToCrlf`.  Only the
 * data-plane hydration replay calls this — `captureText` (pane.capture) stays
 * raw and untrimmed.
 *
 * Exported for direct unit testing.
 */
export function trimTrailingBlankLines(src: Uint8Array): Uint8Array {
  // Walk back from the end, skipping over trailing blank lines.  `end` is the
  // exclusive index of the last byte we keep.  We treat the body as a sequence
  // of LF-separated lines; the segment after the final LF is the last line.
  let end = src.length;
  // Scan backwards line-by-line.  For each trailing line, if it is blank
  // (only spaces / CRs, or empty), drop it along with its preceding LF.
  while (end > 0) {
    // Find the start of the current trailing line: the byte after the previous
    // LF (or 0 if none).  lineStart..end is the line's content (no LF).
    let lineStart = end;
    while (lineStart > 0 && src[lineStart - 1] !== 0x0a) {
      lineStart--;
    }
    // Is src[lineStart..end) blank?
    let blank = true;
    for (let k = lineStart; k < end; k++) {
      const b = src[k]!;
      if (b !== 0x20 /* space */ && b !== 0x0d /* CR */) {
        blank = false;
        break;
      }
    }
    if (!blank) break;
    // Blank trailing line: drop it AND the LF that separates it from the line
    // above (if any), so the surviving body does not end with a dangling LF.
    end = lineStart > 0 ? lineStart - 1 : 0;
  }
  if (end === src.length) return src;
  return src.subarray(0, end);
}
