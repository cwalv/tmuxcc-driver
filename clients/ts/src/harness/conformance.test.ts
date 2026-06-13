/**
 * conformance.test.ts — the protocol conformance suite (tc-ozk.4 / W3.2).
 *
 * Runs every transcript in `protocol/transcripts/` against BOTH:
 *   (a) the SDK's own parser/mirror (`conformClientToTranscript`), and
 *   (b) the REAL session-proxy daemon (`conformDaemonToTranscript`).
 *
 * This is the artifact that makes "the protocol is the product" enforceable in
 * CI: the same wire material pins the client and the daemon to the protocol. Any
 * future SDK (lua/python) or daemon implementation runs against these same
 * transcripts.
 *
 * NO LIVE TMUX: the daemon side drives the real `createControlServer` over an
 * in-memory transport with a fake pipeline; the client side drives the real
 * `connectClient` over an in-memory transport with the scriptable stub daemon.
 *
 * @module harness/conformance.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readdirSync } from "node:fs";

import {
  loadTranscript,
  conformClientToTranscript,
  conformDaemonToTranscript,
  parseTranscript,
  TranscriptError,
} from "./index.js";

// clients/ts/src/harness → clients/ts/src → clients/ts → clients → tmuxcc-driver
const __here = dirname(fileURLToPath(import.meta.url));
const driverRoot = resolve(__here, "../../../../");
const transcriptDir = resolve(driverRoot, "protocol/transcripts");

const transcriptFiles = readdirSync(transcriptDir).filter((f) => f.endsWith(".json"));

describe("protocol conformance (tc-ozk.4)", () => {
  it("at least one transcript exists", () => {
    assert.ok(transcriptFiles.length > 0, "expected transcripts in protocol/transcripts/");
  });

  for (const file of transcriptFiles) {
    const path = resolve(transcriptDir, file);

    describe(file, () => {
      it("loads + validates (fail-loud)", () => {
        const t = loadTranscript(path);
        assert.equal(t.protocolVersion, 3);
        assert.ok(t.transcript.length > 0);
      });

      it("SDK parser/mirror conforms", async () => {
        await conformClientToTranscript(loadTranscript(path));
      });

      it("real session-proxy daemon conforms", async () => {
        await conformDaemonToTranscript(loadTranscript(path));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Loader fail-loud contract
  // -------------------------------------------------------------------------
  describe("loader fail-loud", () => {
    it("rejects a wrong protocolVersion", () => {
      assert.throws(
        () => parseTranscript({ protocolVersion: 999, initialModel: {}, transcript: [] }),
        TranscriptError,
      );
    });

    it("rejects a missing initialModel", () => {
      assert.throws(
        () => parseTranscript({ protocolVersion: 3, transcript: [] }),
        TranscriptError,
      );
    });

    it("rejects an unknown step direction", () => {
      assert.throws(
        () =>
          parseTranscript({
            protocolVersion: 3,
            initialModel: { session: { sessionId: "s0", name: "x" }, windows: [], panes: [], focus: { paneId: null, windowId: null } },
            transcript: [{ direction: "sideways", step: 1, label: "bad", message: { type: "x" } }],
          }),
        TranscriptError,
      );
    });
  });
});
