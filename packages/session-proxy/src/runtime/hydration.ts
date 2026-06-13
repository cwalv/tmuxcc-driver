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
  const replay = lfToCrlf(body);
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
