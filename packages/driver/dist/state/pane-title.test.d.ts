/**
 * Integration tests for paneTitle model field and pane.title-changed delta (tc-2mn8).
 *
 * These tests live in src/state/ (not src/parser/) to respect the
 * parser-no-wire boundary rule: src/parser/ must not import src/wire/.
 *
 * Coverage:
 *   - pane.title-changed delta is emitted by diffModel when paneTitle changes.
 *   - No delta when paneTitle is unchanged.
 *   - No delta when paneTitle goes from defined to absent (undefined).
 *   - paneTitle is carried in snapshot (SnapshotPane.paneTitle).
 */
export {};
//# sourceMappingURL=pane-title.test.d.ts.map