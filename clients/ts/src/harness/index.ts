/**
 * @tmuxcc/client/harness — SDK test harness + protocol conformance (tc-ozk.4).
 *
 * The single, in-SDK harness that host test suites (vscode), the SDK's own
 * tests, and any future SDK/daemon use to run protocol-level tests WITHOUT a
 * live tmux:
 *
 *   - `createStubSessionProxyTransport` / `makeStubModel` — the lifecycle stub
 *     the vscode SessionManager tests consume (handshake + snapshot).
 *   - `runStubDaemon` — a scriptable stub session-proxy daemon that replays a
 *     conformance transcript over a transport.
 *   - transcript format + loader (`loadTranscript`, `Transcript`, …).
 *   - the conformance runner (`conformTranscript` and its two halves) that pins
 *     BOTH the SDK parser/mirror AND the real session-proxy daemon to the same
 *     transcripts.
 *
 * @module harness
 */

export {
  createStubSessionProxyTransport,
  makeStubModel,
  runStubDaemon,
} from "./stub-daemon.js";
export type {
  StubModelOptions,
  StubSessionProxyOptions,
  StubDaemonHandle,
  ClientMessageLog,
} from "./stub-daemon.js";

export {
  TranscriptError,
  loadTranscript,
  parseTranscript,
  serverSteps,
  clientSteps,
} from "./transcript.js";
export type {
  Transcript,
  TranscriptStep,
  ServerStep,
  ClientStep,
  VerbScript,
  VerbCreates,
  TranscriptInitialModel,
  TranscriptWindow,
  TranscriptPane,
} from "./transcript.js";

export {
  conformTranscript,
  conformClientToTranscript,
  conformDaemonToTranscript,
} from "./conformance.js";

export { createFakePipeline } from "./fake-pipeline.js";
export type { FakePipeline } from "./fake-pipeline.js";

export { buildModel, applyVerbCreate } from "./model-builder.js";
