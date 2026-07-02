/**
 * Integration tests for the pane.notify pipeline (tc-76m8.1, S9).
 *
 * Drives the REAL RuntimePipeline (fake tmux host) end-to-end: a `%output`
 * frame carrying an escape → the escape scanner → the rate limiter → the
 * onPaneNotify seam + the metrics counters. Asserts the load-bearing contracts:
 *   - pane.notify fires for BOTH bound and unbound panes (the driver is the
 *     sole observer of unbound panes).
 *   - the render path is byte-identical (the scanned bytes reach the pane
 *     buffer untouched — a BEL still flows through to light the native bell).
 *   - a storm is rate-limited and the Tier-1 drop tripwire fires (loud + metric).
 */
export {};
//# sourceMappingURL=notify-pipeline.test.d.ts.map