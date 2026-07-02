/**
 * Metrics exposition merge (tc-44u4.4).
 *
 * The `/metrics` HTTP surface (and the same merge reused by future readers)
 * must present ONE Prometheus text exposition that combines:
 *
 *   1. the server-proxy registry (`createServerProxyMetrics()` —
 *      `server_proxy_*` plus the canonical `process_*` / `nodejs_*` default
 *      process metrics), and
 *   2. every live per-session registry (`createSessionProxyRegistry()` — the
 *      `topology_*` / `correlator_*` / `flow_*` / `requery_*` families, plus
 *      its OWN copy of the `process_*` / `nodejs_*` defaults).
 *
 * # Why not `Registry.merge`
 *
 * prom-client's `Registry.merge([...])` (and `AggregatorRegistry`) THROW on a
 * duplicate metric NAME across the input registries
 * (`Error: A metric with the name <x> has already been registered.`).  Every
 * session-proxy registry re-declares the SAME session-metric names AND the same
 * `collectDefaultMetrics()` families, so merging two-or-more session registries
 * is structurally impossible — `merge` is a one-registry-per-name union, not an
 * aggregator-by-label.  (Verified against prom-client 15.x.)
 *
 * # The chosen approach: per-session `session` label, default-dedup
 *
 * We namespace at the TEXT-exposition layer instead:
 *
 *   - The server-proxy registry is emitted verbatim and owns the singleton
 *     `process_*` / `nodejs_*` default families (the server-proxy is one
 *     process per machine post-tc-2x3, so its event-loop lag / RSS / CPU are
 *     THE process health signal — the per-session copies are redundant).
 *   - Each session registry's exposition has a `session="<sessionId>"` label
 *     injected into every sample line, so identically-named session families
 *     (`topology_events_total`, `correlator_pending_slot_max_age_seconds`, …)
 *     become per-session series under one family with one HELP/TYPE header.
 *   - Any family the server-proxy registry already emitted (the default
 *     `process_*` / `nodejs_*`, and the `server_proxy_*` families) is DROPPED
 *     from the session exposition — keeping the defaults singletons and
 *     avoiding duplicate HELP/TYPE lines that would make the exposition
 *     unparseable.
 *
 * This is the standard "federate text exposition" technique and needs nothing
 * from prom-client beyond the `metrics(): Promise<string>` each registry
 * already exposes — so it stays decoupled from `SessionProxyRegistry`
 * internals.
 *
 * @module metrics-exposition
 */
/** One session registry's rendered exposition plus the id to namespace it by. */
export interface SessionExposition {
    /** Stable server-proxy-assigned session id (e.g. `"s1"`). */
    sessionId: string;
    /** The Prometheus text exposition from that session's registry. */
    text: string;
}
/**
 * Merge the server-proxy registry exposition with N per-session registry
 * expositions into one valid Prometheus text exposition.
 *
 * - The server-proxy text is authoritative for any family it declares
 *   (the `process_*` / `nodejs_*` defaults and the `server_proxy_*` families).
 *   Those families are emitted verbatim and the same-named families from the
 *   session expositions are DROPPED.
 * - Session-only families (`topology_*`, `correlator_*`, `flow_*`,
 *   `requery_*`, `deltas_*`, `output_*`, `session_*`, `command_round_trip_*`)
 *   are emitted once with their HELP/TYPE header, carrying one series per
 *   session via an injected `session="<id>"` label.
 *
 * Output ends with a trailing newline (Prometheus text format requirement).
 */
export declare function mergeMetricsText(serverProxyText: string, sessions: readonly SessionExposition[]): string;
//# sourceMappingURL=metrics-exposition.d.ts.map