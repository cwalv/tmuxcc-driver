/**
 * Size-ownership policy unit tests — tc-76m8.3 (S3 "Geometry among peers").
 *
 * Drives {@link createSizeOwnershipPolicy} directly with a synthetic clock so
 * the debounce is deterministic (no real-time sleeps). Proves the two AC
 * behaviors precisely — alternation moves ownership after the debounce window;
 * rapid interleaved activity does not oscillate — plus the candidate/handoff
 * bookkeeping the session-proxy relies on.
 */
export {};
//# sourceMappingURL=size-ownership.test.d.ts.map