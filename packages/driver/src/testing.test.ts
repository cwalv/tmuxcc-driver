/**
 * testing.test.ts — unit tests for @tmuxcc/driver/testing (tc-ehzi.6).
 *
 * Verifies ownedSocketFixture:
 *   - creates a 0700 owned non-symlink directory chain
 *   - returns the correct socketPath and runtimeDir
 *   - registers cleanup via t.after so the temp dir is removed on test end
 *
 * Must-fix (a) route taken: observable lstat equivalent rather than exporting
 * verifyRuntimeDir.  We assert the observable invariants (mode 0o700, owned
 * by current uid, non-symlink) directly via lstat, which is exactly what
 * verifyRuntimeDir checks internally.  Additionally, a second
 * resolveBaseRuntimeDir({runtimeDir}) call on the created dir exercises the
 * gate code path as belt-and-suspenders (see design note in testing.ts).
 *
 * @module testing.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { ownedSocketFixture } from "./testing.js";
import { resolveBaseRuntimeDir } from "./runtime-dir.js";

describe("ownedSocketFixture (tc-ehzi.6)", () => {
  it("creates a security-verified socket fixture and schedules cleanup", (t) => {
    const socketName = `tmuxcc-test-fixture-${process.pid}-${Date.now()}`;
    const { socketPath, runtimeDir } = ownedSocketFixture(t, socketName);

    // runtimeDir is the mkdtemp base (exists after fixture creation).
    assert.ok(fs.existsSync(runtimeDir), "runtimeDir must exist after fixture creation");

    // socketPath is <runtimeDir>/<socketName>/server-proxy.sock.
    const socketDir = path.join(runtimeDir, socketName);
    assert.ok(fs.existsSync(socketDir), "socketDir must exist after fixture creation");
    assert.equal(
      socketPath,
      path.join(socketDir, "server-proxy.sock"),
      "socketPath must equal <runtimeDir>/<socketName>/server-proxy.sock",
    );

    // Observable security invariants for runtimeDir (tc-ehzi.6 must-fix (a)):
    // lstat + mode check matches what verifyRuntimeDir enforces internally.
    const baseStat = fs.lstatSync(runtimeDir);
    assert.ok(!baseStat.isSymbolicLink(), "runtimeDir must not be a symlink");
    assert.ok(baseStat.isDirectory(), "runtimeDir must be a directory");
    assert.equal(baseStat.mode & 0o077, 0, "runtimeDir must have no group/other bits (0700)");
    if (typeof process.getuid === "function") {
      assert.equal(baseStat.uid, process.getuid(), "runtimeDir must be owned by the current user");
    }

    // socketDir (the sub-directory) gets the same treatment.
    const socketDirStat = fs.lstatSync(socketDir);
    assert.ok(!socketDirStat.isSymbolicLink(), "socketDir must not be a symlink");
    assert.ok(socketDirStat.isDirectory(), "socketDir must be a directory");
    assert.equal(socketDirStat.mode & 0o077, 0, "socketDir must have no group/other bits (0700)");
    if (typeof process.getuid === "function") {
      assert.equal(socketDirStat.uid, process.getuid(), "socketDir must be owned by the current user");
    }

    // Belt-and-suspenders: a second resolveBaseRuntimeDir call on the fixture
    // dir exercises verifyRuntimeDir's code path and throws on any invariant
    // violation (confirming the gate accepts the fixture's layout).
    assert.doesNotThrow(
      () => resolveBaseRuntimeDir({ runtimeDir }),
      "resolveBaseRuntimeDir must accept the fixture dir (security gate passes)",
    );
  });

  it("each call creates an independent temp dir with a unique path", (t) => {
    const socketName = `tmuxcc-test-fixture-${process.pid}-${Date.now()}`;
    const a = ownedSocketFixture(t, socketName);
    const b = ownedSocketFixture(t, socketName);
    assert.notEqual(a.runtimeDir, b.runtimeDir, "each fixture call must produce a unique runtimeDir");
    assert.notEqual(a.socketPath, b.socketPath, "each fixture call must produce a unique socketPath");
  });

  it("cleanup removes the runtimeDir after the test", async (t) => {
    // Run a nested test so we can observe what happens after it ends.
    // We capture runtimeDir, let the subtest end (triggering t.after cleanup),
    // then assert the dir is gone.
    let capturedRuntimeDir: string | undefined;

    await t.test("inner fixture creation", (inner) => {
      const socketName = `tmuxcc-test-cleanup-${process.pid}-${Date.now()}`;
      const { runtimeDir } = ownedSocketFixture(inner, socketName);
      capturedRuntimeDir = runtimeDir;
      assert.ok(fs.existsSync(runtimeDir), "runtimeDir must exist during the test");
    });

    // After the inner test ends, the fixture's t.after has fired.
    assert.ok(
      capturedRuntimeDir !== undefined,
      "capturedRuntimeDir must have been set by the inner test",
    );
    assert.ok(
      !fs.existsSync(capturedRuntimeDir!),
      "cleanup: runtimeDir must be removed after the test ends",
    );
  });
});
