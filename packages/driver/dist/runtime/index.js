// TODO: I/O runtime — manages the tmux -CC process, per-pane streams, and
// input muxing back in via `send-keys -H`.
export const RUNTIME_PLACEHOLDER = true;
// tc-kyp: tmux -CC subprocess host (spawn/lifecycle/pipes)
export { createTmuxHost } from "./tmux-host.js";
// tc-4fo: runtime pipeline — tmux stdout→tokenizer→parser→reducer→live model
export { createRuntimePipeline } from "./pipeline.js";
// tc-fbz: output demux — fan %output bytes to per-client data-plane transports
export { createOutputDemux } from "./output-demux.js";
// tc-kvk: client→tmux input & resize path (send-keys -H / refresh-client)
export { createInputPath, defaultPaneIdToTmux, defaultWindowIdToTmux } from "./input-path.js";
// tc-dv3: serve control-plane — per-client handshake + snapshot + delta stream
export { createControlServer } from "./serve.js";
// tc-1ho: flow-control coordinator — high/low-water backpressure + refresh-client -A
export { createFlowController, DEFAULT_HIGH_WATER_BYTES, DEFAULT_LOW_WATER_BYTES, } from "./flow-control.js";
// tc-93a: full session-proxy assembly — wires host+pipeline+demux+server+inputPath+flowController
export { createSessionProxy } from "./session-proxy.js";
// tc-2x3.3: die-with-parent (tc-2c5) is gone — the session-proxy now runs
// IN-PROCESS inside the server-proxy event loop (no child process to be
// reparented), so there is nothing to enforce die-with-parent against.
//# sourceMappingURL=index.js.map