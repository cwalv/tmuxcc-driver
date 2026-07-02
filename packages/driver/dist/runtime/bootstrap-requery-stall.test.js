/**
 * tc-hfxb.15 — Bootstrap-requery stall recovery (real tmux 3.4).
 *
 * REGRESSION TARGET. The driver bootstrap requery in `pipeline.start()` is a
 * `list-windows` / `list-panes` round-trip over the freshly-forked `tmux -CC`
 * stream. That round-trip had NO timeout anywhere in the chain: under host load
 * the first reply could STALL, and with no timeout a single transient stall
 * silently consumed the caller's whole connect budget (the e2e suite's 15 s
 * terminal-appearance wait failing at serial position ~22 — the tc-crnt.17 /
 * tc-0eds class). The only existing retry (`connectWithBoundedRetry`,
 * extension-side) fires on a thrown REJECTION, never on a stall.
 *
 * THE FIX (tc-hfxb.15, driver-side): `pipeline.start()` now races each
 * bootstrap `engine.requery()` against `bootstrapRequeryTimeoutMs`; on a stall
 * it CANCELS the stalled cycle's two `list-*` correlator slots
 * (`CommandCorrelator.cancelOldest`, which leaves drained placeholders in the
 * FIFO so a late `%end` can't mis-bind a subsequent command) and RE-ISSUES the
 * (idempotent) requery. The 15 s envelope is unchanged.
 *
 * # Stall-injection seam (test-only, NO production change)
 *
 * `DelayingWriteHost` wraps a real `TmuxHost` and WITHHOLDS the first
 * `delayWrites` writes (the bootstrap `list-windows` + `list-panes` commands)
 * for `releaseAfterMs` before forwarding them to real tmux. Because
 * `correlator.send` registers the slot BEFORE calling `host.write`, the slots
 * are queued immediately (FIFO intact) but tmux only RECEIVES the commands
 * after the delay — so its replies arrive late, exactly reproducing the
 * production stall. After release, the late `list-*` replies must be absorbed
 * by the cancelled placeholder slots (path d below). Production behaviour is
 * untouched when the wrapper isn't used.
 *
 * Asserts, against REAL tmux (no Electron / Chrome):
 *   (a) the bounded timeout FIRES (recovery happens on the order of the stall
 *       delay, NOT after an unbounded 15 s+ hang);
 *   (b) the requery is RE-ISSUED and the session BOOTSTRAPS (model has ≥1
 *       window / ≥1 pane, pipeline is live);
 *   (c) recovery lands within a small budget (well under the 15 s envelope);
 *   (d) NO correlator slot mis-bind: a LATE `%end` from the abandoned first
 *       requery does NOT corrupt a subsequent command's response.
 *
 * Excluded from the session-proxy tsconfig build (real-tmux test, tsx-run).
 *
 * @module runtime/bootstrap-requery-stall.test
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { trackSocket, killTmuxServer } from "./test-tmux-cleanup.js";
import { createTmuxHost } from "./tmux-host.js";
import { createRuntimePipeline } from "./pipeline.js";
// ---------------------------------------------------------------------------
// Guard: skip the whole suite if tmux is absent.
// ---------------------------------------------------------------------------
const tmuxAvailable = (() => {
    try {
        const r = spawnSync("tmux", ["-V"], { encoding: "utf8" });
        return r.status === 0 && /tmux\s+\d/.test(r.stdout ?? "");
    }
    catch {
        return false;
    }
})();
const RUN_SUFFIX = `${Date.now()}`;
function realSockName(label) {
    // tc-bpn — shape `tmuxcc-test-<pid>-...` required by test-tmux-cleanup.
    const sock = `tmuxcc-test-${process.pid}-stall-${RUN_SUFFIX}-${label}`;
    trackSocket(sock);
    return sock;
}
// ---------------------------------------------------------------------------
// DelayingWriteHost — withhold the first N writes for releaseAfterMs.
// ---------------------------------------------------------------------------
/**
 * Wrap a `TmuxHost`, delaying the first `delayWrites` write() calls by
 * `releaseAfterMs` (queued, then flushed in order to the real host). Every
 * other method is a straight pass-through. This is the stall-injection seam:
 * the bootstrap `list-*` commands reach tmux late, so their replies are late.
 */
class DelayingWriteHost {
    _inner;
    _delayWrites;
    _releaseAfterMs;
    _writesSeen = 0;
    _queued = [];
    _released = false;
    constructor(_inner, _delayWrites, _releaseAfterMs) {
        this._inner = _inner;
        this._delayWrites = _delayWrites;
        this._releaseAfterMs = _releaseAfterMs;
    }
    /** True once the delayed writes have been flushed to the real host. */
    get released() {
        return this._released;
    }
    start() {
        return this._inner.start();
    }
    write(data) {
        if (this._writesSeen < this._delayWrites && !this._released) {
            this._writesSeen += 1;
            this._queued.push(data);
            if (this._queued.length === this._delayWrites) {
                // Both bootstrap commands have been queued — schedule the release.
                setTimeout(() => this._release(), this._releaseAfterMs);
            }
            return;
        }
        this._inner.write(data);
    }
    _release() {
        if (this._released)
            return;
        this._released = true;
        for (const data of this._queued) {
            this._inner.write(data);
        }
        this._queued.length = 0;
    }
    onData(handler) {
        return this._inner.onData(handler);
    }
    onExit(handler) {
        return this._inner.onExit(handler);
    }
    onError(handler) {
        return this._inner.onError(handler);
    }
    onStderr(handler) {
        return this._inner.onStderr(handler);
    }
    stop() {
        return this._inner.stop();
    }
    kill(signal) {
        this._inner.kill(signal);
    }
    get pid() {
        return this._inner.pid;
    }
    get exited() {
        return this._inner.exited;
    }
}
// ---------------------------------------------------------------------------
// Capture stderr so we can assert the STALLED diagnostic fired.
// ---------------------------------------------------------------------------
function captureStderr() {
    const orig = process.stderr.write.bind(process.stderr);
    let buf = "";
    process.stderr.write = ((chunk, ...rest) => {
        buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        // Still forward so the test log shows it.
        return orig(chunk, ...rest);
    });
    return {
        restore: () => {
            process.stderr.write = orig;
            return buf;
        },
    };
}
describe("tc-hfxb.15: bootstrap requery stall recovery (real tmux 3.4)", { skip: !tmuxAvailable ? "tmux not found on PATH" : false }, () => {
    it("recovers from a stalled first bootstrap requery without a budget blowout or a slot mis-bind", async () => {
        const sock = realSockName("recover");
        after(() => killTmuxServer(sock));
        // Small, deterministic numbers: the timeout is well under the stall, so
        // attempt 1 ALWAYS times out; the stall releases shortly after, so
        // attempt 2 (against a now-responsive tmux) succeeds. Both are far below
        // the 15 s envelope this fix protects.
        const TIMEOUT_MS = 300;
        const STALL_MS = 600; // > TIMEOUT_MS ⇒ attempt 1 stalls; releases after
        const RECOVERY_BUDGET_MS = 8000; // generous; the real bug hangs ~15 s+
        const realHost = createTmuxHost({
            socketName: sock,
            sessionName: "stallsession",
            cols: 80,
            rows: 24,
        });
        realHost.onError(() => { }); // suppress unhandled error events
        // Delay exactly the two bootstrap list-* writes.
        const host = new DelayingWriteHost(realHost, 2, STALL_MS);
        const pipeline = createRuntimePipeline(host, {
            sessionName: "stallsession",
            bootstrapRequeryTimeoutMs: TIMEOUT_MS,
        });
        const cap = captureStderr();
        let stderrLog = "";
        let elapsedMs = 0;
        try {
            await host.start();
            const startedAt = Date.now();
            await pipeline.start();
            elapsedMs = Date.now() - startedAt;
        }
        finally {
            stderrLog = cap.restore();
        }
        // (a) The bounded timeout FIRED — the pipeline logged the stall + slot
        // cancellation. (If the timeout had not fired, start() would have hung
        // on the stalled round-trip until the delayed write released, with no
        // diagnostic — the pre-fix behaviour.)
        assert.match(stderrLog, /bootstrap requery STALLED/, "the bounded bootstrap-requery timeout must fire and log the stall + slot cancellation");
        assert.match(stderrLog, /cancelled 2 correlator slot\(s\)/, "both stalled list-* correlator slots must be cancelled before re-issue");
        // (b) The requery was RE-ISSUED and the session BOOTSTRAPPED.
        assert.equal(pipeline.isLive(), true, "pipeline must be live after recovery");
        const model = pipeline.getModel();
        assert.ok(model.windows.size >= 1, `recovered model must have >=1 window (got ${model.windows.size})`);
        assert.ok(model.panes.size >= 1, `recovered model must have >=1 pane (got ${model.panes.size})`);
        // (c) Recovery landed within a small budget — NOT an unbounded hang.
        assert.ok(elapsedMs < RECOVERY_BUDGET_MS, `recovery must land within ${RECOVERY_BUDGET_MS} ms (took ${elapsedMs} ms)`);
        // The delayed (stalled) writes must actually have been released by now,
        // so the LATE list-* replies have arrived and been absorbed by the
        // cancelled placeholder slots.
        assert.equal(host.released, true, "the stalled bootstrap writes must have been released");
        // (d) NO slot mis-bind. Issue a subsequent command and assert its
        // response is correct — i.e. the late list-* replies bound to the
        // cancelled placeholders, NOT to this command's slot. We read a known
        // tmux value back. Give the late replies a beat to land first so the
        // mis-bind (if any) would have already corrupted the FIFO.
        await new Promise((r) => setTimeout(r, 200));
        const probe = await pipeline.send("display-message -p -- 'PROBE-OK'");
        assert.equal(probe.ok, true, "subsequent command must succeed (no mis-bind)");
        const body = Buffer.from(probe.body).toString("utf8");
        assert.match(body, /PROBE-OK/, `subsequent command's reply must be its OWN reply, not a mis-bound late list-* reply (got: ${JSON.stringify(body)})`);
        pipeline.stop();
        await host.stop().catch(() => { });
    });
    it("does not time out when tmux responds promptly (no false-positive cancel)", async () => {
        const sock = realSockName("prompt");
        after(() => killTmuxServer(sock));
        const host = createTmuxHost({
            socketName: sock,
            sessionName: "promptsession",
            cols: 80,
            rows: 24,
        });
        host.onError(() => { });
        const pipeline = createRuntimePipeline(host, {
            sessionName: "promptsession",
            bootstrapRequeryTimeoutMs: 300,
        });
        const cap = captureStderr();
        let stderrLog = "";
        try {
            await host.start();
            await pipeline.start();
        }
        finally {
            stderrLog = cap.restore();
        }
        assert.doesNotMatch(stderrLog, /bootstrap requery STALLED/, "a prompt bootstrap must NOT trip the stall timeout (no false positive)");
        assert.equal(pipeline.isLive(), true, "pipeline must be live");
        assert.ok(pipeline.getModel().panes.size >= 1, "model must have >=1 pane");
        pipeline.stop();
        await host.stop().catch(() => { });
    });
});
//# sourceMappingURL=bootstrap-requery-stall.test.js.map