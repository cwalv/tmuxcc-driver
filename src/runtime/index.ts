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
