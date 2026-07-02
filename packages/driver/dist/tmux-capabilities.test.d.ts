/**
 * tmux-capabilities.test.ts — unit + live-probe tests for the tmux capability
 * model (tc-4b6k.12 D9).
 *
 * # Unit tests (no tmux required)
 *
 * - parseTmuxVersion: covers the expected `tmux -V` output formats.
 * - compareTmuxVersion: ordering of major, minor, and patch-letter versions.
 * - deriveCapabilities: spot-checks that each capability's version floor maps
 *   correctly for below-floor, at-floor, and above-floor versions.
 *
 * # Live-probe test (requires tmux on PATH)
 *
 * - probeTmuxCapabilities: verifies the round-trip against the real binary;
 *   skipped when tmux is unavailable.
 *
 * @module tmux-capabilities.test
 */
export {};
//# sourceMappingURL=tmux-capabilities.test.d.ts.map