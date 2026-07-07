import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SESSION_PROXY_PLACEHOLDER, type SessionProxyHandle } from "./index.js";

describe("@tmuxcc/driver session-proxy placeholder exports", () => {
  it("exports SESSION_PROXY_PLACEHOLDER as true", () => {
    assert.strictEqual(SESSION_PROXY_PLACEHOLDER, true);
  });

  it("SessionProxyHandle type is structurally sound (compile-time check)", () => {
    // Construct a minimal conforming object to confirm the type compiles correctly.
    const stub: SessionProxyHandle = {
      pid: 1,
      stop: async () => {},
    };
    assert.strictEqual(stub.pid, 1);
    assert.strictEqual(typeof stub.stop, "function");
  });
});
