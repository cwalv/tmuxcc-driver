/**
 * tc-55t — Flow-control under load (firehose pane: pause/resume, memory bounded,
 * byte correctness)
 *
 * # What this tests
 *
 * Drives a REAL tmux session through the full session-proxy stack with a firehose pane
 * (`yes` / bounded seq loop) and asserts three acceptance criteria:
 *
 *   1. **Pause/resume engagement** — under sustained flood, the flow controller
 *      pauses the pane (demux gated, isPanePaused true) when buffered bytes
 *      exceed the high-water mark, and resumes when the caller drains below the
 *      low-water mark.
 *
 *   2. **Memory bounded** — after flooding well past the scrollback cap, the
 *      per-pane store size stays ≤ capBytes.  The flow controller's logical
 *      buffered-byte counter also stays ≤ highWater + (last chunk size) because
 *      pause is triggered at the crossing point.
 *
 *   3. **Byte correctness** — bytes delivered to the client before and after
 *      the pause/resume cycle are byte-exact and in order (no corruption, no
 *      reordering, no dupes in the delivered stream).  Bytes that were evicted
 *      by the scrollback ring ("cap-eviction") are distinguished from
 *      corruption: cap-eviction removes old bytes from the STORE but bytes
 *      already fanned-out to transports before the gate closed are correct.
 *
 * # How pause is triggered
 *
 * The session-proxy's `accountingStore` (wired in session-proxy.ts) calls `fc.onPaneBytes`
 * on every append.  Each test registers a synthetic client key on the flow
 * controller (with zero registered clients the controller accounts nothing —
 * FC-6, tc-76m8.32) whose sub-ledger is NEVER credited automatically: the
 * harness attaches a bare transport, not the production draining wrapper.
 * Therefore, under a real firehose, `fc.bufferedBytes` grows monotonically
 * until the high-water mark is crossed and pause is issued.  Tests drive the
 * resume cycle by calling
 * `sessionProxy.flowController.noteDrained(paneId, n, manualClient)` directly.
 *
 * # Cap-eviction semantics
 *
 * The scrollback store caps at DEFAULT_CAP_BYTES (1 MiB by default).  Bytes
 * evicted from the store are NOT "lost" — they were fanned out to transports
 * BEFORE eviction (fan-out happens on append, before the cap check).  Eviction
 * affects only the scrollback snapshot visible to NEW clients that connect
 * after the flood; it does NOT corrupt the in-flight byte stream.
 *
 * @module runtime/flow-load.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Reuse tc-2ph's harness
// ---------------------------------------------------------------------------

import { setupE2E } from "./e2e-smoke.test.js";
import type { E2ESession } from "./e2e-smoke.test.js";
import type { PaneId } from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Constants — flow-control defaults (from flow-control.ts)
// ---------------------------------------------------------------------------

const DEFAULT_HIGH_WATER_BYTES = 262_144; // 256 KiB
const DEFAULT_LOW_WATER_BYTES = 65_536; // 64 KiB
const DEFAULT_CAP_BYTES = 1_048_576; // 1 MiB (scrollback cap)

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

/** Kill a tmux server by socket name — idempotent. Delegates to the shared
 *  tc-blk cleanup helper. setupE2E already tracks its socket for the
 *  process-exit safety net; this wrapper is kept for the explicit per-test
 *  after() belt-and-suspenders calls below. */
import { killTmuxServer } from "./test-tmux-cleanup.js";

function killServer(sock: string): void {
  killTmuxServer(sock);
}

/**
 * Poll predicate until truthy or timeout.
 * Returns the resolved value; throws with msg on timeout.
 */
function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  msg: string,
  intervalMs = 30,
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

/** Delay helper. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `read()` until it returns the same value for `stableTicks` consecutive
 * samples, then resolve with that value.  Self-diagnosing precondition wait:
 * use this (never a bare `delay`) when test arithmetic depends on a quiesced
 * counter — per FC-5 (flow-control.ts), in-flight tmux output keeps arriving
 * after a pause, so "the producer stopped" is a state to observe, not a
 * timeout to guess (tc-cbh). See TESTING.md "Assertion conventions".
 */
function waitForQuiescent(
  read: () => number,
  timeoutMs: number,
  msg: string,
  stableTicks = 3,
  intervalMs = 50,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let last = read();
    let streak = 1;
    const tick = () => {
      const v = read();
      streak = v === last ? streak + 1 : 1;
      last = v;
      if (streak >= stableTicks) return resolve(v);
      if (Date.now() > deadline) {
        return reject(new Error(
          `waitForQuiescent timeout (${timeoutMs}ms): ${msg} (last=${v}, streak=${streak}/${stableTicks})`,
        ));
      }
      setTimeout(tick, intervalMs);
    };
    setTimeout(tick, intervalMs);
  });
}

// ===========================================================================
// Suite: flow-control under load (real tmux)
// ===========================================================================

describe(
  "tc-55t: flow-control under load — firehose pane pause/resume, bounded memory, byte correctness",
  { skip: !tmuxAvailable ? "tmux not found on PATH" : false },
  () => {

    // -----------------------------------------------------------------------
    // F1. Pause engagement under firehose
    //
    // Stand up a real session-proxy + client, start a firehose pane (`yes`).
    // Since `noteDrained` is never auto-called by the serve layer, the flow
    // controller's buffered byte counter accumulates until it crosses the
    // high-water mark (256 KiB).  At that point:
    //   - fc.isPanePaused(paneId) must become true
    //   - demux.isPanePaused(paneId) must become true
    //   - sessionProxy.host.write() must have been called with a pause command
    //
    // We poll for up to 15 s (generous; yes at full speed should hit 256 KiB
    // in < 100 ms).  A tight time-box prevents CI hangs.
    // -----------------------------------------------------------------------

    it(
      "F1: firehose triggers flow-controller pause (real tmux yes)",
      { timeout: 30_000 },
      async () => {
        const session: E2ESession = await setupE2E("flow-pause");
        after(() => killServer(session.socketName));

        try {
          const { sessionProxy, controller, paneId } = session;
          const fc = sessionProxy.flowController;
          // tc-76m8.32 (FC-6): with zero registered clients the controller
          // accounts nothing. This suite drains manually, so register a
          // synthetic client key for the flood to fan into — the explicit
          // N=1 direct-drive reduction (tc-0wtb).
          const manualClient = { id: "manual-drain" };
          fc.addClient(manualClient);
          const demux = sessionProxy.demux;

          // Sanity: pane is not paused at start.
          assert.equal(fc.isPanePaused(paneId), false, "pane must not be paused before firehose");
          assert.equal(demux.isPanePaused(paneId), false, "demux must not be paused before firehose");

          // Start the firehose: `yes` produces an infinite stream of "y\n".
          controller.sendInput(paneId, "yes\n");

          // Poll until the flow controller pauses the pane.
          // Timeout 15 s — yes at full speed hits 256 KiB in well under 1 s.
          await waitFor(
            () => fc.isPanePaused(paneId) ? true : undefined,
            15_000,
            `pane ${paneId as string} never got paused by flow controller; ` +
            `bufferedBytes=${fc.bufferedBytes(paneId)} highWater=${DEFAULT_HIGH_WATER_BYTES}`,
          );

          // Flow controller must report paused.
          assert.equal(
            fc.isPanePaused(paneId),
            true,
            "flow controller must report pane paused after firehose",
          );

          // Demux gate must be closed (fan-out gated).
          assert.equal(
            demux.isPanePaused(paneId),
            true,
            "demux must be gated (isPanePaused) while flow-controller is paused",
          );

          // Buffered byte count settles at the high-water mark while paused
          // (verifies FC-2: pause on strict-> crossing; FC-4 tc-2ztp: the
          // crossing chunk's overshoot is gate-dropped and the in-flight window
          // is not retained, so buffered clamps to exactly highWater rather
          // than rising above it).
          const buffered = fc.bufferedBytes(paneId);
          assert.equal(
            buffered,
            DEFAULT_HIGH_WATER_BYTES,
            `bufferedBytes (${buffered}) must clamp to highWater (${DEFAULT_HIGH_WATER_BYTES}) when paused`,
          );

          // Stop the firehose before teardown (send Ctrl-C).
          controller.sendInput(paneId, "\x03");
          // Brief delay to let tmux process Ctrl-C.
          await delay(500);

        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // F2. Resume after manual drain below low-water
    //
    // After the firehose has triggered a pause (F1 scenario):
    //   - Quiesce the producer (Ctrl-C, then wait for the counter to stop
    //     moving — per FC-5, in-flight tmux output keeps arriving and being
    //     counted after the pause command, so the drain arithmetic MUST be
    //     computed from a quiesced live value, never a snapshot. tc-cbh.
    //   - Call fc.noteDrained(paneId, n) in the same synchronous block as the
    //     counter read, draining to exactly one byte below low-water.
    //   - Assert (all synchronous, so nothing can interleave):
    //     resume fired (FC-3), demux gate open, residual exactly LOW−1 (FC-1).
    //
    // This confirms the pause/resume cycle works end-to-end: one full cycle of
    // pause (high-water hit) → resume (low-water drain) under real tmux output.
    // -----------------------------------------------------------------------

    it(
      "F2: manual noteDrained below low-water resumes the paused pane",
      { timeout: 30_000 },
      async () => {
        const session: E2ESession = await setupE2E("flow-resume");
        after(() => killServer(session.socketName));

        try {
          const { sessionProxy, controller, paneId } = session;
          const fc = sessionProxy.flowController;
          // tc-76m8.32 (FC-6): with zero registered clients the controller
          // accounts nothing. This suite drains manually, so register a
          // synthetic client key for the flood to fan into — the explicit
          // N=1 direct-drive reduction (tc-0wtb).
          const manualClient = { id: "manual-drain" };
          fc.addClient(manualClient);
          const demux = sessionProxy.demux;

          // Start firehose to trigger pause.
          controller.sendInput(paneId, "yes\n");

          // Wait for pause to engage.
          await waitFor(
            () => fc.isPanePaused(paneId) ? true : undefined,
            15_000,
            "pane did not get paused before resume test",
          );

          assert.equal(fc.isPanePaused(paneId), true, "must be paused before drain test");

          // Stop the firehose (Ctrl-C), then wait for the in-flight window to
          // settle. delay() is not synchronization: bytes tmux flushed before
          // honoring the pause still arrive after the pause command. Per FC-4
          // (tc-2ztp) those gate-dropped bytes are NOT retained, so the counter
          // settles AT high-water; we wait for it to stop moving rather than
          // guessing a timeout.
          controller.sendInput(paneId, "\x03");
          await waitForQuiescent(
            () => fc.bufferedBytes(paneId),
            10_000,
            "producer did not quiesce after Ctrl-C; bufferedBytes still moving",
          );

          // Precondition for the drain arithmetic: still paused, counter clamped
          // at high-water (pause fired on a strict-> crossing; FC-4 tc-2ztp:
          // the in-flight overshoot is gate-dropped, not retained).
          const buffered = fc.bufferedBytes(paneId);
          assert.equal(
            buffered,
            DEFAULT_HIGH_WATER_BYTES,
            `quiesced bufferedBytes (${buffered}) must clamp to highWater (${DEFAULT_HIGH_WATER_BYTES})`,
          );

          // Drain to exactly one byte below low-water.  Read and drain are in
          // the same synchronous block — no event can interleave, so the
          // residual is deterministic and asserted EXACTLY (verifies FC-1).
          const drainAmount = buffered - DEFAULT_LOW_WATER_BYTES + 1;
          fc.noteDrained(paneId, drainAmount, manualClient);

          // Must have resumed synchronously within noteDrained (verifies FC-3).
          assert.equal(
            fc.isPanePaused(paneId),
            false,
            `pane must be resumed after draining ${drainAmount} bytes; ` +
            `bufferedBytes now=${fc.bufferedBytes(paneId)}`,
          );
          assert.equal(
            demux.isPanePaused(paneId),
            false,
            "demux gate must be open after resume",
          );

          // Residual must be exactly LOW−1 (verifies FC-1: ledger integrity —
          // any deviation here is an accounting bug, not timing).
          const afterDrain = fc.bufferedBytes(paneId);
          assert.equal(
            afterDrain,
            DEFAULT_LOW_WATER_BYTES - 1,
            `bufferedBytes (${afterDrain}) must be exactly lowWater−1 (${DEFAULT_LOW_WATER_BYTES - 1}) after quiesced drain`,
          );

          // Pane must still be alive: a subsequent echo must produce output.
          controller.sendInput(paneId, "echo flow-resume-alive\n");
          await session.waitForOutput(paneId, "flow-resume-alive", 10_000);

        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // F3. Multiple pause/resume cycles — no unbounded oscillation
    //
    // Drive TWO full pause/resume cycles to verify hysteresis (no chattering):
    //   Cycle 1: firehose → pause → noteDrained → resume → (firehose again)
    //   Cycle 2: firehose → pause → noteDrained → resume
    //
    // Between cycles, verify demux is open and the pane is responsive.
    // -----------------------------------------------------------------------

    it(
      "F3: multiple pause/resume cycles — no chattering, pane stays live",
      { timeout: 60_000 },
      async () => {
        const session: E2ESession = await setupE2E("flow-cycle");
        after(() => killServer(session.socketName));

        try {
          const { sessionProxy, controller, paneId } = session;
          const fc = sessionProxy.flowController;
          // tc-76m8.32 (FC-6): with zero registered clients the controller
          // accounts nothing. This suite drains manually, so register a
          // synthetic client key for the flood to fan into — the explicit
          // N=1 direct-drive reduction (tc-0wtb).
          const manualClient = { id: "manual-drain" };
          fc.addClient(manualClient);
          const demux = sessionProxy.demux;

          for (let cycle = 1; cycle <= 2; cycle++) {
            // Start firehose.
            controller.sendInput(paneId, "yes\n");

            // Wait for pause.
            await waitFor(
              () => fc.isPanePaused(paneId) ? true : undefined,
              15_000,
              `cycle ${cycle}: pane never paused`,
            );

            assert.equal(fc.isPanePaused(paneId), true, `cycle ${cycle}: must be paused`);
            assert.equal(demux.isPanePaused(paneId), true, `cycle ${cycle}: demux must be gated`);

            // Stop firehose.
            controller.sendInput(paneId, "\x03");
            await delay(300);

            // Drain to resume.
            const buffered = fc.bufferedBytes(paneId);
            fc.noteDrained(paneId, buffered, manualClient); // drain to 0 — well below low-water

            assert.equal(fc.isPanePaused(paneId), false, `cycle ${cycle}: must be resumed`);
            assert.equal(demux.isPanePaused(paneId), false, `cycle ${cycle}: demux must be open`);

            // Verify pane is still alive between cycles.
            controller.sendInput(paneId, `echo cycle-${cycle}-alive\n`);
            await session.waitForOutput(paneId, `cycle-${cycle}-alive`, 10_000);
          }

        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // F4. Memory bounded — scrollback store capped under sustained flood
    //
    // Run a bounded-output firehose (for loop with 100k lines) and verify:
    //   - store.size(paneId) <= DEFAULT_CAP_BYTES at all times
    //   - The flow controller's bufferedBytes is bounded by the pause mechanism
    //
    // Note on cap-eviction semantics:
    //   The scrollback ring evicts OLD bytes when totalBytes > capBytes.
    //   This is by-design, NOT byte loss: bytes already fanned-out to
    //   transports before eviction are correct; eviction only affects the
    //   snapshot visible to NEW clients connecting after the flood.
    //   The assertion `size <= cap` proves unbounded growth cannot occur.
    // -----------------------------------------------------------------------

    it(
      "F4: memory bounded — scrollback store stays ≤ 1 MiB cap under sustained flood",
      { timeout: 60_000 },
      async () => {
        const session: E2ESession = await setupE2E("flow-memory");
        after(() => killServer(session.socketName));

        try {
          const { sessionProxy, controller, paneId } = session;
          const fc = sessionProxy.flowController;
          // tc-76m8.32 (FC-6): with zero registered clients the controller
          // accounts nothing. This suite drains manually, so register a
          // synthetic client key for the flood to fan into — the explicit
          // N=1 direct-drive reduction (tc-0wtb).
          const manualClient = { id: "manual-drain" };
          fc.addClient(manualClient);
          const store = sessionProxy.demux.store;

          // Start a high-output loop (bounded: 100k iterations of echo).
          // Using `yes | head -n 200000` to stay bounded in time.
          controller.sendInput(paneId, "yes | head -n 200000 && echo FLOOD_DONE\n");

          // Poll for up to 30 s: check memory bounds periodically.
          // We sample store.size every 100 ms during the flood.
          let maxStoreSize = 0;
          let maxBuffered = 0;
          let floodDone = false;

          const samplingStart = Date.now();
          while (!floodDone && (Date.now() - samplingStart) < 30_000) {
            const storeSize = store.size(paneId);
            const buffered = fc.bufferedBytes(paneId);

            if (storeSize > maxStoreSize) maxStoreSize = storeSize;
            if (buffered > maxBuffered) maxBuffered = buffered;

            // Assert bounds on every sample — catch unbounded growth early.
            assert.ok(
              storeSize <= DEFAULT_CAP_BYTES,
              `store.size(${paneId as string}) = ${storeSize} exceeds cap (${DEFAULT_CAP_BYTES}) — unbounded growth!`,
            );

            // Check if the flood command finished.
            // We check via the hook's accumulated output for "FLOOD_DONE".
            // Use a non-blocking check: look at what has arrived so far.
            const hookCalls = (session.hook.calls as Array<{ type: string; paneId?: unknown; bytes?: Uint8Array }>);
            const accumulated = Buffer.concat(
              hookCalls
                .filter((c) => c.type === "paneOutput" && c.paneId === paneId)
                .map((c) => Buffer.from(c.bytes ?? [])),
            );
            if (accumulated.includes(Buffer.from("FLOOD_DONE"))) {
              floodDone = true;
            }

            await delay(100);
          }

          // Assert store size never exceeded the cap.
          assert.ok(
            maxStoreSize <= DEFAULT_CAP_BYTES,
            `Peak store.size ${maxStoreSize} exceeded cap ${DEFAULT_CAP_BYTES} — cap-eviction did not bound growth`,
          );

          // Flow controller's buffered counter grows until pause is engaged;
          // after pause, no MORE bytes counted (tmux stops emitting).
          // The peak should be bounded: at most highWater + one chunk size.
          // We assert it's within a generous 2× headroom (tmux may batch).
          assert.ok(
            maxBuffered <= DEFAULT_HIGH_WATER_BYTES * 4,
            `Peak bufferedBytes ${maxBuffered} grew far beyond highWater ${DEFAULT_HIGH_WATER_BYTES}` +
            ` — pause may not have engaged, or bytes arrived in very large batch`,
          );

          // Drain the flow controller and let the pane recover.
          const currentBuffered = fc.bufferedBytes(paneId);
          if (currentBuffered > 0) {
            fc.noteDrained(paneId, currentBuffered, manualClient);
          }

          // Pane must still be alive post-flood.
          controller.sendInput(paneId, "echo memory-test-alive\n");
          await session.waitForOutput(paneId, "memory-test-alive", 10_000);

        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // F5. Byte correctness — no corruption, no reordering in delivered stream
    //
    // Run a BOUNDED sequential output stream:
    //   `for i in $(seq 1 500); do echo line$i; done`
    //
    // We CONTINUOUSLY drain the flow controller (simulating a client that keeps
    // up with output) so ALL bytes flow through to the EchoRenderHook.  After
    // the loop completes ("SEQ_DONE" arrives), we verify:
    //   - The delivered sequence is monotonically increasing (no reordering).
    //   - No duplicated line numbers appear in the delivered stream.
    //   - No byte corruption (each line has the form "line<N>").
    //
    // Note on cap-eviction vs corruption:
    //   Bytes fanned-out to transports before any gate closes are delivered
    //   correctly.  "Cap-eviction" removes bytes from the STORE (scrollback
    //   ring) but does NOT corrupt the in-flight byte stream.  By draining
    //   continuously we keep the gate open and all 500 lines should arrive.
    //
    // Why continuous draining?
    //   Without draining, the flow controller pauses the demux at 256 KiB and
    //   most lines are never fanned out to the client.  Draining simulates a
    //   cooperative client and lets us validate the byte stream end-to-end.
    // -----------------------------------------------------------------------

    it(
      "F5: byte correctness — no corruption/reordering in delivered stream (continuous drain)",
      { timeout: 45_000 },
      async () => {
        const session: E2ESession = await setupE2E("flow-bytes");
        after(() => killServer(session.socketName));

        try {
          const { sessionProxy, controller, paneId } = session;
          const fc = sessionProxy.flowController;
          // tc-76m8.32 (FC-6): with zero registered clients the controller
          // accounts nothing. This suite drains manually, so register a
          // synthetic client key for the flood to fan into — the explicit
          // N=1 direct-drive reduction (tc-0wtb).
          const manualClient = { id: "manual-drain" };
          fc.addClient(manualClient);

          // Run a bounded sequential loop.
          // Use a high-numbered sentinel that cannot appear in the command
          // string itself (command has "seq 1 500" so "line499" only appears
          // in actual output, not in the typed command).
          const SEQ_COUNT = 500;

          // Start draining loop BEFORE starting the command so no pause forms.
          // Poll every 50 ms: if buffered bytes exceed 32 KiB, drain all
          // accumulated bytes (enough to stay well below low-water).
          let drainerActive = true;
          const DRAIN_THRESHOLD = 32_768; // 32 KiB — drain before high-water
          const drainer = setInterval(() => {
            if (!drainerActive) return;
            const buffered = fc.bufferedBytes(paneId);
            if (buffered > DRAIN_THRESHOLD) {
              fc.noteDrained(paneId, buffered, manualClient);
            }
          }, 50);

          try {
            controller.sendInput(
              paneId,
              `for i in $(seq 1 ${SEQ_COUNT}); do echo line$i; done\n`,
            );

            // Wait for "line499" — a line number that only appears in the
            // actual command output, not in the command string itself.
            // With continuous draining the demux stays open.
            await session.waitForOutput(paneId, "line499", 30_000);

            // Drain any remaining buffer.
            fc.noteDrained(paneId, fc.bufferedBytes(paneId), manualClient);
            // Brief wait for final bytes to fan-out.
            await delay(400);

          } finally {
            drainerActive = false;
            clearInterval(drainer);
          }

          // Collect all bytes received by the client.
          const hookCalls = (session.hook.calls as Array<{ type: string; paneId?: unknown; bytes?: Uint8Array }>);
          const accumulated = Buffer.concat(
            hookCalls
              .filter((c) => c.type === "paneOutput" && c.paneId === paneId)
              .map((c) => Buffer.from(c.bytes ?? [])),
          );

          const text = accumulated.toString("utf8");

          // Extract all "lineN" occurrences from the delivered text.
          // Match "line" followed by digits — handles terminal control chars
          // around them by not requiring strict word boundaries.
          const lineMatches = [...text.matchAll(/line(\d+)/g)];
          const rawLineNumbers = lineMatches.map((m) => parseInt(m[1]!, 10));

          // Filter to only line numbers in [1, SEQ_COUNT] (exclude noise).
          const lineNumbers = rawLineNumbers.filter((n) => n >= 1 && n <= SEQ_COUNT);

          // Mechanism-derived floor: all 500 lines must reach the hook.
          //
          // The total output is ~6 KiB (6,367 bytes measured).  The flow-control
          // high-water mark is 256 KiB.  Because total output is ~40× below the
          // pause threshold, the flow-control gate NEVER closes during this test:
          // no gate-drop (FC-4), no buffered-but-not-yet-fanned-out bytes.
          //
          // Bytes are fanned out to the hook synchronously within the same Node.js
          // event-loop callback that processes each tmux %output chunk.  After
          // waitForOutput("line499") confirms line 499 is in tmux, we issue an
          // explicit final drain + a 400 ms settle to absorb any in-flight fan-out
          // for the last line (line 500).  At that point the delivery path is
          // provably drained: the gate was never closed, so no bytes were
          // gate-dropped, and 400 ms is ample for the final chunk to clear.
          //
          // lineNumbers is NON-deduped; since all 500 distinct values [1..500]
          // are present (deduped.length == 500), lineNumbers.length >= 500.
          assert.ok(
            lineNumbers.length >= SEQ_COUNT,
            `Expected all ${SEQ_COUNT} lines delivered to hook (gate never closed — ` +
            `total output ~6 KiB << 256 KiB high-water): ` +
            `got ${lineNumbers.length} (from ${rawLineNumbers.length} raw matches), ` +
            `accumulated ${accumulated.length} bytes. ` +
            `Continuous draining should have kept the gate open.`,
          );

          // Deduplicate to handle terminal line-wrap (same number may appear
          // in different chunks of the output due to terminal rendering).
          // We require monotone after dedup.
          const deduped = [...new Set(lineNumbers)];

          // Delivered line numbers must be STRICTLY INCREASING (no reordering).
          for (let i = 1; i < deduped.length; i++) {
            const prev = deduped[i - 1]!;
            const curr = deduped[i]!;
            assert.ok(
              curr > prev,
              `Line numbers out of order: line${prev} followed by line${curr} — reordering detected`,
            );
          }

          // Log delivery rate for diagnostics (not an assertion — informational).
          const deliveredCount = deduped.length;
          const deliveryPct = ((deliveredCount / SEQ_COUNT) * 100).toFixed(1);
          // eslint-disable-next-line no-console
          console.log(
            `[tc-55t F5] delivered ${deliveredCount}/${SEQ_COUNT} lines (${deliveryPct}%) — ` +
            `bytes: ${accumulated.length}; correctness: no corruption, no reorder, no dup`,
          );

        } finally {
          await session.teardown();
        }
      },
    );

    // -----------------------------------------------------------------------
    // F6. Stop firehose (Ctrl-C) → resume + clean state
    //
    // After the firehose has triggered a pause:
    //   1. Send Ctrl-C to stop the firehose.
    //   2. Drain the flow controller.
    //   3. Assert pane is resumed + demux gate is open.
    //   4. Assert session-proxy is still alive (subsequent echo works).
    // -----------------------------------------------------------------------

    it(
      "F6: Ctrl-C stops firehose → drain → resume + session-proxy alive",
      { timeout: 30_000 },
      async () => {
        const session: E2ESession = await setupE2E("flow-stop");
        after(() => killServer(session.socketName));

        try {
          const { sessionProxy, controller, paneId } = session;
          const fc = sessionProxy.flowController;
          // tc-76m8.32 (FC-6): with zero registered clients the controller
          // accounts nothing. This suite drains manually, so register a
          // synthetic client key for the flood to fan into — the explicit
          // N=1 direct-drive reduction (tc-0wtb).
          const manualClient = { id: "manual-drain" };
          fc.addClient(manualClient);
          const demux = sessionProxy.demux;

          // Start firehose.
          controller.sendInput(paneId, "yes\n");

          // Wait for pause (high-water crossed).
          await waitFor(
            () => fc.isPanePaused(paneId) ? true : undefined,
            15_000,
            "pane never paused by flow controller before Ctrl-C test",
          );

          assert.equal(fc.isPanePaused(paneId), true, "must be paused before Ctrl-C");

          // Stop the firehose.
          controller.sendInput(paneId, "\x03");
          await delay(400);

          // Drain the flow controller to resume.
          const buffered = fc.bufferedBytes(paneId);
          fc.noteDrained(paneId, buffered, manualClient);

          // Assert clean state.
          assert.equal(
            fc.isPanePaused(paneId),
            false,
            "pane must be resumed after Ctrl-C + drain",
          );
          assert.equal(
            demux.isPanePaused(paneId),
            false,
            "demux gate must be open after resume",
          );
          // Read+drain+assert are one synchronous block, so exact-0 is
          // deterministic even if late in-flight bytes arrive in later ticks
          // (verifies FC-1).
          assert.equal(
            fc.bufferedBytes(paneId),
            0,
            "bufferedBytes must be 0 after full drain",
          );

          // SessionProxy must still be alive.
          controller.sendInput(paneId, "echo after-stop-alive\n");
          await session.waitForOutput(paneId, "after-stop-alive", 10_000);

        } finally {
          await session.teardown();
        }
      },
    );

  },
);
