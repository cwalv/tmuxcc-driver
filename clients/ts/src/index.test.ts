import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_PLACEHOLDER } from "./index.js";

describe("@remux/client placeholder", () => {
  it("exports CLIENT_PLACEHOLDER as true", () => {
    assert.strictEqual(CLIENT_PLACEHOLDER, true);
  });
});
