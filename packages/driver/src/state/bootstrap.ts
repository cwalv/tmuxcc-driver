/**
 * Bootstrap reply schema/codec + initial-model builder (tc-835, retained
 * tc-128.4; schema-derived tc-mysc).
 *
 * @module state/bootstrap
 *
 * # What it is (tc-128.4)
 *
 * `RequeryEngine` (state/requery.ts) owns the bootstrap path end-to-end.
 * Bootstrap is just `engine.requery()` with the empty model as the previous:
 * the diff against empty yields a full snapshot of deltas, and there's no
 * separate "live vs bootstrapping" phase to coordinate. Notifications that
 * arrive during the round-trip are demoted to a dirty bit by the coalescer,
 * which schedules the next requery.
 *
 * This module hosts the WIRE-LEVEL pieces the engine composes on every cycle:
 *
 *   - {@link WINDOWS_ROW} / {@link PANES_ROW} — the two reply-row SCHEMAS. Each
 *     is the SINGLE declaration of its reply's canonical fields; the tmux
 *     format string, the strict parser, the row type, and the test fixture
 *     builder are all DERIVED from it (see `state/reply-row.ts`). Adding a
 *     canonical field is one edit — it is unrepresentable for the format and
 *     the parser to disagree (this defines the tc-pqb4 clobber class out of
 *     existence, rather than guarding against it).
 *   - `BOOTSTRAP_WINDOWS_FORMAT` / `BOOTSTRAP_PANES_FORMAT` — the `-F` format
 *     strings, DERIVED from the schemas (`WINDOWS_ROW.format` / `.format`).
 *   - `bootstrapCommands(target?)` — builds the two `list-*` command lines.
 *   - `buildInitialModel` — folds the parsed rows into a `SessionModel`.
 *
 * # Strict parse replaces the defensive gates
 *
 * `WINDOWS_ROW.parse` / `PANES_ROW.parse` are STRICT: a wrong field count or a
 * per-field decode failure THROWS a `ReplyCodecError` (routed to the session
 * error boundary — see the coalescer). This replaces both the old
 * `parts[i] ?? default` fallbacks AND the old `isNaN(width|height)` /
 * `parts.length < 9` row-validity gates: because the format and the parser are
 * the same artifact, a mismatch is by definition a bug (or an injected control
 * char), not routine variation. The parse strips only a trailing `\r`, never
 * `trim()` (a live pane row ends with empty option fields that `trim()` would
 * eat, manufacturing a short row).
 *
 * # Free-text sanitization + newline policy (validated against tmux 3.4)
 *
 * A field value containing the TAB separator or a NEWLINE row separator would
 * corrupt the tab/line split. Verified live:
 *   - NAMES (`session_name`, `window_name`): tmux ESCAPES an embedded tab to a
 *     2-char `\t` (never a raw tab → no shatter), so names are read PLAIN. tmux
 *     emits an embedded NEWLINE RAW; a newline in a name is BOUNDED-THROW —
 *     pathological input (automatic-rename and normal renames never produce
 *     one) that the strict parser surfaces loudly rather than misparsing.
 *     (`#{q:}` would collapse the newline but over-escapes normal names, and
 *     POSIX `[[:...:]]` classes are unusable in `s///` — the `:` collides with
 *     the modifier terminator.)
 *   - USER OPTIONS (`@tmuxcc_label`, `@tmuxcc-icon`): tmux stores/emits RAW
 *     tabs (the shipped footgun), so these are read through `tabSanitized(...)`
 *     — an in-tmux `#{s/<TAB>/ /:var}` that maps every tab to a space (global,
 *     preserves all other chars). Newlines in user options have no read-side
 *     fix and are closed at the driver's single write point (the driver is the
 *     sole writer of these options).
 *
 * # Id mapping convention
 *
 *   paneId("p" + N)    for tmux `%N`
 *   windowId("w" + N)  for tmux `@N`
 *   sessionId("s" + N) for tmux `$N`
 */

import { parseLayout } from "../parser/layout-string.js";
import { listWindows, listPanes } from "../parser/commands.js";
import type { SessionModel, Session, Window, Pane } from "./model.js";
import {
  emptyModel,
  addSession,
  addWindow,
  addPane,
  updateSession,
  setFocus,
  parsedLayoutToWindowLayout,
  emptyPaneOverlay,
  paneId,
  windowId,
  sessionId,
} from "./model.js";
import {
  defineReplyRow,
  field,
  sigilId,
  text,
  int,
  flag01,
  emptyAsUndefined,
  optionalKeyword,
  tabSanitized,
  type RowTypeOf,
} from "./reply-row.js";
import { createHash } from "node:crypto";
import type { PaneId, WindowId, SessionId } from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Pane user-options
// ---------------------------------------------------------------------------

/**
 * The per-pane tmux user-option that stores the durable, driver-owned pane
 * name (tc-1a8z).
 *
 * Single source of truth for the option NAME, shared by the WRITE side
 * (input-path's `rename-pane` verb → `set-option -pt %N @tmuxcc_label <name>`)
 * and the READ side (BOOTSTRAP_PANES_FORMAT below → `#{@tmuxcc_label}`).  It
 * mirrors the session-ownership marker `@tmuxcc` (tc-w61): canonical state
 * lives WITH the pane in tmux, so it survives a driver restart for free and is
 * natively introspectable.
 *
 * This is the DURABLE channel — never set via a title escape, so the shell
 * cannot clobber it.  Distinct from the live pane_title (tc-2mn8).
 */
export const TMUXCC_LABEL_OPTION = "@tmuxcc_label";

// ---------------------------------------------------------------------------
// Cold-start durable policy/intent user-options (tc-i9aq.1, cold-start.md §4.A)
// ---------------------------------------------------------------------------

/**
 * Per-(pane, client-identity) binding-intent marker (D3, tc-4b6k.2; supersedes
 * the single-scalar `@tmuxcc-bound` of tc-i9aq.1).  `1` means "the client with
 * this identity wants a VS Code terminal recreated for this pane on attach";
 * unset/empty means no intent for that client.  Binding is per-client, so the
 * durable option name carries the client-identity key: two workspaces binding
 * the same pane write DISTINCT options and never collide (dissolves seam S1).
 *
 * Written by the `set-object-policy` verb at PANE scope keyed by the ISSUING
 * connection's identity (`set-option -pt %N @tmuxcc-bound-<key> 1` / `-u` to
 * clear); read per-client on connect and carried forward across requery cycles
 * (see the model.ts `PaneOverlay.boundClients`).  Lives WITH the pane in tmux, so it survives a
 * VS Code restart and vanishes with the pane — staleness is structurally
 * impossible (it cannot outlive its referent).
 *
 * This bare prefix is also the LEGACY / anonymous-connection key: a connection
 * that presents no `ClientIdentity` binds/reads here (see
 * {@link paneBoundOptionName}).
 */
export const TMUXCC_BOUND_OPTION = "@tmuxcc-bound";

/**
 * The per-client tmux user-option name that stores binding intent for one
 * client identity (D3, tc-4b6k.2).
 *
 *   `paneBoundOptionName(id) = "@tmuxcc-bound-" + sha1hex(id).slice(0, 16)`
 *
 * `ClientIdentity.id` is OPAQUE to the driver (the wire contract forbids the
 * driver assuming its charset), so the id is HASHED into the option-name suffix
 * rather than embedded verbatim.  sha1-hex is:
 *   - always format-safe — `#{@tmuxcc-bound-<hex>}` contains no format
 *     metacharacters (verified against tmux next-3.7: user-option names accept
 *     any characters except the `[` array sigil; options.c);
 *   - bounded (~30-char name, no length concern);
 *   - injective in practice for the handful of distinct workspaces attached to
 *     one tmux server (16 hex = 64 bits).
 *
 * An `undefined` clientId (anonymous connection / legacy) falls back to the bare
 * {@link TMUXCC_BOUND_OPTION} — a single shared slot for all anonymous clients,
 * and the back-compat key.
 */
export function paneBoundOptionName(clientId: string | undefined): string {
  if (clientId === undefined) return TMUXCC_BOUND_OPTION;
  const enc = createHash("sha1").update(clientId, "utf8").digest("hex").slice(0, 16);
  return `${TMUXCC_BOUND_OPTION}-${enc}`;
}

/**
 * Detach-on-close policy (cold-start.md §4.A).  Value is `detach` or `kill`;
 * unset/empty means "inherit" (defer to the next scope in the cascade).  Set at
 * PANE, WINDOW, or SESSION scope by the `set-object-policy` verb.
 *
 * tmux does NOT inherit user-options across scopes for `show-options`, but a
 * `#{@tmuxcc-detach}` FORMAT reference DOES walk pane→window→session (verified
 * tmux 3.4).  The requery reads this through `list-panes -F`, so the pane row
 * carries the RESOLVED (effective) close policy — pane override, else window
 * default, else session default — which is exactly the first-wins cascade the
 * host's close decision consumes.  Per-scope-OWN values (for the toggle UI's
 * "current setting" display) are tracked optimistically in the extension's
 * in-memory policy cache (bucket B), written through this verb; the durable
 * truth is the tmux object.
 */
export const TMUXCC_DETACH_OPTION = "@tmuxcc-detach";

/**
 * Per-pane icon policy (cold-start.md §4.A).  Opaque string (a VS Code
 * ThemeIcon id or icon-policy token); unset/empty means "no durable icon
 * policy".  Written at PANE scope by the `set-object-policy` verb and re-read
 * on every requery.
 */
export const TMUXCC_ICON_OPTION = "@tmuxcc-icon";

// ---------------------------------------------------------------------------
// Format strings
// ---------------------------------------------------------------------------

/**
 * Reply-row schema for `list-windows` during bootstrap — the SINGLE
 * declaration of the window reply's canonical fields (tc-mysc). Includes
 * `session_id` and `session_name` so the engine can build Session entities
 * from the windows reply alone (no separate `list-sessions` needed).
 *
 * Deleted vs the pre-schema format (tc-mysc): `window_width`, `window_height`,
 * `window_flags` — parsed and dropped every cycle, never reaching the model.
 * Re-adding any of them is a one-line schema edit — the payoff that makes
 * deletion safe.
 */
export const WINDOWS_ROW = defineReplyRow("list-windows", {
  tmuxSessionId: field("#{session_id}", sigilId("$"), 0),
  // NAME fields read plain: tmux escapes their embedded tabs (verified 3.4).
  sessionName: field("#{session_name}", text, "s0"),
  tmuxWindowId: field("#{window_id}", sigilId("@"), 1),
  name: field("#{window_name}", text, "win"),
  layoutString: field("#{window_layout}", text, "aaaa,80x24,0,0,1"),
  active: field("#{?window_active,1,0}", flag01, true),
  // tc-pqb4: per-window durable options re-read on every requery so they
  // survive a driver restart and are never clobbered back to defaults by a
  // topology-triggered requery cycle.
  synchronizePanes: field("#{?synchronize-panes,1,0}", flag01, false),
  monitorActivity: field("#{?monitor-activity,1,0}", flag01, true),
  monitorSilence: field("#{monitor-silence}", int, 0),
});

/**
 * Reply-row schema for `list-panes` during bootstrap — the SINGLE declaration
 * of the pane reply's canonical fields (tc-mysc).
 *
 * Deleted vs the pre-schema format (tc-mysc): `pane_index`, `pane_top`,
 * `pane_left`, `pane_pid`, `pane_current_command` — parsed (or never even
 * read) and dropped every cycle.
 *
 * `@tmuxcc-detach` (RESOLVED close policy; `#{@}` walks pane→window→session, so
 * the value is the effective first-wins cascade) is an OPEN policy option, so
 * it decodes leniently ("detach"|"kill"|else undefined). `@tmuxcc_label` /
 * `@tmuxcc-icon` are USER OPTIONS that store RAW tabs, so they are read through
 * `tabSanitized(...)` (see the module header). Binding intent (`@tmuxcc-bound`)
 * is NOT read here: it is per-(pane,client) and reconstructed on connect
 * (tc-4b6k.2), carried forward across cycles (model.ts `PaneOverlay.boundClients`).
 */
export const PANES_ROW = defineReplyRow("list-panes", {
  tmuxPaneId: field("#{pane_id}", sigilId("%"), 0),
  tmuxWindowId: field("#{window_id}", sigilId("@"), 1),
  tmuxSessionId: field("#{session_id}", sigilId("$"), 0),
  cols: field("#{pane_width}", int, 80),
  rows: field("#{pane_height}", int, 24),
  active: field("#{?pane_active,1,0}", flag01, true),
  // Dead-pane state (tc-4bv2 / tc-295a.10 shared shape). True when tmux reports
  // `pane_dead=1` — the process exited but `remain-on-exit on` keeps the corpse
  // in `list-panes` as a FIRST-CLASS model member (inspectable/reapable), NOT an
  // absence (a pane that LEAVES `list-panes` is removed by the diff → `pane.closed`).
  dead: field("#{?pane_dead,1,0}", flag01, false),
  // Exit code of a dead corpse (empty for a live pane → undefined). buildInitialModel
  // forces it undefined unless `dead` (belt-and-braces transform).
  exitCode: field("#{pane_dead_status}", emptyAsUndefined(int), undefined),
  // Durable, DRIVER-owned pane name (tc-1a8z): the canonical rename channel set
  // via `rename-pane` → `set-option -pt %N @tmuxcc_label`. NEVER set via a title
  // escape, so the shell cannot clobber it; distinct from the live pane_title.
  // Empty → undefined (unset / cleared).
  label: field(tabSanitized("@tmuxcc_label"), emptyAsUndefined(text), undefined),
  // RESOLVED detach-on-close policy (tc-i9aq.1, cold-start.md §4.A). `#{@tmuxcc-detach}`
  // walks pane→window→session, so this is the EFFECTIVE first-wins cascade value
  // (pane override, else window, else session). Unset → undefined (inherit default).
  detach: field("#{@tmuxcc-detach}", optionalKeyword(["detach", "kill"]), undefined),
  // Durable per-pane icon policy (tc-i9aq.1): opaque string (e.g. a ThemeIcon id),
  // interpreted by the extension. Unset → undefined.
  icon: field(tabSanitized("@tmuxcc-icon"), emptyAsUndefined(text), undefined),
  // Live shell window title (tc-2mn8, format-backed tc-mysc.2) — the SINGLE
  // declaration of this canonical field's semantics (model.ts `Pane.paneTitle`
  // inherits it via PaneFromRow and does not redeclare).
  //
  // TWO read paths, both `#{pane_title}`, that always agree:
  //   - LOW-LATENCY: the `title-watch` `%*` subscription (pipeline.ts) — the
  //     event source that delivers a change within tmux's ~1s timer.
  //   - CANONICAL: THIS requery field — every cycle REAFFIRMS the title from
  //     tmux, so a snapshot rebuilt after a topology change carries titles
  //     instead of dropping them (the tc-mysc.2 regression fix). Because both
  //     paths expand the same value, the requery never clobbers a
  //     subscription-delivered title.
  //
  // User-controlled FREE TEXT (shell OSC-0/2 or `select-pane -T`), so it is read
  // through `tabSanitized(...)` like the other free-text fields. Verified live
  // (tmux 3.4, reply-row-tmux.test.ts): the title-set path (`screen_set_title`)
  // STRIPS every C0 control byte (TAB, NEWLINE, CR) at the SOURCE — an OSC title
  // `X<TAB>Y<NL>Z` is stored as `XYZ`, and `select-pane -T` REJECTS a
  // control-char title wholesale — so `#{pane_title}` never emits a raw tab or
  // newline on EITHER path: the requery row cannot shatter and the
  // `%subscription-changed` line cannot split (amendment 4). The s/// is thus a
  // no-op on real data but pins the tab vector as defense-in-depth; the strict
  // parser still bounded-throws on a raw newline (consistent with names) if a
  // future tmux ever changed this.
  //
  // Empty → undefined (no title seen / cleared); `#{pane_title}` defaults to the
  // hostname on untouched panes. Consumer precedence for tab/tree display:
  // @tmuxcc_label (durable name) > paneTitle (live) > paneId (fallback).
  paneTitle: field(tabSanitized("pane_title"), emptyAsUndefined(text), undefined),
});

/**
 * `list-windows -F` format string — DERIVED from {@link WINDOWS_ROW}. Kept as a
 * named export for `bootstrapCommands` and external importers.
 */
export const BOOTSTRAP_WINDOWS_FORMAT = WINDOWS_ROW.format;

/** `list-panes -F` format string — DERIVED from {@link PANES_ROW}. */
export const BOOTSTRAP_PANES_FORMAT = PANES_ROW.format;

// ---------------------------------------------------------------------------
// Bootstrap command set
// ---------------------------------------------------------------------------

/**
 * How the requery engine scopes its `list-windows` / `list-panes` cycle to a
 * single session.
 *
 *   - `{ kind: "id", sessionId }` — target by the IMMUTABLE tmux session id
 *     (`$N`). This is the steady-state target: it survives a `rename-session`
 *     (the id never changes), so the requery keeps observing the right session
 *     after a rename and can emit the `session.renamed` delta (tc-0v59).
 *   - `{ kind: "name", sessionName }` — target by the (mutable) session name
 *     (`=<name>`). Used ONLY for the very first cold cycle, before any reply
 *     has revealed the immutable id. The name is correct at bootstrap; the
 *     engine captures the id from the first successful reply and switches to
 *     id-targeting forever after.
 *   - `undefined` — no scope: fall back to `-a` (all sessions), the legacy
 *     behaviour for bootstrap shapes that know neither the id nor the name.
 */
export type SessionTarget =
  | { readonly kind: "id"; readonly sessionId: number }
  | { readonly kind: "name"; readonly sessionName: string };

/**
 * Return the two tmux commands the requery engine issues on every cycle.
 *
 * When `target` is provided the commands are scoped to that one session
 * (avoiding cross-session contamination in multi-session environments). The
 * `"id"` form targets by the immutable session id `$N` (rename-safe); the
 * `"name"` form targets by `=<name>` (used only before the id is known).
 * When `target` is absent, falls back to `-a` (all sessions).
 *
 * Returns: `[listWindowsCommand, listPanesCommand]`
 */
export function bootstrapCommands(target?: SessionTarget): [string, string] {
  if (target !== undefined && target.kind === "id") {
    // Steady-state: scope by the IMMUTABLE session id ($N). listWindows emits
    // `-t $<id>`; listPanes emits the session-scoped `-s -t $<id>` form. This
    // survives a rename-session (tc-0v59) because the id never changes.
    const winCmd = listWindows(BOOTSTRAP_WINDOWS_FORMAT, target.sessionId);
    const paneCmd = listPanes({
      sessionId: target.sessionId,
      format: BOOTSTRAP_PANES_FORMAT,
    });
    return [winCmd, paneCmd];
  }
  if (target !== undefined && target.kind === "name" && target.sessionName.length > 0) {
    // Cold-bootstrap only: scope by the mutable session name (tc-tfv.3: avoid
    // cross-session pane/focus contamination when multiple sessions share a
    // tmux server). Used until the first reply reveals the immutable id.
    const nameTarget = `=${target.sessionName}`;
    const winCmd = listWindows(BOOTSTRAP_WINDOWS_FORMAT) + ` -t ${nameTarget}`;
    // list-panes -s scopes to all panes in the session; -t targets the session.
    const paneCmd = listPanes(undefined, BOOTSTRAP_PANES_FORMAT) + ` -s -t ${nameTarget}`;
    return [winCmd, paneCmd];
  }
  // Fallback: all sessions (legacy behaviour).
  const winCmd = listWindows(BOOTSTRAP_WINDOWS_FORMAT) + " -a";
  const paneCmd = listPanes(undefined, BOOTSTRAP_PANES_FORMAT) + " -a";
  return [winCmd, paneCmd];
}

// ---------------------------------------------------------------------------
// Id minting (SAME CONVENTION used elsewhere — keep aligned)
// ---------------------------------------------------------------------------

function mintPaneId(n: number): PaneId {
  return paneId("p" + n);
}

function mintWindowId(n: number): WindowId {
  return windowId("w" + n);
}

function mintSessionId(n: number): SessionId {
  return sessionId("s" + n);
}

// ---------------------------------------------------------------------------
// Reply row types (derived from the schemas above)
// ---------------------------------------------------------------------------

/**
 * One parsed `list-windows` row. Derived from {@link WINDOWS_ROW}: adding a
 * field to that schema adds it here automatically. @internal
 */
export type WindowsReplyRow = RowTypeOf<typeof WINDOWS_ROW>;

/**
 * One parsed `list-panes` row. Derived from {@link PANES_ROW}. @internal
 */
export type PanesReplyRow = RowTypeOf<typeof PANES_ROW>;

// ---------------------------------------------------------------------------
// Pane provenance: canonical fields are a mechanical Pick of the reply row
// ---------------------------------------------------------------------------

/**
 * The pane fields taken VERBATIM from a {@link PanesReplyRow} — same name, same
 * type, no transform (tc-mysc.1). `buildInitialModel` copies exactly these via
 * {@link pickCanonical}; a `Pane` is `PaneFromRow` + remapped identity ids +
 * genuinely-transformed fields (`mode`, `exitCode`) + `overlay`.
 *
 * This list is the SECOND half of the tc-pqb4 defence (the first half — the
 * schema-derived format/parse — landed in tc-mysc): because the canonical
 * fields arrive by this Pick, writing a hardcoded literal for one at the
 * construction site is a type error, so the "silently rebuilt from a default,
 * then clobbered by the diff" bug is defined out of existence rather than
 * guarded against. Adding a canonical field is one edit here + in `PANES_ROW`.
 *
 * The `satisfies` clause pins every entry to a real `PanesReplyRow` key.
 */
export const PANE_CANONICAL_FROM_ROW = [
  "cols",
  "rows",
  "dead",
  "label",
  "detach",
  "icon",
  // Live shell title (tc-mysc.2): format-backed by `#{pane_title}`, picked
  // verbatim like the other free-text option fields. Sourcing it from the requery
  // is the tc-mysc.2 regression fix — a snapshot rebuilt after a topology requery
  // now CARRIES titles instead of dropping them. The title-watch subscription
  // (pipeline.ts) stays the low-latency source; this requery reaffirms.
  "paneTitle",
] as const satisfies readonly (keyof PanesReplyRow)[];

/** The pane fields picked verbatim from a {@link PanesReplyRow} (see {@link PANE_CANONICAL_FROM_ROW}). */
export type PaneFromRow = Pick<PanesReplyRow, (typeof PANE_CANONICAL_FROM_ROW)[number]>;

/** Copy the canonical-from-row fields out of a parsed pane row (mechanical, no transform). */
function pickCanonical(row: PanesReplyRow): PaneFromRow {
  const out: Record<string, unknown> = {};
  for (const key of PANE_CANONICAL_FROM_ROW) {
    out[key] = row[key];
  }
  return out as PaneFromRow;
}

/**
 * The pane fields NOT covered by identity or {@link PaneFromRow} — the
 * explicitly-constructed remainder (`mode`, `exitCode`, `overlay`).
 * buildInitialModel writes this sub-object with a `satisfies` clause so a
 * hardcoded literal for a canonical/identity field is an excess-property type
 * error there.
 */
type PaneConstructionExtras = Omit<Pane, keyof PaneFromRow | "paneId" | "windowId" | "sessionId">;

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

/**
 * Build a fresh `SessionModel` from parsed windows + panes rows.
 *
 * The requery engine calls this on every cycle: the model is the diff
 * baseline that `diffModel(prev, next)` turns into wire deltas.
 *
 * @param windowRows - Output of `WINDOWS_ROW.parse`.
 * @param paneRows   - Output of `PANES_ROW.parse`.
 */
export function buildInitialModel(
  windowRows: WindowsReplyRow[],
  paneRows: PanesReplyRow[],
): SessionModel {
  let model = emptyModel();

  // ---- Step 1: collect sessions ----------------------------------------
  const sessionNames = new Map<number, string>();
  const sessionActiveWindowId = new Map<number, number>(); // tmux ids

  for (const row of windowRows) {
    if (!sessionNames.has(row.tmuxSessionId)) {
      sessionNames.set(row.tmuxSessionId, row.sessionName);
    }
    if (row.active) {
      sessionActiveWindowId.set(row.tmuxSessionId, row.tmuxWindowId);
    }
  }

  // ---- Step 2: add sessions (empty windowIds for now) ------------------
  for (const [tmuxSessId, name] of sessionNames) {
    const sid = mintSessionId(tmuxSessId);
    const session: Session = {
      sessionId: sid,
      name,
      windowIds: [],
      activeWindowId: null, // filled in step 3
    };
    model = addSession(model, session);
  }

  // ---- Step 3: add windows with layout ---------------------------------
  const panesByWindow = new Map<number, PanesReplyRow[]>();
  for (const row of paneRows) {
    let list = panesByWindow.get(row.tmuxWindowId);
    if (list === undefined) {
      list = [];
      panesByWindow.set(row.tmuxWindowId, list);
    }
    list.push(row);
  }

  for (const row of windowRows) {
    const wid = mintWindowId(row.tmuxWindowId);
    const sid = mintSessionId(row.tmuxSessionId);

    let layout: import("@tmuxcc/protocol").WindowLayout | null = null;
    try {
      const parsed = parseLayout(row.layoutString);
      layout = parsedLayoutToWindowLayout(parsed, mintPaneId);
    } catch {
      // Malformed or unrecognized layout string — leave null.
    }

    const winPanes = panesByWindow.get(row.tmuxWindowId) ?? [];
    const activePaneRow = winPanes.find((p) => p.active);
    const activePaneId = activePaneRow !== undefined ? mintPaneId(activePaneRow.tmuxPaneId) : null;

    const win: Window = {
      windowId: wid,
      sessionId: sid,
      name: row.name,
      paneIds: [], // filled in step 4
      activePaneId,
      layout,
      // tc-pqb4: per-window durable options re-read from the tmux reply on every
      // requery so their values survive a driver restart and are never clobbered
      // back to defaults by a topology-triggered requery cycle. Previously these
      // were hardcoded to defaults here, causing EDH-reload to report
      // synchronizePanes=false for all windows even when tmux had sync ON.
      synchronizePanes: row.synchronizePanes,
      monitorActivity: row.monitorActivity,
      monitorSilence: row.monitorSilence,
    };

    model = addWindow(model, win);
  }

  // Step 3b: fix each session's activeWindowId to the correct one.
  for (const [tmuxSessId, tmuxActiveWinId] of sessionActiveWindowId) {
    const sid = mintSessionId(tmuxSessId);
    model = updateSession(model, sid, { activeWindowId: mintWindowId(tmuxActiveWinId) });
  }

  // ---- Step 4: add panes -----------------------------------------------
  for (const row of paneRows) {
    const pid = mintPaneId(row.tmuxPaneId);
    const wid = mintWindowId(row.tmuxWindowId);
    const sid = mintSessionId(row.tmuxSessionId);

    if (!model.windows.has(wid)) continue;
    if (model.panes.has(pid)) continue;

    // Provenance construction (tc-mysc.1): the canonical fields arrive verbatim
    // via `pickCanonical(row)`, so there is no place to write a hardcoded literal
    // for one — the tc-pqb4 clobber is defined out of existence. Only the
    // remapped identity ids and the genuinely-transformed remainder are written
    // explicitly; the `satisfies PaneConstructionExtras` clause makes a hardcoded
    // literal for any canonical/identity field an excess-property type error here.
    const p: Pane = {
      paneId: pid,
      windowId: wid,
      sessionId: sid,
      ...pickCanonical(row),
      ...({
        mode: "normal",
        // exitCode is only meaningful for a dead corpse; a live pane's
        // pane_dead_status is empty (→ undefined) so this guard is belt-and-braces.
        exitCode: row.dead ? row.exitCode : undefined,
        // tc-4b6k.2: binding intent (overlay.boundClients) is per-(pane,client)
        // and is NOT in the bulk requery. A fresh pane starts with an empty
        // overlay; carryForwardOverlays (requery.ts) preserves a surviving pane's
        // overlay wholesale, and a client's slot is (re)read on connect
        // (pipeline.applyClientBinding). paneTitle is now format-backed
        // (`#{pane_title}`, tc-mysc.2) so it arrives verbatim via pickCanonical
        // above — no longer an absent-until-subscription remainder.
        overlay: emptyPaneOverlay(),
      } satisfies PaneConstructionExtras),
    };
    model = addPane(model, p);
  }

  // ---- Step 5: compute global focus triple -----------------------------
  let focusSet = false;
  for (const [tmuxSessId] of sessionActiveWindowId) {
    const sid = mintSessionId(tmuxSessId);
    const sess = model.sessions.get(sid);
    if (sess === undefined) continue;
    const activeWid = sess.activeWindowId;
    if (activeWid === null) continue;
    const win = model.windows.get(activeWid);
    if (win === undefined) continue;
    const activePid = win.activePaneId;
    if (activePid === null) continue;
    model = setFocus(model, { paneId: activePid, windowId: activeWid, sessionId: sid });
    focusSet = true;
    break;
  }
  if (!focusSet) {
    model = setFocus(model, { paneId: null, windowId: null, sessionId: null });
  }

  return model;
}
