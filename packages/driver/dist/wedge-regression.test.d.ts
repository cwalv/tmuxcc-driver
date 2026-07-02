/**
 * wedge-regression.test.ts — tc-7xv.24 regression: real-socket backpressure.
 *
 * # What this verifies
 *
 * The wedge bug (tc-7xv.24): under sustained high-throughput pane output
 * (e.g. `find /` in a tmuxcc terminal) the pty wedged because the server-proxy's
 * `SocketTransport.sendData` ignored Node's backpressure return value.  When
 * the consumer was slow:
 *
 *   1. tmux fired %output bytes into the session-proxy pipeline.
 *   2. demux.store.append called transport.sendData.
 *   3. socket.write returned false (kernel send buffer full).
 *   4. SocketTransport ignored the return value (fire-and-forget).
 *   5. sessionProxy.addClient wrapper called fc.noteDrained immediately, crediting
 *      the bytes as drained the instant they entered the kernel send buffer.
 *   6. fc.bufferedBytes never grew → high-water never crossed → tmux never
 *      paused → session-proxy's outbound buffer grew without bound until V8 stalled.
 *
 * The fix (tc-7xv.6):
 *
 *   - SocketTransport.sendData returns Promise<void> when socket.write returns
 *     false.  The promise resolves on the socket's 'drain' event.
 *   - sessionProxy.addClient's wrapper chains fc.noteDrained off that promise so the
 *     drain credit fires only after actual consumer consumption.
 *   - Now fc.bufferedBytes accurately reflects in-flight bytes; under a slow
 *     consumer it crosses high-water and tmux is correctly told to pause.
 *
 * # How this test works (no real tmux required)
 *
 * We build a fake TmuxHost that records writes (so we can observe pause /
 * continue commands) plus a real SocketTransport pair (Unix domain sockets).
 * The consumer side pauses its socket (`sock.pause()`), simulating a stalled
 * VS Code extension.  We then call demux.store.append directly with byte
 * batches and assert:
 *
 *   1. fc.bufferedBytes grows past high-water (because drain is gated by the
 *      blocked socket).
 *   2. The fake host receives a pause command (refresh-client -A '%pane:pause').
 *   3. After we resume the consumer side, the socket drains; fc.noteDrained
 *      fires and tmux is told to continue.
 *
 * @module runtime/wedge-regression.test
 */
export {};
//# sourceMappingURL=wedge-regression.test.d.ts.map