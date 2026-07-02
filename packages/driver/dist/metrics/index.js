/**
 * Metrics barrel for session-proxy (tc-x6l).
 *
 * Re-exports the prom-client registry + storm alarm so consumers can import
 * from `"../metrics/index.js"` (or `"./metrics/index.js"`) without reaching
 * into sub-modules.
 *
 * @module metrics/index
 */
export { createSessionProxyRegistry, classifyCommand } from "./registry.js";
export { createStormAlarm } from "./storm-alarm.js";
//# sourceMappingURL=index.js.map