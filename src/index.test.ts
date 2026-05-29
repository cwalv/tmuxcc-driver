import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DAEMON_PLACEHOLDER, type DaemonHandle } from "./index.js";

describe("@tmuxcc/daemon placeholder", () => {
  it("exports DAEMON_PLACEHOLDER as true", () => {
    assert.strictEqual(DAEMON_PLACEHOLDER, true);
  });

  it("DaemonHandle type is structurally sound (compile-time check)", () => {
    // Construct a minimal conforming object to confirm the type compiles correctly.
    const stub: DaemonHandle = {
      pid: 1,
      stop: async () => {},
    };
    assert.strictEqual(stub.pid, 1);
    assert.strictEqual(typeof stub.stop, "function");
  });
});
