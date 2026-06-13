/**
 * fake-pipeline.ts — a no-tmux RuntimePipeline for the conformance harness.
 *
 * The daemon-side conformance runner drives the REAL session-proxy control
 * plane (`createControlServer`) over an in-memory transport. `createControlServer`
 * needs a `RuntimePipeline` to snapshot + diff against — but a real pipeline
 * requires a live tmux process. This fake exposes exactly the pipeline surface
 * `serve.ts` consumes (`getModel` / `onModelChange`) and is driven manually by
 * the runner (`fireChange`), so the REAL daemon's snapshot + delta + origin path
 * runs with zero tmux.
 *
 * This mirrors the established `createFakePipeline` pattern in the session-proxy's
 * own `runtime/serve.test.ts`, formalised into the SDK harness so host tests and
 * future SDKs share one driver.
 *
 * @module harness/fake-pipeline
 */

import type {
  RuntimePipeline,
  SessionModel,
} from "@tmuxcc/session-proxy";
import { emptyModel } from "@tmuxcc/session-proxy";

/** A fake pipeline the harness drives directly. */
export interface FakePipeline extends RuntimePipeline {
  /** Fire all onModelChange handlers with (newModel, prevModel) and commit newModel. */
  fireChange(newModel: SessionModel, prevModel: SessionModel): void;
  /** Replace the model getModel() returns (without firing handlers). */
  setModel(model: SessionModel): void;
}

/**
 * Create a fake `RuntimePipeline` seeded with `initialModel` (empty by default).
 *
 * Only `getModel()` and `onModelChange()` are functional — the rest of the
 * RuntimePipeline surface throws or no-ops, since the conformance runner never
 * exercises the tmux-bound seams (send / buffers / start). Calling one of those
 * is a harness bug, so they throw loudly rather than silently returning junk.
 */
export function createFakePipeline(initialModel?: SessionModel): FakePipeline {
  let current: SessionModel = initialModel ?? emptyModel();
  const handlers = new Set<(m: SessionModel, prev: SessionModel) => void>();

  const unsupported = (name: string): never => {
    throw new Error(`FakePipeline.${name} is not supported in the conformance harness`);
  };

  return {
    getModel() {
      return current;
    },
    isLive() {
      return true;
    },
    async start() {
      /* no-op: the harness seeds the model directly */
    },
    stop() {
      /* no-op */
    },
    onModelChange(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onNotification() {
      // The harness drives model changes via fireChange, not notifications.
      return () => {};
    },
    injectNotification() {
      unsupported("injectNotification");
    },
    patchModel() {
      unsupported("patchModel");
    },
    send() {
      return unsupported("send");
    },
    sendBatch() {
      return unsupported("sendBatch");
    },
    refreshCorrelatorPendingGauge() {
      /* no-op: no correlator in the fake */
    },
    get buffers(): never {
      return unsupported("buffers");
    },
    setModel(model) {
      current = model;
    },
    fireChange(newModel, prevModel) {
      current = newModel;
      for (const h of handlers) h(newModel, prevModel);
    },
  };
}
