# tmuxcc-driver — agent orientation

tmuxcc-driver is the stateful protocol adapter between tmux control-mode and
any number of frontends. It owns two process roles (post-tc-2x3 collapse,
one process per machine):

- **server-proxy** (`packages/server-proxy/`) — per-server broker: unix socket
  listener, session table, session-proxy supervisor, watcher (`tmux -CC`
  north-side), idle/tmux-gone self-exit policy.
- **session-proxy** (`packages/session-proxy/`) — per-session adapter: speaks
  `tmux -CC` attach, holds the fold (bootstrap + reducer), serves snapshot +
  ordered deltas to N clients over a per-session unix socket.

Before tc-2x3 these were separate processes. After the collapse each
`createSessionProxy(...)` call runs IN-PROCESS inside the server-proxy's own
event loop; the per-session unix sockets and wire protocol are byte-identical.

## Build and test

Build and install from the workspace root (the `preinstall`/`prebuild` guards
in each package reject non-root invocations):

```
npm install          # from workspace root
npm run build -w @tmuxcc/session-proxy && npm run build -w @tmuxcc/server-proxy
```

Per-package test layers:

| Package | Command | Notes |
|---|---|---|
| `@tmuxcc/server-proxy` | `npm run test -w @tmuxcc/server-proxy` | Unit + integration. |
| `@tmuxcc/session-proxy` | `npm run test:unit -w @tmuxcc/session-proxy` | Unit only (no real tmux). |
| `@tmuxcc/session-proxy` | `npm run test:real-tmux -w @tmuxcc/session-proxy` | Real-tmux suites — a flake is a **correctness signal, not noise**. Run with `--test-concurrency=1`. |
| `@tmuxcc/session-proxy` | `npm run test:soak -w @tmuxcc/session-proxy` | N-run soak for the real-tmux suites (`ci:soak`). |

The `ci` script in each package is `build + typecheck + test + lint:boundaries`.
Boundary lint enforces the parser/runtime/state/wire layering (see
`.dependency-cruiser.cjs`).

## Wire protocol

Clients first connect to the server-proxy socket (capability handshake, then
session snapshot + session-added/removed deltas, then command/response). For a
claimed session they receive a per-session socket path and connect there for the
session-proxy protocol (topology snapshot + deltas + data-plane frames). The
authoritative shape is `protocol/` and `packages/session-proxy/SCHEMA.md`.

## Where things live

- `docs/` — design docs (`observability.md`, `state-model.md`, `perf.md`).
- `protocol/` — language-neutral wire protocol schemas and conformance material.
- `packages/server-proxy/src/metrics.ts` — server-proxy prom-client registry.
- `packages/session-proxy/src/metrics/registry.ts` — session-proxy registry
  (all per-session counters and histograms).

---

## Observability

### How metrics are surfaced

Both process roles emit Prometheus text exposition via a `metricsText()` call
on their respective registries. The text is included in:

- **`server-proxy.info`** wire command response — `ServerProxyInfoPayload.metricsText`
  (string | null). Issued against the server-proxy socket.
- **`session-proxy.info`** wire command response — `SessionProxyInfoPayload.metricsText`
  (string). Issued against the per-session socket.

The **authoritative expected-shape table** — covering every metric with its
healthy steady-state shape, deviation diagnosis, and alert wiring — lives in
`docs/observability.md`. This section is a working reference; defer to that doc
for full detail.

### Existing metrics — LATENCY

| Metric | Registry | What it measures |
|---|---|---|
| `nodejs_eventloop_lag_seconds` | server-proxy (default metrics) | Cross-cutting health signal for the one-process-per-machine model; one session's firehose contends with every session's latency post-tc-2x3. |
| `command_round_trip_seconds{kind}` | session-proxy | `host.write(cmd)` → `%end` block latency for tmux commands (south-side only). Kind = first token of the command line (e.g. `list-windows`). Expected ~0.5–1 ms tight mode. |
| `topology_notify_to_delta_seconds{edge}` | session-proxy | Coalescer `notify(kind)` arrival → matching delta broadcast per cycle edge (`leading` \| `trailing` \| `heartbeat`). The keystone interactive metric; bimodal by design: leading ~1–2 ms, trailing bounded by ceiling ~1 s. |
| `requery_round_trip_seconds` | session-proxy | `list-windows`/`list-panes` round-trip at the requery engine. Separate population from `command_round_trip_seconds` for cleaner tail analysis. |
| `output_frame_size_bytes` | session-proxy | Per-frame `%output`/`%extended-output` payload size (aggregate, no per-pane label). |
| `session_paused_seconds_total` | session-proxy | Wall-clock seconds any pane in the session was flow-control-paused. |

### Existing metrics — CORRECTNESS / LIFECYCLE

| Metric | Registry | What it measures |
|---|---|---|
| `server_proxy_commands_total{kind}` | server-proxy | Server-proxy wire commands received by kind. |
| `server_proxy_connections_total` / `server_proxy_connections_active` | server-proxy | IPC connection accepts / current open count. |
| `server_proxy_sessions_active` | server-proxy | Current session count gauge. |
| `topology_events_total{kind}` | session-proxy | Tmux topology notifications by kind; feeds the storm alarm. |
| `commands_issued_total` | session-proxy | Tmux commands written to the south-side PTY. |
| `deltas_emitted_total` | session-proxy | Wire deltas produced per pipeline cycle (denominator of fan-out ratio). |
| `deltas_fanned_out_total{client}` | session-proxy | Deltas delivered per connected client slot (numerator). Invariant: ratio = attached-client count. |
| `output_bytes_total` | session-proxy | Decoded `%output`/`%extended-output` bytes, aggregate. |
| `session_boundary_trips_total` | session-proxy | Per-session error-boundary trips (pipeline threw; session recycled). Expected-zero tripwire. |
| Expected-zero tripwires (see `docs/observability.md` §3.7) | session-proxy | `requery_teardown_confirmations_total{outcome="refuted"}`, `requery_budget_exhausted_total`, `correlator_unsolicited_blocks_total`, `output_pretopology_dropped_bytes_total{provenance="owned"}`, `flow_drain_clamped_total`, `flow_commands_failed_total{kind}`, `resyncs_total{cause="escalation"}` — each co-located with a loud stderr log. |

### Conventions when adding new metrics

1. **prom-client, bounded labels.** Use `Counter`, `Histogram`, or `Gauge`
   from `prom-client` on the appropriate non-default `Registry` instance
   (`createServerProxyMetrics()` or `createSessionProxyRegistry()`).
   Labels must be bounded vocabulary — per-pane labels are forbidden (unbounded
   pane-id space). See cardinality rule in `docs/observability.md` §2.
2. **Expected-zero tripwires get a co-located loud log.** Any counter whose
   expected steady-state value is zero must also emit a `process.stderr.write`
   line on every increment (the alarm side). Do NOT rely on a metrics reader
   being attached. See `requery_budget_exhausted_total` in `state/requery.ts`
   and `correlator_unsolicited_blocks_total` in `parser/correlator.ts` for the
   pattern.
3. **Histograms get documented buckets.** Bucket sets live as named constants
   in the registry module (e.g. `COMMAND_RTT_BUCKETS`, `NOTIFY_TO_DELTA_BUCKETS`
   in `metrics/registry.ts`) and are referenced in tests so a bucket change is
   a reviewable diff.
4. **Add a row to `docs/observability.md`.** The doc is the single source of
   truth for expected shapes and deviation meanings. Both the implementation
   JSDoc and the doc row should say the same thing; divergence = one is stale.

### Known gap: activation / claim path is un-timed

The entire session-activation path — from `_doClaimSession` in `server-proxy.ts`
through `supervisor.ensureSessionProxy` in `session-proxy-supervisor.ts`
(which spans `tmux -CC attach`, bootstrap requery, and first snapshot send in
`serve.ts addClient`) — has **zero phase timing in any metric**. Every existing
latency metric is either a steady-state tmux-leg RTT or a topology counter.

This was the root gap in the tc-jlyi RCA: a 6–7 s stall lived entirely inside
`await this._supervisor.ensureSessionProxy(...)` (server-proxy.ts ~1397) with
no way to tell which phase (attach / bootstrap / handshake / snapshot) was slow
without hand-instrumentation.

Beads filed to close this gap:

- **tc-is5w** (P1) — `sessionproxy_claim_to_snapshot_seconds{phase}`:
  phase-split histogram of the full activation path (claim_total / ensure /
  create / start / first_snapshot). Turns any future stall into a one-read
  diagnosis.
- **tc-edf8** (P2) — `socketfeed_sendcontrol_queue_depth` + `socketfeed_time_in_queue_seconds`:
  socket-transport backpressure observability (distinguishes slow producer
  from backpressured consumer).
- **tc-bn7d** (P2) — `rpc_round_trip_seconds{kind}`: the full application-leg
  RPC histogram (worker→extHost→reply), distinct from the tmux-only
  `command_round_trip_seconds`. Would have shown `session.claim` at 6700 ms
  while tmux RTT read ~1 ms.
- **tc-m2y8** (P3) — broker lifecycle counters (`server_proxy_self_exit_total`,
  `watcher_eof_total`, `watcher_respawns_total`, `session_boundary_quarantined_total`)
  that are currently log-only. Parent tracking bead: **tc-mbu3**.
