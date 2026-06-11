/**
 * Switch-client narrowing outcome (tc-j9c.2, re-homed in tc-128.4).
 *
 * Previously this type lived on `ReducerContext` because the per-event reducer
 * fired the callback when a `%session-changed` event drifted away from the
 * bound session. The reducer is gone (tc-128.4 retired event interpretation);
 * the requery-driven pipeline now detects drift by inspecting the model
 * deltas — but the wire-level outcome semantics are unchanged, so the type
 * lives on as the public vocabulary the runtime caller (e.g. the session-
 * proxy factory) registers a handler for.
 *
 * Semantics:
 *   "reattach" — the bound session is still alive but our -CC client drifted
 *                away from it; the caller should silently issue
 *                `attach-session -t <bound>` to pull it back.
 *   "unavailable" — the bound session is gone from tmux entirely; the caller
 *                should broadcast `ErrorMessage{code:"session.unavailable"}`
 *                to clients and close their connections.
 *
 * @module state/switch-client
 */

export type SwitchClientOutcome = "reattach" | "unavailable";
