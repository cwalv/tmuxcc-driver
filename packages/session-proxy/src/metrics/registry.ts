/**
 * Session-proxy metrics registry (tc-x6l).
 *
 * Standalone prom-client registry + counters for the session-proxy hot path.
 * This module is intentionally free of pipeline/state dependencies so it can
 * be imported by any layer without creating circular deps.
 *
 * # Counters
 *
 * - `topology_events_total{kind}` — one counter per tmux notification kind
 *   (e.g. "layout-change", "window-add", …) for the classification choke
 *   point (pipeline.onNotification / future coalescer.onNotify in tc-128.4).
 * - `commands_issued_total` — tmux commands written to the south-side PTY.
 * - `deltas_fanned_out_total{client}` — model-change deltas sent to each
 *   connected client (keyed by connection index, not identity — clients are
 *   ephemeral).
 *
 * # Histogram
 *
 * - `command_round_trip_seconds` — latency from `host.write(cmd)` to the
 *   matching `%end` block: time the south-side round-trip takes.
 *
 * # Hot-path cost
 *
 * Each topology event: one `Counter.inc()` call — no allocation, no GC.
 * Storm alarm evaluation: on a timer (default 1 s tick), never per-event.
 *
 * @module metrics/registry
 */

import { Registry, Counter, Histogram } from "prom-client";

// ---------------------------------------------------------------------------
// Registry (non-default so it doesn't pollute Node.js process-wide metrics)
// ---------------------------------------------------------------------------

/**
 * A metrics registry scoped to one session-proxy instance.
 *
 * Using a non-default registry ensures multiple in-process session-proxies
 * (tests, integration setups) get independent counter sets and don't
 * accidentally cross-pollinate.
 */
export interface SessionProxyRegistry {
  /**
   * Increment the per-kind topology event counter.
   *
   * This is the call that goes on the hot path (every topology notification).
   * It is safe to call with `undefined` kind — it records under the label
   * value `"unknown"` so no allocation or branch on the fast path.
   *
   * @param kind - tmux notification kind (e.g. "layout-change", "window-add").
   *               Comes from `NotificationEvent.kind` or the coalescer's
   *               `TopologyEventKind`.
   */
  incTopologyEvent(kind: string | undefined): void;

  /**
   * Increment the commands-issued counter.
   *
   * Called once per command written to the south-side host. May be called
   * from the input-path or from pipeline bootstrap.
   */
  incCommandsIssued(): void;

  /**
   * Increment the deltas-fanned-out counter.
   *
   * Called by the serve layer for each delta sent to a specific client.
   * `clientLabel` is an opaque per-connection label (e.g. "c1", "c2") — not
   * a persistent identity, just enough to attribute fan-out volume per slot.
   */
  incDeltasFannedOut(clientLabel: string): void;

  /**
   * Observe one command round-trip latency sample.
   *
   * @param seconds - Duration from `host.write(cmd)` to `%end` receipt, in seconds.
   */
  observeCommandRoundTrip(seconds: number): void;

  /**
   * Render the full registry as Prometheus text exposition format.
   * Returns a Promise<string> to match prom-client's async API.
   */
  metrics(): Promise<string>;

  /**
   * Stop background resources owned by this registry (none currently; here
   * for lifecycle symmetry so callers can stop() without inspecting internals).
   */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh `SessionProxyRegistry` with isolated prom-client counters.
 *
 * Each session-proxy instance should create exactly one registry at startup and
 * keep it for the lifetime of the session. Pass the registry handle down to
 * the pipeline wiring (or inject it into components as needed).
 */
export function createSessionProxyRegistry(): SessionProxyRegistry {
  const reg = new Registry();

  // Per-kind topology event counter.
  // tc-x6l: the `kind` label is the tmux notification keyword stripped of the
  // leading `%` (e.g. "layout-change", "window-add", "window-close").  We
  // strip `%` in incTopologyEvent() so callers can pass `event.kind` directly
  // (the parser already strips `%` — `event.kind === "layout-change"`, not
  // `"%layout-change"`).
  const topologyEventsTotal = new Counter({
    name: "topology_events_total",
    help: "Total topology notification events classified by kind.",
    labelNames: ["kind"],
    registers: [reg],
  });

  const commandsIssuedTotal = new Counter({
    name: "commands_issued_total",
    help: "Total tmux commands written to the south-side PTY.",
    registers: [reg],
  });

  const deltasFannedOutTotal = new Counter({
    name: "deltas_fanned_out_total",
    help: "Total model-change deltas sent to connected clients, by connection slot.",
    labelNames: ["client"],
    registers: [reg],
  });

  // Command round-trip latency histogram (seconds).
  // Buckets sized for typical tmux responses (sub-1ms to ~50ms; storms push to ~100ms).
  const commandRoundTripSeconds = new Histogram({
    name: "command_round_trip_seconds",
    help: "Time from tmux command write to %end receipt, in seconds.",
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
    registers: [reg],
  });

  return {
    incTopologyEvent(kind: string | undefined): void {
      topologyEventsTotal.inc({ kind: kind ?? "unknown" });
    },

    incCommandsIssued(): void {
      commandsIssuedTotal.inc();
    },

    incDeltasFannedOut(clientLabel: string): void {
      deltasFannedOutTotal.inc({ client: clientLabel });
    },

    observeCommandRoundTrip(seconds: number): void {
      commandRoundTripSeconds.observe(seconds);
    },

    async metrics(): Promise<string> {
      return reg.metrics();
    },

    stop(): void {
      // Nothing to stop currently. Placeholder for lifecycle symmetry.
    },
  };
}
