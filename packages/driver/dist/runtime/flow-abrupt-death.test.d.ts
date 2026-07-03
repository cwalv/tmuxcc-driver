/**
 * tc-76m8.27 — FC-1 accounting on abrupt client death (real tmux).
 *
 * # The bug this file pins
 *
 * A backpressured client's drain credits are DEFERRED: the draining wrapper in
 * session-proxy.ts chains `fc.noteDrained` off the Promise that
 * SocketTransport.sendData returns when `socket.write()` hits backpressure.
 * On abrupt client death (SIGSTOP a client so it stops reading, flood it,
 * SIGKILL it — the tc-76m8.23 repro), SocketTransport._onClose:
 *
 *   1. resolves the shared drain promise (to release awaiters), which QUEUES
 *      every deferred credit as a microtask, then
 *   2. fires the close handlers SYNCHRONOUSLY — including session-proxy's
 *      handler, which calls `fc.removeClient(transport)` and discards the
 *      dead client's sub-ledgers (the correct reconciliation: nothing is owed
 *      to a dead client).
 *
 * The microtasks from (1) then run AFTER (2), so every deferred credit landed
 * on an already-discarded ledger — one "DRAIN CLAMPED" FC-1 tripwire hit per
 * queued chunk. The ordering is deterministic (microtasks run after the
 * synchronous close handlers), not a race.
 *
 * The fix suppresses drain credits once the client transport has closed:
 * bytes that died in the send queue were never drained by anyone, and
 * removeClient IS the reconciliation. These tests assert the expected-zero
 * `flow_drain_clamped_total` counter stays 0 across an abrupt death.
 *
 * # Coverage
 *
 *   T1. Full production path: real unix socket + real SocketTransport +
 *       real kernel backpressure. The client socket stops reading (SIGSTOP
 *       analogue), a real pane floods it past the kernel's socket buffers,
 *       then the socket is destroyed abruptly (SIGKILL analogue). The clamp
 *       tripwire must not fire, and the session-proxy must remain healthy
 *       (dead client fully removed; a fresh client can attach).
 *
 *   T2. Ordering-exact repro with a scripted transport that mimics
 *       SocketTransport._onClose (resolve drain promise, then fire close
 *       handlers synchronously) — deterministic, independent of kernel
 *       buffer sizes. Also asserts the dead client's ledger is fully
 *       reconciled (bufferedBytes back to 0).
 *
 * @module runtime/flow-abrupt-death.test
 */
export {};
//# sourceMappingURL=flow-abrupt-death.test.d.ts.map