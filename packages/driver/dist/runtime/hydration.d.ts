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
 *      `capture-pane -t %N -p -e -J -S - -E -`
 *    (`-S -` / `-E -` are tmux's "everything you've retained" sentinels;
 *    `-J` joins soft-wrapped rows into logical lines so xterm.js can reflow
 *    them on resize, and preserves trailing spaces — tc-0ghi.)
 * 2. Route through `pipeline.send` so the correlator slot is registered
 *    atomically with the host write (tc-3si.1).
 * 3. Read the pane's live grid facts in a second `pipeline.send`:
 *      `display-message -p -t %N -F '#{cursor_x},#{cursor_y},#{history_size},#{pane_height}'`
 *    `capture-pane` carries the grid CONTENT but not the cursor cell nor the
 *    scrollback/screen split; `display-message` recovers them (tc-w3ir.2).
 *
 *    **Capture gate: pipeline correlator `%end`, NOT shell-settled.** Each
 *    `pipeline.send` resolves when the correlator receives the matching `%end`
 *    on the control connection; because the control connection is FIFO-ordered,
 *    `%end` confirms the command completed and the grid is consistent at that
 *    moment. "Shell settled" (i.e. the shell finished redrawing after SIGWINCH)
 *    is deliberately NOT waited on — shell redraw is async and unbounded. The
 *    driver captures a coherent tmux-grid snapshot as of `%end`; the shell's
 *    SIGWINCH redraw converges via the live `%output` stream after the client
 *    attaches.
 *
 * 4. On success, build a single `Uint8Array` — the STRUCTURED reconstruction —
 *    containing
 *      `\x1b[H\x1b[2J\x1b[3J`  (cursor home + erase screen + erase scrollback)
 *    followed by the capture body (its single trailing newline dropped, `\n`
 *    translated to `\r\n`), followed by `\x1b[<row>;<col>H` restoring the
 *    cursor to (cursor_y, cursor_x).  Writing the full captured grid
 *    (`history_size` + `pane_height` rows) into a viewport of `pane_height`
 *    rows lands the `history_size` leading rows in xterm's scrollback region
 *    and the screen in the viewport; the cursor escape pins the true cell.
 * 5. Deliver via `transport.sendData(paneId, ...)`.
 *
 * Why structured (tc-w3ir.2 / tc-kyq4.5): a flat byte-stream replay discards
 * the grid's structure — the scrollback/screen boundary and the cursor — and
 * the old `trimTrailingBlankLines` heuristic compensated only for a fresh
 * no-scrollback pane, breaking the has-scrollback short-screen case (scrollback
 * landed IN the viewport, the "orphan"; the cursor landed at the stream end).
 * Reconstructing from tmux's own data reproduces the pane faithfully regardless
 * of screen height, and subsumes the fresh-pane top-anchor case via the cursor
 * restore (no blank-line trimming needed).
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
import type { PaneId } from "@tmuxcc/protocol";
import type { Transport } from "@tmuxcc/protocol";
import type { CommandResult } from "../parser/correlator.js";
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
export declare const CLEAR_AND_SCROLLBACK: Uint8Array;
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
export declare function hydrateTransport(pipeline: HydrationPipeline, transport: Transport, paneIds: Iterable<PaneId>, sentinels?: HydrationSentinels): Promise<void>;
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
export declare function hydratePane(pipeline: HydrationPipeline, transport: Transport, pid: PaneId, sentinels?: HydrationSentinels): Promise<boolean>;
/**
 * tc-295a.11 (W3.3): one-shot pane text capture, returned as a string.
 *
 * Issues `capture-pane -t %N -p -e -S - -E -` (WITHOUT `-J`) and delivers
 * the raw UTF-8 text as a string.  Unlike the hydration replay path, this
 * intentionally omits `-J` so callers receive display rows separated by bare
 * LF `\n` rather than joined logical lines — suitable for text inspection or
 * clipboard extraction where the caller wants to see the raw grid layout.
 * No transport.sendData, no clear escape, no LF→CRLF translation.
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
export declare function captureText(pipeline: HydrationPipeline, pid: PaneId): Promise<{
    ok: true;
    text: string;
} | {
    ok: false;
}>;
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
export declare function lfToCrlf(src: Uint8Array): Uint8Array;
/**
 * tc-w3ir.2: the pane grid facts the structured replay reconstructs from.
 *
 * Read in one `display-message` round-trip ({@link PANE_GRID_FACTS_FORMAT}).
 * `cursorX` / `cursorY` are tmux's 0-based, screen-relative cursor cell;
 * `historySize` is the number of scrollback rows above the screen; `paneHeight`
 * is the screen height in rows.
 */
export interface PaneGridFacts {
    readonly cursorX: number;
    readonly cursorY: number;
    readonly historySize: number;
    readonly paneHeight: number;
}
/**
 * Parse a {@link PANE_GRID_FACTS_FORMAT} reply body into {@link PaneGridFacts}.
 *
 * The body is `#{cursor_x},#{cursor_y},#{history_size},#{pane_height}` expanded —
 * four non-negative integers separated by commas, possibly with surrounding
 * whitespace / a trailing newline.  Returns `null` when the body does not match
 * that shape (e.g. the pane vanished and the reply is empty) so the caller can
 * fall back to delivering the body WITHOUT a cursor restore — best-effort.
 *
 * Robust to a leading blank line (some tmux builds prepend one before `-p`
 * output): takes the first non-empty line.
 *
 * Exported for direct unit testing.
 */
export declare function parsePaneGridFacts(body: Uint8Array): PaneGridFacts | null;
/**
 * Build a cursor-position escape `ESC [ <row> ; <col> H` (CUP) from tmux's
 * 0-based, screen-relative `cursorX` / `cursorY`.
 *
 * CUP is 1-based, so row = `cursorY + 1` and col = `cursorX + 1`.  After the
 * structured replay the screen fills the viewport with its top row at viewport
 * row 1 (the leading `history_size` rows scrolled into scrollback), so the
 * screen-relative `cursorY` maps directly to the absolute viewport row.
 *
 * Exported for direct unit testing.
 */
export declare function cursorPositionEscape(cursorX: number, cursorY: number): Uint8Array;
/**
 * Drop a single trailing LF (`\n`, 0x0a) from a capture body.
 *
 * `capture-pane -E -` terminates EVERY captured row with a bare LF, including
 * the last — so the body always ends with one `\n`.  Delivered verbatim that
 * final newline would scroll the screen up one row (the top screen row falling
 * into scrollback).  Removing exactly one trailing LF leaves the last screen row
 * as the final bytes written; the cursor is then placed explicitly.  Removing
 * only ONE (not a run) preserves the screen's legitimate blank tail, which fills
 * the viewport.  A body with no trailing LF is returned unchanged (same
 * reference).
 *
 * Operates on the RAW capture body (bare LF), BEFORE `lfToCrlf`.  Only the
 * data-plane hydration replay calls this — `captureText` (pane.capture) stays
 * raw.
 *
 * Exported for direct unit testing.
 */
export declare function stripOneTrailingLf(src: Uint8Array): Uint8Array;
//# sourceMappingURL=hydration.d.ts.map