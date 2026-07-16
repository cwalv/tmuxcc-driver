/**
 * tmux version probe and capability table (tc-4b6k.12 D9).
 *
 * # Purpose
 *
 * The driver probes the installed tmux binary's version ONCE per server-proxy
 * startup, derives a capability map from the version, and holds the result as
 * canonical driver-owned state. This eliminates the per-call-site
 * failure-swallowing degradation pattern (N scattered swallow sites) in favour
 * of one locus where capability absence is model state.
 *
 * # Version table source
 *
 * All version floors in {@link deriveCapabilities} are verified against the
 * tmux CHANGES file in the workspace reference repo (`github/tmux/tmux`).
 * Each entry cites its CHANGES section. Do NOT update from memory — re-verify
 * against the CHANGES file on the next edit.
 *
 * # Minimum supported version
 *
 * {@link MINIMUM_TMUX_VERSION} (`"3.4"`) is the floor below which session
 * creation/claim is rejected with a loud error (tc-cvny.2 D9).
 *
 * Floor rationale: tmuxcc's per-window client size reporting (tc-cvny) uses
 * `refresh-client -C @w:WxH` — the `@<id>:WxH` per-window syntax introduced
 * in tmux 3.3 (CHANGES FROM 3.2a TO 3.3, verified against cmd-refresh-client.c).
 * The floor is set at 3.4 pending tc-cvny.1's authoritative verification of
 * whether 3.3 is sufficient; changing the floor to "3.3" is a one-constant edit
 * here once tc-cvny.1 clears it.
 *
 * @module tmux-capabilities
 */

import { spawnSync } from "node:child_process";
import type { TmuxCapabilityMap } from "@tmuxcc/protocol";

// Re-export the wire type so callers inside @tmuxcc/driver can import
// TmuxCapabilityMap from this module rather than going through @tmuxcc/protocol
// directly (one import point, cleaner dependency graph).
export type { TmuxCapabilityMap };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum tmux version required for tmuxcc to accept session claims (tc-cvny.2).
 *
 * Below this floor `session.claim`, `session.create`, and
 * `session.createUnique` are rejected with a loud `"tmux.below-floor"` error.
 * The server-proxy stays up so the extension can surface the actionable message
 * to the user; only session-mutating operations are gated.
 *
 * Floor rationale: the tc-cvny per-window client size feature requires the
 * `@<id>:WxH` syntax on `refresh-client -C`, which was introduced in tmux 3.3.
 * The floor is conservatively set at 3.4 until tc-cvny.1 verifies whether 3.3
 * is fully sufficient; changing the floor is a one-constant edit.
 * CHANGES FROM 3.2a TO 3.3 (perWindowClientSize capability verified against
 * cmd-refresh-client.c in the reference repo).
 */
export const MINIMUM_TMUX_VERSION = "3.4";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical driver-owned tmux capability state, probed once per server-proxy. */
export interface TmuxCapabilityState {
  /** Version string parsed from `tmux -V`, e.g. `"3.4"` or `"3.2a"`. */
  readonly version: string;
  /** Capability availability table derived from `version`. */
  readonly capabilities: TmuxCapabilityMap;
  /**
   * True when `version` is below {@link MINIMUM_TMUX_VERSION}.
   *
   * When true the server-proxy has already logged the actionable message;
   * callers should surface the floor violation to the user via the
   * `server-proxy.info` `tmuxCapabilities.belowFloor` field.
   */
  readonly belowFloor: boolean;
}

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/**
 * Parse the bare version string from `tmux -V` output.
 *
 * `tmux -V` prints e.g. `"tmux 3.4\n"` or `"tmux 3.2a\n"`.
 * Returns the bare version string (e.g. `"3.4"` or `"3.2a"`) or `null` when
 * the output does not match the expected `tmux <major>.<minor>[<letter>]`
 * format.
 */
export function parseTmuxVersion(output: string): string | null {
  const m = output.trim().match(/^tmux\s+(\d+\.\d+[a-z]?)$/i);
  return m ? (m[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/** Parse a version string into [major, minor, patchLetter] parts. */
function parseParts(v: string): [number, number, string] | null {
  const m = v.match(/^(\d+)\.(\d+)([a-z]?)$/);
  if (!m) return null;
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), m[3] ?? ""];
}

/**
 * Compare two tmux version strings.
 *
 * Returns a negative number if `a < b`, a positive number if `a > b`, and
 * zero if equal. Handles patch-letter suffixes (`"3.2a"` > `"3.2"`).
 * Returns 0 for unparseable versions (treats them as equal).
 *
 * @example
 * compareTmuxVersion("3.2a", "3.2") // > 0
 * compareTmuxVersion("3.1c", "3.2") // < 0
 * compareTmuxVersion("3.4", "3.4")  // === 0
 */
export function compareTmuxVersion(a: string, b: string): number {
  const pa = parseParts(a);
  const pb = parseParts(b);
  if (!pa || !pb) return 0;
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  return pa[2].localeCompare(pb[2]);
}

// ---------------------------------------------------------------------------
// Capability table
// ---------------------------------------------------------------------------

/**
 * Derive the capability map for a given tmux version string.
 *
 * Each entry's floor is verified against `github/tmux/tmux/CHANGES`.
 * The CHANGES section citation is in the field's JSDoc in
 * {@link TmuxCapabilityMap}.
 */
export function deriveCapabilities(version: string): TmuxCapabilityMap {
  const gte = (floor: string): boolean => compareTmuxVersion(version, floor) >= 0;
  return {
    windowSize:        gte("2.9"),
    noOutputFlag:      gte("3.0"),
    windowSizeLatest:  gte("3.1"),
    ignoreSizeFlag:    gte("3.2"),
    readOnlyFlag:      gte("3.2"),
    pauseAfterFlag:    gte("3.2"),
    activePaneFlag:    gte("3.2"),
    // tc-gjdx.2: new-session -e flag landed in 3.2 (CHANGES FROM 3.1c TO 3.2).
    // The same flag for new-window / split-window landed earlier in 3.0
    // (CHANGES FROM 2.9 TO 3.0) and needs no separate capability entry since
    // all supported tmux versions are >= MINIMUM_TMUX_VERSION (3.4 > 3.0).
    newSessionEnvFlag: gte("3.2"),
    scrollOnClear:     gte("3.3"),
    // tc-cvny: per-window client size via `refresh-client -C @<id>:WxH`.
    // Verified in cmd-refresh-client.c: sscanf(size, "@%u:%ux%u", ...) branch.
    // Introduced in 3.3 (confirmed by git tag: fd756a15 is contained in 3.3).
    // CHANGES FROM 3.2a TO 3.3 (confirmed against CHANGES in the reference repo).
    perWindowClientSize: gte("3.3"),
    noDetachOnDestroy: gte("3.6"),
  };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probe the tmux binary version via `tmux -V` and derive the capability state.
 *
 * Runs synchronously (like the other south-side helpers) since it is called
 * once during server-proxy startup before the event loop begins serving
 * requests. The result is cached as {@link ServerProxyImpl._tmuxCapabilityState}
 * and not re-probed per-operation.
 *
 * Returns `null` when:
 *   - The `tmux` binary is not on PATH (ENOENT)
 *   - `tmux -V` exits non-zero
 *   - The version string cannot be parsed
 *
 * A `null` return means "binary absent or unidentifiable" — callers treat it
 * the same as the pre-existing `_tmuxAvailable = false` path.
 */
export function probeTmuxCapabilities(): TmuxCapabilityState | null {
  const result = spawnSync("tmux", ["-V"], {
    encoding: "utf8",
    timeout: 3_000,
  });
  if (result.error || result.status !== 0) return null;
  const version = parseTmuxVersion(result.stdout ?? "");
  if (version === null) return null;
  const capabilities = deriveCapabilities(version);
  const belowFloor = compareTmuxVersion(version, MINIMUM_TMUX_VERSION) < 0;
  return { version, capabilities, belowFloor };
}
