/**
 * session-removal-ordering.test.ts — tc-295a.6 (W1.5)
 *
 * Tests for the cross-stream ordering contract:
 *   sessions.removed (C1) ⟹ session-proxy UDS close (C4) follows promptly.
 *
 * Contract (protocol/session-lifecycle.md):
 *   - sessions.removed fires only on true tmux session drop.
 *   - reapSessionProxy is called before sessions.removed is broadcast (SIGTERM
 *     is sent before the C1 event; UDS close follows promptly after SIGTERM).
 *   - C4 events in flight when sessions.removed lands are legal to drain;
 *     once the C4 UDS closes no further C4 events should arrive.
 *   - Post-removal C4 reconnect is a protocol violation (tripwire).
 *
 * # Tests
 *
 *   L1 (integration, requires tmux): session.destroy closes the session-proxy
 *      UDS and broadcasts sessions.removed on C1; the UDS is gone after the
 *      removal is broadcast.
 *
 *   L2 (integration, requires tmux): post-destroy C4 reconnect fails
 *      (ENOENT/ECONNREFUSED) — the tripwire: a successful reconnect after
 *      sessions.removed means the client entered zombie state.
 *
 *   L3 (kill-under-load, requires tmux): external `tmux kill-session` while
 *      the session-proxy is actively writing pane output; the test asserts
 *      sessions.removed arrives on C1 AND the C4 UDS path is removed after
 *      the removal is broadcast, with in-flight C4 events handled gracefully
 *      via a proper handshaked C4 connection.
 *
 * @module session-removal-ordering.test
 */
export {};
//# sourceMappingURL=session-removal-ordering.test.d.ts.map