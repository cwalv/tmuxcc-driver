/**
 * tc-76m8.32 — zero-client flood must not wedge the pane (real tmux).
 *
 * # The bug this file pins
 *
 * After the LAST client detaches (or before the first ever attaches), pane
 * output kept flowing through the accounting store into the flow controller.
 * The controller fanned those bytes into the implicit DEFAULT_CLIENT
 * sub-ledger — a ledger NO transport ever drains (production only credits
 * `noteDrained` from a real client's draining wrapper). A pane that flooded
 * past HIGH_WATER during such a zero-client interval was paused and could
 * NEVER resume: the resume edge needs the MAX over sub-ledgers to fall to
 * LOW_WATER, and the stale DEFAULT_CLIENT entry pinned it above forever —
 * even after a new client attached (a fresh client starts at 0 and its
 * credits debit only its own sub-ledger). Permanent frozen pane; continuity
 * broken (tmux held/aged the output the store should have mirrored).
 *
 * The fix (FC-6, flow-control.ts): the ledger's keys are exactly the
 * registered client set. With zero registered clients `onPaneBytes` accounts
 * nothing and backpressure never engages — the bytes are owed to no
 * transport (FC-4's sense), and the capped scrollback store keeps mirroring
 * the pane for reattach hydration.
 *
 * # Coverage
 *
 *   Z1. Full production path: attach a client, detach it, flood the pane
 *       during the zero-client interval (well past HIGH_WATER), reattach a
 *       fresh client. The pane must NOT be backpressure-paused, the ledger
 *       must not be pinned, and a post-reattach marker round-trip must reach
 *       the new client (the demux gate is genuinely open).
 *
 * @module runtime/flow-zero-client.test
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createInMemoryTransportPair, runClientHandshake, WIRE_PROTOCOL_VERSION, } from "@tmuxcc/protocol";
import { createSessionProxy } from "./session-proxy.js";
import { trackSocket, killTmuxServer } from "./test-tmux-cleanup.js";
// ---------------------------------------------------------------------------
// tmux guard + socket bookkeeping (mirrors flow-abrupt-death.test.ts).
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
function sockName(label) {
    // tc-bpn shape: tmuxcc-test-<pid>-...; trackSocket BEFORE spawn so a thrown
    // test still gets its server reaped by the process-exit net.
    const sock = `tmuxcc-test-${process.pid}-fzc-${RUN_SUFFIX}-${label}`;
    trackSocket(sock);
    return sock;
}
const CLIENT_CAPS = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    features: [
        "pane-lifecycle",
        "layout-updates",
        "focus-events",
        "input-forwarding",
    ],
};
function firstPaneId(sessionProxy) {
    const it = sessionProxy.pipeline.getModel().panes.keys().next();
    assert.ok(!it.done, "session must have at least one pane after start");
    return it.value;
}
async function waitFor(probe, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = probe();
        if (v !== undefined)
            return v;
        if (Date.now() > deadline)
            throw new Error(`Timeout (${timeoutMs}ms): ${what()}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}
/**
 * Attach an in-memory client through the FULL sessionProxy.addClient wiring
 * (handshake + hydration + draining wrapper + onClose teardown) and wait for
 * hydration to finish so subsequent fan-out is not queue-gated.
 */
async function attachClient(sessionProxy) {
    const { sessionProxy: sessionProxySide, client } = createInMemoryTransportPair();
    const controlMsgs = [];
    const dataChunks = [];
    const addP = sessionProxy.addClient(sessionProxySide);
    await runClientHandshake(client, CLIENT_CAPS);
    client.onControl((m) => controlMsgs.push(m));
    client.onData((_pid, bytes) => dataChunks.push(new Uint8Array(bytes)));
    await addP;
    await waitFor(() => (controlMsgs.some((m) => m.type === "pane.hydration.end") ? true : undefined), 10_000, () => `hydration never completed; saw: ${controlMsgs.map((m) => m.type).join(",")}`);
    const decoder = new TextDecoder();
    return {
        sessionProxySide,
        client,
        received: () => dataChunks.map((c) => decoder.decode(c)).join(""),
    };
}
describe("tc-76m8.32: a zero-client flood must not wedge the pane (real tmux)", { skip: !tmuxAvailable ? "tmux not found on PATH" : false }, () => {
    // -----------------------------------------------------------------------
    // Z1 — attach → detach → zero-client flood → reattach → pane resumes.
    //
    // Water marks are lowered so the 200 KB flood is far past HIGH_WATER
    // (64 KiB): pre-fix this deterministically paused the pane on the
    // undrainable DEFAULT_CLIENT ledger during the zero-client interval.
    // -----------------------------------------------------------------------
    it("Z1: pane floods while no client is attached; a fresh client attaches and output flows", { timeout: 60_000 }, async () => {
        const sock = sockName("z1");
        after(() => killTmuxServer(sock));
        const sessionProxy = createSessionProxy({
            host: { socketName: sock, sessionName: "fzc-z1", cols: 80, rows: 24 },
            flow: { highWaterBytes: 65_536, lowWaterBytes: 16_384 },
        });
        sessionProxy.host.onError(() => { });
        await sessionProxy.start();
        try {
            const pid = firstPaneId(sessionProxy);
            const tmuxN = pid.slice(1);
            const fc = sessionProxy.flowController;
            const decoder = new TextDecoder();
            // 1. A client attaches and detaches — the session has HAD clients;
            //    we are now in the post-last-detach zero-client interval the
            //    bead describes (fc.removeClient ran via the onClose wiring).
            const c1 = await attachClient(sessionProxy);
            c1.sessionProxySide.close();
            await waitFor(() => (sessionProxy.server.clientCount() === 0 ? true : undefined), 10_000, () => `client 1 never detached; clientCount=${sessionProxy.server.clientCount()}`);
            // 2. Zero-client flood: 200 KB of pane output — 3× HIGH_WATER —
            //    driven straight through the pipeline (no client to send input).
            //    The DONE sentinel is quote-split so the ECHOED COMMAND LINE
            //    (which lands in the store immediately) does not contain the
            //    sentinel substring — only the flood's real output does.
            await sessionProxy.send(`send-keys -t %${tmuxN} 'yes | head -c 200000; echo "ZC-FLOOD-DO""NE"' Enter`);
            // The flood either completes into the (capped) store — post-fix,
            // backpressure never engages with zero clients — or crosses
            // HIGH_WATER and pauses the pane on the undrainable ledger
            // (pre-fix). Wait for whichever happens so both worlds proceed to
            // the reattach assertions below.
            await waitFor(() => fc.isPanePaused(pid) ||
                decoder.decode(sessionProxy.demux.store.getContents(pid)).includes("ZC-FLOOD-DONE")
                ? true
                : undefined, 30_000, () => `flood neither paused the pane nor completed; ` +
                `bufferedBytes=${fc.bufferedBytes(pid)} storeBytes=${sessionProxy.demux.store.size(pid)}`);
            // 3. A fresh client attaches through the full production wiring.
            const c2 = await attachClient(sessionProxy);
            // THE wedge assertions: the zero-client flood must not leave the
            // pane backpressure-paused, and no stale ledger may pin the resume
            // edge. Pre-fix both fail forever: the DEFAULT_CLIENT sub-ledger
            // sits clamped at HIGH_WATER (65536 > lowWater 16384) and nothing
            // can ever debit it.
            assert.equal(fc.isPanePaused(pid), false, `pane must not remain paused after a fresh client attaches; ` +
                `bufferedBytes=${fc.bufferedBytes(pid)} is pinned by a ledger no transport drains ` +
                `(the tc-76m8.32 zero-client wedge)`);
            assert.ok(fc.bufferedBytes(pid) <= 16_384, `no stale sub-ledger may pin the max above low-water after reattach; ` +
                `bufferedBytes=${fc.bufferedBytes(pid)}`);
            // 4. Behavioral proof the pane genuinely resumed: a marker typed by
            //    the new client must round-trip back out through the demux gate.
            //    Quote-split like the flood sentinel: the input echo must not
            //    satisfy the wait — only the pane's real output may.
            let seq = 1;
            c2.client.sendControl({
                type: "input",
                seq: ++seq,
                paneId: pid,
                data: 'echo "ZC-MARKER-RES""UME"\n',
            });
            await waitFor(() => (c2.received().includes("ZC-MARKER-RESUME") ? true : undefined), 15_000, () => `marker never reached the reattached client — the demux gate is still closed ` +
                `(paused=${String(fc.isPanePaused(pid))} bufferedBytes=${fc.bufferedBytes(pid)})`);
        }
        finally {
            sessionProxy.kill();
            killTmuxServer(sock);
        }
    });
});
//# sourceMappingURL=flow-zero-client.test.js.map