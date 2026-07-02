/**
 * Tests for src/state/coalescer.ts (tc-128.2).
 *
 * Coverage of the three acceptance regimes from the bead:
 *   - quiet + 1 event → IMMEDIATE requery (leading edge);
 *   - sustained flood → bounded to the 1 Hz ceiling with no missed final
 *     state (trailing-edge fold);
 *   - heartbeat catches a change injected with zero notifications.
 *
 * Plus regression coverage for:
 *   - per-kind `onNotify` hook fires once per notify, before engine work
 *     (the tc-x6l counter seam);
 *   - steady-state `%error` from list-* does NOT wipe the model and the
 *     coalescer retries on the next ceiling boundary (TL design call);
 *   - `stop()` cancels pending timers;
 *   - observer exceptions never break the pipeline.
 *
 * @module state/coalescer.test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCoalescer } from "./coalescer.js";
import { createRequeryEngine } from "./requery.js";
function makeFakeClock() {
    let _now = 0;
    let _nextId = 1;
    let timers = [];
    const clock = {
        now: () => _now,
        setTimeout: (fn, ms) => {
            const t = { id: _nextId++, fireAt: _now + ms, fn };
            timers.push(t);
            return t.id;
        },
        clearTimeout: (handle) => {
            const id = handle;
            timers = timers.filter((t) => t.id !== id);
        },
    };
    /** Flush microtasks. We run multiple turns because each `await` adds at
     * most one to the queue and the engine's cycle awaits two replies. */
    async function flushMicrotasks() {
        for (let i = 0; i < 8; i++) {
            await Promise.resolve();
        }
    }
    async function advance(ms) {
        const target = _now + ms;
        // Fire timers in deadline order, advancing time to each fire point.
        while (true) {
            const next = timers
                .filter((t) => t.fireAt <= target)
                .sort((a, b) => a.fireAt - b.fireAt)[0];
            if (next === undefined)
                break;
            _now = next.fireAt;
            timers = timers.filter((t) => t.id !== next.id);
            next.fn();
            await flushMicrotasks();
        }
        _now = target;
        await flushMicrotasks();
    }
    return {
        clock,
        advance,
        pendingCount: () => timers.length,
        now: () => _now,
    };
}
// ---------------------------------------------------------------------------
// Reply fixtures — minimal bootstrap-shape replies the engine can parse.
// ---------------------------------------------------------------------------
const ENC = new TextEncoder();
function okResult(body) {
    return { ok: true, commandNumber: 0, body: ENC.encode(body) };
}
function errResult() {
    return { ok: false, commandNumber: 0, body: new Uint8Array(0) };
}
/** A windows-reply line for one session/window with one pane. */
function winLine(args) {
    const sess = args.sessNum ?? 0;
    return [
        `$${sess}`,
        "main",
        `@${args.winNum}`,
        args.winName ?? "shell",
        "80",
        "24",
        `0000,80x24,0,0,${args.paneIdInLayout}`,
        "-",
        "1",
    ].join("\t") + "\n";
}
/** A panes-reply line for one pane. */
function paneLine(args) {
    const sess = args.sessNum ?? 0;
    return [
        `%${args.paneNum}`,
        `@${args.winNum}`,
        `$${sess}`,
        "0",
        "80",
        "24",
        "0",
        "0",
        args.active ? "1" : "0",
        "9000",
        "bash",
    ].join("\t") + "\n";
}
/** Build a (windows, panes) reply pair for a list of windows, each with one pane. */
function bothReplies(windows) {
    const win = windows
        .map((n) => winLine({ winNum: n, paneIdInLayout: n }))
        .join("");
    const pane = windows
        .map((n) => paneLine({ paneNum: n, winNum: n, active: n === windows[0] }))
        .join("");
    return [okResult(win), okResult(pane)];
}
/**
 * Build a `SubmitCommand` whose responses are scripted. The script is a list
 * of (windows, panes) pairs; each `requery()` consumes one pair. Tests can
 * mutate `liveState` to model a tmux topology that changes between cycles.
 *
 * `requeryCount()` is the number of full cycles served (one cycle = two
 * commands).
 */
function scriptedSubmit(initialState) {
    let nextReplies = initialState();
    let calls = 0;
    return {
        submit: () => {
            const reply = nextReplies.shift() ?? errResult();
            calls += 1;
            return Promise.resolve(reply);
        },
        setNextReplies: (replies) => {
            nextReplies = replies;
        },
        requeryCount: () => Math.floor(calls / 2),
        pendingCalls: () => calls,
    };
}
// ---------------------------------------------------------------------------
// 1. Quiet + 1 event → immediate (leading edge)
// ---------------------------------------------------------------------------
describe("coalescer: leading edge", () => {
    it("first notify after quiet fires requery immediately (synchronously schedules cycle)", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [...bothReplies([1])]);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({ engine, clock: fake.clock, ceilingMs: 1000 });
        co.notify("%layout-change");
        // requery() submits both commands synchronously (before awaiting), so
        // after a single microtask flush we should see two submits and one
        // settled cycle.
        await fake.advance(0);
        assert.equal(script.requeryCount(), 1, "leading edge must fire immediately");
        assert.equal(engine.getModel().windows.size, 1);
    });
    it("notify after a cycle and a quiet period > ceiling fires immediately again", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [...bothReplies([1])]);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({ engine, clock: fake.clock, ceilingMs: 1000 });
        co.notify();
        await fake.advance(0);
        assert.equal(script.requeryCount(), 1);
        // Quiet for > ceiling; queue another reply pair and notify.
        script.setNextReplies([...bothReplies([1, 2])]);
        await fake.advance(2000);
        co.notify();
        await fake.advance(0);
        assert.equal(script.requeryCount(), 2, "second leading edge after quiet must fire immediately");
        assert.equal(engine.getModel().windows.size, 2);
    });
});
// ---------------------------------------------------------------------------
// 2. Sustained flood → bounded to 1 Hz ceiling, no missed final state
// ---------------------------------------------------------------------------
describe("coalescer: storm bounded by ceiling", () => {
    it("burst of N notifies within 1 s yields exactly 2 requeries — leading edge + one trailing edge — and the final state lands", async () => {
        const fake = makeFakeClock();
        // Three pairs: initial leading-edge (one window), trailing-edge (final
        // state with three windows), and a defensive spare we expect NOT to use.
        const script = scriptedSubmit(() => [
            ...bothReplies([1]),
            ...bothReplies([1, 2, 3]),
            ...bothReplies([1, 2, 3]),
        ]);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({ engine, clock: fake.clock, ceilingMs: 1000 });
        // 50 notifications within 500ms — a storm. Each call advances the clock
        // by 10ms so all of them land inside the ceiling window after the
        // leading edge.
        co.notify(); // t=0 — leading edge fires
        await fake.advance(0);
        assert.equal(script.requeryCount(), 1, "leading edge fires synchronously");
        // Pile on 49 more notifications, each 10ms apart. They fold into a
        // single trailing-edge fire scheduled for t=1000.
        for (let i = 0; i < 49; i++) {
            await fake.advance(10);
            co.notify();
        }
        // t is now 490ms. We've issued 50 notifications total, only 1 cycle.
        assert.equal(script.requeryCount(), 1, "storm folds — still only one cycle");
        // Advance to the ceiling boundary. Trailing-edge cycle fires at t=1000,
        // picking up the final flood state (three windows).
        await fake.advance(1000); // t=1490
        assert.equal(script.requeryCount(), 2, "trailing edge fires at ceiling boundary");
        assert.equal(engine.getModel().windows.size, 3, "trailing edge picked up the final state");
        // After the trailing fire, no further cycles should be scheduled — the
        // storm fully drained.
        await fake.advance(5000);
        assert.equal(script.requeryCount(), 2, "no extra cycles after storm drains");
    });
    it("rate over a long interval is bounded by 1 Hz", async () => {
        const fake = makeFakeClock();
        // Pre-load enough reply pairs that no cycle errors out for lack of data.
        const replies = [];
        for (let i = 0; i < 20; i++)
            replies.push(...bothReplies([1]));
        const script = scriptedSubmit(() => replies);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({ engine, clock: fake.clock, ceilingMs: 1000 });
        // Hammer notify every 10ms for 5 seconds = 500 notifications.
        for (let i = 0; i < 500; i++) {
            co.notify();
            await fake.advance(10);
        }
        // Drain one more ceiling window so any pending trailing edge fires.
        await fake.advance(1500);
        // 5000ms at 1 Hz allows AT MOST 6 cycles (leading edge plus one per
        // second). Allow a small margin for boundary alignment.
        const count = script.requeryCount();
        assert.ok(count <= 7, `rate must be bounded by ~1 Hz; got ${count} cycles in 5s`);
        assert.ok(count >= 5, `expected several cycles in 5s; got ${count}`);
    });
});
// ---------------------------------------------------------------------------
// 3. Heartbeat catches a change with zero notifications
// ---------------------------------------------------------------------------
describe("coalescer: heartbeat", () => {
    it("after start(), an unconditional cycle fires every heartbeatMs even with zero notifications", async () => {
        const fake = makeFakeClock();
        // Start with one window; after the heartbeat tick, two windows will land.
        let state = [...bothReplies([1])];
        const script = scriptedSubmit(() => state);
        const engine = createRequeryEngine({ submit: script.submit });
        // Seed the engine with an initial cycle so `_lastRequeryAt` is not at
        // -Infinity; otherwise the first heartbeat tick would be a leading edge
        // anyway and we couldn't show that the heartbeat itself drove the cycle.
        // Instead: don't seed; just observe that with zero notifications, a
        // requery fires exactly when the heartbeat ticks.
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            heartbeatMs: 5000,
        });
        co.start();
        // Inject an external change with NO notification.
        state = [...bothReplies([1, 2])];
        script.setNextReplies(state);
        // No notifications, no requery yet.
        await fake.advance(4999);
        assert.equal(script.requeryCount(), 0, "no requery before heartbeat");
        assert.equal(engine.getModel().windows.size, 0);
        // Heartbeat fires at t=5000.
        await fake.advance(2);
        assert.equal(script.requeryCount(), 1, "heartbeat fired");
        assert.equal(engine.getModel().windows.size, 2, "heartbeat picked up the silent change");
        co.stop();
    });
    it("heartbeat re-arms itself — fires again at the next interval", async () => {
        const fake = makeFakeClock();
        const replies = [];
        for (let i = 0; i < 5; i++)
            replies.push(...bothReplies([1]));
        const script = scriptedSubmit(() => replies);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            heartbeatMs: 5000,
        });
        co.start();
        await fake.advance(5001);
        const after1 = script.requeryCount();
        assert.equal(after1, 1, "first heartbeat");
        await fake.advance(5000);
        assert.equal(script.requeryCount(), 2, "second heartbeat re-armed");
        co.stop();
    });
});
// ---------------------------------------------------------------------------
// 4. Per-kind classification hook (tc-x6l seam)
// ---------------------------------------------------------------------------
describe("coalescer: onNotify classification hook", () => {
    it("fires exactly once per notify(), in order, with the kind label", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [
            ...bothReplies([1]),
            ...bothReplies([1]),
            ...bothReplies([1]),
        ]);
        const engine = createRequeryEngine({ submit: script.submit });
        const seen = [];
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            onNotify: (kind) => seen.push(kind),
        });
        co.notify("%layout-change");
        co.notify("%window-add");
        co.notify();
        await fake.advance(0);
        assert.deepEqual(seen, ["%layout-change", "%window-add", undefined]);
    });
    it("onNotify exception does not break the pipeline", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [...bothReplies([1])]);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            onNotify: () => { throw new Error("boom"); },
        });
        co.notify();
        await fake.advance(0);
        // Cycle still fired despite the observer throwing.
        assert.equal(script.requeryCount(), 1);
        assert.equal(engine.getModel().windows.size, 1);
    });
});
// ---------------------------------------------------------------------------
// 5. Steady-state %error policy — don't wipe, stay dirty, retry
// ---------------------------------------------------------------------------
describe("coalescer: %error in steady state", () => {
    it("a failed cycle leaves the model intact and retries at the next ceiling", async () => {
        const fake = makeFakeClock();
        // First cycle succeeds (sets up a model with one window). Second cycle
        // fails (both %error). Third cycle (retry) succeeds again with the
        // same shape.
        const script = scriptedSubmit(() => [
            ...bothReplies([1]),
            errResult(), errResult(),
            ...bothReplies([1]),
        ]);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({ engine, clock: fake.clock, ceilingMs: 1000 });
        // Cycle 1: leading edge, success.
        co.notify();
        await fake.advance(0);
        assert.equal(engine.getModel().windows.size, 1, "first cycle established the model");
        // Force a second cycle far in the future via a quiet period + notify.
        await fake.advance(2000);
        co.notify();
        await fake.advance(0);
        // Cycle 2 fired (%error). The engine MUST have left the model alone.
        assert.equal(engine.getModel().windows.size, 1, "%error must NOT wipe the model");
        // The engine should still be dirty (TL design call).
        assert.equal(engine.isDirty(), true, "engine stays dirty after failed cycle");
        // Coalescer scheduled a retry at lastRequeryAt + ceilingMs. Advance
        // past that boundary.
        await fake.advance(1500);
        assert.equal(script.requeryCount(), 3, "retry fired at next ceiling boundary");
        assert.equal(engine.getModel().windows.size, 1, "retry restored a fresh model");
        assert.equal(engine.isDirty(), false, "engine clean after successful retry");
    });
    it("onError observer fires when the engine throws", async () => {
        const fake = makeFakeClock();
        let throwOnce = true;
        const submit = () => {
            if (throwOnce) {
                throwOnce = false;
                return Promise.reject(new Error("submit failure"));
            }
            return Promise.resolve(okResult(""));
        };
        const engine = createRequeryEngine({ submit });
        const errors = [];
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            onError: (err) => errors.push(err),
        });
        co.notify();
        await fake.advance(0);
        assert.equal(errors.length, 1, "onError was called once");
        assert.ok(errors[0] instanceof Error);
    });
});
// ---------------------------------------------------------------------------
// 6. stop() cancels timers
// ---------------------------------------------------------------------------
describe("coalescer: stop()", () => {
    it("cancels a pending trailing-edge fire", async () => {
        const fake = makeFakeClock();
        const replies = [];
        for (let i = 0; i < 5; i++)
            replies.push(...bothReplies([1]));
        const script = scriptedSubmit(() => replies);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({ engine, clock: fake.clock, ceilingMs: 1000 });
        co.notify(); // leading edge fires
        await fake.advance(0);
        assert.equal(script.requeryCount(), 1);
        co.notify(); // schedules trailing edge for t=1000
        assert.ok(fake.pendingCount() > 0, "trailing-edge timer armed");
        co.stop();
        assert.equal(fake.pendingCount(), 0, "stop() cleared the timer");
        // Even past the ceiling, no second cycle should fire.
        await fake.advance(5000);
        assert.equal(script.requeryCount(), 1, "no trailing edge after stop()");
    });
    it("cancels the heartbeat", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [...bothReplies([1])]);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            heartbeatMs: 5000,
        });
        co.start();
        assert.ok(fake.pendingCount() > 0, "heartbeat armed");
        co.stop();
        assert.equal(fake.pendingCount(), 0, "stop() cleared heartbeat");
        await fake.advance(10_000);
        assert.equal(script.requeryCount(), 0, "no requery after stop()");
    });
    it("stop() is idempotent", () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => []);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({ engine, clock: fake.clock });
        co.stop();
        co.stop(); // must not throw
    });
    it("start() is idempotent", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [...bothReplies([1])]);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            heartbeatMs: 5000,
        });
        co.start();
        co.start(); // must not arm a second timer
        assert.equal(fake.pendingCount(), 1, "second start() did not double-arm");
        co.stop();
    });
});
// ---------------------------------------------------------------------------
// 7. Trailing-edge fold — single cycle after the leading edge picks up the
//    accumulated final state, no intermediate cycles.
// ---------------------------------------------------------------------------
describe("coalescer: trailing-edge fold", () => {
    it("multiple notifications inside the ceiling window collapse to one trailing cycle", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [
            ...bothReplies([1]),
            ...bothReplies([1, 2]),
        ]);
        const engine = createRequeryEngine({ submit: script.submit });
        const co = createCoalescer({ engine, clock: fake.clock, ceilingMs: 1000 });
        co.notify(); // t=0 leading edge
        await fake.advance(0);
        // 3 more notifications spaced 200ms apart — all fold into one.
        co.notify();
        await fake.advance(200);
        co.notify();
        await fake.advance(200);
        co.notify();
        await fake.advance(200);
        // t=600ms; still inside the ceiling window. No second cycle yet.
        assert.equal(script.requeryCount(), 1, "trailing-edge fire deferred");
        // Walk to t=1000ms — trailing edge fires.
        await fake.advance(500);
        assert.equal(script.requeryCount(), 2);
        assert.equal(engine.getModel().windows.size, 2, "trailing edge picked up the final state");
    });
});
// ---------------------------------------------------------------------------
// tc-3si.6: onDeltas meta — edge label + firstNotifyAt for the
// topology_notify_to_delta_seconds histogram. The bimodality test asserts
// that leading and trailing edge cycles land in two well-separated regions
// of "now() - firstNotifyAt" via the injected clock — no real timing.
// ---------------------------------------------------------------------------
describe("coalescer: onDeltas meta (tc-3si.6 — bimodal notify-to-delta)", () => {
    it("leading edge reports edge='leading' and firstNotifyAt == notify time", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [...bothReplies([1])]);
        const engine = createRequeryEngine({ submit: script.submit });
        const observed = [];
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            onDeltas: (_result, meta) => {
                // Reuse the injected clock as the "broadcast at" timestamp the
                // runtime would record — this is what pipeline.ts does in
                // production. (See pipeline.ts onDeltas wiring.)
                const broadcastAt = fake.now();
                observed.push({
                    edge: meta.edge,
                    notifyToDeltaMs: meta.firstNotifyAt !== null
                        ? broadcastAt - meta.firstNotifyAt
                        : NaN,
                });
            },
        });
        co.notify("%layout-change"); // t=0 → leading edge fires immediately
        await fake.advance(0);
        assert.equal(observed.length, 1, "expected one cycle commit");
        assert.equal(observed[0].edge, "leading");
        // Leading edge fires synchronously after notify — no ms accrued by the
        // injected clock yet (the scripted submit resolves on a microtask).
        assert.ok(observed[0].notifyToDeltaMs >= 0 && observed[0].notifyToDeltaMs < 10, `leading-mode notify-to-delta should be near zero on the injected clock; got ${observed[0].notifyToDeltaMs}`);
    });
    it("trailing edge reports edge='trailing' and firstNotifyAt == first notify in the window", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [
            ...bothReplies([1]), // leading-edge cycle (initial)
            ...bothReplies([1, 2]), // trailing-edge cycle (this is the one we observe)
        ]);
        const engine = createRequeryEngine({ submit: script.submit });
        const observed = [];
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            onDeltas: (_result, meta) => {
                observed.push({
                    edge: meta.edge,
                    firstNotifyAt: meta.firstNotifyAt,
                    broadcastAt: fake.now(),
                });
            },
        });
        // Leading edge at t=0.
        co.notify();
        await fake.advance(0);
        assert.equal(observed.length, 1);
        assert.equal(observed[0].edge, "leading");
        // Sub-ceiling notify at t=200 starts the trailing-edge window. Two
        // more notifies within the window fold into the same trailing cycle.
        await fake.advance(200);
        co.notify(); // FIRST notify of the trailing window — records firstNotifyAt=200
        await fake.advance(200);
        co.notify();
        await fake.advance(200);
        co.notify();
        // Still inside the ceiling window — no cycle yet.
        assert.equal(observed.length, 1, "trailing-edge fire is deferred");
        // Walk to t=1000ms — trailing edge fires.
        await fake.advance(400);
        assert.equal(observed.length, 2);
        const trailing = observed[1];
        assert.equal(trailing.edge, "trailing", "second cycle is the trailing edge");
        assert.equal(trailing.firstNotifyAt, 200, "firstNotifyAt must be the time of the FIRST notify after the leading-edge cycle (not the third)");
        // The broadcast happens at t=1000 → notify-to-delta = 800ms,
        // bounded by the ceiling. This is the second mode of the bimodal
        // histogram; the test asserts it lands in the trailing region
        // (clearly > 200ms — well above the leading mode's near-zero bucket).
        const trailingNotifyToDeltaMs = trailing.broadcastAt - trailing.firstNotifyAt;
        assert.ok(trailingNotifyToDeltaMs >= 500 && trailingNotifyToDeltaMs <= 1000, `trailing-mode notify-to-delta should be bounded by the ceiling (~800ms here); got ${trailingNotifyToDeltaMs}ms`);
    });
    it("two distinct modes: synthetic 100-sample run lands clearly bimodal", async () => {
        // Drive two regimes alternately and assert that the leading samples
        // cluster near zero and the trailing samples cluster near the
        // ceiling. The test does not check exact timings; it checks that the
        // two modes do not overlap (the keystone of the histogram is exactly
        // that they read as two distinct masses).
        const fake = makeFakeClock();
        // Build a long reply script (≥ 2 cycles × 50 iterations = 100 cycles
        // of replies). Each cycle is two replies (windows + panes).
        const replies = [];
        for (let i = 0; i < 200; i++) {
            replies.push(...bothReplies([1]));
        }
        const script = scriptedSubmit(() => replies);
        const engine = createRequeryEngine({ submit: script.submit });
        const samples = [];
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            onDeltas: (_result, meta) => {
                if (meta.firstNotifyAt === null)
                    return;
                samples.push({ edge: meta.edge, latencyMs: fake.now() - meta.firstNotifyAt });
            },
        });
        // 50 iterations. Each iteration:
        //   - Quiet for >ceiling, then notify → leading-edge sample (~0ms).
        //   - Notify again immediately, then another notify ~200ms later;
        //     trailing edge fires at ceiling → trailing-edge sample
        //     bounded by ~ceiling - 200 = 800ms.
        for (let i = 0; i < 50; i++) {
            await fake.advance(1100); // quiet period > ceiling
            co.notify(); // leading-edge fires
            await fake.advance(0);
            // Immediately notify again — kicks off the trailing window.
            co.notify();
            await fake.advance(200);
            co.notify(); // folds in
            // Walk to the trailing-edge fire.
            await fake.advance(800); // total inside-window: 1000ms
        }
        const leadingSamples = samples.filter((s) => s.edge === "leading");
        const trailingSamples = samples.filter((s) => s.edge === "trailing");
        assert.ok(leadingSamples.length >= 50, `leading-edge samples (got ${leadingSamples.length})`);
        assert.ok(trailingSamples.length >= 50, `trailing-edge samples (got ${trailingSamples.length})`);
        // Bimodal assertion: every leading sample < some_threshold; every
        // trailing sample > some_threshold; the two regions don't overlap.
        const SEPARATOR_MS = 100; // any value between modes; leading <<100, trailing >>100.
        for (const s of leadingSamples) {
            assert.ok(s.latencyMs < SEPARATOR_MS, `leading-edge sample must fall in the low mode; got ${s.latencyMs}ms`);
        }
        for (const s of trailingSamples) {
            assert.ok(s.latencyMs > SEPARATOR_MS, `trailing-edge sample must fall in the high mode; got ${s.latencyMs}ms`);
        }
    });
    it("heartbeat cycle reports edge='heartbeat' and firstNotifyAt === null", async () => {
        const fake = makeFakeClock();
        const script = scriptedSubmit(() => [...bothReplies([1]), ...bothReplies([1])]);
        const engine = createRequeryEngine({ submit: script.submit });
        const observed = [];
        const co = createCoalescer({
            engine,
            clock: fake.clock,
            ceilingMs: 1000,
            heartbeatMs: 30_000,
            onDeltas: (_result, meta) => {
                observed.push({ edge: meta.edge, firstNotifyAt: meta.firstNotifyAt });
            },
        });
        co.start(); // arm the heartbeat
        // Walk to the first heartbeat tick. No notify in this interval — the
        // cycle that fires here should be classified as `heartbeat`.
        await fake.advance(30_000);
        assert.ok(observed.length >= 1, "heartbeat must have fired at least one cycle");
        const heartbeat = observed[0];
        assert.equal(heartbeat.edge, "heartbeat");
        assert.equal(heartbeat.firstNotifyAt, null, "heartbeat cycle has no triggering notify — firstNotifyAt is null");
        co.stop();
    });
});
//# sourceMappingURL=coalescer.test.js.map