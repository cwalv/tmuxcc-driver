/**
 * tc-295a.21 — raw/unhandshaked UDS connection must not crash the session-proxy.
 *
 * # Problem
 *
 * The session-proxy entry point accepts UDS connections in a loop and calls
 * `sessionProxy.addClient(transport)` with `void`, discarding the returned
 * Promise. When a raw (unhandshaked / garbage-bytes / instant-close)
 * connection arrives the handshake inside `addClient` rejects with a
 * `HandshakeError`. Without a `.catch()` the rejected Promise becomes an
 * UNHANDLED PROMISE REJECTION — and in Node ≥ 22 the process exits on the
 * first unhandled rejection. That takes down every session the daemon is
 * serving (a single malformed connection is a denial-of-service).
 *
 * # Fix
 *
 * The entry point's UDS accept loop (`session-proxy-entry.ts`) must catch the
 * `addClient` rejection and log it per-connection. The catch must be specific
 * to the connection path — not a silent global catch-all — so real errors
 * (pipeline failures, etc.) still surface.
 *
 * # Tests
 *
 * U1. A raw (instant-close) transport causes `addClient` to reject with
 *     `HandshakeError{code: "transport.closed"}`.
 * U2. After a bad connection's rejection, the ControlServer's client count
 *     is 0 — the bad connection was NOT added to the client set.
 * U3. A good client can still connect successfully after a bad one rejects —
 *     the server is unaffected.
 * U4. Per-connection error catch (the fix pattern) swallows only the
 *     `HandshakeError` from the bad connection and does not affect a concurrent
 *     good client's handshake.
 *
 * # Transport timing note
 *
 * The in-memory transport fires close synchronously. The handshake
 * (`runServerHandshake`) registers its `onClose` handler synchronously in its
 * first synchronous turn (before the deferred send). Therefore:
 *
 *   const addPromise = server.addClient(dt);   // registers onClose handler
 *   ct.close();                                // fires onClose → HandshakeError
 *   await addPromise;                          // → rejects with HandshakeError
 *
 * This is the correct sequence — start `addClient` FIRST, then close the
 * transport.
 *
 * @module runtime/raw-connection.test
 */
export {};
//# sourceMappingURL=raw-connection.test.d.ts.map