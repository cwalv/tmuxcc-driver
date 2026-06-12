/**
 * runtime-dir.test.ts — unit tests for the GC sweep (tc-s1sm).
 *
 * Tests use tmpdir-based runtime dirs and `tmuxcc-test-*` socket names to
 * avoid any interaction with the production `/run/user/<uid>/tmuxcc/tmuxcc/`
 * directory.
 *
 * @module runtime-dir.test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { gcStaleRuntimeDirs, probeLiveSocket } from "./runtime-dir.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCounter = 0;

/** Unique socket name for a test — follows the tmuxcc-test-* convention. */
function nextSocketName(): string {
  return `tmuxcc-test-rtd-${process.pid}-${++testCounter}-${Date.now()}`;
}

/** Create a fresh tmpdir for use as the base runtime dir. */
function makeBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-rtd-base-"));
}

/** Create a sub-directory under `baseDir` named `socketName`. */
function makeSubDir(baseDir: string, socketName: string): string {
  const dir = path.join(baseDir, socketName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Start a real unix-domain server listening on `sockPath`.
 * Returns a stop function that closes the server.
 */
function startListeningServer(sockPath: string): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(sockPath, () => {
      const stop = (): Promise<void> =>
        new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
      resolve(stop);
    });
  });
}

// ---------------------------------------------------------------------------
// probeLiveSocket tests
// ---------------------------------------------------------------------------

describe("probeLiveSocket (tc-s1sm)", () => {
  let baseDir: string;

  before(() => {
    baseDir = makeBaseDir();
  });

  after(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns true when a unix socket is accepting connections", async () => {
    const sockName = nextSocketName();
    const sockPath = path.join(baseDir, `${sockName}.sock`);
    const stop = await startListeningServer(sockPath);
    try {
      const alive = await probeLiveSocket(sockPath, 500);
      assert.equal(alive, true, "live socket must return true");
    } finally {
      await stop();
    }
  });

  it("returns false for ENOENT (socket file does not exist)", async () => {
    const sockPath = path.join(baseDir, `tmuxcc-test-nonexistent-${Date.now()}.sock`);
    const alive = await probeLiveSocket(sockPath, 200);
    assert.equal(alive, false, "missing socket must return false");
  });

  it("returns false for ECONNREFUSED (socket file exists but no listener)", async () => {
    const sockName = nextSocketName();
    const sockPath = path.join(baseDir, `${sockName}.sock`);
    // Create a socket file by briefly listening and then closing.
    const stop = await startListeningServer(sockPath);
    await stop();
    // Socket file may or may not still exist at this point (OS-dependent);
    // either way, no process is accepting connections.
    const alive = await probeLiveSocket(sockPath, 200);
    assert.equal(alive, false, "closed socket must return false");
  });
});

// ---------------------------------------------------------------------------
// gcStaleRuntimeDirs tests
// ---------------------------------------------------------------------------

describe("gcStaleRuntimeDirs (tc-s1sm)", () => {
  it("removes a stale dir whose server-proxy.sock is not answering", async () => {
    const baseDir = makeBaseDir();
    try {
      const staleName = nextSocketName();
      const staleDir = makeSubDir(baseDir, staleName);
      // Create a dead socket file (no listener).
      const sockPath = path.join(staleDir, "server-proxy.sock");
      // Touch: create then immediately close a server to leave the file behind.
      const stop = await startListeningServer(sockPath);
      await stop();
      // Now sockPath may or may not exist, but no process listens on it.

      const currentName = nextSocketName();
      // currentName dir does not need to exist — we just pass it as the guard.

      await gcStaleRuntimeDirs(baseDir, currentName, { probeTimeoutMs: 200, minAgeMs: 0 });

      assert.equal(
        fs.existsSync(staleDir),
        false,
        "stale dir (dead socket) must be removed by GC",
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("removes an orphan dir with no server-proxy.sock at all", async () => {
    const baseDir = makeBaseDir();
    try {
      const orphanName = nextSocketName();
      const orphanDir = makeSubDir(baseDir, orphanName);
      // No server-proxy.sock — just an empty dir.

      const currentName = nextSocketName();
      await gcStaleRuntimeDirs(baseDir, currentName, { probeTimeoutMs: 200, minAgeMs: 0 });

      assert.equal(
        fs.existsSync(orphanDir),
        false,
        "orphan dir (no server-proxy.sock) must be removed by GC",
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("keeps a live-socket dir (server-proxy.sock accepting connections)", async () => {
    const baseDir = makeBaseDir();
    let stop: (() => Promise<void>) | null = null;
    try {
      const liveName = nextSocketName();
      const liveDir = makeSubDir(baseDir, liveName);
      const sockPath = path.join(liveDir, "server-proxy.sock");
      stop = await startListeningServer(sockPath);

      const currentName = nextSocketName();
      await gcStaleRuntimeDirs(baseDir, currentName, { probeTimeoutMs: 500, minAgeMs: 0 });

      assert.equal(
        fs.existsSync(liveDir),
        true,
        "live-socket dir must NOT be removed by GC",
      );
    } finally {
      if (stop) await stop();
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("never removes the current dir even if it has no socket yet", async () => {
    const baseDir = makeBaseDir();
    try {
      const currentName = nextSocketName();
      const currentDir = makeSubDir(baseDir, currentName);
      // No socket file — this is the dir the new broker is about to use.

      await gcStaleRuntimeDirs(baseDir, currentName, { probeTimeoutMs: 200, minAgeMs: 0 });

      assert.equal(
        fs.existsSync(currentDir),
        true,
        "current dir must never be removed by GC",
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("tolerates ENOENT races: does not throw if a dir disappears during sweep", async () => {
    const baseDir = makeBaseDir();
    try {
      // Create two stale dirs; after we start the sweep we cannot directly force a
      // concurrent deletion, but we CAN test the tolerance by verifying the GC
      // completes without throwing even when the target no longer exists by the
      // time rmSync runs.
      //
      // We approximate this by pre-deleting one stale dir before calling gcStaleRuntimeDirs,
      // so the sweep sees the entry in readdir but finds it gone during stat/rmSync.
      const stale1 = nextSocketName();
      const stale2 = nextSocketName();
      const stale1Dir = makeSubDir(baseDir, stale1);
      const stale2Dir = makeSubDir(baseDir, stale2);
      void stale2Dir; // stale2 dir stays; stale1 is pre-removed.

      // Remove stale1 before GC runs so the sweep encounters a vanished dir.
      fs.rmSync(stale1Dir, { recursive: true, force: true });

      const currentName = nextSocketName();
      // Must not throw.
      await assert.doesNotReject(
        () => gcStaleRuntimeDirs(baseDir, currentName, { probeTimeoutMs: 200, minAgeMs: 0 }),
        "gcStaleRuntimeDirs must tolerate ENOENT races without throwing",
      );

      // stale2 (still present and empty = orphan) should be removed.
      assert.equal(
        fs.existsSync(stale2Dir),
        false,
        "stale2 orphan dir must be removed even after stale1 disappeared",
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("does not throw when baseDir does not exist", async () => {
    const nonExistent = path.join(os.tmpdir(), `tmuxcc-test-noexist-${Date.now()}`);
    await assert.doesNotReject(
      () => gcStaleRuntimeDirs(nonExistent, "any-socket-name", { probeTimeoutMs: 200, minAgeMs: 0 }),
      "gcStaleRuntimeDirs must not throw when the base dir does not exist",
    );
  });

  it("skips non-directory entries in baseDir", async () => {
    const baseDir = makeBaseDir();
    try {
      // Place a plain file in the base dir (not a directory).
      const filePath = path.join(baseDir, "stray-file.txt");
      fs.writeFileSync(filePath, "hello");

      const currentName = nextSocketName();
      await gcStaleRuntimeDirs(baseDir, currentName, { probeTimeoutMs: 200, minAgeMs: 0 });

      // The file should still be there (only directories are considered).
      assert.equal(
        fs.existsSync(filePath),
        true,
        "plain files in baseDir must not be removed by GC",
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("age guard: keeps a fresh sock-less dir (sibling broker mid-startup)", async () => {
    const baseDir = makeBaseDir();
    try {
      // A just-created dir with no server-proxy.sock yet — exactly what a
      // sibling broker's runtime dir looks like between mkdir and listen().
      const youngDir = makeSubDir(baseDir, nextSocketName());

      const currentName = nextSocketName();
      // Default minAgeMs (60s) — the young dir must survive the sweep.
      await gcStaleRuntimeDirs(baseDir, currentName, { probeTimeoutMs: 200 });
      assert.equal(
        fs.existsSync(youngDir),
        true,
        "a dir younger than minAgeMs must not be swept even without a socket",
      );

      // With the guard disabled the same dir is treated as an orphan.
      await gcStaleRuntimeDirs(baseDir, currentName, { probeTimeoutMs: 200, minAgeMs: 0 });
      assert.equal(
        fs.existsSync(youngDir),
        false,
        "with minAgeMs=0 the sock-less orphan is removed",
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
