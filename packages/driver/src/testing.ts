/**
 * @tmuxcc/driver/testing — test-only fixtures for the driver package.
 *
 * MUST NOT be imported from production code or the VS Code extension bundle.
 * The vscode post-build check enforces this by asserting the bundle contains
 * no 'tmuxcc-fixture-' marker string (tc-ehzi.6).
 *
 * This module is intentionally NOT re-exported from the package's main entry
 * point (index.ts).  It is reachable only via the './testing' export condition
 * in package.json:  import { ownedSocketFixture } from '@tmuxcc/driver/testing'
 *
 * @module testing
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

import { serverProxySocketPath } from "./runtime-dir.js";

/**
 * Create a self-contained, security-verified socket fixture for a test.
 *
 * Creates a fresh mkdtemp directory named 'tmuxcc-fixture-*' as the
 * runtimeDir, then derives the server-proxy socket path via
 * serverProxySocketPath(socketName, {runtimeDir}).  The serverProxySocketPath
 * call internally runs ensureDir + verifyRuntimeDir (mode 0o700, owned by
 * current uid, non-symlink) on every directory in the path — so the fixture
 * is security-verified on creation without any extra mkdir/chmod calls here.
 *
 * Cleanup (rmSync recursive) is registered via t.after so it fires at the end
 * of the enclosing test regardless of pass/fail.
 *
 * @param t          Node.js TestContext (the `t` arg of an `it` callback).
 * @param socketName Tmux socket name used as the sub-directory name under base.
 * @returns          { socketPath, runtimeDir } — the computed socket path and
 *                   the temp runtimeDir base.
 */
export function ownedSocketFixture(
  t: TestContext,
  socketName: string,
): { socketPath: string; runtimeDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-fixture-"));
  // serverProxySocketPath calls resolveBaseRuntimeDir which calls ensureDir
  // then verifyRuntimeDir — mode/ownership/layout enforcement stays in
  // runtime-dir.ts, not duplicated here (tc-ehzi.6 design decision).
  const socketPath = serverProxySocketPath(socketName, { runtimeDir: base });
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { socketPath, runtimeDir: base };
}
