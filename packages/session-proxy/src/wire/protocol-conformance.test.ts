/**
 * Protocol schema conformance tests — tc-1y2.
 *
 * Validates that representative wire messages (and the golden transcripts in
 * protocol/golden/) conform to the JSON Schemas in protocol/schemas/ using ajv.
 *
 * Purpose: schema drift fails this test suite. If a TS type changes in a way
 * that is no longer described by the protocol schemas, these tests fail in CI,
 * signalling that the schemas need to be updated.
 *
 * The test covers:
 *   1. Schema loading — all schema files parse and compile without errors.
 *   2. Session-proxy golden transcript — every message in
 *      protocol/golden/session-proxy-connect-snapshot.json validates.
 *   3. Server-proxy golden transcript — every message in
 *      protocol/golden/server-proxy-connect-snapshot.json validates.
 *   4. Representative negative cases — known-invalid messages are rejected.
 *   5. Representative TS-constructed messages — messages built from the TS
 *      types in wire/ are accepted by the schemas (cross-checks TS ↔ schema
 *      agreement).
 *
 * Import note: ajv is a devDependency hoisted to the tmuxcc-driver workspace
 * root (package.json at packages/session-proxy/../../../ level). It is NOT
 * bundled into the production package — conformance tests only run in CI.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ajv v8 with JSON Schema 2020-12 support
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import {
  WIRE_PROTOCOL_VERSION,
  paneId,
  windowId,
  sessionId,
} from "./index.js";

import type {
  SessionProxyMessage,
  ClientMessage,
  SnapshotMessage,
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  LayoutUpdatedMessage,
  FocusChangedMessage,
  SessionProxyCapabilitiesMessage,
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  SessionProxyCommandRequestMessage,
  SessionProxyCommandResponseMessage,
  ResyncRequestMessage,
  ErrorMessage,
  WindowLayout,
} from "./index.js";

// ---------------------------------------------------------------------------
// Path setup
// ---------------------------------------------------------------------------

const __here = dirname(fileURLToPath(import.meta.url));
// packages/session-proxy/src/wire → packages/session-proxy → packages → tmuxcc-driver
const driverRoot = resolve(__here, "../../../../");
const schemaDir = resolve(driverRoot, "protocol/schemas");
const goldenDir = resolve(driverRoot, "protocol/golden");

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

/**
 * All schema files in dependency order. Each file must be added to ajv before
 * any schema that $ref-s it.
 */
const SCHEMA_FILES = [
  "shared/primitives.json",
  "shared/layout.json",
  "session-proxy/server-push.json",
  "session-proxy/client.json",
  "server-proxy/server-push.json",
  "server-proxy/client.json",
] as const;

type SchemaId =
  | "tmuxcc:shared/primitives"
  | "tmuxcc:shared/layout"
  | "tmuxcc:session-proxy/server-push"
  | "tmuxcc:session-proxy/client"
  | "tmuxcc:server-proxy/server-push"
  | "tmuxcc:server-proxy/client";

let ajv: InstanceType<typeof Ajv2020>;

// Validators compiled once, used in all tests
let validateSessionProxyMsg: ValidateFunction;
let validateClientMsg: ValidateFunction;
let validateServerProxyMsg: ValidateFunction;
let validateServerProxyClientMsg: ValidateFunction;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("protocol schema conformance", () => {
  before(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });

    for (const file of SCHEMA_FILES) {
      const raw = readFileSync(resolve(schemaDir, file), "utf8");
      const schema = JSON.parse(raw) as object;
      ajv.addSchema(schema);
    }

    validateSessionProxyMsg = ajv.compile({
      $ref: "tmuxcc:session-proxy/server-push#/$defs/SessionProxyMessage",
    });
    validateClientMsg = ajv.compile({
      $ref: "tmuxcc:session-proxy/client#/$defs/ClientMessage",
    });
    validateServerProxyMsg = ajv.compile({
      $ref: "tmuxcc:server-proxy/server-push#/$defs/ServerProxyMessage",
    });
    validateServerProxyClientMsg = ajv.compile({
      $ref: "tmuxcc:server-proxy/client#/$defs/ServerProxyCommandRequestMessage",
    });
  });

  // -------------------------------------------------------------------------
  // 1. Schema loading
  // -------------------------------------------------------------------------

  describe("schema loading", () => {
    it("all schema files are valid JSON", () => {
      for (const file of SCHEMA_FILES) {
        const raw = readFileSync(resolve(schemaDir, file), "utf8");
        // If invalid JSON, JSON.parse would throw — that would be caught by the
        // test runner and fail the test.
        const schema = JSON.parse(raw) as { $id?: string };
        assert.ok(typeof schema === "object" && schema !== null, `${file}: expected object`);
        assert.ok(typeof schema.$id === "string", `${file}: missing $id`);
      }
    });

    it("index.json is valid JSON with protocolVersion", () => {
      const raw = readFileSync(resolve(schemaDir, "index.json"), "utf8");
      const idx = JSON.parse(raw) as { examples?: Array<{ protocolVersion?: number }> };
      const version = idx.examples?.[0]?.protocolVersion;
      assert.strictEqual(version, WIRE_PROTOCOL_VERSION, "index.json protocolVersion must match WIRE_PROTOCOL_VERSION");
    });

    it("all schemas compile with ajv without errors", () => {
      for (const id of [
        "tmuxcc:session-proxy/server-push",
        "tmuxcc:session-proxy/client",
        "tmuxcc:server-proxy/server-push",
        "tmuxcc:server-proxy/client",
      ] as SchemaId[]) {
        const schema = ajv.getSchema(id);
        assert.ok(schema !== undefined, `schema ${id} must be registered`);
        assert.ok(typeof schema === "function", `schema ${id} must compile to a validator`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Session-proxy golden transcript
  // -------------------------------------------------------------------------

  describe("session-proxy golden transcript", () => {
    type GoldenStep = {
      direction: string;
      step: number;
      label: string;
      message: unknown;
    };
    type GoldenTranscript = {
      protocolVersion: number;
      transcript: GoldenStep[];
    };

    let golden: GoldenTranscript;

    before(() => {
      const raw = readFileSync(
        resolve(goldenDir, "session-proxy-connect-snapshot.json"),
        "utf8",
      );
      golden = JSON.parse(raw) as GoldenTranscript;
    });

    it("golden transcript protocolVersion matches WIRE_PROTOCOL_VERSION", () => {
      assert.strictEqual(golden.protocolVersion, WIRE_PROTOCOL_VERSION);
    });

    it("all session-proxy→client messages validate against SessionProxyMessage schema", () => {
      const serverSteps = golden.transcript.filter(
        (s) => s.direction === "session-proxy→client",
      );
      assert.ok(serverSteps.length > 0, "transcript must contain session-proxy→client messages");

      for (const step of serverSteps) {
        const valid = validateSessionProxyMsg(step.message);
        assert.ok(
          valid,
          `Step ${step.step} "${step.label}": ${JSON.stringify(validateSessionProxyMsg.errors)}`,
        );
      }
    });

    it("all client→session-proxy messages validate against ClientMessage schema", () => {
      const clientSteps = golden.transcript.filter(
        (s) => s.direction === "client→session-proxy",
      );
      assert.ok(clientSteps.length > 0, "transcript must contain client→session-proxy messages");

      for (const step of clientSteps) {
        const valid = validateClientMsg(step.message);
        assert.ok(
          valid,
          `Step ${step.step} "${step.label}": ${JSON.stringify(validateClientMsg.errors)}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Server-proxy golden transcript
  // -------------------------------------------------------------------------

  describe("server-proxy golden transcript", () => {
    type GoldenStep = {
      direction: string;
      step: number;
      label: string;
      message: { type?: string };
    };
    type GoldenTranscript = {
      protocolVersion: number;
      transcript: GoldenStep[];
    };

    let golden: GoldenTranscript;

    before(() => {
      const raw = readFileSync(
        resolve(goldenDir, "server-proxy-connect-snapshot.json"),
        "utf8",
      );
      golden = JSON.parse(raw) as GoldenTranscript;
    });

    it("golden transcript protocolVersion matches WIRE_PROTOCOL_VERSION", () => {
      assert.strictEqual(golden.protocolVersion, WIRE_PROTOCOL_VERSION);
    });

    it("all server-proxy→client messages validate against ServerProxyMessage schema", () => {
      const serverSteps = golden.transcript.filter(
        (s) => s.direction === "server-proxy→client",
      );
      assert.ok(serverSteps.length > 0);

      for (const step of serverSteps) {
        const valid = validateServerProxyMsg(step.message);
        assert.ok(
          valid,
          `Step ${step.step} "${step.label}": ${JSON.stringify(validateServerProxyMsg.errors)}`,
        );
      }
    });

    it("client.capabilities messages validate against ClientCapabilitiesMessage schema", () => {
      const validateCap = ajv.compile({
        $ref: "tmuxcc:session-proxy/client#/$defs/ClientCapabilitiesMessage",
      });
      const capSteps = golden.transcript.filter(
        (s) => s.direction !== "server-proxy→client" && s.message.type === "client.capabilities",
      );
      assert.ok(capSteps.length > 0);
      for (const step of capSteps) {
        const valid = validateCap(step.message);
        assert.ok(valid, `Step ${step.step}: ${JSON.stringify(validateCap.errors)}`);
      }
    });

    it("command.request messages validate against ServerProxyCommandRequestMessage schema", () => {
      const cmdSteps = golden.transcript.filter(
        (s) => s.direction !== "server-proxy→client" && s.message.type === "command.request",
      );
      assert.ok(cmdSteps.length > 0);
      for (const step of cmdSteps) {
        const valid = validateServerProxyClientMsg(step.message);
        assert.ok(valid, `Step ${step.step}: ${JSON.stringify(validateServerProxyClientMsg.errors)}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. Negative cases — invalid messages are rejected
  // -------------------------------------------------------------------------

  describe("negative cases", () => {
    it("rejects a snapshot missing required 'session' field", () => {
      const bad = {
        type: "snapshot",
        seq: 2,
        // missing: session
        windows: [],
        panes: [],
        focus: { paneId: null, windowId: null },
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "missing 'session' should fail validation");
    });

    it("rejects pane.opened with non-integer seq", () => {
      const bad = {
        type: "pane.opened",
        seq: "not-a-number",
        paneId: "p0",
        windowId: "w0",
        cols: 80,
        rows: 24,
        active: true,
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "non-integer seq should fail validation");
    });

    it("rejects pane.opened with missing paneId", () => {
      const bad = {
        type: "pane.opened",
        seq: 1,
        windowId: "w0",
        cols: 80,
        rows: 24,
        active: true,
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "missing paneId should fail validation");
    });

    it("rejects input message with non-string data", () => {
      const bad = {
        type: "input",
        seq: 1,
        paneId: "p0",
        data: 42,
      };
      const valid = validateClientMsg(bad);
      assert.strictEqual(valid, false, "non-string data should fail validation");
    });

    it("rejects command.response with missing correlationId", () => {
      const bad = {
        type: "command.response",
        seq: 3,
        // missing correlationId
        result: { ok: true },
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "missing correlationId should fail validation");
    });

    it("rejects error message with seq < 1", () => {
      const bad = {
        type: "error",
        seq: 0,
        code: "internal",
        message: "something went wrong",
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "seq=0 should fail validation (minimum is 1)");
    });

    it("rejects focus.changed with non-null/non-string paneId", () => {
      const bad = {
        type: "focus.changed",
        seq: 5,
        paneId: 42,
        windowId: "w0",
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "integer paneId should fail validation");
    });
  });

  // -------------------------------------------------------------------------
  // 5. TS-constructed messages — TS types agree with schemas
  // -------------------------------------------------------------------------

  describe("TS-constructed messages validate against schemas", () => {
    const P0 = paneId("p0");
    const P1 = paneId("p1");
    const W0 = windowId("w0");
    const S0 = sessionId("s0");

    const sampleLayout: WindowLayout = {
      cols: 80,
      rows: 24,
      root: {
        kind: "hsplit",
        rect: { x: 0, y: 0, cols: 80, rows: 24 },
        children: [
          { kind: "pane", paneId: P0, rect: { x: 0, y: 0, cols: 40, rows: 24 } },
          { kind: "pane", paneId: P1, rect: { x: 40, y: 0, cols: 40, rows: 24 } },
        ],
      },
    };

    it("SessionProxyCapabilitiesMessage", () => {
      const msg: SessionProxyCapabilitiesMessage = {
        type: "session-proxy.capabilities",
        seq: 1,
        capabilities: {
          protocolVersion: WIRE_PROTOCOL_VERSION,
          features: ["pane-lifecycle", "layout-updates", "focus-events", "input-forwarding"],
        },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("SnapshotMessage (full with windows and panes)", () => {
      const msg: SnapshotMessage = {
        type: "snapshot",
        seq: 2,
        session: { sessionId: S0, name: "main" },
        windows: [
          {
            windowId: W0,
            name: "editor",
            active: true,
            synchronizePanes: false,
            monitorActivity: true,
            monitorSilence: 0,
            layout: sampleLayout,
          },
        ],
        panes: [
          { paneId: P0, windowId: W0, cols: 40, rows: 24 },
          { paneId: P1, windowId: W0, cols: 40, rows: 24 },
        ],
        focus: { paneId: P0, windowId: W0 },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("SnapshotMessage (empty session — no windows)", () => {
      const msg: SnapshotMessage = {
        type: "snapshot",
        seq: 2,
        session: { sessionId: S0, name: "empty" },
        windows: [],
        panes: [],
        focus: { paneId: null, windowId: null },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneOpenedMessage", () => {
      const msg: PaneOpenedMessage = {
        type: "pane.opened",
        seq: 3,
        paneId: P0,
        windowId: W0,
        cols: 80,
        rows: 24,
        active: true,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneClosedMessage (with optional exitCode)", () => {
      const msg: PaneClosedMessage = {
        type: "pane.closed",
        seq: 4,
        paneId: P0,
        windowId: W0,
        exitCode: 0,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneClosedMessage (without exitCode)", () => {
      const msg: PaneClosedMessage = {
        type: "pane.closed",
        seq: 4,
        paneId: P0,
        windowId: W0,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneResizedMessage", () => {
      const msg: PaneResizedMessage = {
        type: "pane.resized",
        seq: 5,
        paneId: P0,
        cols: 120,
        rows: 40,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("LayoutUpdatedMessage", () => {
      const msg: LayoutUpdatedMessage = {
        type: "layout.updated",
        seq: 6,
        windowId: W0,
        layout: sampleLayout,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("FocusChangedMessage (with paneId)", () => {
      const msg: FocusChangedMessage = {
        type: "focus.changed",
        seq: 7,
        paneId: P1,
        windowId: W0,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("FocusChangedMessage (null focus)", () => {
      const msg: FocusChangedMessage = {
        type: "focus.changed",
        seq: 7,
        paneId: null,
        windowId: null,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("SessionProxyCommandResponseMessage (success with payload)", () => {
      const msg: SessionProxyCommandResponseMessage = {
        type: "command.response",
        seq: 8,
        correlationId: "req-001",
        result: { ok: true, payload: { windowId: W0, paneId: P0 } },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("SessionProxyCommandResponseMessage (success no payload)", () => {
      const msg: SessionProxyCommandResponseMessage = {
        type: "command.response",
        seq: 9,
        correlationId: "req-002",
        result: { ok: true },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("SessionProxyCommandResponseMessage (failure)", () => {
      const msg: SessionProxyCommandResponseMessage = {
        type: "command.response",
        seq: 10,
        correlationId: "req-003",
        result: { ok: false, code: "pane.not-found", message: "Pane p0 does not exist" },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("ErrorMessage (unsolicited)", () => {
      const msg: ErrorMessage = {
        type: "error",
        seq: 11,
        code: "protocol.malformed",
        message: "Required field paneId is missing",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("ErrorMessage (with correlationId)", () => {
      const msg: ErrorMessage = {
        type: "error",
        seq: 12,
        code: "session.unavailable",
        message: "Session destroyed mid-flight",
        correlationId: "req-007",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("InputMessage", () => {
      const msg: InputMessage = {
        type: "input",
        seq: 1,
        paneId: P0,
        data: "ls -la\r",
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("ResizeRequestMessage", () => {
      const msg: ResizeRequestMessage = {
        type: "resize.request",
        seq: 2,
        paneId: P0,
        cols: 132,
        rows: 50,
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("ClientCapabilitiesMessage", () => {
      const msg: ClientCapabilitiesMessage = {
        type: "client.capabilities",
        seq: 1,
        capabilities: {
          protocolVersion: WIRE_PROTOCOL_VERSION,
          features: ["pane-lifecycle", "input-forwarding"],
        },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("ResyncRequestMessage", () => {
      const msg: ResyncRequestMessage = {
        type: "resync.request",
        seq: 3,
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (open-window)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 4,
        correlationId: "req-010",
        command: { kind: "open-window", name: "logs" },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (split-pane)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 5,
        correlationId: "req-011",
        command: { kind: "split-pane", paneId: P0, direction: "horizontal" },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (close-pane)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 6,
        correlationId: "req-012",
        command: { kind: "close-pane", paneId: P0 },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (rename-window)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 7,
        correlationId: "req-013",
        command: { kind: "rename-window", windowId: W0, name: "editor" },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (set-synchronize-panes)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 8,
        correlationId: "req-014",
        command: { kind: "set-synchronize-panes", windowId: W0, on: true },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (kill-session)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 9,
        correlationId: "req-015",
        command: { kind: "kill-session", sessionName: "main" },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (set-monitor-silence with seconds=0)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 10,
        correlationId: "req-016",
        command: { kind: "set-monitor-silence", windowId: W0, seconds: 0 },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (set-monitor-silence with seconds=null)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 11,
        correlationId: "req-017",
        command: { kind: "set-monitor-silence", windowId: W0, seconds: null },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (resize-managed-window)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 12,
        correlationId: "req-018",
        command: {
          kind: "resize-managed-window",
          windowId: W0,
          cols: 80,
          rows: 24,
          panes: [
            { paneId: P0, cols: 40, rows: 24 },
            { paneId: P1, cols: 40, rows: 24 },
          ],
        },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });
  });
});
