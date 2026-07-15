/**
 * Driver-owned manual-window lifecycle ledger (tc-x9bj).
 *
 * Tracks which windows currently have `window-size manual` set by the
 * `resize-managed-window` path, and issues the idempotent reset
 * (`set-window-option -u window-size`) when a pane is removed or moved out
 * of a marked window, or when a window is closed.
 *
 * The client's `release-managed-window` wire command is deleted (pre-alpha);
 * the driver now owns the entire manual lifecycle, independent of
 * size-ownership.ts (ownership policy is a separate concern — out of scope).
 *
 * # Lifecycle
 *
 *   1. `markManual(windowId)` — called after a `resize-managed-window` batch
 *      is sent. The window is now under `window-size manual` in tmux.
 *
 *   2. `onModelChange(next, prev)` — called from the session-proxy's model
 *      change subscription. For each marked window:
 *      - Window gone from model → drop the mark (tmux already cleaned up).
 *      - Pane count decreased (pane died or moved out via break-pane) →
 *        send `set-window-option -u window-size` and clear the mark.
 *
 *   3. `bootstrapSweep(model)` — called once on the first model change
 *      (initial snapshot). Sends the idempotent reset to EVERY window with
 *      ≤1 pane in the snapshot, un-freezing any window left in `manual` by a
 *      prior proxy crash or an unsplit that raced a restart.
 *
 * # Transient: 3→2 strip shrink
 *
 * When a 3-pane strip loses one pane (still 2 panes), pane count drops from
 * 3 → 2, triggering a release here. The client's next managed evaluation
 * re-enters manual (~50-100ms later, on the same `notePaneDims` edge).
 * The confirm-then-trust path tolerates this transient; the strip
 * re-converges to the correct geometry after the re-entry.
 *
 * @module runtime/manual-window-ledger
 */

import type { WindowId } from "@tmuxcc/protocol";
import type { SessionModel } from "../state/model.js";
import { setWindowSizeDefault } from "../parser/commands.js";
import { defaultWindowIdToTmux } from "./input-path.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ManualWindowLedger {
  /**
   * Mark a window as having `window-size manual` set.
   * Called after a `resize-managed-window` batch is dispatched.
   */
  markManual(windowId: WindowId): void;

  /**
   * React to a model change. For each marked window, release the manual lock
   * if a pane was removed or moved out (pane count decreased) or the window
   * was closed.
   */
  onModelChange(next: SessionModel, prev: SessionModel): void;

  /**
   * Bootstrap sweep: send the idempotent `set -u window-size` reset to every
   * window in `model` that has ≤1 pane. Covers windows stranded in `manual`
   * by a prior proxy crash or an unsplit-race that outlived a restart.
   */
  bootstrapSweep(model: SessionModel): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ManualWindowLedger.
 *
 * @param send - Fire-and-forget command write (typically `() => pipeline.send(cmd)`).
 *               The ledger sends at most one `set-window-option -u window-size`
 *               command per window per release event; the command is idempotent
 *               in tmux (safe to send even when the window was not manual).
 */
export function createManualWindowLedger(
  send: (cmd: string) => void,
): ManualWindowLedger {
  const _marked = new Set<WindowId>();

  function release(windowId: WindowId): void {
    send(setWindowSizeDefault(defaultWindowIdToTmux(windowId)));
    _marked.delete(windowId);
  }

  return {
    markManual(windowId) {
      _marked.add(windowId);
    },

    onModelChange(next, prev) {
      for (const wid of Array.from(_marked)) {
        const nextWin = next.windows.get(wid);
        if (nextWin === undefined) {
          // Window closed — drop the mark. tmux already cleaned up the window;
          // there is nothing to reset.
          _marked.delete(wid);
          continue;
        }
        const prevWin = prev.windows.get(wid);
        if (prevWin === undefined) continue; // window just appeared — no prior count to compare.
        if (nextWin.paneIds.length < prevWin.paneIds.length) {
          // A pane was removed (kill-pane / close-pane) or moved out
          // (break-pane re-homes the pane to a new window). Release the
          // `window-size manual` override so the surviving pane(s) can
          // resume auto-tracking their tmux client dimensions.
          release(wid);
        }
      }
    },

    bootstrapSweep(model) {
      for (const [wid, win] of model.windows) {
        if (win.paneIds.length <= 1) {
          // A window with ≤1 pane is invariantly never manual under normal
          // operation; if it is, it was stranded by a prior crash. Send the
          // idempotent reset — tmux no-ops it if the window is already in
          // the default policy.
          send(setWindowSizeDefault(defaultWindowIdToTmux(wid)));
        }
      }
    },
  };
}
