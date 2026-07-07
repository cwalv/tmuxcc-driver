/**
 * Size-ownership policy unit tests — tc-76m8.3 (S3 "Geometry among peers").
 *
 * Drives {@link createSizeOwnershipPolicy} directly with a synthetic clock so
 * the debounce is deterministic (no real-time sleeps). Proves the two AC
 * behaviors precisely — alternation moves ownership after the debounce window;
 * rapid interleaved activity does not oscillate — plus the candidate/handoff
 * bookkeeping the session-proxy relies on.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Clock, TimeoutHandle } from "../state/coalescer.js";
import { createSizeOwnershipPolicy } from "./size-ownership.js";

// ---------------------------------------------------------------------------
// Synthetic clock — deterministic time + queueable timers (no async needed;
// the policy has no Promise plumbing).
// ---------------------------------------------------------------------------

interface Timer {
  id: number;
  fireAt: number;
  fn: () => void;
}

function makeFakeClock(): { clock: Clock; advance: (ms: number) => void; pending: () => number } {
  let now = 0;
  let nextId = 1;
  let timers: Timer[] = [];

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: Timer = { id: nextId++, fireAt: now + ms, fn };
      timers.push(t);
      return t.id as unknown as TimeoutHandle;
    },
    clearTimeout: (handle) => {
      const id = handle as unknown as number;
      timers = timers.filter((t) => t.id !== id);
    },
  };

  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      const next = timers
        .filter((t) => t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (next === undefined) break;
      now = next.fireAt;
      timers = timers.filter((t) => t.id !== next.id);
      next.fn();
    }
    now = target;
  }

  return { clock, advance, pending: () => timers.length };
}

const DEBOUNCE = 250;

describe("SizeOwnershipPolicy (tc-76m8.3)", () => {
  it("first candidate becomes owner immediately; a non-candidate never owns", () => {
    const { clock } = makeFakeClock();
    const changes: (string | null)[] = [];
    const policy = createSizeOwnershipPolicy({
      debounceMs: DEBOUNCE,
      clock,
      onOwnerChange: (o) => changes.push(o),
    });

    // A non-candidate registered first does NOT become owner.
    policy.addClient("observer", false);
    assert.equal(policy.owner, null);

    policy.addClient("A", true);
    assert.equal(policy.owner, "A");
    assert.ok(policy.isSizeOwner("A"));
    assert.deepEqual(changes, ["A"]);

    // A second candidate does not steal ownership on connect (mere connection
    // is not activity).
    policy.addClient("B", true);
    assert.equal(policy.owner, "A");
    assert.deepEqual(changes, ["A"]);
  });

  it("AC1: activity alternation moves ownership after the debounce window", () => {
    const { clock, advance } = makeFakeClock();
    const changes: (string | null)[] = [];
    const policy = createSizeOwnershipPolicy({
      debounceMs: DEBOUNCE,
      clock,
      onOwnerChange: (o) => changes.push(o),
    });
    policy.addClient("A", true); // A owns
    policy.addClient("B", true);
    changes.length = 0;

    // B becomes active while A is idle.
    policy.noteActivity("B");
    // Before the debounce elapses, A still owns (no premature flip).
    advance(DEBOUNCE - 1);
    assert.ok(policy.isSizeOwner("A"), "A still owns within the debounce window");
    assert.equal(changes.length, 0);

    // Once the owner has been silent for the full window, B wins.
    advance(1);
    assert.ok(policy.isSizeOwner("B"), "B owns after debounce");
    assert.deepEqual(changes, ["B"]);

    // And it alternates back: A active, B idle → after debounce, A owns.
    policy.noteActivity("A");
    advance(DEBOUNCE);
    assert.ok(policy.isSizeOwner("A"), "A reclaims after its own debounce window");
    assert.deepEqual(changes, ["B", "A"]);
  });

  it("AC2: rapid interleaved input does not oscillate ownership", () => {
    const { clock, advance } = makeFakeClock();
    const changes: (string | null)[] = [];
    const policy = createSizeOwnershipPolicy({
      debounceMs: DEBOUNCE,
      clock,
      onOwnerChange: (o) => changes.push(o),
    });
    policy.addClient("A", true); // A owns
    policy.addClient("B", true);
    changes.length = 0;

    // Both peers type, interleaved, faster than the debounce: the owner keeps
    // reasserting within each window, so the challenge timer never fires.
    for (let i = 0; i < 50; i++) {
      policy.noteActivity("B"); // challenger
      advance(DEBOUNCE / 5);
      policy.noteActivity("A"); // owner reasserts, cancelling the challenge
      advance(DEBOUNCE / 5);
    }
    assert.ok(policy.isSizeOwner("A"), "ownership never flipped under interleave");
    assert.deepEqual(changes, [], "no ownership changes emitted during the storm");

    // The instant A goes quiet for a full window while B keeps typing, the
    // handoff completes — proving it was hysteresis, not a hard lock.
    policy.noteActivity("B");
    advance(DEBOUNCE);
    assert.ok(policy.isSizeOwner("B"), "clean handoff once the owner truly idles");
    assert.deepEqual(changes, ["B"]);
  });

  it("focus is an activity signal equivalent to input", () => {
    const { clock, advance } = makeFakeClock();
    const policy = createSizeOwnershipPolicy({ debounceMs: DEBOUNCE, clock });
    policy.addClient("A", true);
    policy.addClient("B", true);

    // B focuses (no typing) while A is idle → B takes ownership after debounce.
    policy.noteActivity("B");
    advance(DEBOUNCE);
    assert.ok(policy.isSizeOwner("B"));
  });

  it("a non-candidate's activity is ignored (cannot seize ownership)", () => {
    const { clock, advance } = makeFakeClock();
    const policy = createSizeOwnershipPolicy({ debounceMs: DEBOUNCE, clock });
    policy.addClient("A", true); // owner
    policy.addClient("obs", false); // read-only / ignore-size observer

    policy.noteActivity("obs");
    advance(DEBOUNCE * 4);
    assert.ok(policy.isSizeOwner("A"), "observer activity never moves ownership");
    assert.ok(!policy.isSizeOwner("obs"));
  });

  it("owner departure hands off immediately to the most-recently-active peer", () => {
    const { clock, advance } = makeFakeClock();
    const changes: (string | null)[] = [];
    const policy = createSizeOwnershipPolicy({
      debounceMs: DEBOUNCE,
      clock,
      onOwnerChange: (o) => changes.push(o),
    });
    policy.addClient("A", true); // A owns
    policy.addClient("B", true);
    policy.addClient("C", true);
    changes.length = 0;

    // B was active more recently than C.
    policy.noteActivity("C");
    advance(10);
    policy.noteActivity("B");

    // A (the owner) leaves → immediate handoff (no debounce) to B (most recent).
    policy.removeClient("A", true);
    assert.ok(policy.isSizeOwner("B"), "handoff to most-recently-active remaining peer");
    assert.deepEqual(changes, ["B"]);

    // Everyone leaves → each owner departure hands off, last one to null.
    policy.removeClient("B", true); // owner leaves → C (the only remaining) takes over
    assert.ok(policy.isSizeOwner("C"));
    policy.removeClient("C", true); // last candidate leaves → no owner
    assert.equal(policy.owner, null);
    assert.deepEqual(changes, ["B", "C", null]);
  });

  it("removing the pending challenger cancels its in-flight promotion", () => {
    const { clock, advance, pending } = makeFakeClock();
    const changes: (string | null)[] = [];
    const policy = createSizeOwnershipPolicy({
      debounceMs: DEBOUNCE,
      clock,
      onOwnerChange: (o) => changes.push(o),
    });
    policy.addClient("A", true); // A owns
    policy.addClient("B", true);
    changes.length = 0;

    policy.noteActivity("B"); // B challenges; timer armed
    assert.equal(pending(), 1);
    policy.removeClient("B", true); // B disconnects before promotion
    assert.equal(pending(), 0, "the pending timer was cleared");
    advance(DEBOUNCE * 2);
    assert.ok(policy.isSizeOwner("A"), "A keeps ownership; the vanished challenger never wins");
    assert.deepEqual(changes, []);
  });

  it("single-candidate session: the sole client always owns (D4 unchanged)", () => {
    const { clock, advance } = makeFakeClock();
    const policy = createSizeOwnershipPolicy({ debounceMs: DEBOUNCE, clock });
    policy.addClient("solo", true);
    assert.ok(policy.isSizeOwner("solo"));
    // Its own input keeps it owner; nothing to contend.
    policy.noteActivity("solo");
    advance(DEBOUNCE * 3);
    assert.ok(policy.isSizeOwner("solo"));
  });

  it("tc-51oo: candidacy is refcounted per key — closing one same-key connection keeps candidacy/ownership", () => {
    const { clock } = makeFakeClock();
    const changes: (string | null)[] = [];
    const policy = createSizeOwnershipPolicy({
      debounceMs: DEBOUNCE,
      clock,
      onOwnerChange: (o) => changes.push(o),
    });

    // One window presents ONE identity across TWO connections (e.g. an old/new
    // reconnect overlap, or a main + pane-scoped connection both as candidates).
    policy.addClient("win", true); // conn #1 → first candidate → owner
    policy.addClient("win", true); // conn #2, same identity → no steal, refcount 2
    assert.equal(policy.owner, "win");
    assert.deepEqual(changes, ["win"]);

    // Closing conn #1 must NOT strip the still-connected conn #2's candidacy.
    policy.removeClient("win", true);
    assert.ok(policy.isSizeOwner("win"), "key still owns while another candidate connection is live");
    assert.deepEqual(changes, ["win"], "no owner change while a candidate connection remains");

    // Only when the LAST candidate connection closes does the key stop owning.
    policy.removeClient("win", true);
    assert.equal(policy.owner, null);
    assert.deepEqual(changes, ["win", null]);
  });

  it("tc-51oo: a non-candidate connection close is a no-op (never strips a same-key candidate)", () => {
    const { clock, advance } = makeFakeClock();
    const policy = createSizeOwnershipPolicy({ debounceMs: DEBOUNCE, clock });

    policy.addClient("win", true); // candidate main connection → owner
    policy.addClient("win", false); // non-candidate aux (ignore-size) — not refcounted
    assert.ok(policy.isSizeOwner("win"));

    // The aux connection closing must not touch the window's candidacy/ownership.
    policy.removeClient("win", false);
    assert.ok(policy.isSizeOwner("win"), "non-candidate close leaves the candidate untouched");

    // And activity still flows to the still-owning key.
    policy.noteActivity("win");
    advance(DEBOUNCE * 2);
    assert.ok(policy.isSizeOwner("win"));
  });

  it("tc-51oo: a candidate-remove with no registered connection throws (add/remove imbalance tripwire)", () => {
    const { clock } = makeFakeClock();
    const policy = createSizeOwnershipPolicy({ debounceMs: DEBOUNCE, clock });

    // Never added as a candidate — a wasCandidate remove is a bookkeeping bug,
    // not an idempotent no-op: absorbed, a stray decrement could strip a key
    // that still has live connections.
    assert.throws(
      () => policy.removeClient("ghost", true),
      /add\/remove imbalance/,
    );

    // Already fully removed → same tripwire on the second remove.
    policy.addClient("win", true);
    policy.removeClient("win", true);
    assert.throws(() => policy.removeClient("win", true), /add\/remove imbalance/);
  });

  it("dispose cancels any pending timer", () => {
    const { clock, pending } = makeFakeClock();
    const policy = createSizeOwnershipPolicy({ debounceMs: DEBOUNCE, clock });
    policy.addClient("A", true);
    policy.addClient("B", true);
    policy.noteActivity("B");
    assert.equal(pending(), 1);
    policy.dispose();
    assert.equal(pending(), 0);
  });
});
