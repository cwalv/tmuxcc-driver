/**
 * Tests for the tmux layout-string parser (tc-efj).
 *
 * Coverage:
 *   - Single-pane (leaf) layout → correct w/h/x/y/paneId.
 *   - Horizontal split (`{}` = LAYOUT_LEFTRIGHT) with 2 panes.
 *   - Vertical split (`[]` = LAYOUT_TOPBOTTOM) with 2 panes.
 *   - Nested splits (split within split, matching the real example string).
 *   - Checksum: parsed value matches layoutChecksum(body) for known good strings.
 *   - Checksum mismatch: a corrupted body produces a different computedChecksum.
 *   - Round-trip: parse → dumpLayout → equals original string.
 *   - Malformed input throws LayoutParseError.
 */
export {};
//# sourceMappingURL=layout-string.test.d.ts.map