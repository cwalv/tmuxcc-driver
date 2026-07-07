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
 * root (package.json at packages/protocol/../../../ level). It is NOT
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
  connectionId,
  CommandError,
  isCommandError,
} from "./index.js";

import type {
  SessionProxyMessage,
  ClientMessage,
  SnapshotMessage,
  PaneOpenedMessage,
  PaneClosedMessage,
  PaneResizedMessage,
  WindowAddedMessage,
  LayoutUpdatedMessage,
  FocusChangedMessage,
  SessionProxyCapabilitiesMessage,
  InputMessage,
  ResizeRequestMessage,
  ClientCapabilitiesMessage,
  SessionProxyCommandRequestMessage,
  SessionProxyCommandResponseMessage,
  ResyncRequestMessage,
  ClientFocusMessage,
  ErrorMessage,
  WindowLayout,
  PaneAttachMessage,
  PaneAttachFailedMessage,
  PaneHydrationBeginMessage,
  PaneHydrationEndMessage,
  PaneNotifyMessage,
  PaneTitleChangedMessage,
  PanePolicyChangedMessage,
  ClientIdentity,
  ClientFlags,
  // tc-gjdx.1: session template + apply/freeze verb surface
  SessionTemplate,
  WindowTemplate,
  TemplateApplyResult,
  ServerProxyCommandRequestMessage,
  ServerProxyCommandResponseMessage,
  ServerProxyMessage,
  // tc-usln: session.topology + server-proxy.set-metrics-http
  SessionTopologyCommand,
  ServerProxySetMetricsHttpCommand,
  SessionTopologyPayload,
  MetricsHttpStatePayload,
  // tc-u4ny.1: typed command-failure envelope
  CommandFailure,
} from "./index.js";

// ---------------------------------------------------------------------------
// Path setup
// ---------------------------------------------------------------------------

const __here = dirname(fileURLToPath(import.meta.url));
// packages/protocol/src → packages/protocol → packages → tmuxcc-driver
const driverRoot = resolve(__here, "../../../");
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
  "shared/session-template.json",
  "session-proxy/server-push.json",
  "session-proxy/client.json",
  "server-proxy/server-push.json",
  "server-proxy/client.json",
] as const;

type SchemaId =
  | "tmuxcc:shared/primitives"
  | "tmuxcc:shared/layout"
  | "tmuxcc:shared/session-template"
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

    it("rejects pane.opened whose origin is missing requestId — tc-ozk.2", () => {
      const bad = {
        type: "pane.opened",
        seq: 1,
        paneId: "p0",
        windowId: "w0",
        cols: 80,
        rows: 24,
        active: true,
        origin: { connectionId: "conn1" },
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "origin missing requestId should fail validation");
    });

    it("rejects pane.opened whose origin carries an extra property — tc-ozk.2", () => {
      const bad = {
        type: "pane.opened",
        seq: 1,
        paneId: "p0",
        windowId: "w0",
        cols: 80,
        rows: 24,
        active: true,
        origin: { connectionId: "conn1", requestId: "5", extra: true },
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "origin with extra property should fail validation");
    });

    it("rejects pane.opened with invalid detach value — tc-i9aq.1", () => {
      const bad = {
        type: "pane.opened",
        seq: 1,
        paneId: "p0",
        windowId: "w0",
        cols: 80,
        rows: 24,
        active: true,
        detach: "stay",
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "detach must be 'detach' | 'kill'");
    });

    it("rejects pane.closed whose cause is missing requestId — tc-u7cu.6", () => {
      const bad = {
        type: "pane.closed",
        seq: 4,
        paneId: "p0",
        windowId: "w0",
        cause: { connectionId: "conn1" },
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "cause missing requestId should fail validation");
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

    it("rejects pane.notify with an unknown kind — tc-76m8.1", () => {
      const bad = {
        type: "pane.notify",
        seq: 1,
        paneId: "p0",
        kind: "toast",
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "unknown kind should fail validation");
    });

    it("rejects pane.notify whose payload carries an extra property — tc-76m8.1", () => {
      const bad = {
        type: "pane.notify",
        seq: 1,
        paneId: "p0",
        kind: "osc9",
        payload: { message: "hi", urgency: "critical" },
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "payload with extra property should fail validation");
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
    const C0 = connectionId("conn1");

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

    it("PaneOpenedMessage (born dead with exitCode) — tc-4bv2 / tc-295a.10", () => {
      const msg: PaneOpenedMessage = {
        type: "pane.opened",
        seq: 3,
        paneId: P0,
        windowId: W0,
        cols: 80,
        rows: 24,
        active: true,
        dead: true,
        exitCode: 0,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneOpenedMessage (with verb origin) — tc-ozk.2", () => {
      const msg: PaneOpenedMessage = {
        type: "pane.opened",
        seq: 3,
        paneId: P0,
        windowId: W0,
        cols: 80,
        rows: 24,
        active: true,
        origin: { connectionId: C0, requestId: "7" },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("WindowAddedMessage (with verb origin) — tc-ozk.2", () => {
      const msg: WindowAddedMessage = {
        type: "window.added",
        seq: 3,
        windowId: W0,
        name: "shell",
        active: true,
        origin: { connectionId: C0, requestId: "12" },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("WindowAddedMessage (foreign — no origin) — tc-ozk.2", () => {
      const msg: WindowAddedMessage = {
        type: "window.added",
        seq: 3,
        windowId: W0,
        name: "shell",
        active: false,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("SnapshotMessage (with own connectionId) — tc-ozk.2", () => {
      const msg: SnapshotMessage = {
        type: "snapshot",
        seq: 2,
        session: { sessionId: S0, name: "main" },
        windows: [],
        panes: [],
        focus: { paneId: null, windowId: null },
        connectionId: C0,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneDeadChangedMessage (dead with exitCode) — tc-4bv2 / tc-295a.10", () => {
      const msg: SessionProxyMessage = {
        type: "pane.dead-changed",
        seq: 4,
        paneId: P0,
        dead: true,
        exitCode: 137,
      };
      assert.ok(validateSessionProxyMsg(msg), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneDeadChangedMessage (respawn, dead:false, no exitCode) — tc-4bv2 / tc-295a.10", () => {
      const msg: SessionProxyMessage = {
        type: "pane.dead-changed",
        seq: 4,
        paneId: P0,
        dead: false,
      };
      assert.ok(validateSessionProxyMsg(msg), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("SnapshotMessage (with a dead pane) — tc-4bv2 / tc-295a.10", () => {
      const msg: SnapshotMessage = {
        type: "snapshot",
        seq: 2,
        session: { sessionId: S0, name: "main" },
        windows: [
          {
            windowId: W0,
            name: "shell",
            active: true,
            synchronizePanes: false,
            monitorActivity: true,
            monitorSilence: 0,
            layout: sampleLayout,
          },
        ],
        panes: [
          { paneId: P0, windowId: W0, cols: 80, rows: 24, dead: true, exitCode: 0 },
          { paneId: P1, windowId: W0, cols: 80, rows: 24, dead: true },
        ],
        focus: { paneId: P0, windowId: W0 },
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

    it("PaneClosedMessage (with wire-verb cause) — tc-u7cu.6", () => {
      const msg: PaneClosedMessage = {
        type: "pane.closed",
        seq: 4,
        paneId: P0,
        windowId: W0,
        cause: { connectionId: C0, requestId: "42" },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneClosedMessage (foreign close — no cause) — tc-u7cu.6", () => {
      const msg: PaneClosedMessage = {
        type: "pane.closed",
        seq: 4,
        paneId: P0,
        windowId: W0,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneOpenedMessage (with bound/detach/icon — cold attach) — tc-i9aq.1", () => {
      const msg: PaneOpenedMessage = {
        type: "pane.opened",
        seq: 3,
        paneId: P0,
        windowId: W0,
        cols: 80,
        rows: 24,
        active: true,
        bound: true,
        detach: "detach",
        icon: "$(terminal)",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneOpenedMessage (bound:false, detach:kill) — tc-i9aq.1", () => {
      const msg: PaneOpenedMessage = {
        type: "pane.opened",
        seq: 3,
        paneId: P0,
        windowId: W0,
        cols: 80,
        rows: 24,
        active: false,
        bound: false,
        detach: "kill",
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

    it("ErrorMessage (session.unavailable with cause pane-exit) — tc-fah2", () => {
      const msg: ErrorMessage = {
        type: "error",
        seq: 13,
        code: "session.unavailable",
        message: "The tmux session has exited unexpectedly.",
        cause: "pane-exit",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("ErrorMessage (session.unavailable with cause external) — tc-fah2", () => {
      const msg: ErrorMessage = {
        type: "error",
        seq: 14,
        code: "session.unavailable",
        message: "The tmux session has exited unexpectedly.",
        cause: "external",
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

    // tc-4b6k.1 (D2): durable client identity on the handshake message.
    it("ClientCapabilitiesMessage (with durable identity) — tc-4b6k.1", () => {
      const msg: ClientCapabilitiesMessage = {
        type: "client.capabilities",
        seq: 1,
        capabilities: {
          protocolVersion: WIRE_PROTOCOL_VERSION,
          features: ["pane-lifecycle", "input-forwarding"],
        },
        identity: { id: "ws-3a7f92b1", label: "myproject" },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("ClientCapabilitiesMessage (identity id only, no label) — tc-4b6k.1", () => {
      const msg: ClientCapabilitiesMessage = {
        type: "client.capabilities",
        seq: 1,
        capabilities: { protocolVersion: WIRE_PROTOCOL_VERSION, features: [] },
        identity: { id: "tmuxcc" },
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

    // tc-76m8.3 (S3): client-focus activity signal for size-ownership policy.
    it("ClientFocusMessage", () => {
      const msg: ClientFocusMessage = {
        type: "client.focus",
        seq: 4,
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("PaneAttachFailedMessage (pane.not-found)", () => {
      const msg: PaneAttachFailedMessage = {
        type: "pane.attach.failed",
        seq: 13,
        paneId: P0,
        code: "pane.not-found",
        message: "Pane p0 is not present in the session model.",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneHydrationBeginMessage", () => {
      const msg: PaneHydrationBeginMessage = {
        type: "pane.hydration.begin",
        seq: 14,
        paneId: P0,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneHydrationEndMessage", () => {
      const msg: PaneHydrationEndMessage = {
        type: "pane.hydration.end",
        seq: 15,
        paneId: P0,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    // tc-76m8.1 (S9): pane attention/status notifications, all four kinds.
    it("PaneNotifyMessage (bell — no payload)", () => {
      const msg: PaneNotifyMessage = {
        type: "pane.notify",
        seq: 20,
        paneId: P0,
        kind: "bell",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneNotifyMessage (osc9 — OSC 9 body)", () => {
      const msg: PaneNotifyMessage = {
        type: "pane.notify",
        seq: 21,
        paneId: P0,
        kind: "osc9",
        payload: { message: "Build finished", source: "osc9" },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneNotifyMessage (osc9 — OSC 777 title+body)", () => {
      const msg: PaneNotifyMessage = {
        type: "pane.notify",
        seq: 22,
        paneId: P0,
        kind: "osc9",
        payload: { title: "agent", message: "needs your input", source: "osc777" },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneNotifyMessage (progress — ConEmu OSC 9;4)", () => {
      const msg: PaneNotifyMessage = {
        type: "pane.notify",
        seq: 23,
        paneId: P0,
        kind: "progress",
        payload: { progressState: "set", progress: 42 },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneNotifyMessage (cmd-exit — OSC 633;D)", () => {
      const msg: PaneNotifyMessage = {
        type: "pane.notify",
        seq: 24,
        paneId: P0,
        kind: "cmd-exit",
        payload: { exitCode: 1 },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneAttachMessage (client→session-proxy)", () => {
      const msg: PaneAttachMessage = {
        type: "pane.attach",
        seq: 13,
        paneId: P0,
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

    // tc-295a.11: pane.capture
    it("SessionProxyCommandRequestMessage (pane.capture) — tc-295a.11", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 13,
        correlationId: "req-019",
        command: { kind: "pane.capture", paneId: P0 },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    // tc-6gnc.9: rename-session
    it("SessionProxyCommandRequestMessage (rename-session) — tc-6gnc.9", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 16,
        correlationId: "req-020",
        command: { kind: "rename-session", name: "new-session-name" },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandRequestMessage (rename-session with spaces) — tc-6gnc.9", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 17,
        correlationId: "req-021",
        command: { kind: "rename-session", name: "my project session" },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("SessionProxyCommandResponseMessage (pane.capture success with text) — tc-295a.11", () => {
      const msg: SessionProxyCommandResponseMessage = {
        type: "command.response",
        seq: 14,
        correlationId: "req-019",
        result: { ok: true, payload: { text: "$ ls -la\ntotal 8\ndrwxr-xr-x 2 user user 4096 Jan  1 00:00 .\n" } },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("SessionProxyCommandResponseMessage (pane.capture failure pane.not-found) — tc-295a.11", () => {
      const msg: SessionProxyCommandResponseMessage = {
        type: "command.response",
        seq: 15,
        correlationId: "req-019",
        result: { ok: false, code: "pane.not-found", message: "Pane p0 is not present in the session model." },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    // tc-2mn8 / tc-s6ov.4: live pane title delta — was missing from schema.
    it("PaneTitleChangedMessage (non-empty title) — tc-2mn8", () => {
      const msg: PaneTitleChangedMessage = {
        type: "pane.title-changed",
        seq: 30,
        paneId: P0,
        title: "npm run build",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PaneTitleChangedMessage (empty title — shell cleared) — tc-2mn8", () => {
      const msg: PaneTitleChangedMessage = {
        type: "pane.title-changed",
        seq: 31,
        paneId: P0,
        title: "",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    // tc-i9aq.1: durable pane-policy delta — was missing from schema.
    it("PanePolicyChangedMessage (bound only) — tc-i9aq.1", () => {
      const msg: PanePolicyChangedMessage = {
        type: "pane.policy-changed",
        seq: 32,
        paneId: P0,
        bound: true,
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PanePolicyChangedMessage (bound + detach + icon) — tc-i9aq.1", () => {
      const msg: PanePolicyChangedMessage = {
        type: "pane.policy-changed",
        seq: 33,
        paneId: P0,
        bound: true,
        detach: "detach",
        icon: "$(terminal)",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    it("PanePolicyChangedMessage (bound:false, detach:kill) — tc-i9aq.1", () => {
      const msg: PanePolicyChangedMessage = {
        type: "pane.policy-changed",
        seq: 34,
        paneId: P0,
        bound: false,
        detach: "kill",
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });

    // SnapshotPane with durable policy + live title fields — were missing from schema.
    it("SnapshotMessage (pane with bound/detach/icon/paneTitle) — tc-i9aq.1 / tc-2mn8", () => {
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
          {
            paneId: P0,
            windowId: W0,
            cols: 40,
            rows: 24,
            bound: true,
            detach: "detach",
            icon: "$(terminal)",
            paneTitle: "vim",
          },
          {
            paneId: P1,
            windowId: W0,
            cols: 40,
            rows: 24,
            bound: false,
            detach: "kill",
          },
        ],
        focus: { paneId: P0, windowId: W0 },
      };
      assert.ok(validateSessionProxyMsg(msg as SessionProxyMessage), JSON.stringify(validateSessionProxyMsg.errors));
    });
  });

  // -------------------------------------------------------------------------
  // 6. Client identity + client flags $defs — tc-4b6k.1 (D2 / D8)
  // -------------------------------------------------------------------------

  describe("client identity + flags $defs (tc-4b6k.1)", () => {
    let validateIdentity: ValidateFunction;
    let validateFlags: ValidateFunction;

    before(() => {
      validateIdentity = ajv.compile({
        $ref: "tmuxcc:shared/primitives#/$defs/ClientIdentity",
      });
      validateFlags = ajv.compile({
        $ref: "tmuxcc:shared/primitives#/$defs/ClientFlags",
      });
    });

    it("accepts ClientIdentity with id + label", () => {
      const id: ClientIdentity = { id: "ws-3a7f92b1", label: "myproject" };
      assert.ok(validateIdentity(id), JSON.stringify(validateIdentity.errors));
    });

    it("accepts ClientIdentity with id only", () => {
      const id: ClientIdentity = { id: "tmuxcc" };
      assert.ok(validateIdentity(id), JSON.stringify(validateIdentity.errors));
    });

    it("rejects ClientIdentity missing id", () => {
      assert.strictEqual(validateIdentity({ label: "no-id" }), false);
    });

    it("rejects ClientIdentity with an extra property", () => {
      assert.strictEqual(
        validateIdentity({ id: "x", workspaceUri: "file:///leak" }),
        false,
        "additionalProperties:false must reject host vocabulary on the wire",
      );
    });

    it("rejects ClientIdentity with non-string id", () => {
      assert.strictEqual(validateIdentity({ id: 42 }), false);
    });

    // ClientFlags: D4 (tc-4b6k.3) wired the behavior; these tests validate the
    // $def shape. The wider parity-map (activePane, pauseAfter, …) stays reserved.
    it("accepts ClientFlags {} (all flags absent)", () => {
      const flags: ClientFlags = {};
      assert.ok(validateFlags(flags), JSON.stringify(validateFlags.errors));
    });

    it("accepts ClientFlags with ignoreSize + readOnly", () => {
      const flags: ClientFlags = { ignoreSize: true, readOnly: false };
      assert.ok(validateFlags(flags), JSON.stringify(validateFlags.errors));
    });

    // tc-76m8.28: pullHydration — client-declared pull-hydration (the
    // session-proxy skips the unsolicited addClient bulk replay for it).
    it("accepts ClientFlags with pullHydration", () => {
      const flags: ClientFlags = { pullHydration: true };
      assert.ok(validateFlags(flags), JSON.stringify(validateFlags.errors));
    });

    it("rejects ClientFlags with a non-boolean flag", () => {
      assert.strictEqual(validateFlags({ ignoreSize: "yes" }), false);
    });

    it("rejects ClientFlags with an unknown flag", () => {
      assert.strictEqual(
        validateFlags({ activePane: true }),
        false,
        "unknown parity-map flags stay reserved prose (§12), not typed slots yet",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 7. Session template schema — tc-gjdx.1
  // -------------------------------------------------------------------------

  describe("session template schema (tc-gjdx.1)", () => {
    let validateTemplate: ValidateFunction;

    before(() => {
      validateTemplate = ajv.compile({
        $ref: "tmuxcc:shared/session-template#/$defs/SessionTemplate",
      });
    });

    // A strip-shaped template — the extension's MANAGED subset: a single split
    // of pane leaves. Validates via the same full-fidelity schema (one schema,
    // not a driver + extension subset).
    const stripTemplate: SessionTemplate = {
      name: "web-dev",
      windows: [
        { name: "editor", geometry: { kind: "pane", command: "nvim ." } },
        {
          name: "servers",
          geometry: {
            kind: "hsplit",
            children: [
              { kind: "pane", command: "npm run dev", cwd: "/repo/web" },
              { kind: "pane", command: "npm run api", cwd: "/repo/api", env: { PORT: "4000" } },
            ],
          },
        },
      ],
    };

    // A wild nested tree — beyond the managed subset. Still valid; the extension
    // renders it UNMANAGED (apply-don't-reject), the driver applies full fidelity.
    const wildTemplate: SessionTemplate = {
      windows: [
        {
          name: "wild",
          geometry: {
            kind: "vsplit",
            sizes: [3, 1],
            children: [
              {
                kind: "hsplit",
                children: [
                  { kind: "pane" },
                  {
                    kind: "vsplit",
                    children: [
                      { kind: "pane", command: "htop" },
                      { kind: "pane" },
                    ],
                  },
                ],
              },
              { kind: "pane", command: "tail -f log" },
            ],
          },
        },
      ],
    };

    it("accepts a strip-shaped template (managed subset)", () => {
      assert.ok(validateTemplate(stripTemplate), JSON.stringify(validateTemplate.errors));
    });

    it("accepts a wild nested tree (unmanaged — apply-don't-reject)", () => {
      assert.ok(validateTemplate(wildTemplate), JSON.stringify(validateTemplate.errors));
    });

    it("accepts a window with omitted geometry (compiler default: single default pane)", () => {
      const t: SessionTemplate = { windows: [{ name: "shell" }] };
      assert.ok(validateTemplate(t), JSON.stringify(validateTemplate.errors));
    });

    it("accepts a single-pane window (geometry is a lone pane leaf)", () => {
      const t: SessionTemplate = { windows: [{ geometry: { kind: "pane" } }] };
      assert.ok(validateTemplate(t), JSON.stringify(validateTemplate.errors));
    });

    it("accepts an unnamed inline template (no top-level name)", () => {
      const t: SessionTemplate = { windows: [{ name: "w", geometry: { kind: "pane" } }] };
      assert.ok(validateTemplate(t), JSON.stringify(validateTemplate.errors));
    });

    it("accepts a leaf pane with cwd + command + env", () => {
      const t: SessionTemplate = {
        windows: [{ geometry: { kind: "pane", cwd: "/x", command: "sh", env: { A: "1", B: "" } } }],
      };
      assert.ok(validateTemplate(t), JSON.stringify(validateTemplate.errors));
    });

    it("rejects a template with no windows key", () => {
      assert.strictEqual(validateTemplate({ name: "x" }), false, "windows is required");
    });

    it("rejects a template with an empty windows array", () => {
      assert.strictEqual(validateTemplate({ windows: [] }), false, "minItems 1 — a template describes a non-empty session");
    });

    it("rejects a split with a single child", () => {
      const bad = { windows: [{ geometry: { kind: "hsplit", children: [{ kind: "pane" }] } }] };
      assert.strictEqual(validateTemplate(bad), false, "a split needs at least two children");
    });

    it("rejects an unknown node kind", () => {
      const bad = { windows: [{ geometry: { kind: "tab", children: [] } }] };
      assert.strictEqual(validateTemplate(bad), false, "kind must be pane | hsplit | vsplit");
    });

    it("rejects a leaf pane carrying a paneId (no ids in the DESIRED tree)", () => {
      const bad = { windows: [{ geometry: { kind: "pane", paneId: "p0" } }] };
      assert.strictEqual(validateTemplate(bad), false, "desired-geometry leaves carry no paneId (additionalProperties:false)");
    });

    it("rejects a leaf pane carrying a rect (no ABSOLUTE geometry)", () => {
      const bad = { windows: [{ geometry: { kind: "pane", rect: { x: 0, y: 0, cols: 80, rows: 24 } } }] };
      assert.strictEqual(validateTemplate(bad), false, "desired geometry is proportional — no absolute Rect");
    });

    it("rejects a window carrying a raw tmux layout string (layout strings never on the wire)", () => {
      const bad = { windows: [{ name: "w", layout: "5x24,0,0[5x12,0,0,0,5x12,0,12,1]" }] };
      assert.strictEqual(validateTemplate(bad), false, "layout strings are a driver-internal compile artifact — additionalProperties:false rejects a `layout` field");
    });

    it("rejects a non-string env value", () => {
      const bad = { windows: [{ geometry: { kind: "pane", env: { PORT: 4000 } } }] };
      assert.strictEqual(validateTemplate(bad), false, "env values are strings (fully substituted)");
    });

    it("rejects an extra property on a leaf pane", () => {
      const bad = { windows: [{ geometry: { kind: "pane", shellCommand: "sh" } }] };
      assert.strictEqual(validateTemplate(bad), false, "leaf uses `command`, not the verb's `shellCommand` — additionalProperties:false");
    });

    it("rejects a proportional weight of zero", () => {
      const bad = { windows: [{ geometry: { kind: "hsplit", sizes: [1, 0], children: [{ kind: "pane" }, { kind: "pane" }] } }] };
      assert.strictEqual(validateTemplate(bad), false, "weights are positive (exclusiveMinimum 0)");
    });
  });

  // -------------------------------------------------------------------------
  // 8. Session template verb surface — tc-gjdx.1 (server-proxy wire, additive)
  // -------------------------------------------------------------------------

  describe("session template verb surface (tc-gjdx.1)", () => {
    const template: SessionTemplate = {
      name: "web-dev",
      windows: [
        { name: "editor", geometry: { kind: "pane", command: "nvim ." } },
        {
          name: "servers",
          geometry: {
            kind: "hsplit",
            sizes: [2, 1],
            children: [
              { kind: "pane", command: "npm run dev" },
              { kind: "pane", command: "npm run api", env: { PORT: "4000" } },
            ],
          },
        },
      ],
    };

    // --- creating verbs carry an optional template (applied iff created:true) ---

    it("accepts session.claim carrying a template", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 2,
        correlationId: "claim-t1",
        command: { kind: "session.claim", name: "main", template },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("accepts session.create carrying a template", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 2,
        correlationId: "create-t1",
        command: { kind: "session.create", name: "main", template },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("accepts session.createUnique carrying a template", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 2,
        correlationId: "unique-t1",
        command: { kind: "session.createUnique", baseName: "tmuxcc", workspaceUri: "file:///repo", template },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    // Additive guarantee: a template-less claim (the pre-tc-gjdx shape) still validates.
    it("accepts session.claim WITHOUT a template (template is additive-optional)", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 2,
        correlationId: "claim-plain",
        command: { kind: "session.claim", name: "main" },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    // --- apply-to-live verb (with preview/dry-run) ---

    it("accepts a session.applyTemplate command (real apply)", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 3,
        correlationId: "apply-1",
        command: { kind: "session.applyTemplate", sessionId: sessionId("s0"), template },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("accepts a session.applyTemplate command (dryRun preview)", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 3,
        correlationId: "apply-preview",
        command: { kind: "session.applyTemplate", sessionId: sessionId("s0"), template, dryRun: true },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("rejects a session.applyTemplate missing the template", () => {
      const bad = {
        type: "command.request",
        seq: 3,
        correlationId: "apply-bad",
        command: { kind: "session.applyTemplate", sessionId: "s0" },
      };
      assert.strictEqual(validateServerProxyClientMsg(bad), false, "template is required on applyTemplate");
    });

    it("rejects a session.applyTemplate missing the sessionId", () => {
      const bad = {
        type: "command.request",
        seq: 3,
        correlationId: "apply-bad2",
        command: { kind: "session.applyTemplate", template },
      };
      assert.strictEqual(validateServerProxyClientMsg(bad), false, "sessionId is required on applyTemplate");
    });

    // --- freeze verb ---

    it("accepts a session.freezeTemplate command", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 4,
        correlationId: "freeze-1",
        command: { kind: "session.freezeTemplate", sessionId: sessionId("s0") },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("accepts a session.freezeTemplate command with a name", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 4,
        correlationId: "freeze-named",
        command: { kind: "session.freezeTemplate", sessionId: sessionId("s0"), name: "snapshot" },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    // --- result payloads (server-proxy → client) ---

    it("accepts a command.response carrying an applyTemplate preview (would-create set)", () => {
      const result: TemplateApplyResult = {
        dryRun: true,
        windows: [{ name: "servers", geometry: { kind: "pane", command: "npm run api" } }],
      };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 5,
        correlationId: "apply-preview",
        result: { ok: true, payload: { applyTemplate: result } },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });

    it("accepts a command.response carrying an applyTemplate did-create set (empty = no-op re-apply)", () => {
      const result: TemplateApplyResult = { dryRun: false, windows: [] };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 6,
        correlationId: "apply-noop",
        result: { ok: true, payload: { applyTemplate: result } },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });

    it("accepts a command.response carrying a frozenTemplate", () => {
      const frozen: SessionTemplate = {
        name: "snapshot",
        windows: [
          { name: "main", geometry: { kind: "hsplit", children: [{ kind: "pane", cwd: "/a" }, { kind: "pane", cwd: "/b" }] } },
        ],
      };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 7,
        correlationId: "freeze-1",
        result: { ok: true, payload: { frozenTemplate: frozen } },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });

    it("accepts a command.response reporting template.invalid (fail-loud, no rollback)", () => {
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 8,
        correlationId: "apply-fail",
        result: { ok: false, code: "template.invalid", message: "split-pane failed on window 'servers'; created windows: editor" },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });
  });

  // -------------------------------------------------------------------------
  // 9. env on creating verbs — tc-gjdx.2 (session-proxy + server-proxy, additive)
  // -------------------------------------------------------------------------

  describe("env on creating verbs (tc-gjdx.2)", () => {
    // --- session-proxy: open-window and split-pane ---

    it("accepts open-window carrying env (session-proxy)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 20,
        correlationId: "ow-env-1",
        command: { kind: "open-window", env: { MY_VAR: "hello", PORT: "8080" } },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("accepts split-pane carrying env (session-proxy)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 21,
        correlationId: "sp-env-1",
        command: { kind: "split-pane", direction: "horizontal", env: { TOKEN: "abc", EMPTY: "" } },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    // Additive guarantee: open-window and split-pane WITHOUT env still validates.
    it("accepts open-window WITHOUT env (env is additive-optional)", () => {
      const msg: SessionProxyCommandRequestMessage = {
        type: "command.request",
        seq: 22,
        correlationId: "ow-plain",
        command: { kind: "open-window" },
      };
      assert.ok(validateClientMsg(msg as ClientMessage), JSON.stringify(validateClientMsg.errors));
    });

    it("rejects open-window with a non-string env value", () => {
      const bad = {
        type: "command.request",
        seq: 23,
        correlationId: "ow-bad-env",
        command: { kind: "open-window", env: { PORT: 8080 } },
      };
      assert.strictEqual(validateClientMsg(bad as unknown as ClientMessage), false,
        "env values must be strings — additionalProperties:{type:string}");
    });

    it("rejects split-pane with a non-string env value", () => {
      const bad = {
        type: "command.request",
        seq: 24,
        correlationId: "sp-bad-env",
        command: { kind: "split-pane", direction: "horizontal", env: { COUNT: 3 } },
      };
      assert.strictEqual(validateClientMsg(bad as unknown as ClientMessage), false,
        "env values must be strings — additionalProperties:{type:string}");
    });

    // --- server-proxy: session.create and session.createUnique ---

    it("accepts session.create carrying env (server-proxy)", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 25,
        correlationId: "create-env-1",
        command: { kind: "session.create", name: "main", env: { API_KEY: "secret", PORT: "3000" } },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("accepts session.createUnique carrying env (server-proxy)", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 26,
        correlationId: "unique-env-1",
        command: { kind: "session.createUnique", baseName: "dev", env: { WORKSPACE: "/home/user/proj" } },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    // Additive guarantee: session.create and session.createUnique WITHOUT env still validate.
    it("accepts session.create WITHOUT env (env is additive-optional)", () => {
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 27,
        correlationId: "create-plain",
        command: { kind: "session.create", name: "plain" },
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("rejects session.create with a non-string env value", () => {
      const bad = {
        type: "command.request",
        seq: 28,
        correlationId: "create-bad-env",
        command: { kind: "session.create", name: "x", env: { COUNT: 99 } },
      };
      assert.strictEqual(validateServerProxyClientMsg(bad), false,
        "env values must be strings — additionalProperties:{type:string}");
    });

    it("rejects session.createUnique with a non-string env value", () => {
      const bad = {
        type: "command.request",
        seq: 29,
        correlationId: "unique-bad-env",
        command: { kind: "session.createUnique", baseName: "dev", env: { NUM: true } },
      };
      assert.strictEqual(validateServerProxyClientMsg(bad), false,
        "env values must be strings — additionalProperties:{type:string}");
    });
  });

  // -------------------------------------------------------------------------
  // 10. session.topology + server-proxy.set-metrics-http verbs — tc-usln
  // -------------------------------------------------------------------------

  describe("session.topology + server-proxy.set-metrics-http verbs (tc-usln)", () => {
    // --- session.topology request ---

    it("accepts a session.topology command request", () => {
      const cmd: SessionTopologyCommand = { kind: "session.topology", sessionId: sessionId("s0") };
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 30,
        correlationId: "topo-1",
        command: cmd,
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("rejects session.topology missing sessionId", () => {
      const bad = {
        type: "command.request",
        seq: 31,
        correlationId: "topo-bad",
        command: { kind: "session.topology" },
      };
      assert.strictEqual(validateServerProxyClientMsg(bad), false, "sessionId is required on session.topology");
    });

    // --- session.topology ok-response payload ---

    it("accepts a command.response carrying a topology payload (windows + panes)", () => {
      const topology: SessionTopologyPayload = {
        windows: [
          { windowId: "@1", name: "editor", active: true },
          { windowId: "@2", name: "shell", active: false },
        ],
        panes: [
          { paneId: "%1", windowId: "@1", bound: true, detach: "detach", icon: "$(terminal)" },
          { paneId: "%2", windowId: "@1", bound: false, detach: "kill", icon: undefined },
          { paneId: "%3", windowId: "@2", bound: false, detach: undefined, icon: undefined },
        ],
      };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 32,
        correlationId: "topo-1",
        result: { ok: true, payload: { topology } },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });

    it("accepts a command.response carrying an empty topology payload (no windows)", () => {
      const topology: SessionTopologyPayload = { windows: [], panes: [] };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 33,
        correlationId: "topo-empty",
        result: { ok: true, payload: { topology } },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });

    // --- server-proxy.set-metrics-http request ---

    it("accepts a server-proxy.set-metrics-http command (enable with bind omitted)", () => {
      const cmd: ServerProxySetMetricsHttpCommand = { kind: "server-proxy.set-metrics-http", enabled: true };
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 34,
        correlationId: "metrics-1",
        command: cmd,
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("accepts a server-proxy.set-metrics-http command (enable with explicit bind)", () => {
      const cmd: ServerProxySetMetricsHttpCommand = {
        kind: "server-proxy.set-metrics-http",
        enabled: true,
        bind: "127.0.0.1:9090",
      };
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 35,
        correlationId: "metrics-2",
        command: cmd,
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("accepts a server-proxy.set-metrics-http command (disable — bind ignored)", () => {
      const cmd: ServerProxySetMetricsHttpCommand = { kind: "server-proxy.set-metrics-http", enabled: false };
      const msg: ServerProxyCommandRequestMessage = {
        type: "command.request",
        seq: 36,
        correlationId: "metrics-off",
        command: cmd,
      };
      assert.ok(validateServerProxyClientMsg(msg), JSON.stringify(validateServerProxyClientMsg.errors));
    });

    it("rejects server-proxy.set-metrics-http missing enabled", () => {
      const bad = {
        type: "command.request",
        seq: 37,
        correlationId: "metrics-bad",
        command: { kind: "server-proxy.set-metrics-http" },
      };
      assert.strictEqual(validateServerProxyClientMsg(bad), false, "enabled is required on set-metrics-http");
    });

    // --- server-proxy.set-metrics-http ok-response payload ---

    it("accepts a command.response carrying a metricsHttp payload (listener bound)", () => {
      const metricsHttp: MetricsHttpStatePayload = { enabled: true, address: "/run/tmuxcc/default/metrics-http.sock" };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 38,
        correlationId: "metrics-1",
        result: { ok: true, payload: { metricsHttp } },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });

    it("accepts a command.response carrying a metricsHttp payload (listener unbound, address null)", () => {
      const metricsHttp: MetricsHttpStatePayload = { enabled: false, address: null };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 39,
        correlationId: "metrics-off",
        result: { ok: true, payload: { metricsHttp } },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });

    it("accepts a command.response carrying a metricsHttp payload (TCP bind address)", () => {
      const metricsHttp: MetricsHttpStatePayload = { enabled: true, address: "127.0.0.1:9090" };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 40,
        correlationId: "metrics-2",
        result: { ok: true, payload: { metricsHttp } },
      };
      assert.ok(validateServerProxyMsg(msg as ServerProxyMessage), JSON.stringify(validateServerProxyMsg.errors));
    });
  });

  // -------------------------------------------------------------------------
  // 11. CommandFailure with details — tc-u4ny.1
  //
  // IMPORTANT: this details-carrying sample is the ONLY automated guard that a
  // details-bearing failure message actually round-trips correctly through both
  // schemas. The socket codec is bare JSON.parse (no runtime schema validation),
  // and protocol-conformance.test.ts validates only goldens + representative TS
  // messages — never live emissions. Therefore these tests are load-bearing:
  // if the schemas or types regress, only these tests catch it.
  // -------------------------------------------------------------------------

  describe("CommandFailure with details (tc-u4ny.1)", () => {
    // Server-proxy wire: failure with details (tmux.capability-required)
    it("server-proxy command.response failure with details validates against ServerProxyMessage schema", () => {
      const failure: CommandFailure = {
        ok: false,
        code: "tmux.capability-required",
        message: "Upgrade tmux to >= 3.2 or omit env from session.create.",
        details: { capability: "newSessionEnvFlag" },
      };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 41,
        correlationId: "cap-req-1",
        result: failure,
      };
      assert.ok(
        validateServerProxyMsg(msg as ServerProxyMessage),
        JSON.stringify(validateServerProxyMsg.errors),
      );
    });

    // Server-proxy wire: plain failure (no details) still validates
    it("server-proxy command.response plain failure (no details) still validates", () => {
      const failure: CommandFailure = {
        ok: false,
        code: "session.name-taken",
        message: "A session named 'main' already exists.",
      };
      const msg: ServerProxyCommandResponseMessage = {
        type: "command.response",
        seq: 42,
        correlationId: "name-taken-1",
        result: failure,
      };
      assert.ok(
        validateServerProxyMsg(msg as ServerProxyMessage),
        JSON.stringify(validateServerProxyMsg.errors),
      );
    });

    // Session-proxy wire: failure with details validates against SessionProxyMessage schema
    it("session-proxy command.response failure with details validates against SessionProxyMessage schema", () => {
      const failure: CommandFailure = {
        ok: false,
        code: "tmux.capability-required",
        message: "Upgrade tmux to >= 3.2 or omit env from split-pane.",
        details: { capability: "newSessionEnvFlag" },
      };
      const msg: SessionProxyCommandResponseMessage = {
        type: "command.response",
        seq: 20,
        correlationId: "cap-req-sp-1",
        result: failure,
      };
      assert.ok(
        validateSessionProxyMsg(msg as SessionProxyMessage),
        JSON.stringify(validateSessionProxyMsg.errors),
      );
    });

    // Session-proxy wire: rejects failure with details that carries a non-object details value
    it("session-proxy command.response rejects failure with non-object details", () => {
      const bad = {
        type: "command.response",
        seq: 21,
        correlationId: "bad-details-1",
        result: { ok: false, code: "verb.failed", message: "tmux error", details: "a-string" },
      };
      const valid = validateSessionProxyMsg(bad);
      assert.strictEqual(valid, false, "details must be an object when present");
    });

    // isCommandError structural check survives a simulated dual-package-copy
    it("isCommandError discriminates structurally — survives dual-package-copy simulation", () => {
      // A genuine CommandError from this copy
      const err = new CommandError("tmux.capability-required", "too old", { capability: "newSessionEnvFlag" });
      assert.ok(isCommandError(err), "genuine CommandError must be recognised");
      assert.ok(isCommandError(err, "tmux.capability-required"), "code-specific check must pass");
      assert.strictEqual(isCommandError(err, "internal"), false, "wrong code must return false");

      // Simulate the dual-package-copy hazard: a plain object with the right shape.
      // instanceof returns false for this (it came from a different bundle copy),
      // but isCommandError checks name + code structurally and must return true.
      const foreign = Object.assign(new Error("too old"), {
        name: "CommandError",
        code: "tmux.capability-required",
        details: { capability: "newSessionEnvFlag" },
      });
      assert.ok(isCommandError(foreign), "structural check must pass for a foreign-copy CommandError");
      assert.ok(isCommandError(foreign, "tmux.capability-required"), "code-specific structural check must pass");

      // A plain Error must not match
      const plainErr = new Error("oops");
      assert.strictEqual(isCommandError(plainErr), false, "plain Error must not match");

      // A non-object must not match
      assert.strictEqual(isCommandError("string-error"), false, "string must not match");
      assert.strictEqual(isCommandError(null), false, "null must not match");
    });
  });
});
