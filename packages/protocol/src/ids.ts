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
 * Representation: a plain string (e.g. "p0", "p1", …). The session-proxy mints
 * these; clients treat them as opaque tokens. Strings were chosen over numbers
 * so that future namespacing (multi-session, reconnect) can be encoded without
 * a breaking schema change (e.g. "s0-p3").
 *
 * South-side mapping: the session-proxy's tmux parser maps tmux's `%N` pane ids to
 * `PaneId` values. That mapping lives entirely inside the sessionProxy; `%N` syntax
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

/**
 * Opaque per-connection identifier on the wire (tc-ozk.2).
 *
 * Minted by the session-proxy's ControlServer when a client connects (e.g.
 * "conn1", "conn2"). Stable for the life of one connection; reused from a slot
 * pool after disconnect (bounded by max concurrent clients — NOT a stable
 * client identity). Used to attribute the origin of a verb-caused creation
 * delta: a `pane.opened` / `window.added` carries `origin.connectionId` naming
 * the connection whose wire verb caused it; a client compares it against its
 * own connectionId (advertised in the snapshot) to decide whether the creation
 * is its own.
 */
export type ConnectionId = Brand<string, "ConnectionId">;

// ---------------------------------------------------------------------------
// Constructor helpers (for use inside the session-proxy only — clients receive ids
// from session-proxy-pushed messages and must not construct them independently).
// ---------------------------------------------------------------------------

/** @internal Mint a PaneId from a raw string (session-proxy use only). */
export function paneId(raw: string): PaneId {
  return raw as PaneId;
}

/** @internal Mint a WindowId from a raw string (session-proxy use only). */
export function windowId(raw: string): WindowId {
  return raw as WindowId;
}

/** @internal Mint a SessionId from a raw string (session-proxy use only). */
export function sessionId(raw: string): SessionId {
  return raw as SessionId;
}

/** @internal Mint a ConnectionId from a raw string (session-proxy use only). */
export function connectionId(raw: string): ConnectionId {
  return raw as ConnectionId;
}

// ---------------------------------------------------------------------------
// tc-33ug — wire ↔ tmux pane-id conversion pair
// ---------------------------------------------------------------------------
//
// The wire protocol uses `p<N>` as the PaneId (minted by the session-proxy at
// the south boundary).  tmux itself uses `%<N>` (what `#{pane_id}` reports).
// These two forms are visually parallel but different strings; every QA seam
// and test helper that needs to shell out to tmux must cross this boundary.
//
// Having the conversion live beside the PaneId type means there is exactly ONE
// place to fix if the minting scheme ever changes (currently `pN`; a future
// multi-session namespacing might produce `s0-pN`).

/**
 * Convert a wire PaneId (`p<N>`) to the native tmux pane id string (`%<N>`).
 *
 * Used wherever QA tooling or tests need to shell out to `tmux … -t %<N>`
 * given a PaneId from the oracle / model.
 *
 * Example: `paneIdToTmux("p3" as PaneId)` → `"%3"`.
 */
export function paneIdToTmux(id: PaneId): string {
  return `%${(id as string).slice(1)}`;
}

/**
 * Convert a native tmux pane id string (`%<N>`) to a wire PaneId (`p<N>`).
 *
 * Validates that `tmuxId` starts with `%` and the remainder is a non-negative
 * integer; throws `TypeError` on malformed input so callers fail loud rather
 * than silently producing a wrong PaneId.
 *
 * Example: `tmuxToPaneId("%3")` → `"p3" as PaneId`.
 *
 * @throws {TypeError} when `tmuxId` does not match the `%<N>` form.
 */
export function tmuxToPaneId(tmuxId: string): PaneId {
  if (!tmuxId.startsWith("%") || Number.isNaN(parseInt(tmuxId.slice(1), 10))) {
    throw new TypeError(
      `tmuxToPaneId: expected tmux pane id in "%<N>" form, got ${JSON.stringify(tmuxId)}`,
    );
  }
  return `p${tmuxId.slice(1)}` as PaneId;
}
