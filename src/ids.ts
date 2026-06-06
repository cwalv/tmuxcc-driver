/**
 * Shared primitive identifier types — neutral module, importable by any layer.
 *
 * These identifiers are used by BOTH the parser (south-facing, byte streams →
 * events) and the wire protocol (north-facing, transport framing).  They live
 * here — outside either layer — so neither direction imports from the other.
 *
 * INVARIANT: nothing here may leak tmux south-side vocabulary.
 *   - PaneId is a clean opaque string — the daemon maps tmux's internal %N ids
 *     to these at the south boundary and never exposes %N on the wire.
 *   - WindowId / SessionId follow the same pattern.
 *
 * All existing code continues to import from `wire/ids.ts`, which re-exports
 * everything from this module.
 */

// ---------------------------------------------------------------------------
// Branded helper — zero runtime cost, prevents accidental mix-ups at compile
// time without introducing a class or symbol.
// ---------------------------------------------------------------------------
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Opaque pane identifier on the wire.
 *
 * Representation: a plain string (e.g. "p0", "p1", …). The daemon mints
 * these; clients treat them as opaque tokens. Strings were chosen over numbers
 * so that future namespacing (multi-session, reconnect) can be encoded without
 * a breaking schema change (e.g. "s0-p3").
 *
 * South-side mapping: the daemon's tmux parser maps tmux's `%N` pane ids to
 * `PaneId` values. That mapping lives entirely inside the daemon; `%N` syntax
 * never appears on the wire.
 *
 * The data plane (tc-2mq) imports `PaneId` from this module to tag byte-stream
 * frames with the same identifier.
 */
export type PaneId = Brand<string, "PaneId">;

/** Opaque window identifier on the wire (same opaque-string convention). */
export type WindowId = Brand<string, "WindowId">;

/** Opaque session identifier on the wire. */
export type SessionId = Brand<string, "SessionId">;

// ---------------------------------------------------------------------------
// Constructor helpers (for use inside the daemon only — clients receive ids
// from daemon-pushed messages and must not construct them independently).
// ---------------------------------------------------------------------------

/** @internal Mint a PaneId from a raw string (daemon use only). */
export function paneId(raw: string): PaneId {
  return raw as PaneId;
}

/** @internal Mint a WindowId from a raw string (daemon use only). */
export function windowId(raw: string): WindowId {
  return raw as WindowId;
}

/** @internal Mint a SessionId from a raw string (daemon use only). */
export function sessionId(raw: string): SessionId {
  return raw as SessionId;
}
