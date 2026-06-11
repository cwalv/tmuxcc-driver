/**
 * tc-3si.8 — Real-tmux topology canary: firehose + concurrent split-pane
 *
 * # Why
 *
 * tc-3si.1 made every command write go through `pipeline.send` (atomic slot
 * register + write via the CommandCorrelator). Before that fix, flow-control
 * pause/continue commands took a slot-less `host.write(cmd)` path. The tmux
 * %end reply to that write could then mis-bind to a concurrent requery's
 * `list-windows`/`list-panes` slot — the engine would parse a pause-ack as a
 * topology snapshot, producing a CORRUPT committed model (panes.size == 0 or
 * windows.size == 0, missing pane that should be present after a split, etc.).
 *
 * Existing real-tmux tests do not catch this:
 *   - flow-load (F1–F6) asserts only gate state, byte counts, output delivery.
 *   - resilience R3 checks panes.size >= 2 but has no firehose, so no
 *     pause/continue command is in flight during the topology window.
 *
 * This canary is the missing intersection: a firehose drives pause/continue
 * traffic AND a split-pane forces a requery cycle, then we assert the
 * COMMITTED topology model is correct.
 *
 * # How
 *
 * Each iteration:
 *   1. Re-engage the firehose (`yes`) and wait for the flow-controller pause.
 *   2. Issue split-pane while pause/continue refresh-client commands and
 *      the split's own request can interleave with the resulting topology
 *      requery.
 *   3. Stop the firehose, drain to drop below low-water (triggers a
 *      `continue` refresh-client command — another command in flight).
 *   4. Wait for the new pane to appear in the COMMITTED model.
 *   5. Assert: every prior pane is still present, the new pane is present,
 *      windows.size >= 1, and the pane-id of every pane is well-formed.
 *
 * Iterating N times widens the race window honestly within one test (each
 * split is an independent interleaving chance). With tc-3si.1's slotted
 * writes the test is deterministic-green; with the slot-less bug
 * re-introduced, at least one of the N iterations corrupts the model.
 *
 * Test wall-clock is kept short (single test, ~6 s typical) so the soak
 * script's 120 s budget can comfortably absorb N runs alongside flow-load
 * and resilience.
 *
 * @module runtime/topology-canary.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { setupE2E } from "./e2e-smoke.test.js";
import type { E2ESession } from "./e2e-smoke.test.js";
import { killTmuxServer } from "./test-tmux-cleanup.js";
import type { PaneId } from "../wire/ids.js";

// ---------------------------------------------------------------------------
// Flow-control defaults (mirror flow-control.ts constants for diagnostics)
// ---------------------------------------------------------------------------

const DEFAULT_HIGH_WATER_BYTES = 262_144; // 256 KiB
const DEFAULT_LOW_WATER_BYTES = 65_536; // 64 KiB

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
  intervalMs = 20,
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

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ===========================================================================
// Suite: real-tmux topology canary
// ===========================================================================

describe(
  "tc-3si.8: topology canary — firehose + concurrent split-pane asserts " +
    "committed model topology (the tc-e3m race)",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {

    // -----------------------------------------------------------------------
    // C1. Firehose-induced flow-control traffic + interleaved split-pane
    //     requeries — each iteration is an independent chance to interleave a
    //     pause/continue refresh-client reply with the split's list-* requery.
    //
    //     Acceptance: at the end of each iteration the COMMITTED model must
    //     contain exactly the expected pane count (previous panes + 1 new
    //     pane), and the new pane's id must be well-formed.
    // -----------------------------------------------------------------------

    it(
      "C1: firehose + N successive splits — committed topology stays correct",
      { timeout: 60_000 },
      async () => {
        const session: E2ESession = await setupE2E("topo-canary");
        after(() => killServer(session.socketName));

        try {
          const { sessionProxy, controller, paneId: pane1Id } = session;
          const fc = sessionProxy.flowController;
          const pipeline = sessionProxy.pipeline;

          // Sanity: start with exactly one pane (1 window).
          const model0 = pipeline.getModel();
          assert.equal(
            model0.panes.size,
            1,
            `must start with 1 pane; got ${model0.panes.size}`,
          );
          assert.ok(
            model0.windows.size >= 1,
            `must start with >= 1 window; got ${model0.windows.size}`,
          );

          // Snapshot the initial pane set for cross-iteration invariants.
          const seenPaneIds = new Set<string>([pane1Id as string]);

          // Number of split iterations.  Each iteration is an independent
          // chance to interleave a flow-control reply with the requery's
          // list-* reply.  5 iterations keeps the test under ~6 s on a
          // lightly-loaded machine.
          const ITERATIONS = 5;

          // The pane we send the firehose to — always pane1, because subsequent
          // splits create new panes whose shell prompts may not be ready
          // immediately for arbitrary input.
          const firehosePaneId = pane1Id;

          for (let i = 1; i <= ITERATIONS; i++) {
            const expectedPaneCount = 1 + i;

            // Step 1: Re-engage the firehose to trigger a pause command.
            //   - Drain anything stale from the prior iteration first.
            const staleBuffered = fc.bufferedBytes(firehosePaneId);
            if (staleBuffered > 0) {
              fc.noteDrained(firehosePaneId, staleBuffered);
            }

            // Send the firehose start.  `yes` produces ~"y\n" continuously.
            controller.sendInput(firehosePaneId, "yes\n");

            // Wait for pause (high-water crossed).  This proves the
            // refresh-client -A pause command has been issued by the flow
            // controller.
            await waitFor(
              () => (fc.isPanePaused(firehosePaneId) ? true : undefined),
              15_000,
              `iter ${i}: pane never paused; ` +
                `bufferedBytes=${fc.bufferedBytes(firehosePaneId)} ` +
                `highWater=${DEFAULT_HIGH_WATER_BYTES}`,
            );

            // Step 2: Issue the split-pane command WHILE the firehose is
            //   actively pumping bytes (the pause has gated the demux but
            //   tmux may still be emitting %output for in-flight chunks,
            //   and subsequent drains will cause continue commands to be
            //   issued — both pause and continue %end replies are at risk of
            //   mis-binding to the upcoming list-* requery slots).
            controller.sendCommand({
              kind: "split-pane",
              paneId: pane1Id,
              direction: i % 2 === 0 ? "vertical" : "horizontal",
            });

            // Step 3: Stop the firehose with Ctrl-C and drain — this issues
            //   the continue refresh-client command, adding more in-flight
            //   slot traffic that overlaps with the topology requery.
            controller.sendInput(firehosePaneId, "\x03");

            // Small delay so tmux can process Ctrl-C, then drain — this puts
            // the continue refresh-client write right next to the split's
            // requery list-* commands in the FIFO.  No artificial sleep in
            // production code paths; this is test-side pacing.
            await delay(20);
            const buffered = fc.bufferedBytes(firehosePaneId);
            if (buffered > 0) {
              fc.noteDrained(firehosePaneId, buffered);
            }

            // Step 4: Wait for the committed model to reflect the new pane
            // count.  We poll the pipeline's model directly — this is the
            // authoritative committed topology that downstream consumers see.
            await waitFor(
              () => {
                const m = pipeline.getModel();
                return m.panes.size >= expectedPaneCount ? true : undefined;
              },
              15_000,
              `iter ${i}: committed model panes.size never reached ` +
                `${expectedPaneCount}; ` +
                `current=${pipeline.getModel().panes.size}`,
            );

            // Step 5: Topology assertions on the COMMITTED model.
            const modelI = pipeline.getModel();

            // (a) Pane count matches expectation exactly (no extras, no losses).
            assert.equal(
              modelI.panes.size,
              expectedPaneCount,
              `iter ${i}: committed panes.size must equal ${expectedPaneCount}; ` +
                `got ${modelI.panes.size}. Model panes: ` +
                `${[...modelI.panes.keys()].join(",")}`,
            );

            // (b) At least one window present (split-pane never reduces this).
            assert.ok(
              modelI.windows.size >= 1,
              `iter ${i}: committed windows.size must be >= 1; ` +
                `got ${modelI.windows.size}`,
            );

            // (c) Every previously-seen pane is still present (no spurious
            //     drops from a corrupted requery snapshot).
            for (const prevPid of seenPaneIds) {
              assert.ok(
                modelI.panes.has(prevPid as PaneId),
                `iter ${i}: previously-seen pane ${prevPid} missing from ` +
                  `committed model; current panes: ` +
                  `${[...modelI.panes.keys()].join(",")}`,
              );
            }

            // (d) Every committed pane id is well-formed ("p<N>"). A
            //     mis-bound list-panes reply would yield garbage parsed
            //     records (empty/garbled ids).
            for (const pid of modelI.panes.keys()) {
              assert.match(
                pid as string,
                /^p\d+$/,
                `iter ${i}: committed pane id "${pid as string}" must be ` +
                  `"p<N>"; mis-shape suggests a corrupted requery snapshot`,
              );
            }

            // (e) Each window must reference a pane that exists in the
            //     model.  A topology snapshot built from misaligned bytes
            //     can produce windows referencing dropped/unknown panes.
            for (const win of modelI.windows.values()) {
              for (const pid of win.paneIds) {
                assert.ok(
                  modelI.panes.has(pid as PaneId),
                  `iter ${i}: window ${win.windowId as string} references ` +
                    `pane ${pid as string} that is NOT in the committed ` +
                    `panes map — topology snapshot corruption`,
                );
              }
            }

            // Add the new pane(s) to the running seen-set for the next
            // iteration's invariant checks.
            for (const pid of modelI.panes.keys()) {
              seenPaneIds.add(pid as string);
            }
          }

          // Final sanity check on the assembled topology.
          const finalModel = pipeline.getModel();
          assert.equal(
            finalModel.panes.size,
            1 + ITERATIONS,
            `final committed panes.size must equal ${1 + ITERATIONS}; ` +
              `got ${finalModel.panes.size}`,
          );

          // Drain residue so teardown is clean.
          const residue = fc.bufferedBytes(firehosePaneId);
          if (residue > 0) {
            fc.noteDrained(firehosePaneId, residue);
          }
        } finally {
          await session.teardown();
        }
      },
    );
  },
);

// Reference unused defaults so dead-code lint doesn't trip if we ever drop
// the diagnostic strings above.
void DEFAULT_LOW_WATER_BYTES;
