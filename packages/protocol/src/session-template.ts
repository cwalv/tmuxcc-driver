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

// ---------------------------------------------------------------------------
// Geometry tree — DESIRED split tree (sibling of ./layout.ts, no ids/rects)
// ---------------------------------------------------------------------------

/**
 * A leaf node in a window's desired-geometry tree: one pane.
 *
 * The sibling of {@link import("./layout.js").LayoutPane}, but DESIRED (a
 * request), not ACTUAL — no `paneId` (the driver mints it) and no `rect`
 * (tmux sizes it). Every field is optional; an empty `{ kind: "pane" }` is a
 * default-shell pane inheriting the session working directory and environment.
 */
export interface TemplatePane {
  readonly kind: "pane";
  /**
   * Working directory (compiled to the creating verb's `cwd` -> tmux `-c`).
   * Omitted: inherit the session working directory. A fully-substituted
   * absolute path — no `${...}` syntax.
   */
  readonly cwd?: string;
  /**
   * Shell command to run (compiled to the creating verb's `shellCommand` ->
   * the trailing tmux shell-command). Omitted: the default shell. A single
   * shell-interpreted string, fully substituted.
   */
  readonly command?: string;
  /**
   * Environment variables to set, name -> value (compiled to repeatable tmux
   * `-e NAME=value`, D9-gated per tc-gjdx.2). Omitted: inherit the session
   * environment. Values are fully substituted — no `${...}` syntax.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * A horizontal split: children arranged side-by-side (left → right).
 * Mirrors {@link import("./layout.js").LayoutHSplit} and tmux's "{…}"
 * (LAYOUT_LEFTRIGHT) notation, expressed semantically. A DESIRED split — no
 * `rect`; `sizes` are proportional, not absolute.
 */
export interface TemplateHSplit {
  readonly kind: "hsplit";
  /** Child nodes arranged left to right. At least two. */
  readonly children: readonly TemplateNode[];
  /**
   * Optional proportional weights, PARALLEL to `children` (same length, i-th
   * weight for i-th child). Relative — only the ratios matter (`[2, 1]` and
   * `[0.66, 0.34]` both mean 2:1). Omitted: an equal split. The
   * length-equals-children invariant is enforced by semantic validation in
   * code (JSON Schema cannot cross-reference two array lengths).
   */
  readonly sizes?: readonly number[];
}

/**
 * A vertical split: children stacked top-to-bottom. Mirrors
 * {@link import("./layout.js").LayoutVSplit} and tmux's "[…]"
 * (LAYOUT_TOPBOTTOM) notation. A DESIRED split — no `rect`; `sizes` are
 * proportional. See {@link TemplateHSplit.sizes}.
 */
export interface TemplateVSplit {
  readonly kind: "vsplit";
  /** Child nodes stacked top to bottom. At least two. */
  readonly children: readonly TemplateNode[];
  /** Optional proportional weights, PARALLEL to `children`. See {@link TemplateHSplit.sizes}. */
  readonly sizes?: readonly number[];
}

/**
 * Any node in a window's desired-geometry tree. Discriminate on `kind`:
 * "pane" (leaf), "hsplit", or "vsplit". Arbitrary nesting is valid —
 * expressive enough for anything tmux holds. The extension's strip-shaped
 * managed subset (a single split of pane leaves) is a semantic capability,
 * not a type restriction.
 */
export type TemplateNode = TemplatePane | TemplateHSplit | TemplateVSplit;

// ---------------------------------------------------------------------------
// Window + session
// ---------------------------------------------------------------------------

/**
 * One window in a session template: an optional name plus an optional
 * desired-geometry tree.
 */
export interface WindowTemplate {
  /**
   * Optional window name. Also the merge key for apply-to-live (tc-gjdx.4): a
   * live window with a matching name is left alone; a window whose name is
   * absent live is created. Omitted: tmux names the window.
   */
  readonly name?: string;
  /**
   * The window's desired split tree; leaves are pane specs. OMITTED: a single
   * default-shell pane (the common "just give me a window" case) — the
   * compiler (tc-gjdx.3) treats a window with no geometry as one empty
   * {@link TemplatePane}.
   */
  readonly geometry?: TemplateNode;
}

/**
 * A complete session template: an ordered list of windows, with an optional
 * identity name.
 *
 * Carried on the creating claim verbs (applied iff `created:true`), on the
 * apply-to-live verb, and returned by freeze. Full tmux fidelity — validation
 * is structural only; capability (managed vs unmanaged) is a downstream
 * semantic, never a hard reject.
 */
export interface SessionTemplate {
  /**
   * Optional template identity. When applied, the driver records it as the
   * `@tmuxcc-template` session user-option so "created from template X"
   * survives reattach (tc-gjdx.3 awareness). Also the config key under the
   * extension's `sessionTemplates` setting (tc-gjdx.6). Omitted for
   * inline/ad-hoc templates (no awareness stamp).
   */
  readonly name?: string;
  /**
   * The windows to create, in order. At least one — a template describes a
   * non-empty session.
   */
  readonly windows: readonly WindowTemplate[];
}

// ---------------------------------------------------------------------------
// Apply-to-live result (tc-gjdx.4)
// ---------------------------------------------------------------------------

/**
 * Result of a `session.applyTemplate` command (tc-gjdx.4).
 *
 * In `dryRun` (preview) mode `windows` is the would-create set; on a real
 * apply that SUCCEEDS `windows` is the did-create set — the two are equal for
 * the same template+session (the preview-equals-apply invariant clients
 * confirm against). A real apply that fails mid-transaction does NOT return
 * this payload: it fails loud via the command response's error result (code +
 * message naming the failed verb and the created-so-far state), with no
 * rollback (tc-gjdx.3 partial-failure semantics).
 */
export interface TemplateApplyResult {
  /**
   * Echoes the request: true = preview only (nothing was created); false =
   * the windows were actually created.
   */
  readonly dryRun: boolean;
  /**
   * The windows the safe-direction merge would create (dryRun) / did create
   * (real apply): the subset of the template's windows whose names are absent
   * in the live session. Empty when the template is already satisfied (a
   * re-apply is a no-op). A would-create window IS a {@link WindowTemplate}.
   */
  readonly windows: readonly WindowTemplate[];
}
