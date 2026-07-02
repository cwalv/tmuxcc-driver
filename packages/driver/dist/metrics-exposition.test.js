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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import promClient from "prom-client";
import { mergeMetricsText } from "./metrics-exposition.js";
const { Registry, Counter, Gauge, Histogram } = promClient;
/** Build a session-shaped registry with the wedge-signal gauge + a labelled counter. */
function makeSessionReg(seed) {
    const reg = new Registry();
    new Gauge({
        name: "correlator_pending_slot_max_age_seconds",
        help: "oldest pending slot age",
        registers: [reg],
    }).set(seed.age);
    new Counter({
        name: "topology_events_total",
        help: "topology events by kind",
        labelNames: ["kind"],
        registers: [reg],
    }).inc({ kind: "layout-change" }, seed.events);
    // A default-style family that ALSO appears on the server-proxy registry —
    // must be dropped from the merged session output (server-proxy owns it).
    new Gauge({ name: "process_resident_memory_bytes", help: "rss", registers: [reg] }).set(1);
    return reg;
}
describe("mergeMetricsText (tc-44u4.4)", () => {
    it("namespaces same-named session families by session label under one header", async () => {
        const server = new Registry();
        new Counter({ name: "server_proxy_commands_total", help: "cmds", labelNames: ["kind"], registers: [server] }).inc({ kind: "session.claim" }, 3);
        new Gauge({ name: "process_resident_memory_bytes", help: "rss", registers: [server] }).set(42);
        const s1 = makeSessionReg({ age: 0.1, events: 5 });
        const s2 = makeSessionReg({ age: 2.5, events: 9 });
        const merged = mergeMetricsText(await server.metrics(), [
            { sessionId: "s1", text: await s1.metrics() },
            { sessionId: "s2", text: await s2.metrics() },
        ]);
        // One HELP + one TYPE for the shared session family.
        assert.equal((merged.match(/^# HELP correlator_pending_slot_max_age_seconds /gm) ?? []).length, 1, "exactly one HELP line for the wedge gauge");
        assert.equal((merged.match(/^# TYPE correlator_pending_slot_max_age_seconds /gm) ?? []).length, 1);
        // Per-session series with injected label.
        assert.match(merged, /correlator_pending_slot_max_age_seconds\{session="s1"\} 0\.1/);
        assert.match(merged, /correlator_pending_slot_max_age_seconds\{session="s2"\} 2\.5/);
        // Existing labels are preserved alongside the injected session label.
        assert.match(merged, /topology_events_total\{session="s1",kind="layout-change"\} 5/);
        assert.match(merged, /topology_events_total\{session="s2",kind="layout-change"\} 9/);
    });
    it("keeps the server-proxy default families singleton (drops the session copies)", async () => {
        const server = new Registry();
        new Gauge({ name: "process_resident_memory_bytes", help: "rss", registers: [server] }).set(42);
        const s1 = makeSessionReg({ age: 0.1, events: 5 });
        const s2 = makeSessionReg({ age: 0.2, events: 6 });
        const merged = mergeMetricsText(await server.metrics(), [
            { sessionId: "s1", text: await s1.metrics() },
            { sessionId: "s2", text: await s2.metrics() },
        ]);
        // The server-proxy's value is authoritative and the session copies are gone.
        assert.equal((merged.match(/^# HELP process_resident_memory_bytes /gm) ?? []).length, 1);
        assert.match(merged, /^process_resident_memory_bytes 42$/m);
        // No session-namespaced copy of the default family.
        assert.doesNotMatch(merged, /process_resident_memory_bytes\{session=/);
    });
    it("namespaces histogram bucket/sum/count sample lines", async () => {
        const server = new Registry();
        const s1 = new Registry();
        new Histogram({ name: "command_round_trip_seconds", help: "rtt", buckets: [0.001, 0.01], registers: [s1] }).observe(0.005);
        const merged = mergeMetricsText(await server.metrics(), [
            { sessionId: "s1", text: await s1.metrics() },
        ]);
        assert.match(merged, /command_round_trip_seconds_bucket\{session="s1",le="0\.01"\} 1/);
        assert.match(merged, /command_round_trip_seconds_sum\{session="s1"\}/);
        assert.match(merged, /command_round_trip_seconds_count\{session="s1"\} 1/);
    });
    it("ends with a trailing newline and handles zero sessions", async () => {
        const server = new Registry();
        new Counter({ name: "server_proxy_connections_total", help: "c", registers: [server] }).inc(2);
        const merged = mergeMetricsText(await server.metrics(), []);
        assert.match(merged, /server_proxy_connections_total 2/);
        assert.ok(merged.endsWith("\n"));
    });
});
//# sourceMappingURL=metrics-exposition.test.js.map