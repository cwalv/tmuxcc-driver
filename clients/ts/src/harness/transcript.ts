/**
 * transcript.ts — the conformance transcript format (tc-ozk.4 / W3.2).
 *
 * A transcript is a language-neutral, replayable script of one session-proxy
 * wire conversation: handshake → snapshot → deltas → verbs (with effect ids and
 * origin attribution) → pane.capture. Transcripts live next to the protocol
 * schemas (`protocol/transcripts/`) so they are the shared contract artifact:
 *
 *   - The TS SDK's parser/mirror is replayed against them (the client conforms).
 *   - The REAL session-proxy daemon is replayed against them (the daemon conforms).
 *   - Any FUTURE SDK (lua, python) runs against the same transcripts via the stub
 *     daemon; any future daemon implementation is checked against the SDKs.
 *
 * This is the SUPERSET of the golden-transcript format already used by
 * `protocol/golden/*.json` (`{protocolVersion, transcript:[{direction,step,
 * label,syncPoint?,message}]}`). It adds:
 *
 *   - `initialModel`: the canonical SessionModel the daemon snapshots from. The
 *     daemon-side conformance runner seeds a fake pipeline with this so the REAL
 *     `createControlServer` produces the snapshot at step 1; the SDK-side runner
 *     uses it to assert the client's mirror catches up to the right baseline.
 *   - `verbs`: per-`command.request` correlationId, the model mutation the
 *     daemon performs (so the daemon-side runner can drive the fake pipeline and
 *     observe the REAL daemon emit the transcript's deltas + origin).
 *
 * # Fail-loud (epic policy: PRE-ALPHA FAIL-LOUD, NO DEFENSE-IN-DEPTH)
 *
 * `loadTranscript` throws `TranscriptError` on any structural problem (missing
 * field, wrong protocolVersion, unknown step direction). A malformed transcript
 * is a hard failure, never a silently-skipped step.
 *
 * @module harness/transcript
 */

import { readFileSync } from "node:fs";

import type { SessionProxyMessage, ClientMessage, SessionProxyCommandResponseMessage, PaneId, WindowId, SessionId, ConnectionId, WindowLayout } from "@tmuxcc/protocol";
import { WIRE_PROTOCOL_VERSION } from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a transcript is structurally invalid, or when a conformance
 * replay observes a mismatch between a transcript's expectation and what the
 * SDK / daemon actually produced. Named so callers can assert on `.name`.
 */
export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptError";
  }
}

// ---------------------------------------------------------------------------
// Step shapes
// ---------------------------------------------------------------------------

/** A session-proxy→client push: a server message the daemon emits. */
export interface ServerStep {
  readonly direction: "session-proxy→client";
  readonly step: number;
  readonly label: string;
  /** Free-text sync-point annotation (mirrors golden transcripts). */
  readonly syncPoint?: string;
  readonly message: SessionProxyMessage;
}

/** A client→session-proxy message: input / resize / command.request / resync. */
export interface ClientStep {
  readonly direction: "client→session-proxy";
  readonly step: number;
  readonly label: string;
  readonly message: ClientMessage;
}

export type TranscriptStep = ServerStep | ClientStep;

// ---------------------------------------------------------------------------
// Verb scripting (daemon-side replay)
// ---------------------------------------------------------------------------

/**
 * The model mutation the daemon performs in response to a creating verb
 * (split-pane / open-window / break-pane — tc-ozk.1). The daemon-side
 * conformance runner applies this to its fake pipeline AND records the
 * verb-origin so the REAL session-proxy emits the origin-tagged creation deltas
 * the transcript expects (tc-ozk.2).
 */
export interface VerbCreates {
  /** The new pane id tmux creates (effect id — tc-ozk.1). */
  readonly newPaneId?: PaneId;
  /** The new window id tmux creates (effect id — tc-ozk.1). */
  readonly newWindowId?: WindowId;
  /** Cols of the created pane (defaults to the snapshot window's cols). */
  readonly cols?: number;
  /** Rows of the created pane (defaults to the snapshot window's rows). */
  readonly rows?: number;
  /** Window name for an open-window verb. */
  readonly windowName?: string;
  /** Whether focus moves to the new pane (emits focus.changed). */
  readonly focus?: boolean;
}

/**
 * Per-verb scripting keyed by the `command.request` correlationId in the
 * transcript. Tells the daemon-side runner what effect ids the verb returns and
 * (for capture) what text to reply with — so the runner can drive the REAL
 * session-proxy's command-response + creation-delta path deterministically.
 */
export interface VerbScript {
  /**
   * The `command.response` the daemon returns for this correlationId. The
   * runner feeds the verb's effect ids / capture payload through here. Carries
   * `result.ok` and (on success) the payload that AC requires
   * (paneId/windowId for creates; {text} for pane.capture).
   */
  readonly response: SessionProxyCommandResponseMessage["result"];
  /**
   * For a creating verb (tc-ozk.1), the model mutation + origin record the
   * daemon performs. Omitted for non-creating verbs (e.g. pane.capture, which
   * only returns a response).
   */
  readonly creates?: VerbCreates;
}

// ---------------------------------------------------------------------------
// Canonical initial model (daemon snapshot seed)
// ---------------------------------------------------------------------------

/**
 * A wire-shaped pane in the transcript's initial model. Matches `SnapshotPane`.
 */
export interface TranscriptPane {
  readonly paneId: PaneId;
  readonly windowId: WindowId;
  readonly cols: number;
  readonly rows: number;
}

/**
 * A wire-shaped window in the transcript's initial model. The layout is carried
 * verbatim from the transcript (it is the same `WindowLayout` shape the wire
 * uses).
 */
export interface TranscriptWindow {
  readonly windowId: WindowId;
  readonly name: string;
  readonly active: boolean;
  readonly paneIds: readonly PaneId[];
  readonly activePaneId: PaneId | null;
  /** Structured layout, carried verbatim (same shape as the wire). */
  readonly layout: WindowLayout;
  readonly synchronizePanes?: boolean;
  readonly monitorActivity?: boolean;
  readonly monitorSilence?: number;
}

/**
 * The canonical model the daemon snapshots from at step 1. Wire-shaped (ids,
 * cols/rows) so it is language-neutral; the daemon-side runner converts it to a
 * driver `SessionModel` to seed its fake pipeline.
 */
export interface TranscriptInitialModel {
  readonly session: { readonly sessionId: SessionId; readonly name: string };
  readonly windows: readonly TranscriptWindow[];
  readonly panes: readonly TranscriptPane[];
  readonly focus: { readonly paneId: PaneId | null; readonly windowId: WindowId | null };
  /** The connectionId the daemon assigns this client (echoed in the snapshot). */
  readonly connectionId?: ConnectionId;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * A complete conformance transcript.
 */
export interface Transcript {
  /** Must equal {@link WIRE_PROTOCOL_VERSION}. */
  readonly protocolVersion: number;
  /** Human description (carried from the JSON `description` field). */
  readonly description: string;
  /** The canonical model the daemon snapshots from (daemon-side seed). */
  readonly initialModel: TranscriptInitialModel;
  /** Verb scripting keyed by command.request correlationId. */
  readonly verbs: Readonly<Record<string, VerbScript>>;
  /** The ordered wire conversation. */
  readonly transcript: readonly TranscriptStep[];
}

// ---------------------------------------------------------------------------
// Loader (fail-loud)
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new TranscriptError(msg);
}

/**
 * Parse + validate a transcript object (already-parsed JSON). Throws
 * {@link TranscriptError} on any structural problem.
 */
export function parseTranscript(raw: unknown): Transcript {
  if (typeof raw !== "object" || raw === null) fail("transcript must be an object");
  const t = raw as Record<string, unknown>;

  if (t.protocolVersion !== WIRE_PROTOCOL_VERSION) {
    fail(
      `transcript protocolVersion ${String(t.protocolVersion)} != WIRE_PROTOCOL_VERSION ${WIRE_PROTOCOL_VERSION}`,
    );
  }
  if (typeof t.initialModel !== "object" || t.initialModel === null) {
    fail("transcript missing `initialModel`");
  }
  if (!Array.isArray(t.transcript)) fail("transcript missing `transcript` array");

  const steps: TranscriptStep[] = [];
  for (const s of t.transcript as unknown[]) {
    if (typeof s !== "object" || s === null) fail("each transcript step must be an object");
    const step = s as Record<string, unknown>;
    const dir = step.direction;
    if (dir !== "session-proxy→client" && dir !== "client→session-proxy") {
      fail(`unknown step direction: ${String(dir)} (step ${String(step.step)})`);
    }
    if (typeof step.message !== "object" || step.message === null) {
      fail(`step ${String(step.step)} (${String(step.label)}) missing \`message\``);
    }
    steps.push(step as unknown as TranscriptStep);
  }

  const verbs = (t.verbs ?? {}) as Record<string, VerbScript>;

  return {
    protocolVersion: t.protocolVersion as number,
    description: typeof t.description === "string" ? t.description : "",
    initialModel: t.initialModel as unknown as TranscriptInitialModel,
    verbs,
    transcript: steps,
  };
}

/** Load + validate a transcript from a JSON file. */
export function loadTranscript(path: string): Transcript {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`failed to read/parse transcript ${path}: ${(err as Error).message}`);
  }
  return parseTranscript(raw);
}

// ---------------------------------------------------------------------------
// Step filters
// ---------------------------------------------------------------------------

/** The session-proxy→client steps (daemon pushes), in transcript order. */
export function serverSteps(t: Transcript): ServerStep[] {
  return t.transcript.filter((s): s is ServerStep => s.direction === "session-proxy→client");
}

/** The client→session-proxy steps (client requests), in transcript order. */
export function clientSteps(t: Transcript): ClientStep[] {
  return t.transcript.filter((s): s is ClientStep => s.direction === "client→session-proxy");
}
