/**
 * Wire-layer identifier re-exports.
 *
 * The canonical definitions live in `src/ids.ts` (a neutral module shared by
 * both the parser layer and the wire layer).  This file re-exports them so
 * that all existing imports of `wire/ids` continue to work unchanged.
 */
export type { PaneId, WindowId, SessionId } from "../ids.js";
export { paneId, windowId, sessionId } from "../ids.js";
