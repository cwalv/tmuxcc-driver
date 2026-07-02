/**
 * tc-4sg — Hot-path throughput benchmark.
 *
 * Measures MB/s for sub-stages of the %output hot path:
 *   1. tokenizer.push()      — raw bytes → NotificationToken (with rawLine)
 *   2. decodeOutputPayload() — octal-escaped payload → raw pane bytes
 *   3. scrollback.append()   — raw bytes → PaneBufferStore chunk list
 *   4. full pipeline         — tokenize → decode → append (through demux tap)
 *
 * NOT a correctness test — numbers are logged, not asserted tightly.
 * Asserts only:
 *   - Benchmark completes (no throw)
 *   - Decoded byte count is positive and plausible
 *
 * Bounded input: ~8 MB of synthetic %output lines → completes in seconds.
 * Safe to run in CI (no tight timing assertions).
 *
 * @module runtime/perf-bench.test
 */
export {};
//# sourceMappingURL=perf-bench.test.d.ts.map