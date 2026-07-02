/**
 * Two-client size-ownership behavioral test — tc-76m8.3 (S3 "Geometry among
 * peers"), real tmux 3.4.
 *
 * Proves the D4 POLICY layer end-to-end through the full session-proxy assembly
 * (`createSessionProxy` → `sessionProxy.addClient`, the path that carries the
 * activity/gate/reapply wiring — the fake-tmux harnesses attach via
 * `server.addClient` and bypass it). The debounce clock is injected so the
 * timing is deterministic; only the tmux resize round-trips use real time.
 *
 * The session-proxy holds ONE tmux `-CC` client; both VS Code peers are
 * driver-side clients multiplexed onto it. `resize.request → refresh-client -C`
 * sets that one client's size, so tmux's reported pane geometry is the ground
 * truth for which client's resize the gate let through.
 *
 * Coverage:
 *   T1. Alternation moves ownership after debounce (AC1) — a non-owner's resize
 *       is dropped; after the non-owner becomes the most-recently-active client
 *       and the debounce elapses, ownership moves and the new owner's viewport
 *       is re-applied (native-perfect geometry, no gesture).
 *   T2. Rapid interleaved input does not oscillate ownership (AC2) — the owner's
 *       own activity keeps cancelling the challenge, so ownership never flips
 *       during simultaneous typing.
 *   T3. Single-client D4 mechanics unchanged — the sole client drives size; a
 *       client that attached with the `ignore-size` flag never does.
 *
 * @module runtime/size-ownership.e2e.test
 */
export {};
//# sourceMappingURL=size-ownership.e2e.test.d.ts.map