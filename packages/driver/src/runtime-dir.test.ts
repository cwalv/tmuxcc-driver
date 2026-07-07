/**
 * runtime-dir.test.ts — unit tests for the GC sweep (tc-s1sm) and runtime-dir
 * security hardening (tc-idlp).
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

import { gcStaleRuntimeDirs, probeLiveSocket, resolveBaseRuntimeDir, runtimeBasePath } from "./runtime-dir.js";

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
 * Back-date a directory's atime/mtime to `Date.now() - offsetMs` (default 5 s).
 *
 * WHY: `stat.mtimeMs` has sub-millisecond precision whereas `Date.now()` returns
 * an integer millisecond.  On a fast machine, a freshly-created dir can have a
 * fractional mtime that is numerically larger than `Date.now()`, making
 * `Date.now() - stat.mtimeMs < 0`, which triggers the age guard even when the
 * caller passes `minAgeMs: 0`.  Back-dating ensures the fixture is unambiguously
 * older than the cutoff so the GC sweep always reaches it.
 */
function backdateDir(dir: string, offsetMs = 5_000): void {
  const t = new Date(Date.now() - offsetMs);
  fs.utimesSync(dir, t, t);
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
      // Back-date: the async server start/stop adds real delay but can still be
      // sub-millisecond-precise relative to Date.now() on a loaded machine.
      backdateDir(staleDir);

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
      // Back-date so the age guard (Date.now() - stat.mtimeMs < minAgeMs) never
      // fires: stat.mtimeMs has sub-millisecond precision; on a fast machine the
      // fractional part can exceed the integer Date.now(), yielding a negative
      // diff even when minAgeMs=0.
      backdateDir(orphanDir);

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
      // Back-date both dirs so the age guard never fires on a fast machine.
      backdateDir(stale1Dir);
      backdateDir(stale2Dir);

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
      // Back-date before the second sweep so the sub-millisecond mtime precision
      // of a just-created dir can never make Date.now() - stat.mtimeMs negative.
      backdateDir(youngDir);
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

// ---------------------------------------------------------------------------
// resolveBaseRuntimeDir security hardening tests (tc-idlp)
//
// These tests exercise ensureDir + verifyRuntimeDir via the public API:
// resolveBaseRuntimeDir({ runtimeDir: <controlled path> }).
// ---------------------------------------------------------------------------

describe("resolveBaseRuntimeDir — security: hijack detection (tc-idlp)", () => {
  it("succeeds when the dir does not exist yet (creates fresh 0700 dir)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-rtd-parent-"));
    const freshDir = path.join(base, "fresh-runtime-dir");
    try {
      // Must not throw.
      const result = resolveBaseRuntimeDir({ runtimeDir: freshDir });
      assert.equal(result, freshDir, "returns the requested runtimeDir path");
      const stat = fs.lstatSync(freshDir);
      assert.ok(stat.isDirectory(), "created path must be a directory");
      assert.equal(
        stat.mode & 0o077,
        0,
        "freshly created dir must have no group/other bits",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("succeeds when the dir already exists with safe 0700 permissions owned by us", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-rtd-parent-"));
    const ownedDir = path.join(base, "owned-runtime-dir");
    fs.mkdirSync(ownedDir, { mode: 0o700 });
    try {
      // A pre-existing 0700 dir owned by us must be accepted without throwing.
      assert.doesNotThrow(
        () => resolveBaseRuntimeDir({ runtimeDir: ownedDir }),
        "a pre-existing safe 0700 dir must be accepted",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws for a pre-existing group-readable dir (mode 0750)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-rtd-parent-"));
    const groupReadable = path.join(base, "group-readable");
    fs.mkdirSync(groupReadable, { mode: 0o750 });
    // Forcibly set the mode to bypass any umask that already stripped the group bits.
    fs.chmodSync(groupReadable, 0o750);
    try {
      assert.throws(
        () => resolveBaseRuntimeDir({ runtimeDir: groupReadable }),
        /unsafe permissions/,
        "group-readable dir must cause abort with 'unsafe permissions' message",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws for a pre-existing world-readable dir (mode 0755)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-rtd-parent-"));
    const worldReadable = path.join(base, "world-readable");
    fs.mkdirSync(worldReadable, { mode: 0o755 });
    fs.chmodSync(worldReadable, 0o755);
    try {
      assert.throws(
        () => resolveBaseRuntimeDir({ runtimeDir: worldReadable }),
        /unsafe permissions/,
        "world-readable dir must cause abort with 'unsafe permissions' message",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws when the path is a symlink to a directory", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-rtd-parent-"));
    const realTarget = path.join(base, "real-target");
    const symlinkPath = path.join(base, "symlink");
    fs.mkdirSync(realTarget, { mode: 0o700 });
    fs.symlinkSync(realTarget, symlinkPath);
    try {
      assert.throws(
        () => resolveBaseRuntimeDir({ runtimeDir: symlinkPath }),
        /symlink/,
        "a symlink to a directory must cause abort",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws when the path is a dangling symlink", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-rtd-parent-"));
    const symlinkPath = path.join(base, "dangling");
    fs.symlinkSync(path.join(base, "nonexistent-target"), symlinkPath);
    try {
      assert.throws(
        () => resolveBaseRuntimeDir({ runtimeDir: symlinkPath }),
        // mkdirSync on a dangling symlink target path throws ENOENT (the
        // dangling symlink does not count as EEXIST), so mkdirSync errors
        // first.  Either way the call must throw rather than proceed.
        (err: unknown) => err instanceof Error,
        "a dangling symlink must cause abort",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws when the path is owned by another user (uses /tmp as foreign-owned dir)", () => {
    // /tmp is owned by root (uid 0).  On any non-root test environment,
    // passing it as runtimeDir must abort with an ownership error.
    if (typeof process.getuid !== "function") {
      // getuid not available on this platform — skip.
      return;
    }
    if (process.getuid() === 0) {
      // Running as root — cannot test foreign-ownership; skip.
      return;
    }
    assert.throws(
      () => resolveBaseRuntimeDir({ runtimeDir: os.tmpdir() }),
      /owned by uid|unsafe permissions/,
      "/tmp must be rejected as a runtime dir (wrong owner or unsafe permissions)",
    );
  });
});

// ---------------------------------------------------------------------------
// runtimeBasePath tests (tc-ehzi.6)
//
// Verifies the pure formula (no fs calls).  Each case asserts on the
// returned path and confirms the path was NOT created on disk.
// ---------------------------------------------------------------------------

describe("runtimeBasePath — pure formula, no fs calls (tc-ehzi.6)", () => {
  it("returns the runtimeDir override unchanged without touching the filesystem", () => {
    const override = path.join(os.tmpdir(), `tmuxcc-test-rbp-override-${Date.now()}`);
    // Must not exist; any prior creation would invalidate the no-fs-calls assertion.
    assert.ok(!fs.existsSync(override), "precondition: override dir must not exist");
    const result = runtimeBasePath({ runtimeDir: override });
    assert.equal(result, override, "returns the override path as-is");
    assert.ok(!fs.existsSync(override), "must NOT create the directory (no fs calls)");
  });

  it("returns $XDG_RUNTIME_DIR/tmuxcc when XDG_RUNTIME_DIR is set, without creating it", () => {
    const fakeXdg = path.join(os.tmpdir(), `tmuxcc-test-rbp-xdg-${Date.now()}`);
    const prev = process.env["XDG_RUNTIME_DIR"];
    process.env["XDG_RUNTIME_DIR"] = fakeXdg;
    try {
      assert.ok(!fs.existsSync(fakeXdg), "precondition: fake XDG dir must not exist");
      const result = runtimeBasePath();
      assert.equal(result, path.join(fakeXdg, "tmuxcc"), "returns XDG/tmuxcc");
      assert.ok(!fs.existsSync(fakeXdg), "must NOT create any directories (no fs calls)");
    } finally {
      if (prev === undefined) {
        delete process.env["XDG_RUNTIME_DIR"];
      } else {
        process.env["XDG_RUNTIME_DIR"] = prev;
      }
    }
  });

  it("returns os.tmpdir()/tmuxcc-<uid> when XDG_RUNTIME_DIR is unset, without creating it", () => {
    const prev = process.env["XDG_RUNTIME_DIR"];
    delete process.env["XDG_RUNTIME_DIR"];
    try {
      const uid = process.getuid?.() ?? "0";
      const expected = path.join(os.tmpdir(), `tmuxcc-${uid}`);
      const result = runtimeBasePath();
      assert.equal(result, expected, "returns tmpdir/tmuxcc-<uid>");
      // We cannot guarantee the fallback path does not already exist on a dev
      // machine (it is created by the broker at startup).  We therefore only
      // assert on the returned string, not on whether it exists.
    } finally {
      if (prev === undefined) {
        delete process.env["XDG_RUNTIME_DIR"];
      } else {
        process.env["XDG_RUNTIME_DIR"] = prev;
      }
    }
  });
});
