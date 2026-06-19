/**
 * tc-4gor — Real-tmux break-pane re-home regression
 *
 * # Why
 *
 * A detached `break-pane -d -s %N` re-homes a pane into a brand-new window in
 * tmux (the source of truth), but the session-proxy topology PROJECTION did not
 * re-home the pane in the committed model: the new window materialised EMPTY
 * while the broken-out pane stayed listed under its old window. Stable-wrong,
 * not a timing lag (the tc-6dof Layer-B harness verified the divergence held
 * for 25 s). This bug was masked for the whole life of the break-pane verb by
 * the earlier `-t %N` (should be `-s %N`) builder bug (tc-6dof, driver commit
 * 031d46c) which silently no-op'd every break-pane, so the post-break reconcile
 * for a DETACHED break-pane had never been exercised live.
 *
 * # tmux's notification shape for `break-pane -d` (control-mode capture, 3.4)
 *
 *   %layout-change @0 <new-layout-of-OLD-window>   ← old window reflows
 *   %window-add @1                                 ← new window appears
 *   (NO %layout-change @1 for the new window)
 *
 * `%window-add` is a topology dirty bit → the coalescer fires a requery whose
 * `list-windows`/`list-panes` BOTH already report the re-home (verified against
 * tmux 3.4: `list-panes -s -t $0` shows `%1 @1` immediately after the break).
 * So the COMMITTED model must end with the broken-out pane in the NEW window
 * and absent from the OLD window.
 *
 * # What this asserts (the regression oracle)
 *
 *   1. tmux source of truth: the broken-out pane lives in a DISTINCT window.
 *   2. session-proxy committed model: the same pane's `windowId` is the NEW
 *      window, the NEW window is non-empty, and the OLD window no longer
 *      references the pane.
 *
 * @module runtime/break-pane-rehome.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { setupE2E } from "./e2e-smoke.test.js";
import type { E2ESession } from "./e2e-smoke.test.js";
import { killTmuxServer } from "./test-tmux-cleanup.js";
import type { PaneId, WindowId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Guard: skip entire suite if tmux absent
// ---------------------------------------------------------------------------

const tmuxAvailable = (() => {
  try {
    const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function killServer(sock: string): void {
  killTmuxServer(sock);
}

function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  msg: string,
  intervalMs = 25,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() > deadline) {
        return reject(new Error(`waitFor timeout (${timeoutMs}ms): ${msg}`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// ===========================================================================
// Suite: real-tmux break-pane re-home
// ===========================================================================

describe(
  "tc-4gor: detached break-pane re-homes the pane in the committed projection",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {
    it(
      "B1: break-pane -d -s %N — committed model moves the pane into the new (non-empty) window, old window drops it",
      { timeout: 60_000 },
      async () => {
        const session: E2ESession = await setupE2E("break-rehome");
        after(() => killServer(session.socketName));

        try {
          const { controller, paneId: pane1Id, hook } = session;
          const pipeline = session.sessionProxy.pipeline;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hookCalls = hook.calls as Array<{ type: string; paneId?: string; windowId?: string }>;

          // ── 1. Build a 2-pane single-window strip (split-pane) ─────────────
          const model0 = pipeline.getModel();
          assert.equal(
            model0.panes.size,
            1,
            `must start with 1 pane; got ${model0.panes.size}`,
          );
          const window0Id = pipeline.getModel().panes.get(pane1Id)!.windowId;

          controller.sendCommand({
            kind: "split-pane",
            paneId: pane1Id,
            direction: "horizontal",
          });

          // Wait for the second pane to commit, both in the SAME window.
          await waitFor(
            () => {
              const m = pipeline.getModel();
              return m.panes.size >= 2 ? true : undefined;
            },
            15_000,
            "split-pane did not produce a second committed pane",
          );

          const splitModel = pipeline.getModel();
          assert.equal(splitModel.panes.size, 2, "must have exactly 2 panes after split");
          // The pane we will break out is the OTHER one (not pane1).
          const breakPaneId = [...splitModel.panes.keys()].find(
            (p) => p !== (pane1Id as string),
          ) as PaneId;
          assert.ok(breakPaneId !== undefined, "must find the split-created pane");

          // Both panes must be in the same starting window.
          assert.equal(
            splitModel.panes.get(breakPaneId)!.windowId,
            window0Id,
            "split pane must start in the original window",
          );
          assert.equal(splitModel.windows.size, 1, "must start with exactly 1 window");

          // ── 2. Detached break-pane: the pane breaks out to its own window ──
          controller.sendCommand({ kind: "break-pane", paneId: breakPaneId });

          // ── 3. Oracle: the COMMITTED model re-homes the pane ───────────────
          //
          // After the break, tmux reports the pane in a brand-new window. The
          // committed projection must converge to: a second window exists, the
          // broken-out pane's windowId is that new window, the new window's
          // paneIds includes it, and the old window NO LONGER references it.
          await waitFor(
            () => {
              const m = pipeline.getModel();
              if (m.windows.size < 2) return undefined;
              const pane = m.panes.get(breakPaneId);
              if (pane === undefined) return undefined;
              // The pane must have left the original window.
              if (pane.windowId === window0Id) return undefined;
              const newWin = m.windows.get(pane.windowId);
              if (newWin === undefined) return undefined;
              if (!newWin.paneIds.includes(breakPaneId)) return undefined;
              return true;
            },
            20_000,
            "committed model never re-homed the broken-out pane into the new window " +
              "(tc-4gor: projection kept the pane in its old window / new window empty)",
          );

          const finalModel = pipeline.getModel();
          const brokenPane = finalModel.panes.get(breakPaneId)!;
          const newWindowId: WindowId = brokenPane.windowId;

          // (a) Two distinct windows now.
          assert.equal(finalModel.windows.size, 2, "must have exactly 2 windows after break");
          assert.notEqual(
            newWindowId,
            window0Id,
            "broken-out pane must live in a DIFFERENT window than the original",
          );

          // (b) The broken-out pane is a member of the NEW window (non-empty).
          const newWindow = finalModel.windows.get(newWindowId)!;
          assert.ok(
            newWindow.paneIds.includes(breakPaneId),
            `new window ${newWindowId} must list the broken-out pane ${breakPaneId}; ` +
              `got paneIds=[${newWindow.paneIds.join(",")}]`,
          );
          assert.equal(
            newWindow.paneIds.length,
            1,
            `new window must contain exactly the one broken-out pane; ` +
              `got [${newWindow.paneIds.join(",")}]`,
          );

          // (c) The OLD window no longer references the broken-out pane.
          const oldWindow = finalModel.windows.get(window0Id)!;
          assert.ok(
            !oldWindow.paneIds.includes(breakPaneId),
            `old window ${window0Id} must NOT still list the broken-out pane ` +
              `${breakPaneId}; got paneIds=[${oldWindow.paneIds.join(",")}]`,
          );
          assert.ok(
            oldWindow.paneIds.includes(pane1Id as string),
            `old window ${window0Id} must still contain the host pane ${pane1Id}`,
          );

          // (d) Every window references only panes that exist (model invariant).
          for (const win of finalModel.windows.values()) {
            for (const pid of win.paneIds) {
              assert.ok(
                finalModel.panes.has(pid),
                `window ${win.windowId} references missing pane ${pid}`,
              );
            }
          }

          // (d2) CLIENT-SIDE oracle (the actual bug locus): the wire delta path
          // must have carried the re-home to the client. The driver model
          // re-homed even before tc-4gor (it rebuilds from list-panes), but the
          // WIRE emitted no re-home delta, so the Mirror / VS Code side-tree kept
          // the pane under its old window. Assert the EchoRenderHook (driven by
          // the Mirror's delta diff) received an onPaneMoved for the broken pane
          // into the new window — proving projection → wire → Mirror end-to-end.
          await waitFor(
            () =>
              hookCalls.some(
                (c) =>
                  c.type === "paneMoved" &&
                  c.paneId === (breakPaneId as string) &&
                  c.windowId === (newWindowId as string),
              )
                ? true
                : undefined,
            10_000,
            `client render-hook never received onPaneMoved(${breakPaneId} → ${newWindowId}) ` +
              `— the pane.moved wire delta did not re-home the client (tc-4gor regression)`,
          );
          // The re-home must be carried as a MOVE, not a recreate: no pane.closed
          // for the broken pane (that would discard the client's scrollback and
          // dispose its terminal tab). This is the wire-level guarantee that the
          // pane keeps its identity across a break-pane.
          assert.ok(
            !hookCalls.some(
              (c) => c.type === "paneClosed" && c.paneId === (breakPaneId as string),
            ),
            `break-pane must NOT emit pane.closed for the re-homed pane ${breakPaneId} ` +
              `(it would discard the client's scrollback) — re-home must be a move, not a recreate`,
          );

          // (e) Cross-check against the tmux source of truth.
          const lp = spawnSync(
            "tmux",
            ["-L", session.socketName, "list-panes", "-a", "-F", "#{pane_id} #{window_id}"],
            { encoding: "utf8", timeout: 5000 },
          );
          assert.equal(lp.status, 0, "tmux list-panes -a must succeed");
          // breakPaneId "pN" → tmux "%N".
          const tmuxBrokenPaneSigil = "%" + (breakPaneId as string).slice(1);
          const brokenRow = lp.stdout
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith(tmuxBrokenPaneSigil + " "));
          assert.ok(
            brokenRow !== undefined,
            `tmux must still list the broken-out pane ${tmuxBrokenPaneSigil}; got:\n${lp.stdout}`,
          );
          // newWindowId "wN" → tmux "@N".
          const tmuxNewWindowSigil = "@" + (newWindowId as string).slice(1);
          assert.equal(
            brokenRow!.split(/\s+/)[1],
            tmuxNewWindowSigil,
            `tmux source of truth must agree the broken-out pane is in window ` +
              `${tmuxNewWindowSigil}; row was "${brokenRow}"`,
          );
        } finally {
          await session.teardown();
        }
      },
    );
  },
);
