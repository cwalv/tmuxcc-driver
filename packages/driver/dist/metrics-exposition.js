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
/**
 * Extract the metric (family) name from a sample or header line.
 *
 * - Header lines: `# HELP <name> ...` / `# TYPE <name> <type>` → `<name>`.
 * - Sample lines: `<name>{labels} value` or `<name> value` → `<name>`.
 *   Histogram/summary sample lines carry a suffix (`_bucket`, `_sum`,
 *   `_count`); we return the FULL sample-line metric token (e.g.
 *   `h_seconds_bucket`) and rely on the TYPE/HELP header (which uses the base
 *   name) to drive de-dup — so we key families by the header name and attach
 *   samples to the family whose header name is a prefix.  In practice
 *   prom-client always emits the HELP/TYPE header immediately before a
 *   family's samples, so we group by "the most recent header name".
 */
function sampleMetricName(line) {
    const braceIdx = line.indexOf("{");
    const spaceIdx = line.indexOf(" ");
    let end = line.length;
    if (braceIdx >= 0)
        end = Math.min(end, braceIdx);
    if (spaceIdx >= 0)
        end = Math.min(end, spaceIdx);
    return line.slice(0, end);
}
/**
 * Parse a Prometheus text exposition into ordered families keyed by HELP/TYPE
 * header name.  prom-client always emits, per family, an optional `# HELP`,
 * an optional `# TYPE`, then the family's sample lines, separated by blank
 * lines — so a state machine that opens a new family on each `# HELP`/`# TYPE`
 * header (or on the first sample with a new base name) reconstructs them
 * faithfully.
 */
function parseExposition(text) {
    const families = new Map();
    let current = null;
    const ensure = (name) => {
        let fam = families.get(name);
        if (fam === undefined) {
            fam = { help: null, type: null, samples: [] };
            families.set(name, fam);
        }
        return fam;
    };
    for (const rawLine of text.split("\n")) {
        const line = rawLine;
        if (line.length === 0)
            continue;
        if (line.startsWith("# HELP ")) {
            const name = line.slice("# HELP ".length).split(" ")[0] ?? "";
            current = name;
            ensure(name).help = line;
            continue;
        }
        if (line.startsWith("# TYPE ")) {
            const name = line.slice("# TYPE ".length).split(" ")[0] ?? "";
            current = name;
            ensure(name).type = line;
            continue;
        }
        if (line.startsWith("#"))
            continue; // stray comment — ignore
        // Sample line.  Attach to the current header family if the sample name
        // starts with it (histogram `_bucket`/`_sum`/`_count` suffixes); else open
        // a header-less family keyed by the sample's own metric name.
        const sName = sampleMetricName(line);
        if (current !== null && sName.startsWith(current)) {
            ensure(current).samples.push(line);
        }
        else {
            current = sName;
            ensure(sName).samples.push(line);
        }
    }
    return families;
}
/**
 * Inject a `session="<id>"` label into a single sample line.
 *
 * `<name>{a="1"} 2`  → `<name>{session="<id>",a="1"} 2`
 * `<name> 2`         → `<name>{session="<id>"} 2`
 *
 * The label value is a server-proxy-minted session id (`s<N>`) — no escaping
 * needed (it never contains `"` / `\` / newline), but we still escape
 * defensively to keep the exposition well-formed if the id shape ever changes.
 */
function injectSessionLabel(line, sessionId) {
    const esc = sessionId.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const label = `session="${esc}"`;
    const braceIdx = line.indexOf("{");
    if (braceIdx >= 0) {
        const closeIdx = line.indexOf("}", braceIdx);
        const existing = line.slice(braceIdx + 1, closeIdx);
        const sep = existing.length > 0 ? "," : "";
        return `${line.slice(0, braceIdx + 1)}${label}${sep}${existing}${line.slice(closeIdx)}`;
    }
    // No labels: `<name> <value>` → `<name>{session="..."} <value>`.
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx < 0)
        return line; // malformed; pass through untouched
    return `${line.slice(0, spaceIdx)}{${label}}${line.slice(spaceIdx)}`;
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
export function mergeMetricsText(serverProxyText, sessions) {
    const serverFamilies = parseExposition(serverProxyText);
    const out = [];
    // 1. Server-proxy families verbatim (authoritative for the defaults).
    for (const fam of serverFamilies.values()) {
        if (fam.help !== null)
            out.push(fam.help);
        if (fam.type !== null)
            out.push(fam.type);
        for (const s of fam.samples)
            out.push(s);
    }
    // 2. Session families, namespaced.  Emit each family's HELP/TYPE header
    //    exactly once (from the first session that declares it), then the
    //    session-labelled samples from every session.  Skip any family the
    //    server-proxy registry already owns.
    const emittedHeader = new Set();
    // Preserve a stable family order: first appearance across sessions.
    const familyOrder = [];
    const seenFamily = new Set();
    const parsedSessions = sessions.map((s) => ({
        sessionId: s.sessionId,
        families: parseExposition(s.text),
    }));
    for (const ps of parsedSessions) {
        for (const name of ps.families.keys()) {
            if (serverFamilies.has(name))
                continue; // owned by server-proxy
            if (!seenFamily.has(name)) {
                seenFamily.add(name);
                familyOrder.push(name);
            }
        }
    }
    for (const name of familyOrder) {
        for (const ps of parsedSessions) {
            const fam = ps.families.get(name);
            if (fam === undefined)
                continue;
            if (!emittedHeader.has(name)) {
                emittedHeader.add(name);
                if (fam.help !== null)
                    out.push(fam.help);
                if (fam.type !== null)
                    out.push(fam.type);
            }
            for (const s of fam.samples) {
                out.push(injectSessionLabel(s, ps.sessionId));
            }
        }
    }
    return out.join("\n") + "\n";
}
//# sourceMappingURL=metrics-exposition.js.map