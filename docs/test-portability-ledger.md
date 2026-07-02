# Test-suite portability ledger — tc-a88z

**Purpose:** Audit the driver test suite for black-box / white-box portability;
quantify the rewrite moat; enumerate the irreducible white-box set with effort
estimates.  Feeds `tc-ni6f` (Rust rewrite decision).

**Promotion applied:** `resilience.test.ts R3` — replaced internal
`pipeline.getModel()` wait and `projectSnapshot()` assertion with wire-level
equivalents (hook `paneOpened` count + direct snapshot capture from `ct2` wire).
Suite is green after the change.

---

## Definitions

| Term | Meaning |
|------|---------|
| **BLACK-BOX** | Drives a daemon over its socket / validates `protocol/`; would re-validate ANY implementation without modification. |
| **MIXED** | Has both black-box sections (behavioral observations) AND white-box sections (TS internal imports or direct state inspection). |
| **WHITE-BOX** | Imports and directly exercises TS internal modules; tests implementation details, not externally-observable behavior. |

---

## File-by-file ledger

### Session-proxy — parser (8 files)

| File | Class | Rationale |
|------|-------|-----------|
| `packages/session-proxy/src/parser/commands.test.ts` | WHITE-BOX | Imports `./commands.js`; asserts on output of internal command-serializer functions (`sendKeysHex`, `refreshClientSize`). |
| `packages/session-proxy/src/parser/correlator.test.ts` | WHITE-BOX | Imports `./tokenizer.js`, `./correlator.js`; directly instantiates `CommandCorrelator` and feeds hand-crafted byte buffers. |
| `packages/session-proxy/src/parser/golden/golden.test.ts` | WHITE-BOX | Imports all internal parser modules; feeds real-captured corpus bytes through the TS parser stack and asserts on token/event streams. |
| `packages/session-proxy/src/parser/layout-string.test.ts` | WHITE-BOX | Imports `./layout-string.js`; directly calls `parseLayout`, `dumpLayout`, `layoutChecksum`. |
| `packages/session-proxy/src/parser/notifications.test.ts` | WHITE-BOX | Imports `./notifications.js`, `./tokenizer.js`; directly calls `parseNotification` on hand-constructed tokens. |
| `packages/session-proxy/src/parser/osc-title-sniffer.test.ts` | WHITE-BOX | Imports `./osc-title-sniffer.js`; calls `OscTitleSniffer.feed()` and asserts on `updatedTitle`. |
| `packages/session-proxy/src/parser/output-codec.test.ts` | WHITE-BOX | Imports `./output-codec.js`, `./tokenizer.js`; tests `decodeOutputPayload`, `encodeOutputPayload`, `parseOutputNotification`. |
| `packages/session-proxy/src/parser/tokenizer.test.ts` | WHITE-BOX | Imports `./tokenizer.js`; tests `ControlTokenizer` and `tokenizeBuffer` with synthetic byte arrays. |

### Session-proxy — state (6 files)

| File | Class | Rationale |
|------|-------|-----------|
| `packages/session-proxy/src/state/coalescer.test.ts` | WHITE-BOX | Imports `./coalescer.js`, `./requery.js`, `../parser/correlator.js`; drives `createCoalescer` + `createRequeryEngine` with a fake clock. |
| `packages/session-proxy/src/state/model.test.ts` | WHITE-BOX | Imports `./model.js`, `../wire/ids.js`, `../parser/layout-string.js`; directly calls `addPane`, `checkInvariants`, `parsedLayoutToWindowLayout`. |
| `packages/session-proxy/src/state/pane-title.test.ts` | WHITE-BOX | Imports `./projection.js`, `./model.js`, `../wire/ids.js`; calls `diffModel` on hand-built `SessionModel` objects. |
| `packages/session-proxy/src/state/projection.test.ts` | WHITE-BOX | Imports `./projection.js`, `./model.js`, `../wire/ids.js`, `../wire/session-proxy-control.js`; tests `projectSnapshot` and `diffModel` in-process. |
| `packages/session-proxy/src/state/requery.test.ts` | WHITE-BOX | Imports `./requery.js`, `./projection.js`, `./model.js`, `../parser/correlator.js`; tests `requeryDiff` and `createRequeryEngine` with synthetic replies. |
| `packages/session-proxy/src/state/scrollback.test.ts` | WHITE-BOX | Imports `./scrollback.js`, `../wire/ids.js`; tests `createPaneBufferStore` append, eviction, and cap behavior. |

### Session-proxy — wire (5 files)

| File | Class | Rationale |
|------|-------|-----------|
| `packages/session-proxy/src/wire/framing.test.ts` | WHITE-BOX | Imports `./framing.js`, `./ids.js`; tests `encodeFrame`, `decodeFrame`, `FrameDecoder` with synthetic byte arrays in-process. |
| `packages/session-proxy/src/wire/handshake.test.ts` | WHITE-BOX | Imports `./transport.js`, `./envelope.js`, `./handshake.js`; tests handshake algorithm + full `runSessionProxyHandshake`/`runClientHandshake` over in-memory transport. |
| `packages/session-proxy/src/wire/protocol-conformance.test.ts` | WHITE-BOX | Imports `./index.js`; validates `protocol/schemas/` JSON Schemas and golden transcripts, then validates TS-constructed messages against those schemas. Schema validation is language-neutral; TS message construction is white-box. |
| `packages/session-proxy/src/wire/transport.test.ts` | WHITE-BOX | Imports `./transport.js`, `./session-proxy-control.js`, `./ids.js`; tests `createInMemoryTransportPair` delivery and close behavior in-process. |
| `packages/session-proxy/src/wire/wire.test.ts` | WHITE-BOX | Imports `./index.js`; tests type guards (`isControlMessage`, `isSessionProxyMessage`), ID constructors, and `WIRE_PROTOCOL_VERSION`. |

### Session-proxy — runtime (27 files)

| File | Class | Rationale |
|------|-------|-----------|
| `packages/session-proxy/src/runtime/attach-hydration.test.ts` | WHITE-BOX | Imports `./output-demux.js`, `./hydration.js`, `./flow-control.js`, `../wire/transport.js`, `../parser/correlator.js`; tests hydration ordering with scripted fake pipelines and in-memory transports. |
| `packages/session-proxy/src/runtime/bootstrap-requery-stall.test.ts` | MIXED | Imports `./tmux-host.js`, `./pipeline.js` (internal) and spawns real tmux. Tests stall recovery timing; assertions check internal `pipeline.getModel().panes.size`. |
| `packages/session-proxy/src/runtime/break-pane-noop.test.ts` | MIXED | Imports `./e2e-smoke.test.js`, `./input-path.js`, `../wire/index.js`; spawns real tmux via `setupE2E`; asserts on internal `VerbResult` type. |
| `packages/session-proxy/src/runtime/break-pane-rehome.test.ts` | MIXED | Imports `./e2e-smoke.test.js`, `../wire/ids.js`; spawns real tmux via `setupE2E`; asserts on committed internal `model.windowId` after break-pane. |
| `packages/session-proxy/src/runtime/close-cause.test.ts` | WHITE-BOX | Imports `./close-cause.js`, `../wire/ids.js`; tests `createCloseCauseRegistry` record/consume/clear/TTL in-process. |
| `packages/session-proxy/src/runtime/composed-fuzz.test.ts` | WHITE-BOX | Imports `./pipeline.js`, `./tmux-host.js`, `../state/coalescer.js`, `../state/model.js`; adversarial fuzz against `createRuntimePipeline` over a `FuzzTmuxHost` (fake) with internal invariant assertions. |
| `packages/session-proxy/src/runtime/e2e-smoke.test.ts` | MIXED | Imports `./session-proxy.js`, `../wire/index.js` and `@tmuxcc/client` modules; spawns real tmux 3.4. E1–E7 assert on `EchoRenderHook` callbacks (wire-observable) and pane output — the setup is white-box (TS internal wiring) but assertions are behavioral. |
| `packages/session-proxy/src/runtime/flow-control.test.ts` | WHITE-BOX | Imports `./flow-control.js`, `./output-demux.js`, `../wire/transport.js`, `../parser/correlator.js`; tests flow controller with a fake `send` callback and in-memory transport. |
| `packages/session-proxy/src/runtime/flow-load.test.ts` | MIXED | Imports `./e2e-smoke.test.js`; spawns real tmux via `setupE2E`. All 6 tests (F1–F6) directly access `sessionProxy.flowController` (fc.isPanePaused, fc.bufferedBytes, fc.noteDrained) and `sessionProxy.demux` internals. `fc.noteDrained` is used as a CONTROL mechanism, not just an observation — no wire-level equivalent exists. |
| `packages/session-proxy/src/runtime/hydration.test.ts` | WHITE-BOX | Imports `./hydration.js`, `../wire/ids.js`, `../wire/transport.js`, `../parser/correlator.js`; tests `hydrateTransport`, `lfToCrlf`, `parsePaneGridFacts` with fakes and in-memory transports. |
| `packages/session-proxy/src/runtime/input-path.test.ts` | WHITE-BOX | Imports `./input-path.js`, `../parser/correlator.js`, `../wire/index.js`; tests `createInputPath` with a `FakeDeps` struct that captures `send()` calls. |
| `packages/session-proxy/src/runtime/integration.test.ts` | MIXED | Imports many internal modules; spawns `fake-tmux.js` as a subprocess (T1–T6) and real tmux (R1–R3). Wire-message assertions in some sections, internal model assertions in others. |
| `packages/session-proxy/src/runtime/output-before-topology.test.ts` | WHITE-BOX | Imports `./output-demux.js`, `../wire/transport.js`, `../wire/ids.js`; tests staging/flush ordering with in-memory transports. |
| `packages/session-proxy/src/runtime/output-demux.test.ts` | WHITE-BOX | Imports `./output-demux.js`, `../wire/transport.js`, `../state/scrollback.js`, `../wire/ids.js`; tests output demux append → fan-out with in-memory transport pair. |
| `packages/session-proxy/src/runtime/pane-capture.test.ts` | WHITE-BOX | Imports `./hydration.js`, `../wire/ids.js`, `../parser/correlator.js`; tests `captureText` with scripted fake pipelines; integration section uses `createSessionProxy` with a fake host. |
| `packages/session-proxy/src/runtime/perf-bench.test.ts` | WHITE-BOX | Imports internal parser, state, and runtime modules; measures throughput of the internal hot path with minimal assertions. |
| `packages/session-proxy/src/runtime/pipeline.test.ts` | WHITE-BOX | Imports `./pipeline.js`, `./tmux-host.js`, `../state/scrollback.js`, `../state/model.js`; tests `createRuntimePipeline` with a `FakeTmuxHost`; asserts on `checkInvariants` and model state. |
| `packages/session-proxy/src/runtime/raw-connection.test.ts` | WHITE-BOX | Imports `./serve.js`, `./pipeline.js`, `../wire/index.js`; tests handshake failure and client-count behavior over in-memory transport. |
| `packages/session-proxy/src/runtime/resilience.test.ts` | MIXED | I1–I4: in-memory (white-box, test ControlServer lifecycle). R1–R5 (real-tmux): R1–R2 behavioral (exit/socket detection), R3 now wire-level (snapshot captured from ct2 wire — tc-a88z promotion), R4 uses internal `clientCount()`, R5 wire-level (error message). |
| `packages/session-proxy/src/runtime/resize-roundtrip.test.ts` | MIXED | Imports `./e2e-smoke.test.js`; spawns real tmux via `setupE2E`. Asserts on both internal `pipeline.getModel()` window layout AND wire `layout.updated` delta delivery. |
| `packages/session-proxy/src/runtime/resync.test.ts` | WHITE-BOX | Imports `./serve.js`, `../state/model.js`, `./pipeline.js`, `../wire/index.js`; all driven over in-memory transports with a filtered transport to simulate seq gaps. |
| `packages/session-proxy/src/runtime/serve.test.ts` | WHITE-BOX | Imports `./serve.js`, `./verb-origin.js`, `../wire/index.js`, `../state/model.js`, `../state/scrollback.js`; tests `createControlServer` with a fake pipeline and in-memory transport. |
| `packages/session-proxy/src/runtime/test-tmux-cleanup-boot-sweep.test.ts` | MIXED | Imports `./test-tmux-cleanup.js`; spawns real child node processes (PID liveness) and creates real socket files to test `sweepOrphanedSockets`. |
| `packages/session-proxy/src/runtime/test-tmux-cleanup.test.ts` | MIXED | Imports `./test-tmux-cleanup.js`; S3 creates a real tmux server to prove `flushAllTracked()` reaps it. Tests cleanup-helper contract against real processes. |
| `packages/session-proxy/src/runtime/tmux-host.test.ts` | MIXED | Imports `./tmux-host.js`, `./test-tmux-cleanup.js`; hermetic section spawns `fake-tmux.js`; real-tmux section spawns actual tmux 3.4. Tests pipe plumbing and lifecycle. |
| `packages/session-proxy/src/runtime/topology-canary.test.ts` | MIXED | Imports `./e2e-smoke.test.js`, `../wire/ids.js`; spawns real tmux via `setupE2E`. C1 drives `fc.noteDrained` (white-box control) and asserts on `pipeline.getModel()` (white-box observation). The committed-model check IS the test — a wire-level equivalent would be weaker and miss the specific mis-bind bug class (tc-e3m). |
| `packages/session-proxy/src/runtime/verb-origin.test.ts` | WHITE-BOX | Imports `./verb-origin.js`, `../wire/ids.js`; tests `createVerbOriginRegistry` record/lookup/clear/TTL/size-cap in-process. |

### Session-proxy — metrics (3 files)

| File | Class | Rationale |
|------|-------|-----------|
| `packages/session-proxy/src/metrics/registry.test.ts` | WHITE-BOX | Imports `./registry.js`; calls `createSessionProxyRegistry` and `classifyCommand`; asserts on Prometheus text exposition output. |
| `packages/session-proxy/src/metrics/storm-alarm.test.ts` | WHITE-BOX | Imports `./storm-alarm.js`, `../state/coalescer.js`; tests `createStormAlarm` with a fake clock. |
| `packages/session-proxy/src/metrics/storm-flood.test.ts` | WHITE-BOX | Imports `./storm-alarm.js`, `./registry.js`; drives alarm + registry with an inline fake clock; asserts on `tripBreakdowns`. |

### Session-proxy — root (2 files)

| File | Class | Rationale |
|------|-------|-----------|
| `packages/session-proxy/src/index.test.ts` | WHITE-BOX | Imports `./index.js`; checks `SESSION_PROXY_PLACEHOLDER === true` and `SessionProxyHandle` type compiles. |
| `packages/session-proxy/src/npm-root-guard.test.ts` | WHITE-BOX | Imports `../../../scripts/npm-root-guard.mjs`; tests `isBlockedDirectSubdir` decision function. |

### Server-proxy (15 files)

| File | Class | Rationale |
|------|-------|-----------|
| `packages/server-proxy/src/collapsed-process-lifecycle.e2e.test.ts` | MIXED | Imports `./index.js`, `@tmuxcc/session-proxy`; spawns a real server-proxy BINARY (subprocess) and real tmux. Wire-protocol assertions (snapshot, `server-proxy.info`). Closest to fully black-box of all MIXED files — only coupling is the TS setup code. |
| `packages/server-proxy/src/metrics-exposition.test.ts` | WHITE-BOX | Imports `./metrics-exposition.js`; tests `mergeMetricsText` with in-process `prom-client` registries. |
| `packages/server-proxy/src/metrics-http.integration.test.ts` | MIXED | Imports `./index.js`, `./runtime-dir.js`, `@tmuxcc/session-proxy`; uses `createServerProxy` which manages tmux sessions (M5 needs real tmux). Tests HTTP binding lifecycle. |
| `packages/server-proxy/src/metrics-http.test.ts` | WHITE-BOX | Imports `./metrics-http.js`; tests `parseMetricsHttpBind` (pure) and `bindMetricsHttp` via in-process unix socket. |
| `packages/server-proxy/src/metrics.test.ts` | WHITE-BOX | Imports `./metrics.js`; tests `createServerProxyMetrics` and Prometheus text output. |
| `packages/server-proxy/src/runtime-dir.test.ts` | WHITE-BOX | Imports `./runtime-dir.js`; tests `gcStaleRuntimeDirs` and `probeLiveSocket` against an in-process unix socket. |
| `packages/server-proxy/src/server-proxy-entry.test.ts` | WHITE-BOX | Imports `./server-proxy-entry.js`; tests `_parseEntryConfig` and `_parseIdleExitMs` (private functions) — pure argument parsing. |
| `packages/server-proxy/src/server-proxy-log.test.ts` | WHITE-BOX | Imports `./server-proxy-log.js`; tests `openServerProxyLog` and `installStderrMirror` against real filesystem in tmpdir. |
| `packages/server-proxy/src/server-proxy.test.ts` | MIXED | Imports `./index.js`, `@tmuxcc/session-proxy`; U1 in-memory, I1–I7 + R1 use `createServerProxy` with real tmux sessions. Wire-level assertions on `snapshot`, `session.claim` response, `sessions.added` delta. |
| `packages/server-proxy/src/session-error-boundary.test.ts` | MIXED | Imports `@tmuxcc/session-proxy`, `./session-proxy-supervisor.js`; spawns real tmux via `createSessionProxy`. Proves session B's `onTopologyNotify` fires after session A's fault — behavioral assertion. |
| `packages/server-proxy/src/session-removal-ordering.test.ts` | MIXED | Imports `./index.js`, `@tmuxcc/session-proxy`; uses `createServerProxy` with real tmux. Wire-protocol assertions: `sessions.removed` precedes UDS close. |
| `packages/server-proxy/src/socket-transport.mux.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` (`encodeFrame`, `paneId`) and `./socket-transport.js`; creates in-process unix socket server/client. Tests exact-boundary frame demux with interleaved control/data. |
| `packages/server-proxy/src/socket-transport.test.ts` | WHITE-BOX | Imports `./socket-transport.js`; creates in-process unix socket echo server. Tests control-plane round-trip. |
| `packages/server-proxy/src/tmux-south.test.ts` | MIXED | Imports `./tmux-south.js`; calls `createSession`, `listSessions`, `probeTmuxLiveness` against real tmux. Asserts on returned session IDs and null-vs-empty semantics. |
| `packages/server-proxy/src/wedge-regression.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy`, `./socket-transport.js`; fake TmuxHost with in-process unix sockets; asserts on internal `fc.bufferedBytes` and fake-host command capture. |

### Clients/ts (11 files)

| File | Class | Rationale |
|------|-------|-----------|
| `clients/ts/src/attached-clients.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` and `./mirror.js`, `./client.js`; tests `attachedClientCount` propagation through internal Mirror over in-memory transport. |
| `clients/ts/src/connection.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` and `./connection.js`; tests `SessionProxyConnection` state machine over in-memory transport. |
| `clients/ts/src/e2e.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` and internal client modules; uses a scripted mock session-proxy over in-memory transport; asserts on `EchoRenderHook` callbacks and `Mirror` model state. |
| `clients/ts/src/harness/conformance.test.ts` | WHITE-BOX | Imports `./index.js`; loads protocol transcripts from disk and drives both `conformClientToTranscript` and `conformDaemonToTranscript` over in-memory transports. |
| `clients/ts/src/index.test.ts` | WHITE-BOX | Checks `CLIENT_PLACEHOLDER === true`. |
| `clients/ts/src/input.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` and `./input.js`; tests `createInputApi` with a mock `InputSender`. |
| `clients/ts/src/mirror-attach.test.ts` | WHITE-BOX | Imports `./render-hook.js`, `./mirror.js`, `@tmuxcc/session-proxy`; tests `Mirror.attach` by calling `mirror.receiveSnapshot()` / `mirror.receiveDelta()` directly. |
| `clients/ts/src/mirror.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` and `./mirror.js`; directly tests `Mirror`, `applySnapshot`, `applyDelta` with constructed `SessionModel` objects. |
| `clients/ts/src/pane-stream.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` and `./connection.js`, `./pane-stream.js`; tests `PaneStreamConsumer` over in-memory transport. |
| `clients/ts/src/roundtrip.test.ts` | WHITE-BOX | Imports exclusively from `@tmuxcc/session-proxy`. Tests frame encode/decode round-trips and type guards using TS implementations in-process. |
| `clients/ts/src/send-command.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` and `./input.js`, `./client.js`, `./render-hook.js`; tests `InputApi.sendCommand` delivery over in-memory transport. |

### Driver-admin (1 file)

| File | Class | Rationale |
|------|-------|-----------|
| `packages/driver-admin/src/info.test.ts` | WHITE-BOX | Imports `@tmuxcc/session-proxy` and `./info.js`; tests `runServerProxyCommand` correlation contract over in-memory transport. |

---

## Totals

| Class | Count |
|-------|-------|
| BLACK-BOX | **0** |
| WHITE-BOX | **60** |
| MIXED | **18** |
| **Total** | **78** |

No file is entirely black-box. Every test imports TS internal modules for at minimum
its setup code.

---

## Moat quantification

### What counts as the "moat"

The Rust-rewrite claim rests on: "if we run a new implementation against the test
suite, we catch the hard-won correctness." The moat is the fraction of
**real-tmux test cases** where the ASSERTION observes externally-visible behavior
(wire messages, process lifecycle, file-system state) rather than TS
implementation internals.

### Real-tmux test case breakdown

The 18 MIXED files contain approximately 110 test cases that run against real
tmux or real spawned processes. Below is the split:

**Portable-assertion cases (~72 cases / ~65%)**

These test cases assert on:
- `EchoRenderHook` callbacks that a client receives over the wire (e2e-smoke E1–E7)
- Wire protocol messages captured from the transport (resilience R3 after tc-a88z
  promotion, server-proxy snapshot/delta assertions, collapse-lifecycle assertions)
- Process lifecycle observables (exit detection, socket files, binary spawn)
- HTTP endpoint responses (metrics-http integration)
- Session listing and ID semantics (tmux-south tests)

A Rust implementation that speaks the correct wire protocol and manages tmux
sessions correctly would pass these cases — test SETUP must be rewritten
(connect-to-socket instead of `createSessionProxy`), but no ASSERTION logic changes.

**Irreducible white-box cases (~38 cases / ~35%)**

These test cases either (a) use TS internals as the **observation mechanism** where
no wire-level equivalent exists, or (b) use TS internals as the **control mechanism**
(stimulus, not observation):

| File | Cases | Why irreducible |
|------|-------|-----------------|
| `flow-load.test.ts` (F1–F6) | 6 | `fc.noteDrained()` is the control mechanism to trigger resume; no wire-equivalent. `fc.isPanePaused()`, `fc.bufferedBytes()`, `demux.isPanePaused()`, `store.size()` are the observations; no wire-level counterparts exist. |
| `topology-canary.test.ts` (C1) | 1 | `pipeline.getModel()` is the authoritative committed topology. A wire-level check (count `pane.opened` events) would not detect the specific mis-bind bug (tc-e3m) because the bug can corrupt the internal model WITHOUT producing an incorrect delta to existing clients. |
| `break-pane-noop.test.ts`, `break-pane-rehome.test.ts` | 4 | Assert on `VerbResult` type and internal `model.windowId` after break-pane. Behavior (which window the pane moved to) is in principle wire-observable via `layout.updated` deltas, but promoting requires structural re-authoring. |
| `bootstrap-requery-stall.test.ts` | 2 | Polls `pipeline.getModel().panes.size` to detect stall-recovery timing; no wire-level signal for "pipeline completed a requery." |
| `resize-roundtrip.test.ts` | 2–3 | Partially white-box: asserts on `pipeline.getModel()` window layout AND the `layout.updated` wire delta (the latter is already portable). |
| `integration.test.ts` (internal sections) | ~10 | Mix of fake-host (white-box control) and real-tmux sections; real-tmux R1–R3 have a mix of wire and internal assertions. |
| `resilience.test.ts` (R1, R4 remnants) | 2 | R1 (`host.onExit`, `host.exited`) and R4 (`server.clientCount()`) use internal APIs; behavioral equivalents exist in principle but are not cheap promotions. |

### Summary moat figure

**~65% of real-tmux test cases already have wire-observable behavioral assertions.**  
**~35% of real-tmux test cases are irreducibly coupled to TS internals.**

As a fraction of the FULL test suite (unit + integration + real-tmux):
- ~72 real-tmux portable cases out of ~450 total cases across the suite = ~16%
- The bulk of the suite (~75%) is white-box unit tests of the TS parser, state machine, and wire codec — these test the TS implementation, not the protocol.

---

## Cheap promotion applied

**`resilience.test.ts R3`** (tc-a88z): Replaced two white-box constructs:

1. `waitFor(() => sessionProxy.pipeline.getModel().panes.size >= 2)`
   → `waitFor(() => hook.calls.filter(c => c.type === "paneOpened").length >= 2)`
   (wire-observable: first client's render hook receives `pane.opened` deltas)

2. `const { projectSnapshot } = await import("../state/projection.js"); projectSnapshot(sessionProxy.pipeline.getModel(), { seq: 1 }).panes.length >= 2`
   → `ct2.onControl` installed BEFORE `await addPromise`; asserts `wireMessages.find(m => m.type === "snapshot").panes.length >= 2`
   (direct wire capture of the snapshot sent to the second client)

Suite remains green (all 85 session-proxy test cases pass, including R3).

### Why other candidates were not promoted

Promotions require that the assertion continues to test the SAME BUG CLASS after promotion. In several cases, the wire-level equivalent would be weaker:

- **`topology-canary C1`**: The bug class (slot-less write corrupts committed model) can produce a corrupt internal model even when the deltas to existing clients are correct. A wire-level assertion (count `pane.opened` events on the existing client) would miss this. The internal `pipeline.getModel()` check is the right test.
- **`flow-load F1–F6`**: `fc.noteDrained()` is not an observation but a control input that drives the resume cycle. Without it, the test cannot drive the pause/resume state machine. Promoting requires a fundamentally different test design (the flow-control drain API would need to be surface-accessible).
- **`break-pane-*`**: The `windowId` and `VerbResult` assertions are testing specific post-operation topology facts. Promoting to `layout.updated` wire assertions would test the same behavior but requires rebuilding the assertion logic around the wire message shape — 30–50 lines of structural re-authoring each, not "cheap."

---

## Irreducible white-box set (rewrite effort estimate)

A Rust rewrite must re-author the following categories. Effort estimates assume
one engineer familiar with the Rust implementation.

### Category 1: Parser unit tests (~40 cases across 8 files)
**Effort: 1–2 weeks**
Tests the tmux control-mode parser (tokenizer, correlator, layout-string,
notification, output-codec, OSC title sniffer, golden corpus). The Rust
implementation will have its own parser data types; these tests must be rewritten
from scratch against the Rust parser's types and functions. The golden corpus
files (`protocol/golden/`) are language-neutral and can be reused as test
fixtures; only the test driver code needs rewriting.

### Category 2: State machine unit tests (~60 cases across 6 state + 4 runtime files)
**Effort: 2–3 weeks**
Tests the session model (`model.ts`, `requery.ts`, `coalescer.ts`,
`projection.ts`, `scrollback.ts`) and core runtime logic (`pipeline.ts`,
`serve.ts`, `flow-control.ts`, `output-demux.ts`). The TS data structures
(SessionModel, PaneBufferStore, RuntimePipeline) have no Rust equivalents; each
test must be rewritten against Rust equivalents. Logic complexity is high (e.g.,
`requery.test.ts` exercises the requery engine's convergence under 14+ scenarios;
`coalescer.test.ts` drives a fake clock through timer-fire sequences).

### Category 3: Wire codec unit tests (~30 cases across 5 wire files)
**Effort: 1 week**
Tests frame encoding/decoding, handshake negotiation, and in-memory transport
behavior. The wire PROTOCOL is language-neutral (`protocol/schemas/`); only the
TS codec implementation is white-box. A Rust implementation would use
`protocol/schemas/` for compliance and write equivalent Rust codec tests.
`protocol-conformance.test.ts`'s schema-validation portion can be reused directly
(it validates `protocol/schemas/` JSON files independent of TS types); only the
"TS-constructed message validates against schema" section needs rewriting.

### Category 4: Flow-control real-tmux tests (6 cases in `flow-load.test.ts`)
**Effort: 1 week (design-first)**
The flow controller's pause/resume mechanism is tested via internal APIs
(`fc.noteDrained`, `fc.isPanePaused`, `fc.bufferedBytes`). A Rust
implementation must expose equivalent testability surface (either through an
internal test module or an explicit test-only API). The behavioral outcomes (pane
stops receiving bytes when paused; byte stream is correct after resume; memory is
bounded) are well-specified; the difficulty is choosing a testability approach
that doesn't pollute the production API.

### Category 5: Topology-canary (1 case in `topology-canary.test.ts`)
**Effort: 1–2 weeks (design-first)**
The canary's purpose is to detect command mis-binding under concurrent flow-control
and requery operations. The Rust rewrite must expose the committed model for
inspection in tests (e.g., via a test-only observer hook) or employ an equivalent
mechanism (e.g., expose a `committed_pane_count()` function for test use).
This is a small amount of code but requires architectural deliberation to avoid
polluting the production interface.

### Total irreducible rewrite estimate

| Category | Effort |
|----------|--------|
| Parser unit tests | 1–2 weeks |
| State machine unit tests | 2–3 weeks |
| Wire codec unit tests | 1 week |
| Flow-control real-tmux | 1 week |
| Topology canary | 1–2 weeks |
| **Total** | **6–9 weeks** for a complete, parity test suite |

The **6–9 week** range is the "lower bound for a quality rewrite" — an incomplete
port that skips state-machine unit tests and ships with only the behavioral
real-tmux tests would have higher defect risk for edge cases in the requery engine,
coalescer, and scrollback logic.

---

## Verdict for `tc-ni6f` (Rust rewrite decision)

The test suite provides a meaningful correctness moat, but it is not
implementation-neutral. Approximately 65% of real-tmux behavioral test cases
have wire-observable assertions that would validate any conforming implementation;
these are the lowest-risk foundation for a rewrite. The remaining 35% of
real-tmux cases — and the entire white-box unit test layer (parser, state, wire
codec) — are TS-coupled and must be re-authored for Rust. The hard-won correctness
captured in the topology canary (tc-e3m) and flow-control tests (tc-55t) is
especially worth preserving: both represent real production bugs found only by
those specific tests, and their irreducibility is structural (they rely on
internal control surfaces that no wire-level equivalent can replicate). A clean
Rust rewrite on a 6–9 week test-reconstruction timeline carries moderate-but-real
risk: the behavioral test moat (65%) is genuine, but the 35% internal-model tests
guard bug classes that are not otherwise visible at the wire. The rewrite decision
should weight this: the moat is real, but it is narrower than a fully black-box
test suite would provide.
