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
import type { Clock, TimeoutHandle } from "./coalescer.js";
import { createRequeryEngine } from "./requery.js";
import type { SubmitCommand } from "./requery.js";
import type { CommandResult } from "../parser/correlator.js";

// ---------------------------------------------------------------------------
// Fake clock — deterministic time + queueable timers.
//
// `advance(ms)` walks time forward in one or more chunks, firing any timer
// whose deadline passes, and awaiting the engine's microtask queue between
// fires so that timer callbacks that kick off `engine.requery()` get their
// Promise plumbing settled before the next timer.
// ---------------------------------------------------------------------------

interface Timer {
  id: number;
  fireAt: number;
  fn: () => void;
}

function makeFakeClock(): {
  clock: Clock;
  advance: (ms: number) => Promise<void>;
  pendingCount: () => number;
  now: () => number;
} {
  let _now = 0;
  let _nextId = 1;
  let timers: Timer[] = [];

  const clock: Clock = {
    now: () => _now,
    setTimeout: (fn, ms) => {
      const t: Timer = { id: _nextId++, fireAt: _now + ms, fn };
      timers.push(t);
      return t.id as unknown as TimeoutHandle;
    },
    clearTimeout: (handle) => {
      const id = handle as unknown as number;
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

  async function advance(ms: number): Promise<void> {
    const target = _now + ms;
    // Fire timers in deadline order, advancing time to each fire point.
    while (true) {
      const next = timers
        .filter((t) => t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (next === undefined) break;
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

function okResult(body: string): CommandResult {
  return { ok: true, commandNumber: 0, body: ENC.encode(body) };
}

function errResult(): CommandResult {
  return { ok: false, commandNumber: 0, body: new Uint8Array(0) };
}

/** A windows-reply line for one session/window with one pane. */
function winLine(args: {
  sessNum?: number;
  winNum: number;
  paneIdInLayout: number;
  winName?: string;
}): string {
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
function paneLine(args: {
  paneNum: number;
  winNum: number;
  sessNum?: number;
  active?: boolean;
}): string {
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
function bothReplies(windows: number[]): [CommandResult, CommandResult] {
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
function scriptedSubmit(initialState: () => CommandResult[]): {
  submit: SubmitCommand;
  setNextReplies: (replies: CommandResult[]) => void;
  requeryCount: () => number;
  pendingCalls: () => number;
} {
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
    co.notify();           // t=0 — leading edge fires
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
    const replies: CommandResult[] = [];
    for (let i = 0; i < 20; i++) replies.push(...bothReplies([1]));
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
    const replies: CommandResult[] = [];
    for (let i = 0; i < 5; i++) replies.push(...bothReplies([1]));
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
    const seen: (string | undefined)[] = [];
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
    const submit: SubmitCommand = () => {
      if (throwOnce) {
        throwOnce = false;
        return Promise.reject(new Error("submit failure"));
      }
      return Promise.resolve(okResult(""));
    };
    const engine = createRequeryEngine({ submit });
    const errors: unknown[] = [];
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
    const replies: CommandResult[] = [];
    for (let i = 0; i < 5; i++) replies.push(...bothReplies([1]));
    const script = scriptedSubmit(() => replies);
    const engine = createRequeryEngine({ submit: script.submit });
    const co = createCoalescer({ engine, clock: fake.clock, ceilingMs: 1000 });

    co.notify();             // leading edge fires
    await fake.advance(0);
    assert.equal(script.requeryCount(), 1);

    co.notify();             // schedules trailing edge for t=1000
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
    co.stop();    // must not throw
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
    co.start();   // must not arm a second timer
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

    co.notify();             // t=0 leading edge
    await fake.advance(0);

    // 3 more notifications spaced 200ms apart — all fold into one.
    co.notify(); await fake.advance(200);
    co.notify(); await fake.advance(200);
    co.notify(); await fake.advance(200);
    // t=600ms; still inside the ceiling window. No second cycle yet.
    assert.equal(script.requeryCount(), 1, "trailing-edge fire deferred");

    // Walk to t=1000ms — trailing edge fires.
    await fake.advance(500);
    assert.equal(script.requeryCount(), 2);
    assert.equal(engine.getModel().windows.size, 2, "trailing edge picked up the final state");
  });
});
