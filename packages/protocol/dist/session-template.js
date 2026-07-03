/**
 * Session template — the declarative session shape (tc-gjdx).
 *
 * A session template is a named, declarative description of a session: an
 * ordered list of windows, each an optional name plus an optional
 * desired-geometry tree whose leaves are pane specs. The driver applies a
 * template at session-create (exactly once, keyed off `created:true`) or to a
 * live session (safe-direction merge), and can freeze a live session back into
 * one.
 *
 * ONE shared schema, full tmux fidelity. The extension's managed subset
 * (strip-shaped geometry) is a SEMANTIC capability, not a type wall: wilder
 * trees still apply (unmanaged) rather than being rejected — apply-don't-reject.
 *
 * Two invariants this type deliberately upholds:
 *   - NO layout strings. Geometry is a structured split tree (the sibling of
 *     ./layout.ts's actual-layout tree, but DESIRED — no paneIds, no Rects);
 *     tmux layout strings are a driver-internal compile artifact (tc-gjdx.3),
 *     never on the wire, never in config.
 *   - NO substitution syntax. The wire carries FULLY-SUBSTITUTED concrete
 *     templates; ${workspaceFolder} / ${env:NAME} resolution is a client-side
 *     concern (tc-gjdx.6). Every string here is a literal.
 *
 * Vocabulary bridge: a leaf pane names its shell command `command`; the
 * driver's creating verbs (open-window / split-pane) name the same thing
 * `shellCommand`. The compiler (tc-gjdx.3) maps template `command` ->
 * verb `shellCommand`, and template `env` -> the repeatable tmux `-e` flag
 * (D9-gated, tc-gjdx.2).
 *
 * These types are hand-written and kept in agreement with
 * protocol/schemas/shared/session-template.json by the ajv conformance tests
 * (the tc-4b6k.5 regime: JSON Schema source + hand-written types + conformance).
 */
export {};
//# sourceMappingURL=session-template.js.map