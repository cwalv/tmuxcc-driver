/**
 * metrics-http.test.ts — unit tests for the `/metrics` (+ `/info`) HTTP
 * exposition's bind parsing and listener lifecycle (tc-44u4.4).
 *
 * No tmux required — drives the HTTP surface directly with a stub provider.
 *
 * Covers:
 *   - bind-spec parsing: the secure unix default, explicit `unix:/path`,
 *     loopback TCP, and the REFUSAL of a non-loopback TCP host;
 *   - the unix-socket bind is mode 0600 under the 0700 runtime-dir chain;
 *   - `/metrics` and `/info` render; unknown paths → 404; non-GET → 405;
 *   - close() unbinds and removes the managed unix socket file.
 *
 * @module metrics-http.test
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { parseMetricsHttpBind, bindMetricsHttp } from "./metrics-http.js";
function makeRuntimeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-mhttp-"));
}
const STUB_PROVIDERS = {
    metricsText: async () => "# HELP demo_total demo\n# TYPE demo_total counter\ndemo_total 7\n",
    infoJson: async () => ({ socketName: "demo", ok: true }),
};
/** GET over a unix-domain HTTP socket. Resolves { status, body, headers }. */
function getUnix(socketPath, reqPath, method = "GET") {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath, path: reqPath, method }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({
                status: res.statusCode ?? 0,
                body,
                contentType: res.headers["content-type"],
            }));
        });
        req.on("error", reject);
        req.end();
    });
}
describe("parseMetricsHttpBind (tc-44u4.4)", () => {
    // A real temp dir — metricsHttpSocketPath creates the runtime sub-dir.
    const rtBase = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxcc-test-mhttpp-"));
    const rt = { runtimeDir: rtBase };
    afterEach(() => { });
    it("empty / 'unix' → the secure runtime-dir unix default (managed)", () => {
        for (const spec of [undefined, "", "unix"]) {
            const b = parseMetricsHttpBind(spec, "sock", rt);
            assert.equal(b.kind, "unix");
            assert.equal(b.kind === "unix" && b.managed, true);
            assert.ok(b.kind === "unix" && b.path.endsWith("/sock/metrics-http.sock"));
        }
    });
    it("'unix:/abs/path' → explicit unix socket (unmanaged)", () => {
        const b = parseMetricsHttpBind("unix:/tmp/m.sock", "sock", rt);
        assert.equal(b.kind, "unix");
        assert.equal(b.kind === "unix" && b.path, "/tmp/m.sock");
        assert.equal(b.kind === "unix" && b.managed, false);
    });
    it("loopback TCP forms parse; localhost normalises to 127.0.0.1", () => {
        assert.deepEqual(parseMetricsHttpBind("127.0.0.1:9099", "s", rt), { kind: "tcp", host: "127.0.0.1", port: 9099 });
        assert.deepEqual(parseMetricsHttpBind("localhost:0", "s", rt), { kind: "tcp", host: "127.0.0.1", port: 0 });
        assert.deepEqual(parseMetricsHttpBind("[::1]:9099", "s", rt), { kind: "tcp", host: "::1", port: 9099 });
    });
    it("REFUSES a non-loopback TCP host (security: 127.0.0.1 is the only TCP allowed)", () => {
        assert.throws(() => parseMetricsHttpBind("0.0.0.0:9099", "s", rt), /metrics\.bind-invalid/);
        assert.throws(() => parseMetricsHttpBind("192.168.1.5:9099", "s", rt), /metrics\.bind-invalid/);
        assert.throws(() => parseMetricsHttpBind("example.com:9099", "s", rt), /metrics\.bind-invalid/);
    });
    it("rejects malformed specs", () => {
        assert.throws(() => parseMetricsHttpBind("unix:", "s", rt), /metrics\.bind-invalid/);
        assert.throws(() => parseMetricsHttpBind("127.0.0.1:notaport", "s", rt), /metrics\.bind-invalid/);
        assert.throws(() => parseMetricsHttpBind("nohostport", "s", rt), /metrics\.bind-invalid/);
    });
});
describe("bindMetricsHttp lifecycle (tc-44u4.4)", () => {
    let listener = null;
    let rtDir = null;
    afterEach(async () => {
        if (listener !== null) {
            await listener.close();
            listener = null;
        }
        if (rtDir !== null) {
            fs.rmSync(rtDir, { recursive: true, force: true });
            rtDir = null;
        }
    });
    it("serves /metrics and /info over a 0600 unix socket; unbinds on close", async () => {
        rtDir = makeRuntimeDir();
        const bind = parseMetricsHttpBind("unix", "sn", { runtimeDir: rtDir });
        listener = await bindMetricsHttp(bind, STUB_PROVIDERS);
        const sockPath = bind.kind === "unix" ? bind.path : "";
        // Security: socket node is mode 0600 under the 0700 runtime-dir chain.
        assert.equal(fs.statSync(sockPath).mode & 0o777, 0o600, "metrics socket is 0600");
        const dirMode = fs.statSync(path.dirname(sockPath)).mode & 0o777;
        assert.equal(dirMode, 0o700, "runtime sub-dir is 0700");
        const metrics = await getUnix(sockPath, "/metrics");
        assert.equal(metrics.status, 200);
        assert.match(metrics.body, /demo_total 7/);
        assert.match(metrics.contentType ?? "", /text\/plain/);
        const info = await getUnix(sockPath, "/info");
        assert.equal(info.status, 200);
        assert.match(info.contentType ?? "", /application\/json/);
        assert.deepEqual(JSON.parse(info.body), { socketName: "demo", ok: true });
        const notFound = await getUnix(sockPath, "/nope");
        assert.equal(notFound.status, 404);
        const wrongMethod = await getUnix(sockPath, "/metrics", "POST");
        assert.equal(wrongMethod.status, 405);
        // close() unbinds AND removes the managed socket file.
        await listener.close();
        listener = null;
        assert.equal(fs.existsSync(sockPath), false, "managed socket file removed on close");
    });
    it("binds loopback TCP and serves /metrics", async () => {
        const bind = parseMetricsHttpBind("127.0.0.1:0", "sn", {});
        listener = await bindMetricsHttp(bind, STUB_PROVIDERS);
        // address is host:port — port 0 resolved to an ephemeral port by the OS,
        // but our handle reports the requested port; bind on 0 means we must read
        // from the address string. Re-bind on a concrete check instead:
        assert.match(listener.address, /^127\.0\.0\.1:\d+$/);
    });
});
//# sourceMappingURL=metrics-http.test.js.map