/**
 * Shared primitive identifier types — neutral module, importable by any layer.
 *
 * These identifiers are used by BOTH the parser (south-facing, byte streams →
 * events) and the wire protocol (north-facing, transport framing).  They live
 * here — outside either layer — so neither direction imports from the other.
 *
 * INVARIANT: nothing here may leak tmux south-side vocabulary.
 *   - PaneId is a clean opaque string — the session-proxy maps tmux's internal %N ids
 *     to these at the south boundary and never exposes %N on the wire.
 *   - WindowId / SessionId follow the same pattern.
 *
 * All existing code continues to import from `wire/ids.ts`, which re-exports
 * everything from this module.
 */
// ---------------------------------------------------------------------------
// Constructor helpers (for use inside the session-proxy only — clients receive ids
// from session-proxy-pushed messages and must not construct them independently).
// ---------------------------------------------------------------------------
/** @internal Mint a PaneId from a raw string (session-proxy use only). */
export function paneId(raw) {
    return raw;
}
/** @internal Mint a WindowId from a raw string (session-proxy use only). */
export function windowId(raw) {
    return raw;
}
/** @internal Mint a SessionId from a raw string (session-proxy use only). */
export function sessionId(raw) {
    return raw;
}
/** @internal Mint a ConnectionId from a raw string (session-proxy use only). */
export function connectionId(raw) {
    return raw;
}
//# sourceMappingURL=ids.js.map