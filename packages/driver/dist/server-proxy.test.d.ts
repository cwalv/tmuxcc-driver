/**
 * server-proxy.test.ts — integration + race tests for the tmuxcc-broker.
 *
 * # Test categories
 *
 * ## Unit / handshake tests (always run)
 *
 * U1. ServerProxy starts, accepts a connection, runs handshake, sends snapshot.
 *
 * ## Integration tests (guarded by tmux availability)
 *
 * I1. spawn a server-proxy on a test socket, connect as a client, receive snapshot.
 * I2. session.claim creates a session + session-proxy + returns endpoint + created=true.
 * I3. session.claim on existing session returns same endpoint, created=false.
 * I4. session.create fails if name is already taken.
 * I5. session.destroy kills session + reaps session-proxy.
 * I6. sessions.added delta is pushed to subscribers after session.claim.
 * I7. Connect to session-proxy endpoint, run snapshot + input round-trip (session-proxy wire).
 *
 * ## Race test
 *
 * R1. 10 concurrent session.claim requests for the same name all receive
 *     the same sessionId + endpoint; only one session-proxy process is spawned;
 *     exactly one response reports created=true (tc-3y8.2).
 *
 * # Cleanup
 *
 * Each test creates its own server-proxy with a unique test socket name
 * (tmuxcc-test-sp-<N>-<ts>) and calls serverProxy.shutdown() in afterEach.
 *
 * @module serverProxy.test
 */
export {};
//# sourceMappingURL=server-proxy.test.d.ts.map