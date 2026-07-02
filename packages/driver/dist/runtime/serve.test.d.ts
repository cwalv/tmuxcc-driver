/**
 * Tests for the control-plane server — tc-dv3.
 *
 * Covers the acceptance criteria:
 *   1. Single client: receives snapshot (seq=1) then correct deltas (seq=2,3,…).
 *   2. Multi-client: two clients each get their own snapshot + independent seq.
 *   3. Seq monotonicity: 1, 2, 3, … with no gaps.
 *   4. Client disconnect: removeClient / transport close → no more sends, no crash.
 *   5. Snapshot timing (tc-3eh.2): snapshot arrives after async-transport delivery,
 *      not at the no-op handler that runClientHandshake leaves in place.
 *
 * # Test strategy
 *
 * We use a FAKE pipeline (`createFakePipeline`) that exposes `getModel()` and
 * `onModelChange()` but is driven manually by the test (calling `fireChange` to
 * simulate a model update). This avoids real tmux and keeps tests deterministic.
 *
 * For the handshake, we run `runClientHandshake` on the client side of the
 * in-memory transport pair so we get a real negotiated session without needing
 * a real process.
 *
 * @module runtime/serve.test
 */
export {};
//# sourceMappingURL=serve.test.d.ts.map