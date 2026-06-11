// TODO: I/O runtime — manages the tmux -CC process, per-pane streams, and
// input remuxing via `send-keys -H`.

export const RUNTIME_PLACEHOLDER = true;

// tc-kyp: tmux -CC subprocess host (spawn/lifecycle/pipes)
export { createTmuxHost } from "./tmux-host.js";
export type { TmuxHost, TmuxHostOptions } from "./tmux-host.js";

// tc-4fo: runtime pipeline — tmux stdout→tokenizer→parser→reducer→live model
export { createRuntimePipeline } from "./pipeline.js";
export type {
  RuntimePipeline,
  RuntimePipelineOptions,
  ModelChangeHandler,
} from "./pipeline.js";

// tc-fbz: output demux — fan %output bytes to per-client data-plane transports
export { createOutputDemux } from "./output-demux.js";
export type { OutputDemux, OutputDemuxOptions } from "./output-demux.js";

// tc-kvk: client→tmux input & resize path (send-keys -H / refresh-client)
export { createInputPath, defaultPaneIdToTmux, defaultWindowIdToTmux } from "./input-path.js";
export type { InputPath, InputPathOptions } from "./input-path.js";

// tc-dv3: serve control-plane — per-client handshake + snapshot + delta stream
export { createControlServer } from "./serve.js";
export type { ControlServer, ControlServerOptions } from "./serve.js";

// tc-1ho: flow-control coordinator — high/low-water backpressure + refresh-client -A
export {
  createFlowController,
  DEFAULT_HIGH_WATER_BYTES,
  DEFAULT_LOW_WATER_BYTES,
} from "./flow-control.js";
export type { FlowController, FlowControllerOptions } from "./flow-control.js";

// tc-93a: full session-proxy assembly — wires host+pipeline+demux+server+inputPath+flowController
export { createSessionProxy } from "./session-proxy.js";
export type { SessionProxy, SessionProxyOptions, SessionProxyHostView } from "./session-proxy.js";

// tc-2c5: die-with-parent watchdog — entry points install this at startup so a
// SIGKILLed server-proxy never leaves orphan session-proxies (ext-a §6.3)
export { installDieWithParent } from "./die-with-parent.js";
export type { DieWithParentOptions } from "./die-with-parent.js";
