/**
 * tmux-capabilities.test.ts — unit + live-probe tests for the tmux capability
 * model (tc-4b6k.12 D9).
 *
 * # Unit tests (no tmux required)
 *
 * - parseTmuxVersion: covers the expected `tmux -V` output formats.
 * - compareTmuxVersion: ordering of major, minor, and patch-letter versions.
 * - deriveCapabilities: spot-checks that each capability's version floor maps
 *   correctly for below-floor, at-floor, and above-floor versions.
 *
 * # Live-probe test (requires tmux on PATH)
 *
 * - probeTmuxCapabilities: verifies the round-trip against the real binary;
 *   skipped when tmux is unavailable.
 *
 * @module tmux-capabilities.test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseTmuxVersion, compareTmuxVersion, deriveCapabilities, probeTmuxCapabilities, MINIMUM_TMUX_VERSION, } from "./tmux-capabilities.js";
// ---------------------------------------------------------------------------
// parseTmuxVersion
// ---------------------------------------------------------------------------
describe("parseTmuxVersion", () => {
    it("parses a plain numeric version from tmux -V output", () => {
        assert.equal(parseTmuxVersion("tmux 3.4"), "3.4");
    });
    it("parses a patch-letter version", () => {
        assert.equal(parseTmuxVersion("tmux 3.2a"), "3.2a");
        assert.equal(parseTmuxVersion("tmux 3.1c"), "3.1c");
    });
    it("strips leading/trailing whitespace", () => {
        assert.equal(parseTmuxVersion("  tmux 3.4  "), "3.4");
        assert.equal(parseTmuxVersion("tmux 3.4\n"), "3.4");
    });
    it("returns null for empty input", () => {
        assert.equal(parseTmuxVersion(""), null);
    });
    it("returns null when 'tmux' prefix is absent", () => {
        assert.equal(parseTmuxVersion("3.4"), null);
    });
    it("returns null for a non-standard version string", () => {
        assert.equal(parseTmuxVersion("tmux next-3.4"), null);
        assert.equal(parseTmuxVersion("tmux 3.4.1"), null);
    });
});
// ---------------------------------------------------------------------------
// compareTmuxVersion
// ---------------------------------------------------------------------------
describe("compareTmuxVersion", () => {
    it("treats equal versions as equal", () => {
        assert.equal(compareTmuxVersion("3.4", "3.4"), 0);
        assert.equal(compareTmuxVersion("3.2a", "3.2a"), 0);
    });
    it("orders by major version", () => {
        assert(compareTmuxVersion("4.0", "3.4") > 0);
        assert(compareTmuxVersion("2.9", "3.0") < 0);
    });
    it("orders by minor version within the same major", () => {
        assert(compareTmuxVersion("3.4", "3.3") > 0);
        assert(compareTmuxVersion("3.1", "3.2") < 0);
    });
    it("orders patch-letter suffixes lexicographically", () => {
        // "3.2a" > "3.2" (letter suffix > no suffix)
        assert(compareTmuxVersion("3.2a", "3.2") > 0);
        // "3.1c" > "3.1b" > "3.1a"
        assert(compareTmuxVersion("3.1c", "3.1b") > 0);
        assert(compareTmuxVersion("3.1a", "3.1b") < 0);
    });
    it("returns 0 for unparseable versions", () => {
        assert.equal(compareTmuxVersion("not-a-version", "3.4"), 0);
        assert.equal(compareTmuxVersion("3.4", "not-a-version"), 0);
    });
});
// ---------------------------------------------------------------------------
// deriveCapabilities (spot-checks per capability floor, sourced from CHANGES)
// ---------------------------------------------------------------------------
describe("deriveCapabilities", () => {
    // windowSize — CHANGES FROM 2.8 TO 2.9
    it("windowSize is false below 2.9", () => {
        assert.equal(deriveCapabilities("2.8").windowSize, false);
    });
    it("windowSize is true at 2.9", () => {
        assert.equal(deriveCapabilities("2.9").windowSize, true);
    });
    it("windowSize is true above 2.9", () => {
        assert.equal(deriveCapabilities("3.4").windowSize, true);
    });
    // noOutputFlag — CHANGES FROM 2.9 TO 3.0
    it("noOutputFlag is false below 3.0", () => {
        assert.equal(deriveCapabilities("2.9").noOutputFlag, false);
    });
    it("noOutputFlag is true at 3.0", () => {
        assert.equal(deriveCapabilities("3.0").noOutputFlag, true);
    });
    // windowSizeLatest — CHANGES FROM 3.0a TO 3.1
    it("windowSizeLatest is false below 3.1", () => {
        assert.equal(deriveCapabilities("3.0").windowSizeLatest, false);
    });
    it("windowSizeLatest is true at 3.1", () => {
        assert.equal(deriveCapabilities("3.1").windowSizeLatest, true);
    });
    // ignoreSizeFlag / readOnlyFlag / pauseAfterFlag / activePaneFlag — CHANGES FROM 3.1c TO 3.2
    it("ignoreSizeFlag is false below 3.2", () => {
        assert.equal(deriveCapabilities("3.1").ignoreSizeFlag, false);
        assert.equal(deriveCapabilities("3.1c").ignoreSizeFlag, false);
    });
    it("ignoreSizeFlag is true at 3.2", () => {
        assert.equal(deriveCapabilities("3.2").ignoreSizeFlag, true);
    });
    it("readOnlyFlag is false below 3.2", () => {
        assert.equal(deriveCapabilities("3.1").readOnlyFlag, false);
    });
    it("readOnlyFlag is true at 3.2", () => {
        assert.equal(deriveCapabilities("3.2").readOnlyFlag, true);
    });
    it("pauseAfterFlag is false below 3.2", () => {
        assert.equal(deriveCapabilities("3.1").pauseAfterFlag, false);
    });
    it("pauseAfterFlag is true at 3.2", () => {
        assert.equal(deriveCapabilities("3.2").pauseAfterFlag, true);
    });
    it("activePaneFlag is false below 3.2", () => {
        assert.equal(deriveCapabilities("3.1").activePaneFlag, false);
    });
    it("activePaneFlag is true at 3.2", () => {
        assert.equal(deriveCapabilities("3.2").activePaneFlag, true);
    });
    // scrollOnClear — CHANGES FROM 3.2a TO 3.3
    it("scrollOnClear is false below 3.3", () => {
        assert.equal(deriveCapabilities("3.2").scrollOnClear, false);
        assert.equal(deriveCapabilities("3.2a").scrollOnClear, false);
    });
    it("scrollOnClear is true at 3.3", () => {
        assert.equal(deriveCapabilities("3.3").scrollOnClear, true);
    });
    it("scrollOnClear is true above 3.3", () => {
        assert.equal(deriveCapabilities("3.4").scrollOnClear, true);
    });
    // noDetachOnDestroy — CHANGES FROM 3.5a TO 3.6
    it("noDetachOnDestroy is false below 3.6", () => {
        assert.equal(deriveCapabilities("3.5").noDetachOnDestroy, false);
        assert.equal(deriveCapabilities("3.5a").noDetachOnDestroy, false);
    });
    it("noDetachOnDestroy is true at 3.6", () => {
        assert.equal(deriveCapabilities("3.6").noDetachOnDestroy, true);
    });
    it("all capabilities true on a future version", () => {
        const caps = deriveCapabilities("99.0");
        assert.equal(caps.windowSize, true);
        assert.equal(caps.noOutputFlag, true);
        assert.equal(caps.windowSizeLatest, true);
        assert.equal(caps.ignoreSizeFlag, true);
        assert.equal(caps.readOnlyFlag, true);
        assert.equal(caps.pauseAfterFlag, true);
        assert.equal(caps.activePaneFlag, true);
        assert.equal(caps.scrollOnClear, true);
        assert.equal(caps.noDetachOnDestroy, true);
    });
    it("all capabilities false on a very old version", () => {
        const caps = deriveCapabilities("1.0");
        assert.equal(caps.windowSize, false);
        assert.equal(caps.noOutputFlag, false);
        assert.equal(caps.windowSizeLatest, false);
        assert.equal(caps.ignoreSizeFlag, false);
        assert.equal(caps.readOnlyFlag, false);
        assert.equal(caps.pauseAfterFlag, false);
        assert.equal(caps.activePaneFlag, false);
        assert.equal(caps.scrollOnClear, false);
        assert.equal(caps.noDetachOnDestroy, false);
    });
});
// ---------------------------------------------------------------------------
// MINIMUM_TMUX_VERSION
// ---------------------------------------------------------------------------
describe("MINIMUM_TMUX_VERSION", () => {
    it("is a parseable version string", () => {
        // The floor itself must be a parseable version string.
        const parts = MINIMUM_TMUX_VERSION.match(/^\d+\.\d+[a-z]?$/);
        assert.ok(parts, `MINIMUM_TMUX_VERSION "${MINIMUM_TMUX_VERSION}" is not parseable`);
    });
    it("is at or above 3.0 (no-output required for the watcher)", () => {
        assert(compareTmuxVersion(MINIMUM_TMUX_VERSION, "3.0") >= 0);
    });
});
// ---------------------------------------------------------------------------
// probeTmuxCapabilities — live-probe (requires tmux on PATH)
// ---------------------------------------------------------------------------
function tmuxAvailable() {
    const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
    return r.status === 0 && !r.error;
}
const TMUX_AVAILABLE = tmuxAvailable();
describe("probeTmuxCapabilities (live probe)", { skip: !TMUX_AVAILABLE }, () => {
    it("returns a non-null TmuxCapabilityState with a parseable version", () => {
        const state = probeTmuxCapabilities();
        assert.notEqual(state, null, "probeTmuxCapabilities() returned null with tmux on PATH");
        assert.ok(state.version.match(/^\d+\.\d+[a-z]?$/), `version "${state.version}" not in expected format`);
    });
    it("capabilities object has all expected keys", () => {
        const state = probeTmuxCapabilities();
        assert.ok(state !== null);
        const caps = state.capabilities;
        assert.equal(typeof caps.windowSize, "boolean");
        assert.equal(typeof caps.noOutputFlag, "boolean");
        assert.equal(typeof caps.windowSizeLatest, "boolean");
        assert.equal(typeof caps.ignoreSizeFlag, "boolean");
        assert.equal(typeof caps.readOnlyFlag, "boolean");
        assert.equal(typeof caps.pauseAfterFlag, "boolean");
        assert.equal(typeof caps.activePaneFlag, "boolean");
        assert.equal(typeof caps.scrollOnClear, "boolean");
        assert.equal(typeof caps.noDetachOnDestroy, "boolean");
    });
    it("belowFloor is consistent with version and MINIMUM_TMUX_VERSION", () => {
        const state = probeTmuxCapabilities();
        assert.ok(state !== null);
        const expectedBelowFloor = compareTmuxVersion(state.version, MINIMUM_TMUX_VERSION) < 0;
        assert.equal(state.belowFloor, expectedBelowFloor);
    });
    it("capabilities are consistent with deriveCapabilities(version)", () => {
        const state = probeTmuxCapabilities();
        assert.ok(state !== null);
        const expected = deriveCapabilities(state.version);
        assert.deepEqual(state.capabilities, expected);
    });
});
//# sourceMappingURL=tmux-capabilities.test.js.map