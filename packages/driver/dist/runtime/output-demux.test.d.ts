/**
 * Tests for output-demux (tc-fbz, updated tc-128.4).
 *
 * Acceptance: %output for pane N becomes a data-plane frame tagged pane N;
 * bytes are byte-exact (including non-UTF-8 sequences).
 *
 * Strategy: drive the demux's tapped store directly to simulate pane bytes
 * arriving from the runtime pipeline, paired with createInMemoryTransportPair()
 * to verify the client-side onData handler receives the correct (paneId,
 * bytes). Pane tracking is always-on (tc-128.4), so every test calls
 * `notifyPaneBound` for the panes it expects bytes for — exactly what the
 * production wiring in session-proxy.ts does in its onModelChange handler.
 *
 * @module runtime/output-demux.test
 */
export {};
//# sourceMappingURL=output-demux.test.d.ts.map