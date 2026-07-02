/**
 * metrics-exposition.test.ts — unit tests for the `/metrics` text merge
 * (tc-44u4.4).
 *
 * Verifies that `mergeMetricsText` produces ONE valid Prometheus exposition
 * from the server-proxy registry plus N per-session registries:
 *   - server-proxy default families (`process_*` / `nodejs_*`) stay singletons;
 *   - identically-named session families become per-session series under one
 *     HELP/TYPE header, namespaced by an injected `session="<id>"` label;
 *   - histograms (bucket/sum/count) and label-bearing samples are namespaced
 *     correctly.
 *
 * These are the cases that make `Registry.merge` throw — see the module header
 * for why text-level namespacing is the chosen approach.
 *
 * @module metrics-exposition.test
 */
export {};
//# sourceMappingURL=metrics-exposition.test.d.ts.map