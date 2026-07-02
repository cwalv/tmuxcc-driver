/**
 * info.test.ts — Layer A unit coverage for the server-proxy command-correlation
 * helper (tc-44u4.3).
 *
 * `fetchServerProxyInfo` / `fetchSessionProxyInfo` open REAL unix sockets via
 * `@tmuxcc/driver`, so they need a live driver to exercise end-to-end —
 * that belongs to an integration/e2e layer, not a unit test (there is no mock
 * driver socket).  What IS unit-testable without a live driver is the
 * request/response correlation contract, which `runServerProxyCommand` owns and
 * which an in-memory transport pair drives exactly: correlationId echo,
 * ok-payload extraction, `ok:false` error propagation, and transport-close
 * rejection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTransportPair } from "@tmuxcc/protocol";
import type { MessageBase, ServerProxyCommandRequestMessage } from "@tmuxcc/protocol";

import { runServerProxyCommand } from "./info.js";

test("runServerProxyCommand resolves with the correlated ok payload", async () => {
  const { sessionProxy: serverProxy, client } = createInMemoryTransportPair();

  // Stand-in server-proxy: echo back a command.response carrying an info payload.
  serverProxy.onControl((msg: MessageBase) => {
    const req = msg as ServerProxyCommandRequestMessage;
    assert.equal(req.type, "command.request");
    assert.equal(req.command.kind, "server-proxy.info");
    serverProxy.sendControl({
      type: "command.response",
      seq: 1,
      correlationId: req.correlationId,
      result: { ok: true, payload: { info: { socketName: "sock-x" } } },
    } as unknown as Parameters<typeof serverProxy.sendControl>[0]);
  });

  const payload = await runServerProxyCommand(
    client,
    { kind: "server-proxy.info" },
    "server-proxy.info",
  );
  assert.equal(payload.info?.socketName, "sock-x");
});

test("runServerProxyCommand rejects on an ok:false result", async () => {
  const { sessionProxy: serverProxy, client } = createInMemoryTransportPair();

  serverProxy.onControl((msg: MessageBase) => {
    const req = msg as ServerProxyCommandRequestMessage;
    serverProxy.sendControl({
      type: "command.response",
      seq: 1,
      correlationId: req.correlationId,
      result: { ok: false, code: "protocol.unknown-message", message: "nope" },
    } as unknown as Parameters<typeof serverProxy.sendControl>[0]);
  });

  await assert.rejects(
    runServerProxyCommand(client, { kind: "server-proxy.info" }, "server-proxy.info"),
    /server-proxy server-proxy\.info failed: \[protocol\.unknown-message\] nope/,
  );
});

test("runServerProxyCommand ignores a mismatched correlationId then resolves on the match", async () => {
  const { sessionProxy: serverProxy, client } = createInMemoryTransportPair();

  serverProxy.onControl((msg: MessageBase) => {
    const req = msg as ServerProxyCommandRequestMessage;
    // A stray response for a DIFFERENT correlationId must not resolve us.
    serverProxy.sendControl({
      type: "command.response",
      seq: 1,
      correlationId: "some-other-id",
      result: { ok: true, payload: { info: { socketName: "WRONG" } } },
    } as unknown as Parameters<typeof serverProxy.sendControl>[0]);
    serverProxy.sendControl({
      type: "command.response",
      seq: 2,
      correlationId: req.correlationId,
      result: { ok: true, payload: { info: { socketName: "right" } } },
    } as unknown as Parameters<typeof serverProxy.sendControl>[0]);
  });

  const payload = await runServerProxyCommand(
    client,
    { kind: "server-proxy.info" },
    "server-proxy.info",
  );
  assert.equal(payload.info?.socketName, "right");
});

test("runServerProxyCommand rejects when the transport closes before a response", async () => {
  const { sessionProxy: serverProxy, client } = createInMemoryTransportPair();

  serverProxy.onControl(() => {
    // Never respond — slam the transport instead.
    serverProxy.close();
  });

  await assert.rejects(
    runServerProxyCommand(client, { kind: "server-proxy.info" }, "server-proxy.info"),
    /closed before server-proxy\.info response/,
  );
});
