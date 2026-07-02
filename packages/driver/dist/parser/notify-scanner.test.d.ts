/**
 * Unit tests for the pane attention/status escape scanner (tc-76m8.1, S9).
 *
 * Covers the AC: sequences split across chunk boundaries, notifications
 * interleaved with plain output, the recognizer set (OSC 9 / 777 / BEL /
 * ConEmu 9;4 / OSC 633;D), the passthrough-never-lossy contract (a BEL that
 * terminates a title/DCS is NOT miscounted as a bell), and the bounded state
 * machine (over-long unterminated sequences abort rather than buffer forever).
 */
export {};
//# sourceMappingURL=notify-scanner.test.d.ts.map