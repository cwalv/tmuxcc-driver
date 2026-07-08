/**
 * tc-gek — Multi-session input latency (driver real-tmux, serial lane).
 *
 * Moved from tmuxcc-vscode/test/e2e/multi-session-latency.flow.ts by tc-1yek.5.
 *
 * Measures driver-level input round-trip latency under N=1 and N=3 concurrent
 * sessions: `controller.sendInput(paneId, "echo MARKER\n")` → wait for "MARKER"
 * in EchoRenderHook output.  Asserts the N=3 per-session median is within
 * N3_BASELINE_MULTIPLIER (2x) of the same run's N=1 baseline, plus a 1000 ms
 * absolute backstop.
 *
 * Serial-lane: must run alone at concurrency=1 (io/cpu contention from a
 * concurrent test would skew the calibration baseline).  Added to
 * test:real-tmux which already runs with --test-concurrency=1.
 *
 * @module runtime/multi-session-latency.test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import { setupE2E } from "./e2e-smoke.test.js";
import type { E2ESession } from "./e2e-smoke.test.js";
import type { PaneId } from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Guard: skip entire suite if tmux absent
// ---------------------------------------------------------------------------

const TMUX_AVAILABLE = (() => {
  try {
    const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
    return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Measurement knobs
// ---------------------------------------------------------------------------

/** Timed echo round-trips per session per phase; the MEDIAN is the assertion unit. */
const REPS_PER_SESSION = 5;

/** Per-rep hard budget (ms); a timed-out rep records this value. */
const REP_BUDGET_MS = 10_000;

/** The loose initial round-trip bound (ms) — asserted at N=1. */
const ROUND_TRIP_BOUND_MS = 200;

/** The N=3 per-session median hard backstop (ms). */
const N3_ROUND_TRIP_BOUND_MS = 1_000;

/** The bead's N=3-vs-baseline multiple. */
const N3_BASELINE_MULTIPLIER = 2;

/** Gate for the "N=3 within N3_BASELINE_MULTIPLIER x of N=1" assertion. */
const ENFORCE_N3_WITHIN_BASELINE_MULTIPLE = true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique per-run tag. */
const RUN_TAG = randomBytes(3).toString("hex");

/** Median of a non-empty list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Poll accumulated EchoRenderHook output for paneId until needle is found.
 * Returns the elapsed milliseconds since `t0`.
 */
function waitForPaneOutput(
  hook: E2ESession["hook"],
  paneId: PaneId,
  needle: string,
  t0: number,
  budgetMs: number,
): Promise<number> {
  const needleBytes = Buffer.from(needle, "utf8");
  return new Promise<number>((resolve, reject) => {
    const deadline = t0 + budgetMs;
    const tick = () => {
      // Accumulate all onPaneOutput bytes for this pane.
      const calls = hook.calls as Array<{ type: string; paneId?: PaneId; bytes?: Uint8Array }>;
      const buf = Buffer.concat(
        calls
          .filter((c) => c.type === "paneOutput" && c.paneId === paneId)
          .map((c) => Buffer.from(c.bytes ?? [])),
      );
      if (buf.includes(needleBytes)) {
        return resolve(Date.now() - t0);
      }
      if (Date.now() >= deadline) {
        return reject(
          new Error(
            `waitForPaneOutput timeout (${budgetMs}ms): needle "${needle}" ` +
              `not found in ${buf.length} bytes`,
          ),
        );
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

interface SessionMeasurement {
  latenciesMs: number[];
  medianMs: number;
  timeouts: number;
}

/**
 * Measure REPS_PER_SESSION echo round-trips on one session.
 * Sends "echo <unique-marker>" and waits for the marker to appear in output.
 */
async function measureRoundTrips(
  label: string,
  session: E2ESession,
): Promise<SessionMeasurement> {
  const { paneId, controller } = session;

  // Warm-up: send a no-op echo and wait for it to complete before timing.
  const warmMarker = `DRVRLT_WARM_${RUN_TAG}_${label}`;
  controller.sendInput(paneId, `echo ${warmMarker}\n`);
  await waitForPaneOutput(session.hook, paneId, warmMarker, Date.now(), 60_000);

  const latenciesMs: number[] = [];
  let timeouts = 0;

  for (let rep = 0; rep < REPS_PER_SESSION; rep++) {
    const repMarker = `DRVRLT_REP_${RUN_TAG}_${label}_r${rep}`;
    const t0 = Date.now();
    controller.sendInput(paneId, `echo ${repMarker}\n`);
    let latency: number;
    try {
      latency = await waitForPaneOutput(session.hook, paneId, repMarker, t0, REP_BUDGET_MS);
    } catch {
      timeouts += 1;
      latency = REP_BUDGET_MS;
    }
    latenciesMs.push(latency);
  }

  return {
    latenciesMs,
    medianMs: median(latenciesMs),
    timeouts,
  };
}

function logMeasurement(phase: string, label: string, m: SessionMeasurement): void {
  console.log(
    `[tc-gek/driver] ${phase} label=${label} reps=[${m.latenciesMs.join(", ")}] ms ` +
      `median=${m.medianMs} ms timeouts=${m.timeouts}`,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const sessions: E2ESession[] = [];

after(async () => {
  for (const s of sessions) {
    await s.teardown().catch(() => { /**/ });
  }
  sessions.length = 0;
});

describe(
  "tc-gek: multi-session input latency (driver real-tmux, serial lane)",
  { skip: !TMUX_AVAILABLE ? "tmux not found on PATH" : false },
  () => {
    it(
      "N=3 per-session median within 2x of the N=1 baseline (driver round-trip)",
      { timeout: 540_000 },
      async () => {
        // ── N=1 calibration ────────────────────────────────────────────────
        const s1 = await setupE2E(`gek-${RUN_TAG}-n1`, { sessionName: `gek${RUN_TAG}n1` });
        sessions.push(s1);

        const n1 = await measureRoundTrips("n1s0", s1);
        logMeasurement("N=1", "n1s0", n1);

        const baselineMedianMs = n1.medianMs;
        const calibrationPassed = n1.timeouts === 0 && n1.medianMs < ROUND_TRIP_BOUND_MS;
        console.log(
          `[tc-gek/driver] N=1 baseline median=${baselineMedianMs} ms ` +
            `(bound ${ROUND_TRIP_BOUND_MS} ms) calibrationPassed=${calibrationPassed}`,
        );

        // ── N=3: open sessions 2 and 3 ──────────────────────────────────────
        const s2 = await setupE2E(`gek-${RUN_TAG}-n2`, { sessionName: `gek${RUN_TAG}n2` });
        sessions.push(s2);
        const s3 = await setupE2E(`gek-${RUN_TAG}-n3`, { sessionName: `gek${RUN_TAG}n3` });
        sessions.push(s3);

        const n3Sessions = [
          { label: "n3s0", session: s1 },
          { label: "n3s1", session: s2 },
          { label: "n3s2", session: s3 },
        ] as const;

        // Measure all three sessions sequentially (serial-lane).
        const results: SessionMeasurement[] = [];
        for (const { label, session } of n3Sessions) {
          const m = await measureRoundTrips(label, session);
          logMeasurement("N=3", label, m);
          results.push(m);
        }

        const medians = results.map((m) => m.medianMs);
        const maxMedian = Math.max(...medians);
        console.log(
          `[tc-gek/driver] N=3 medians=[${medians.join(", ")}] ms max=${maxMedian} ms ` +
            `baseline(N=1)=${baselineMedianMs} ms`,
        );

        // ── Assertions ──────────────────────────────────────────────────────
        assert.equal(n1.timeouts, 0, "[tc-gek/driver] N=1 must have zero timeouts");
        assert.ok(
          n1.medianMs < ROUND_TRIP_BOUND_MS,
          `[tc-gek/driver] N=1 median ${n1.medianMs} ms ≥ bound ${ROUND_TRIP_BOUND_MS} ms`,
        );

        const ratio = maxMedian / baselineMedianMs;
        console.log(
          `[tc-gek/driver] N=3/N=1 ratio: ${ratio.toFixed(1)}x ` +
            `(target ≤ ${N3_BASELINE_MULTIPLIER}x; enforced: ${ENFORCE_N3_WITHIN_BASELINE_MULTIPLE})`,
        );

        if (!calibrationPassed) {
          console.log(
            "[tc-gek/driver] N=1 calibration FAILED — N=3 numbers reported above " +
              "WITHOUT ratio assertion (see bead acceptance).",
          );
          return;
        }

        for (const [i, m] of results.entries()) {
          assert.equal(m.timeouts, 0, `[tc-gek/driver] N=3 session ${i} must have zero timeouts`);
          assert.ok(
            m.medianMs < N3_ROUND_TRIP_BOUND_MS,
            `[tc-gek/driver] N=3 session ${i} median ${m.medianMs} ms ≥ backstop ${N3_ROUND_TRIP_BOUND_MS} ms`,
          );
        }

        if (ENFORCE_N3_WITHIN_BASELINE_MULTIPLE && maxMedian > N3_BASELINE_MULTIPLIER * baselineMedianMs) {
          throw new Error(
            `[tc-gek/driver] worst N=3 median ${maxMedian} ms exceeds ` +
              `${N3_BASELINE_MULTIPLIER}x the N=1 baseline ` +
              `(${baselineMedianMs} ms → allowed ${N3_BASELINE_MULTIPLIER * baselineMedianMs} ms)`,
          );
        }
      },
    );
  },
);
