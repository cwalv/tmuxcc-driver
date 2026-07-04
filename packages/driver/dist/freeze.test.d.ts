/**
 * freeze.test.ts — unit tests for the tc-gjdx.5 freeze logic.
 *
 * Tests:
 *   U1. actualToDesiredNode: single-pane leaf → TemplatePane with cwd.
 *   U2. actualToDesiredNode: horizontal split → hsplit with proportional sizes.
 *   U3. actualToDesiredNode: vertical split → vsplit with proportional sizes.
 *   U4. actualToDesiredNode: nested wild tree preserves orientation mapping.
 *   U5. buildFrozenTemplate: produces a schema-valid SessionTemplate.
 *   U6. buildFrozenTemplate: optional name is embedded.
 *   U7. buildFrozenTemplate: window with empty name → name field omitted.
 *   U8. freeze→desired tree→serializeGeometry round-trip (pure): the desired
 *       tree re-serializes to a layout string with the same topology and
 *       integer-exact total sizes (verifies proportional-size derivation
 *       is self-consistent with serializeGeometry).
 *
 * @module freeze.test
 */
export {};
//# sourceMappingURL=freeze.test.d.ts.map