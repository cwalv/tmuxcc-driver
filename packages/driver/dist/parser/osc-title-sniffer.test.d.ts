/**
 * Unit tests for OscTitleSniffer (tc-2mn8).
 *
 * Coverage:
 *   - OSC-0 and OSC-2 both update pane_title.
 *   - BEL (0x07) terminator.
 *   - ST (ESC \, i.e. 0x1B 0x5C) terminator.
 *   - A sequence split across two %output chunks (cross-chunk buffering).
 *   - Non-title OSC numbers (1, 4, 8, 52, …) are ignored / passed through.
 *   - Embedded OSC bytes do not corrupt surrounding terminal output.
 *   - Empty title (shell cleared it) is a valid update.
 *   - Multiple sequences in a single chunk: last one wins (both fire).
 */
export {};
//# sourceMappingURL=osc-title-sniffer.test.d.ts.map