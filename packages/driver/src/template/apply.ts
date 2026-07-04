/**
 * Session-template applicator (tc-gjdx.3) — the INTERPRETER half.
 *
 * Executes a {@link CompiledTemplate} plan against a live session by issuing the
 * driver's existing creating verbs through a single `send` seam (the
 * session-proxy's slotted, correlated command path). The compiler
 * ({@link import("./compile.js")}) is pure and id-free; this module resolves the
 * runtime tmux ids the `-P -F` creations mint and threads them into the
 * subsequent split / select-layout / kill steps.
 *
 * # Compile→apply order (per window)
 *
 *   1. `new-window -P -F …`  → the window's FIRST pane (leaf 0), with the
 *      leaf's name/cwd/command/env.
 *   2. `split-window -P -F …` for leaves 1..k-1, each splitting the
 *      PREVIOUSLY-created pane. Splitting the last-created pane keeps tmux's
 *      `w->panes` list in creation order, which equals the layout's depth-first
 *      leaf order — so the positional `select-layout` assignment lands each leaf
 *      in the right cell.
 *   3. `select-layout` (only when the window has >1 pane) applies the desired
 *      geometry, sized against the window's CURRENT dimensions.
 *
 * After all template windows exist, the throwaway INITIAL window (the one a
 * freshly-minted session is born with — its pane can't carry per-pane
 * cwd/command/env) is killed. This runs LAST, after ≥1 template window exists,
 * so the session is never emptied.
 *
 * # Awareness (survives reattach / driver restart with no driver-side state)
 *
 * When the template is named, `@tmuxcc-template=<name>` is set as a session
 * user-option FIRST, so "created from template X" is recorded even if a later
 * step fails (fail-loud preserves provenance alongside the partial session). The
 * broker surfaces it on the session row (see tmux-south listSessions).
 *
 * # Partial failure (ratified: stop-first, no rollback — tc-gjdx.3)
 *
 * Apply is a SEQUENCE of creating verbs. On the FIRST failure — a rejected verb
 * OR a `select-layout` tmux refuses — we STOP and throw {@link
 * TemplateApplyError} naming the failed verb, tmux's verbatim reason, and the
 * created-so-far topology. There is NO auto-rollback: rollback would destroy the
 * evidence (and possibly real user work). The old extension applicator swallowed
 * these to a warn-log; that class of swallow is exactly what this replaces.
 *
 * @module template/apply
 */

import type { CommandResult } from "../parser/correlator.js";
import {
  newWindow,
  splitWindow,
  selectLayout,
  killWindow,
  setOptionForSession,
  displayMessagePane,
  parseEffectIds,
} from "../parser/commands.js";
import { serializeGeometry } from "../parser/layout-string.js";
import type { CompiledTemplate, CompiledWindow, CompiledPane } from "./compile.js";

/**
 * The tmux user-option that records the applied template's identity on the
 * session, so "created from template X" survives reattach and driver restarts
 * with no driver-side state to go stale (tc-gjdx.3 awareness).
 */
export const TEMPLATE_SESSION_OPTION = "@tmuxcc-template";

/**
 * The single command seam the applicator drives: send a tmux command string
 * through the session-proxy's slotted, correlated path and resolve with the
 * {@link CommandResult} (`ok` + reply `body`). This is exactly
 * `SessionProxy.send`; a fake makes the applicator unit-testable without tmux.
 */
export type TemplateApplySend = (command: string) => Promise<CommandResult>;

/** One window created by an apply, in creation order. */
export interface AppliedWindow {
  /** tmux window id (`@N`). */
  readonly windowId: string;
  /** tmux pane ids (`%N`) in creation order (leaf order). */
  readonly paneIds: readonly string[];
  /** The window's template name, when it had one. */
  readonly name?: string;
}

/** The topology an apply created (so far). Reused by tc-gjdx.4's apply-to-live. */
export interface TemplateApplyOutcome {
  readonly windows: readonly AppliedWindow[];
}

/**
 * A mid-transaction apply failure (tc-gjdx.3 partial-failure semantics). Carries
 * the wire `template.invalid` code, the failed verb, tmux's verbatim reason, and
 * the created-so-far topology. NO rollback was performed — the partial session
 * persists as evidence. tc-gjdx.4 (apply-to-live) reuses this shape.
 */
export class TemplateApplyError extends Error {
  readonly code = "template.invalid";
  constructor(
    /** The verb that failed, e.g. `open-window`, `split-pane`, `select-layout`. */
    readonly failedVerb: string,
    /** The exact tmux command string that failed. */
    readonly failedCommand: string,
    /** tmux's verbatim refusal text (or a driver-side reason). */
    readonly tmuxMessage: string,
    /** Topology created before the failure — NOT rolled back. */
    readonly created: TemplateApplyOutcome,
  ) {
    super(
      `template apply failed at ${failedVerb}: ${tmuxMessage}. ` +
        `Created before failure: ${describeCreated(created)} (no rollback — partial session preserved).`,
    );
    this.name = "TemplateApplyError";
  }
}

function describeCreated(outcome: TemplateApplyOutcome): string {
  if (outcome.windows.length === 0) return "nothing";
  return outcome.windows
    .map((w) => `${w.windowId}[${w.paneIds.join(",")}]`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Applicator
// ---------------------------------------------------------------------------

/**
 * Options for {@link applyCompiledTemplate}.
 */
export interface ApplyCompiledTemplateOptions {
  /**
   * When true (the default — apply-at-create path), the applicator identifies
   * the session's initial throwaway window before applying template windows
   * and kills it after the last template window is created.
   *
   * Set to false for apply-to-live (tc-gjdx.4): the session already has user
   * windows, there is no throwaway initial window, and no existing window
   * must be killed.
   */
  killInitialWindow?: boolean;
}

/**
 * Apply a {@link CompiledTemplate} to the session `send` is bound to.
 *
 * `sessionName` targets the `@tmuxcc-template` awareness option (tmux
 * `set-option -t <name>` — the session-proxy is bound to exactly one session).
 *
 * `opts.killInitialWindow` (default `true`): the apply-at-create path kills
 * the throwaway initial window after creating all template windows.  Pass
 * `{ killInitialWindow: false }` for the apply-to-live path, where the
 * session already has real user windows.
 *
 * Resolves with the created topology on success; rejects with
 * {@link TemplateApplyError} on the first failure (no rollback).
 */
export async function applyCompiledTemplate(
  send: TemplateApplySend,
  plan: CompiledTemplate,
  sessionName: string,
  opts?: ApplyCompiledTemplateOptions,
): Promise<TemplateApplyOutcome> {
  const killInitialWindow = opts?.killInitialWindow ?? true;
  const created: AppliedWindow[] = [];
  const outcome = (): TemplateApplyOutcome => ({ windows: created.slice() });

  // Run a non-creating verb; throw a fail-loud TemplateApplyError on refusal.
  const run = async (verb: string, command: string): Promise<void> => {
    const result = await send(command);
    if (!result.ok) {
      throw new TemplateApplyError(verb, command, tmuxText(result) || `tmux rejected ${verb}`, outcome());
    }
  };

  // Run a CREATING verb (`-P -F` id-printing) and return the minted tmux ids.
  const runCreating = async (
    verb: string,
    command: string,
  ): Promise<{ paneNum: number; windowNum: number }> => {
    const result = await send(command);
    if (!result.ok) {
      throw new TemplateApplyError(verb, command, tmuxText(result) || `tmux rejected ${verb}`, outcome());
    }
    const ids = parseEffectIds(decode(result.body));
    if (ids === null) {
      // tmux accepted but the -P -F reply did not parse — the verb's contract
      // is broken; fail loud rather than continue against unknown ids.
      throw new TemplateApplyError(
        verb,
        command,
        `${verb} succeeded but its -P -F effect-id reply was unparseable: ${JSON.stringify(decode(result.body))}`,
        outcome(),
      );
    }
    return ids;
  };

  // Query a single expanded format value from a pane (window dims for the layout).
  const query = async (verb: string, command: string): Promise<string> => {
    const result = await send(command);
    if (!result.ok) {
      throw new TemplateApplyError(verb, command, tmuxText(result) || `tmux rejected ${verb}`, outcome());
    }
    return decode(result.body).trim();
  };

  // Identify the throwaway initial window BEFORE creating any template window,
  // so we can kill it at the end.  Only needed on the apply-at-create path —
  // apply-to-live has real user windows and must not kill any of them.
  let initialWindowId: string | null = null;
  if (killInitialWindow) {
    const initialWindowNum = await query(
      "list-windows",
      "list-windows -F '#{window_id}'",
    );
    initialWindowId = firstLine(initialWindowNum); // e.g. "@0"
  }

  // Awareness FIRST: record provenance so a later partial failure still stamps
  // "created from template X" onto the persisted (partial) session.
  if (plan.templateName !== undefined) {
    await run(
      "set-option @tmuxcc-template",
      setOptionForSession(sessionName, TEMPLATE_SESSION_OPTION, plan.templateName),
    );
  }

  for (const window of plan.windows) {
    await applyWindow(window, created, run, runCreating, query);
  }

  // Kill the throwaway initial window LAST — the session already has ≥1
  // template window, so it is never emptied.  Apply-to-live skips this.
  if (killInitialWindow && initialWindowId !== null) {
    const num = tmuxNum(initialWindowId);
    if (num !== null) {
      await run("kill-window", killWindow(num));
    }
  }

  return outcome();
}

async function applyWindow(
  window: CompiledWindow,
  created: AppliedWindow[],
  run: (verb: string, command: string) => Promise<void>,
  runCreating: (verb: string, command: string) => Promise<{ paneNum: number; windowNum: number }>,
  query: (verb: string, command: string) => Promise<string>,
): Promise<void> {
  const [first, ...rest] = window.panes;

  // Leaf 0 → new-window (carrying the leaf's name/cwd/command/env).
  const firstIds = await runCreating(
    "open-window",
    newWindow({
      printIds: true,
      ...(window.name !== undefined ? { name: window.name } : {}),
      ...paneCreateOpts(first!),
    }),
  );

  const applied: AppliedWindow = {
    windowId: `@${firstIds.windowNum}`,
    paneIds: [`%${firstIds.paneNum}`],
    ...(window.name !== undefined ? { name: window.name } : {}),
  };
  // Push eagerly so the created-so-far report includes this window even if a
  // later split within it fails.
  created.push(applied);
  const paneIds: string[] = applied.paneIds as string[];

  // Leaves 1..k-1 → split the previously-created pane (keeps w->panes in order).
  let lastPaneNum = firstIds.paneNum;
  for (const pane of rest) {
    const ids = await runCreating(
      "split-pane",
      splitWindow(lastPaneNum, "horizontal", {
        printIds: true,
        ...paneCreateOpts(pane),
      }),
    );
    lastPaneNum = ids.paneNum;
    paneIds.push(`%${ids.paneNum}`);
  }

  // Geometry (present iff >1 pane) → select-layout sized to the current window.
  if (window.geometry !== undefined) {
    const dims = await query(
      "display-message",
      displayMessagePane(firstIds.paneNum, "#{window_width}x#{window_height}"),
    );
    const size = parseDims(dims);
    if (size === null) {
      throw new TemplateApplyError(
        "select-layout",
        `display-message …#{window_width}x#{window_height} (@${firstIds.windowNum})`,
        `could not read window size for select-layout (got ${JSON.stringify(dims)})`,
        { windows: created.slice() },
      );
    }
    await run(
      "select-layout",
      selectLayout(firstIds.windowNum, serializeGeometry(window.geometry, size)),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compiled pane → the creating verb's cwd/env/shellCommand options. */
function paneCreateOpts(pane: CompiledPane): {
  startDirectory?: string;
  env?: Record<string, string>;
  shellCommand?: string;
} {
  return {
    ...(pane.cwd !== undefined ? { startDirectory: pane.cwd } : {}),
    ...(pane.env !== undefined ? { env: { ...pane.env } } : {}),
    ...(pane.shellCommand !== undefined ? { shellCommand: pane.shellCommand } : {}),
  };
}

const DECODER = new TextDecoder();
function decode(body: Uint8Array | undefined): string {
  return body !== undefined ? DECODER.decode(body) : "";
}

/** tmux's verbatim reply/error text (trimmed), or "" when the block had no body. */
function tmuxText(result: CommandResult): string {
  return decode(result.body).trim();
}

function firstLine(s: string): string | null {
  for (const raw of s.split("\n")) {
    const line = raw.trim();
    if (line !== "") return line;
  }
  return null;
}

/** `@12` / `%3` → 12 / 3; null when it does not match a tmux id. */
function tmuxNum(id: string): number | null {
  const m = /^[@%$](\d+)$/.exec(id.trim());
  return m === null ? null : parseInt(m[1]!, 10);
}

/** `"200x50"` → `{ cols: 200, rows: 50 }`; null on a malformed value. */
function parseDims(s: string): { cols: number; rows: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(s.trim());
  if (m === null) return null;
  return { cols: parseInt(m[1]!, 10), rows: parseInt(m[2]!, 10) };
}
