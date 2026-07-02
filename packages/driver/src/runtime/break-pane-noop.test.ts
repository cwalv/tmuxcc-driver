/**
 * tc-0c30.20 — Real-tmux break-pane EMPTY `-P` body NO-OP regression.
 *
 * # The bug
 *
 * `break-pane -d -P -F '#{pane_id} #{window_id}' -s %N` on a pane that is
 * ALREADY the sole pane in its own window is a tmux NO-OP: there is nothing to
 * break out, so tmux replies `%end` (SUCCESS) with an EMPTY `-P` body — no
 * `#{pane_id} #{window_id}` line is printed (verified against tmux 3.4: 15/15).
 *
 * The driver's `runCreatingVerb` previously ran `parseEffectIds("")` → null and
 * mis-classified that empty success body as `verb.no-effect-ids` ("succeeded but
 * its -P -F effect-id reply was unparseable: \"\""). On the auto-promotion path
 * (terminal-factory `_runPromotionCheck`) that surfaced a spurious
 * `tmuxcc: auto-promotion failed — …` error notification, intermittently
 * reddening the reuse-random-walk gate (tc-0c30.7).
 *
 * The race: the geometric promotion check picks an outlier pane from the
 * coalesced-lag client model; by the time `break-pane` reaches tmux the sibling
 * has exited (typeExit / externalKillPane) or a prior promotion already re-homed
 * it, so the pane is alone — the promotion goal is already met.
 *
 * # What this asserts (the regression oracle)
 *
 * Standing up a REAL tmux session-proxy, split a pane to get 2 panes in one
 * window, KILL the sibling so the survivor is the sole pane in its window, then
 * issue `break-pane` on that survivor through the production input-path. tmux
 * replies `%end` with an empty `-P` body, and the driver must resolve the verb
 * `ok: true` carrying the pane's CURRENT ids (idempotent no-op) — NOT a
 * `verb.no-effect-ids` failure.
 *
 * This makes the empty-body race DETERMINISTIC at the driver level (the
 * already-sole-pane state is set up explicitly rather than waited-for under
 * model lag), so the regression is caught without depending on e2e timing.
 *
 * @module runtime/break-pane-noop.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { setupE2E } from "./e2e-smoke.test.js";
import type { E2ESession } from "./e2e-smoke.test.js";
import { killTmuxServer } from "./test-tmux-cleanup.js";
import type { PaneId } from "@tmuxcc/protocol";
import type { VerbResult } from "./input-path.js";
import type { ClientMessage } from "@tmuxcc/protocol";

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

describe(
  "tc-0c30.20: break-pane on an already-sole pane is an idempotent no-op (real tmux)",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {
    it(
      "break-pane survivor-of-killed-strip → ok=true with the pane's current ids, NOT verb.no-effect-ids",
      { timeout: 60_000 },
      async () => {
        const session: E2ESession = await setupE2E("break-noop");
        after(() => killTmuxServer(session.socketName));

        try {
          const { controller, paneId: pane1Id } = session;
          const pipeline = session.sessionProxy.pipeline;

          // ── 1. Split so the window has 2 panes ────────────────────────────
          controller.sendCommand({
            kind: "split-pane",
            paneId: pane1Id,
            direction: "horizontal",
          });
          await waitFor(
            () => (pipeline.getModel().panes.size >= 2 ? true : undefined),
            15_000,
            "split-pane did not produce a second committed pane",
          );

          const splitModel = pipeline.getModel();
          assert.equal(splitModel.panes.size, 2, "must have exactly 2 panes after split");
          const siblingId = [...splitModel.panes.keys()].find(
            (p) => p !== (pane1Id as string),
          ) as PaneId;
          assert.ok(siblingId !== undefined, "must find the split-created sibling");
          const window0Id = splitModel.panes.get(pane1Id)!.windowId;

          // ── 2. Kill the sibling so pane1 is the SOLE pane in its window ────
          // This is the deterministic stand-in for the random-walk's
          // typeExit / externalKillPane that leaves the promotion outlier alone
          // by the time break-pane lands.
          controller.sendCommand({ kind: "close-pane", paneId: siblingId });
          await waitFor(
            () => {
              const m = pipeline.getModel();
              if (m.panes.has(siblingId)) return undefined;
              // pane1 must now be the only pane in window0.
              const inWin0 = [...m.panes.values()].filter(
                (p) => p.windowId === window0Id,
              );
              return inWin0.length === 1 && m.panes.has(pane1Id) ? true : undefined;
            },
            15_000,
            "sibling kill did not leave pane1 as the sole pane in its window",
          );

          // ── 3. break-pane on the now-sole pane through the production path ─
          // tmux replies %end with an EMPTY -P body (nothing to break out). The
          // driver must treat that as an idempotent no-op success.
          const result = await new Promise<VerbResult>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("break-pane verb did not respond within 15s")),
              15_000,
            );
            const msg: ClientMessage = {
              type: "command.request",
              seq: 1,
              correlationId: "noop-1",
              command: { kind: "break-pane", paneId: pane1Id },
            };
            session.sessionProxy.inputPath.handleClientMessage(msg, (_cid, r) => {
              clearTimeout(timer);
              resolve(r);
            });
          });

          // ── 4. Oracle: ok=true (idempotent no-op), NOT a fail-loud refusal ─
          assert.equal(
            result.ok,
            true,
            `break-pane on an already-sole pane must resolve ok=true (idempotent ` +
              `no-op); got ${JSON.stringify(result)}`,
          );
          if (result.ok) {
            // The pane keeps its id and its current window — no NEW window.
            assert.equal(
              result.newPaneId,
              pane1Id,
              "no-op must return the source pane's own id",
            );
            assert.equal(
              result.newWindowId,
              window0Id,
              "no-op must return the pane's CURRENT window (it did not move)",
            );
          }
        } finally {
          await session.teardown();
        }
      },
    );
  },
);
