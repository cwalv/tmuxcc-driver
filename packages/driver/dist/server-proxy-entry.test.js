/**
 * server-proxy-entry.test.ts — argument + env parsing for the server-proxy
 * entry script (tc-eqgp).
 *
 * The entry script is responsible for translating the CLI argv and the
 * relevant environment variables into the `ServerProxyOptions` it hands to
 * `createServerProxy`.  These tests pin the parser behaviour without
 * spawning a child process so they run in the unit-test suite.
 *
 * @module server-proxy-entry.test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _parseEntryConfig, _parseIdleExitMs } from "./server-proxy-entry.js";
describe("server-proxy-entry – _parseIdleExitMs (tc-eqgp)", () => {
    it("accepts a positive integer string", () => {
        assert.equal(_parseIdleExitMs("1500"), 1500);
    });
    it("rejects undefined", () => {
        assert.equal(_parseIdleExitMs(undefined), undefined);
    });
    it("rejects empty string", () => {
        assert.equal(_parseIdleExitMs(""), undefined);
    });
    it("rejects non-numeric strings", () => {
        assert.equal(_parseIdleExitMs("abc"), undefined);
    });
    it("rejects zero", () => {
        assert.equal(_parseIdleExitMs("0"), undefined);
    });
    it("rejects negative integers", () => {
        assert.equal(_parseIdleExitMs("-1"), undefined);
    });
});
describe("server-proxy-entry – _parseEntryConfig (tc-eqgp)", () => {
    it("returns socketName from --socket-name", () => {
        const cfg = _parseEntryConfig(["--socket-name", "tmuxcc"], {});
        assert.equal(cfg.socketName, "tmuxcc");
        assert.equal(cfg.runtimeDir, undefined);
        assert.equal(cfg.idleExitMs, undefined);
    });
    it("returns socketName=null when --socket-name is missing (CLI driver maps to usage error)", () => {
        const cfg = _parseEntryConfig([], {});
        assert.equal(cfg.socketName, null);
    });
    it("returns runtimeDir from --runtime-dir", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--runtime-dir", "/tmp/x"], {});
        assert.equal(cfg.runtimeDir, "/tmp/x");
    });
    it("returns idleExitMs from --idle-exit-ms when valid", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--idle-exit-ms", "2500"], {});
        assert.equal(cfg.idleExitMs, 2500);
    });
    it("returns idleExitMs=undefined when --idle-exit-ms is malformed", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--idle-exit-ms", "nope"], {});
        assert.equal(cfg.idleExitMs, undefined);
    });
    it("reads TMUXCC_IDLE_EXIT_MS from env when --idle-exit-ms not given", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], { TMUXCC_IDLE_EXIT_MS: "3000" });
        assert.equal(cfg.idleExitMs, 3000);
    });
    it("--idle-exit-ms wins over TMUXCC_IDLE_EXIT_MS when both are present (explicit CLI is more local intent)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--idle-exit-ms", "1234"], { TMUXCC_IDLE_EXIT_MS: "9999" });
        assert.equal(cfg.idleExitMs, 1234);
    });
    it("rejects malformed TMUXCC_IDLE_EXIT_MS (falls back to default)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], { TMUXCC_IDLE_EXIT_MS: "abc" });
        assert.equal(cfg.idleExitMs, undefined);
    });
    it("rejects zero TMUXCC_IDLE_EXIT_MS (falls back to default)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], { TMUXCC_IDLE_EXIT_MS: "0" });
        assert.equal(cfg.idleExitMs, undefined);
    });
    // tc-0eds: --persist-through-tmux-gone / TMUXCC_PERSIST_THROUGH_TMUX_GONE.
    it("persistThroughTmuxGone is undefined by default (production default unchanged)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], {});
        assert.equal(cfg.persistThroughTmuxGone, undefined);
    });
    it("returns persistThroughTmuxGone=true from --persist-through-tmux-gone", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--persist-through-tmux-gone"], {});
        assert.equal(cfg.persistThroughTmuxGone, true);
    });
    it("reads TMUXCC_PERSIST_THROUGH_TMUX_GONE=1 from env when the flag is absent", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], { TMUXCC_PERSIST_THROUGH_TMUX_GONE: "1" });
        assert.equal(cfg.persistThroughTmuxGone, true);
    });
    it("reads TMUXCC_PERSIST_THROUGH_TMUX_GONE=true from env", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], { TMUXCC_PERSIST_THROUGH_TMUX_GONE: "true" });
        assert.equal(cfg.persistThroughTmuxGone, true);
    });
    it("ignores a non-truthy TMUXCC_PERSIST_THROUGH_TMUX_GONE (default stays off)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], { TMUXCC_PERSIST_THROUGH_TMUX_GONE: "0" });
        assert.equal(cfg.persistThroughTmuxGone, undefined);
    });
    // tc-7aqb.2: --spawn-info JSON flag.
    it("returns spawnInfo from --spawn-info with valid JSON", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--spawn-info", '{"buildId":"1.2.3"}'], {});
        assert.deepEqual(cfg.spawnInfo, { buildId: "1.2.3" });
    });
    it("returns spawnInfo with dev buildId (semver+discriminator)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--spawn-info", '{"buildId":"0.0.0+dev.1718886000000"}'], {});
        assert.deepEqual(cfg.spawnInfo, { buildId: "0.0.0+dev.1718886000000" });
    });
    it("returns spawnInfo=undefined when --spawn-info is absent (backward-compat)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], {});
        assert.equal(cfg.spawnInfo, undefined);
    });
    it("returns spawnInfo=undefined when --spawn-info JSON is malformed (resilient)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--spawn-info", "not-json"], {});
        assert.equal(cfg.spawnInfo, undefined);
    });
    it("returns spawnInfo=undefined when --spawn-info JSON is missing buildId (resilient)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--spawn-info", '{"other":"field"}'], {});
        assert.equal(cfg.spawnInfo, undefined);
    });
    it("returns spawnInfo=undefined when --spawn-info buildId is not a string (resilient)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--spawn-info", '{"buildId":42}'], {});
        assert.equal(cfg.spawnInfo, undefined);
    });
    // tc-44u4.4: --metrics-addr / TMUXCC_METRICS_ADDR (mirrors the idle-exit
    // precedence — CLI wins; absent ⇒ OFF, the secure default).
    it("metricsAddr is undefined by default (OFF — no listener bound)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], {});
        assert.equal(cfg.metricsAddr, undefined);
    });
    it("returns metricsAddr from --metrics-addr", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--metrics-addr", "unix"], {});
        assert.equal(cfg.metricsAddr, "unix");
    });
    it("returns metricsAddr from --metrics-addr with a 127.0.0.1:PORT value", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--metrics-addr", "127.0.0.1:9099"], {});
        assert.equal(cfg.metricsAddr, "127.0.0.1:9099");
    });
    it("reads TMUXCC_METRICS_ADDR from env when --metrics-addr is absent", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], { TMUXCC_METRICS_ADDR: "unix:/tmp/m.sock" });
        assert.equal(cfg.metricsAddr, "unix:/tmp/m.sock");
    });
    it("--metrics-addr wins over TMUXCC_METRICS_ADDR (explicit CLI is more local intent)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x", "--metrics-addr", "unix"], { TMUXCC_METRICS_ADDR: "127.0.0.1:9099" });
        assert.equal(cfg.metricsAddr, "unix");
    });
    it("treats an empty TMUXCC_METRICS_ADDR as not supplied (OFF)", () => {
        const cfg = _parseEntryConfig(["--socket-name", "x"], { TMUXCC_METRICS_ADDR: "" });
        assert.equal(cfg.metricsAddr, undefined);
    });
});
//# sourceMappingURL=server-proxy-entry.test.js.map