/**
 * Tests for CommandCorrelator (tc-82a).
 *
 * Acceptance criteria:
 *   - Interleaved notifications + command blocks resolve to the right command.
 *   - Body lines are not misparsed (a body line starting with % stays body).
 *   - %error resolves the command as failed.
 *   - Raw/non-UTF-8 bytes in body are preserved.
 *   - Integration: uses the real ControlTokenizer → CommandCorrelator pipeline.
 */
export {};
//# sourceMappingURL=correlator.test.d.ts.map