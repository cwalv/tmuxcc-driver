/**
 * tc-33ug — paneIdToTmux / tmuxToPaneId unit tests.
 *
 * The conversion pair lives beside the PaneId type in ids.ts so there is
 * exactly ONE canonical site for the wire `p<N>` ↔ tmux `%<N>` mapping.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { paneIdToTmux, tmuxToPaneId } from "./ids.js";
import type { PaneId } from "./ids.js";

describe("paneIdToTmux", () => {
  it("converts p0 to %0", () => {
    assert.strictEqual(paneIdToTmux("p0" as PaneId), "%0");
  });

  it("converts p3 to %3", () => {
    assert.strictEqual(paneIdToTmux("p3" as PaneId), "%3");
  });

  it("converts p42 to %42", () => {
    assert.strictEqual(paneIdToTmux("p42" as PaneId), "%42");
  });

  it("round-trips with tmuxToPaneId", () => {
    const wire = "p7" as PaneId;
    assert.strictEqual(tmuxToPaneId(paneIdToTmux(wire)), wire);
  });
});

describe("tmuxToPaneId", () => {
  it("converts %0 to p0", () => {
    assert.strictEqual(tmuxToPaneId("%0"), "p0" as PaneId);
  });

  it("converts %3 to p3", () => {
    assert.strictEqual(tmuxToPaneId("%3"), "p3" as PaneId);
  });

  it("converts %42 to p42", () => {
    assert.strictEqual(tmuxToPaneId("%42"), "p42" as PaneId);
  });

  it("round-trips with paneIdToTmux", () => {
    const tmux = "%12";
    assert.strictEqual(paneIdToTmux(tmuxToPaneId(tmux)), tmux);
  });

  it("throws on missing % prefix", () => {
    assert.throws(
      () => tmuxToPaneId("p3"),
      (err: unknown) => err instanceof TypeError && (err as TypeError).message.includes("%<N>"),
    );
  });

  it("throws on bare number", () => {
    assert.throws(
      () => tmuxToPaneId("3"),
      (err: unknown) => err instanceof TypeError,
    );
  });

  it("throws on NaN suffix", () => {
    assert.throws(
      () => tmuxToPaneId("%abc"),
      (err: unknown) => err instanceof TypeError,
    );
  });

  it("throws on empty string", () => {
    assert.throws(
      () => tmuxToPaneId(""),
      (err: unknown) => err instanceof TypeError,
    );
  });
});
