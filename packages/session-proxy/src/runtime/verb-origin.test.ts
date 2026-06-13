/**
 * Tests for the verb-origin registry (tc-ozk.2).
 *
 * The registry correlates a creating verb's returned effect ids to the
 * connection + requestId that caused them, so creation deltas can be stamped
 * with their origin. These tests pin the record / lookup / clear contract and
 * the TTL + size-cap eviction that bounds the map.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createVerbOriginRegistry } from "./verb-origin.js";
import { paneId, windowId, connectionId } from "../wire/ids.js";

const P1 = paneId("p1");
const W1 = windowId("w1");
const P2 = paneId("p2");
const W2 = windowId("w2");
const CONN_A = connectionId("conn1");

describe("VerbOriginRegistry (tc-ozk.2)", () => {
  it("record then lookup returns the origin for BOTH the pane and the window id", () => {
    const reg = createVerbOriginRegistry();
    reg.record(P1, W1, CONN_A, "req-1");

    assert.deepEqual(reg.lookup(P1), { connectionId: CONN_A, requestId: "req-1" });
    assert.deepEqual(reg.lookup(W1), { connectionId: CONN_A, requestId: "req-1" });
  });

  it("lookup of an unrecorded id (foreign creation) returns undefined", () => {
    const reg = createVerbOriginRegistry();
    assert.equal(reg.lookup(P2), undefined);
    assert.equal(reg.lookup(W2), undefined);
  });

  it("lookup is idempotent — it does NOT consume the entry (multi-client fan-out)", () => {
    const reg = createVerbOriginRegistry();
    reg.record(P1, W1, CONN_A, "req-1");

    // Every connected client's diffModel pass must see the same origin.
    const first = reg.lookup(P1);
    const second = reg.lookup(P1);
    const third = reg.lookup(P1);
    assert.deepEqual(first, { connectionId: CONN_A, requestId: "req-1" });
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
  });

  it("clear drops the entry for an id (pane/window left the model)", () => {
    const reg = createVerbOriginRegistry();
    reg.record(P1, W1, CONN_A, "req-1");
    reg.clear(P1);
    assert.equal(reg.lookup(P1), undefined);
    // The window id keyed by the same record is independent — clearing the pane
    // does not clear the window (they may be reaped at different times).
    assert.deepEqual(reg.lookup(W1), { connectionId: CONN_A, requestId: "req-1" });
  });

  it("entries expire after the TTL", () => {
    let now = 1_000;
    const reg = createVerbOriginRegistry({ ttlMs: 100, now: () => now });
    reg.record(P1, W1, CONN_A, "req-1");

    now = 1_050; // within TTL
    assert.deepEqual(reg.lookup(P1), { connectionId: CONN_A, requestId: "req-1" });

    now = 1_200; // past TTL
    assert.equal(reg.lookup(P1), undefined, "expired entry must not be returned");
  });

  it("the size cap evicts the oldest entries (defends against a verb-storm leak)", () => {
    let now = 0;
    const reg = createVerbOriginRegistry({ maxEntries: 2, now: () => now });
    // Each record() inserts TWO entries (pane + window), so one record already
    // fills the cap of 2. A second record evicts the first record's entries.
    reg.record(P1, W1, CONN_A, "req-1");
    now = 1;
    reg.record(P2, W2, CONN_A, "req-2");

    // The first record's entries were evicted to honour the cap.
    assert.equal(reg.lookup(P1), undefined);
    assert.equal(reg.lookup(W1), undefined);
    // The newest record survives.
    assert.deepEqual(reg.lookup(P2), { connectionId: CONN_A, requestId: "req-2" });
    assert.deepEqual(reg.lookup(W2), { connectionId: CONN_A, requestId: "req-2" });
  });
});
