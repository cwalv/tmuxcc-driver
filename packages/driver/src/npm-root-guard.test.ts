import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The workspace-root npm guard is a shared, committed script at the driver repo
// root (referenced by every member's preinstall/prebuild). It lives outside any
// member's src/, so we pin its pure decision function here, in the member that
// the tc-rs99 false-positive originally took down (@tmuxcc/driver).
import { isBlockedDirectSubdir } from "../../../scripts/npm-root-guard.mjs";

const MEMBER = "/weave/github/cwalv/tmuxcc-driver/packages/driver";
const ROOT = "/weave";

describe("npm-root-guard discriminator (tc-rs99)", () => {
  it("BLOCKS a direct subdir invocation (INIT_CWD === cwd, no root sentinel)", () => {
    // Developer cd'd into the member dir and ran `npm run build` directly.
    assert.equal(
      isBlockedDirectSubdir({ fromRoot: false, initCwd: MEMBER, cwd: MEMBER }),
      true,
    );
  });

  it("ALLOWS a nested root-initiated build (sentinel set by the root flow)", () => {
    // A member lifecycle script spawned `npm run build`; the nested npm reset
    // INIT_CWD to the member dir, but TMUXCC_NPM_FROM_ROOT was inherited from
    // the root-initiated flow. This is the case that RED'd the gate.
    assert.equal(
      isBlockedDirectSubdir({ fromRoot: true, initCwd: MEMBER, cwd: MEMBER }),
      false,
    );
  });

  it("ALLOWS the classic root `-w` fan-out (npm runs the member from the root cwd)", () => {
    // `npm run build -w <member>` from the root: cwd is the member dir but
    // INIT_CWD is the root, so they differ even without the sentinel.
    assert.equal(
      isBlockedDirectSubdir({ fromRoot: false, initCwd: ROOT, cwd: MEMBER }),
      false,
    );
  });

  it("ALLOWS when INIT_CWD is unset (npm not the invoker)", () => {
    assert.equal(
      isBlockedDirectSubdir({ fromRoot: false, initCwd: undefined, cwd: MEMBER }),
      false,
    );
  });
});
