/**
 * Tests for the close-cause registry (tc-u7cu.6).
 *
 * The registry correlates a closing verb's pane ids to the connection + requestId
 * that caused them, so pane.closed deltas can be stamped with their cause.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCloseCauseRegistry } from "./close-cause.js";
import { paneId, connectionId } from "@tmuxcc/protocol";
const P1 = paneId("p1");
const P2 = paneId("p2");
const CONN_A = connectionId("conn1");
describe("CloseCauseRegistry (tc-u7cu.6)", () => {
    it("record then consume returns the cause for the pane id", () => {
        const reg = createCloseCauseRegistry();
        reg.record(P1, CONN_A, "req-1");
        const cause = reg.consume(P1);
        assert.deepEqual(cause, { connectionId: CONN_A, requestId: "req-1" });
    });
    it("consume of an unrecorded id (unsolicited close) returns undefined", () => {
        const reg = createCloseCauseRegistry();
        assert.equal(reg.consume(P2), undefined);
    });
    it("consume is ONE-SHOT — second consume returns undefined (each pane closes once)", () => {
        const reg = createCloseCauseRegistry();
        reg.record(P1, CONN_A, "req-1");
        const first = reg.consume(P1);
        assert.deepEqual(first, { connectionId: CONN_A, requestId: "req-1" });
        // Second consume must return undefined — the entry was consumed.
        const second = reg.consume(P1);
        assert.equal(second, undefined, "entry must be consumed on first lookup");
    });
    it("clear drops the entry for a pane id", () => {
        const reg = createCloseCauseRegistry();
        reg.record(P1, CONN_A, "req-1");
        reg.clear(P1);
        assert.equal(reg.consume(P1), undefined);
    });
    it("entries expire after the TTL", () => {
        let now = 1_000;
        const reg = createCloseCauseRegistry({ ttlMs: 100, now: () => now });
        reg.record(P1, CONN_A, "req-1");
        now = 1_050; // within TTL
        assert.deepEqual(reg.consume(P1), { connectionId: CONN_A, requestId: "req-1" });
        // Record again (the previous consume removed the entry).
        reg.record(P1, CONN_A, "req-1");
        now = 1_250; // past TTL
        assert.equal(reg.consume(P1), undefined, "expired entry must not be returned");
    });
    it("the size cap evicts the oldest entries", () => {
        let now = 0;
        const reg = createCloseCauseRegistry({ maxEntries: 1, now: () => now });
        reg.record(P1, CONN_A, "req-1");
        now = 1;
        reg.record(P2, CONN_A, "req-2");
        // The first entry was evicted to honour the cap.
        assert.equal(reg.consume(P1), undefined);
        // The newest entry survives.
        assert.deepEqual(reg.consume(P2), { connectionId: CONN_A, requestId: "req-2" });
    });
    it("multiple panes can be recorded independently (kill-window case)", () => {
        const P3 = paneId("p3");
        const reg = createCloseCauseRegistry();
        reg.record(P1, CONN_A, "req-1");
        reg.record(P2, CONN_A, "req-1");
        reg.record(P3, CONN_A, "req-1");
        assert.deepEqual(reg.consume(P1), { connectionId: CONN_A, requestId: "req-1" });
        assert.deepEqual(reg.consume(P2), { connectionId: CONN_A, requestId: "req-1" });
        assert.deepEqual(reg.consume(P3), { connectionId: CONN_A, requestId: "req-1" });
    });
});
//# sourceMappingURL=close-cause.test.js.map