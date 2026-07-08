/**
 * Schema-derived codec for tab-separated tmux command-reply rows (tc-mysc).
 *
 * @module state/reply-row
 *
 * # Why this exists
 *
 * The session-proxy's authoritative `SessionModel` is rebuilt from scratch on
 * every requery cycle out of two tab-separated tmux replies (`list-windows -F`
 * / `list-panes -F`). Historically three artifacts had to agree by hand for
 * every tmux-canonical field: the FORMAT string, the positional PARSER, and
 * the model CONSTRUCTION. Nothing coupled them, so a field that was canonical
 * in tmux but missing from the format was silently rebuilt from a hardcoded
 * literal every cycle — and the diff then emitted a delta CLOBBERING any
 * correct value that had arrived by another path (tc-pqb4).
 *
 * This module makes tmux-canonical fields derivable from ONE declaration. A
 * {@link ReplyRow} is defined once as a typed field map; the tmux format
 * string, the strict parser, the row TYPE, and the test fixture builder are
 * all DERIVED from it. Adding a canonical field is a single edit the compiler
 * propagates — it is unrepresentable for the format and the parser to disagree,
 * for a row field to be untyped, or for a fixture to be missing a column.
 *
 * # Fail-loud, not fail-soft
 *
 * The parse is STRICT. Because the format and the parser are the same artifact,
 * a field-count mismatch or a per-field decode failure is by definition a
 * driver bug (or an un-sanitizable injected control character), not routine
 * data variation — so it THROWS a {@link ReplyCodecError} rather than
 * defaulting. The strict count/decode replaces the old defensive
 * `parts[i] ?? default` fallbacks and the `isNaN(width|height)` row-validity
 * gate. Routing: a {@link ReplyCodecError} raised out of `engine.requery()` is
 * deterministic (the same reply re-parses the same way), so retrying it would
 * serve a stale model forever at ~1 Hz; the coalescer routes it to the session
 * error boundary instead of the transient-retry path (tc-mysc amendment 1).
 */

import type { PaneMode } from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Base class for every reply-codec failure. Distinguished from ordinary
 * `Error`s so the coalescer can route it to the FATAL/boundary path rather than
 * the transient-retry path: a codec error is deterministic (format and parser
 * are one artifact — the same reply re-parses identically), so retrying is
 * futile and would serve a stale model on an infinite loop (tc-mysc amendment
 * 1). See `state/coalescer.ts`.
 */
export class ReplyCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyCodecError";
  }
}

/**
 * A reply row split on TAB into the wrong number of fields. The format string
 * and the parser are derived from the same schema, so this can only mean a
 * driver bug or a raw control character that survived sanitization (a tab or
 * newline in an un-sanitized field shifts/splits columns). Fail-loud.
 */
export class ReplyShapeError extends ReplyCodecError {
  constructor(
    readonly replyName: string,
    readonly expectedFields: number,
    readonly actualFields: number,
    readonly line: string,
  ) {
    super(
      `${replyName}: reply row has ${actualFields} tab-separated field(s), ` +
        `expected ${expectedFields}: ${JSON.stringify(line)}`,
    );
    this.name = "ReplyShapeError";
  }
}

/** A single field's raw value could not be decoded by its codec. */
export class FieldDecodeError extends ReplyCodecError {
  constructor(
    readonly replyName: string,
    readonly field: string,
    readonly raw: string,
    readonly reason: string,
  ) {
    super(
      `${replyName}: field "${field}" failed to decode (${reason}): ` +
        `${JSON.stringify(raw)}`,
    );
    this.name = "FieldDecodeError";
  }
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

/**
 * Bidirectional codec for one field's wire representation.
 *
 * `decode` turns the raw tab-delimited substring into the typed value and
 * THROWS on an unexpected shape (the parse wraps the throw in a
 * {@link FieldDecodeError} with the field/reply context). `encode` is the
 * inverse, used by the fixture builder so test rows and the parser share one
 * definition of each field's wire form.
 */
export interface FieldCodec<T> {
  decode(raw: string): T;
  encode(value: T): string;
}

/** tmux sigil-prefixed numeric id (`$N` session, `@N` window, `%N` pane). */
export function sigilId(sigil: "$" | "@" | "%"): FieldCodec<number> {
  return {
    decode(raw) {
      if (!raw.startsWith(sigil) || !/^\d+$/.test(raw.slice(sigil.length))) {
        throw new Error(`expected ${sigil}<int>`);
      }
      return parseInt(raw.slice(sigil.length), 10);
    },
    encode(value) {
      return `${sigil}${value}`;
    },
  };
}

/** Verbatim text (no transform). */
export const text: FieldCodec<string> = {
  decode: (raw) => raw,
  encode: (value) => value,
};

/** Non-negative integer (`#{pane_width}`, `#{monitor-silence}`, …). */
export const int: FieldCodec<number> = {
  decode(raw) {
    if (!/^\d+$/.test(raw)) throw new Error("expected a non-negative integer");
    return parseInt(raw, 10);
  },
  encode: (value) => String(value),
};

/** tmux boolean rendered by `#{?cond,1,0}` — exactly "1" or "0". */
export const flag01: FieldCodec<boolean> = {
  decode(raw) {
    if (raw === "1") return true;
    if (raw === "0") return false;
    throw new Error('expected "1" or "0"');
  },
  encode: (value) => (value ? "1" : "0"),
};

/** Wrap a codec so an empty string decodes to `undefined` (option unset). */
export function emptyAsUndefined<T>(inner: FieldCodec<T>): FieldCodec<T | undefined> {
  return {
    decode: (raw) => (raw === "" ? undefined : inner.decode(raw)),
    encode: (value) => (value === undefined ? "" : inner.encode(value)),
  };
}

/**
 * A closed set of allowed keyword values, else `undefined`.
 *
 * Deliberately LENIENT (unknown/empty → `undefined`), unlike the strict scalar
 * codecs: these back OPEN user-option policy fields (e.g. `@tmuxcc-detach`)
 * whose value is not driver-guaranteed. An unrecognized policy legitimately
 * means "no policy / inherit default", not model corruption — the wrong regime
 * to fail-loud on. (This is NOT the tc-pqb4 class: that class was a CANONICAL
 * field silently rebuilt from a HARDCODED literal, which this schema makes
 * unrepresentable; a lenient open-option decode is a different thing.)
 */
export function optionalKeyword<const K extends string>(
  allowed: readonly K[],
): FieldCodec<K | undefined> {
  const set = new Set<string>(allowed);
  return {
    decode: (raw) => (set.has(raw) ? (raw as K) : undefined),
    encode: (value) => value ?? "",
  };
}

/**
 * tmux `#{pane_mode}` ⇄ the wire {@link PaneMode} (tc-mysc.3).
 *
 * `#{pane_mode}` reports the pane's active mode-table NAME: EMPTY for a normal
 * pane, `"copy-mode"` in copy-mode, and `"<x>-mode"` for the other window modes
 * (`"view-mode"`, `"tree-mode"` for choose-tree/-buffer/-client, `"options-mode"`
 * for customize-mode — all verified live, tmux 3.4). The two common states get a
 * friendly wire alias (`""` → `"normal"`, `"copy-mode"` → `"copy"`); every other
 * mode name passes through VERBATIM.
 *
 * The verbatim pass-through is deliberate: `PaneMode` is an OPEN string union
 * (`"normal" | "copy" | "view" | string`), and this bead does NOT invent a
 * normalization table for the long tail of tmux mode names (settling
 * `view-mode`/`tree-mode` against the wire literals is an open question — see
 * state-model.md §9). Consequently `"view-mode"` decodes to `"view-mode"`, NOT
 * the `"view"` wire literal — the alias set is intentionally just the two states
 * the model acts on today.
 *
 * `encode` is the exact inverse (`"normal"` → `""`, `"copy"` → `"copy-mode"`,
 * else verbatim) so a fixture row and the parser share one definition of the
 * wire form. Unlike {@link optionalKeyword}, this codec never fails: any string
 * is a legal mode name.
 */
export const paneMode: FieldCodec<PaneMode> = {
  decode(raw) {
    if (raw === "") return "normal";
    if (raw === "copy-mode") return "copy";
    return raw;
  },
  encode(value) {
    if (value === "normal") return "";
    if (value === "copy") return "copy-mode";
    return value;
  },
};

// ---------------------------------------------------------------------------
// Free-text sanitization (tc-mysc amendments 2 & 3)
// ---------------------------------------------------------------------------

/**
 * A LITERAL tab byte (0x09) — NOT the two-character escape `"\\t"`.
 *
 * tmux `#{s/pattern/replace/:var}` treats the pattern as a regular expression.
 * A two-char `\t` pattern does NOT match a tab in tmux's regex engine — it
 * matches the LETTER `t` — so it would corrupt every `t` in the value and leave
 * the tab untouched (verified live, tmux 3.4). The pattern MUST be a real 0x09
 * byte. This constant pins that; a regression test asserts the derived format
 * carries a real tab and not the two-char escape.
 */
export const SANITIZE_TAB_PATTERN = "\t";

/**
 * A tmux format reference for `varName` that maps every embedded TAB to a space
 * INSIDE tmux, before the value is emitted into the tab-separated reply row.
 *
 * This is the sanitizer for USER-OPTION text fields (`@tmuxcc_label`,
 * `@tmuxcc-icon`): unlike window/session NAMES — whose tabs tmux already
 * escapes to a 2-char `\t` — user options store and emit RAW tabs (verified
 * live, tmux 3.4), so a tab pasted into a pane rename would otherwise shift
 * every later column. `s///` is GLOBAL and preserves all other characters
 * (also verified). It does NOT cover newlines (no read-side tmux modifier does
 * — POSIX `[[:...:]]` classes collide with the `:` terminator; `#{q:}` is a
 * no-op on user options); user-option newlines are closed at the driver's
 * single write point. See the module header of `state/bootstrap.ts`.
 */
export function tabSanitized(varName: string): string {
  return `#{s/${SANITIZE_TAB_PATTERN}/ /:${varName}}`;
}

// ---------------------------------------------------------------------------
// Field spec + row schema
// ---------------------------------------------------------------------------

/**
 * One field of a reply row: its tmux format fragment, its codec, and a default
 * value for the fixture builder. Construct with {@link field}.
 */
export interface FieldSpec<T> {
  /** tmux `#{...}` format fragment for this column. */
  readonly fmt: string;
  /** Wire ⇄ value codec. */
  readonly codec: FieldCodec<T>;
  /** Default value emitted by the fixture builder when a test omits this field. */
  readonly fixture: T;
}

/** Declare one {@link FieldSpec}. `T` is inferred from `codec`/`fixture`. */
export function field<T>(fmt: string, codec: FieldCodec<T>, fixture: T): FieldSpec<T> {
  return { fmt, codec, fixture };
}

/** A reply-row schema: an ordered map from field name to {@link FieldSpec}. */
export type RowSchema = Record<string, FieldSpec<unknown>>;

/** The decoded row type derived from a schema `S`. */
export type RowOf<S extends RowSchema> = {
  readonly [K in keyof S]: S[K] extends FieldSpec<infer T> ? T : never;
};

/** The decoded row type of a compiled {@link ReplyRow} (e.g. `typeof PANES_ROW`). */
export type RowTypeOf<R> = R extends ReplyRow<infer S> ? RowOf<S> : never;

/**
 * A compiled reply-row schema. All of `format`, `parse`, and the fixture
 * builders are derived from the single schema passed to {@link defineReplyRow},
 * so they cannot drift apart.
 */
export interface ReplyRow<S extends RowSchema> {
  /** The tmux `-F` format string: field fragments joined with TAB. */
  readonly format: string;
  /** Ordered field names (schema declaration order). */
  readonly keys: readonly (keyof S & string)[];
  /**
   * Parse a reply body into typed rows. STRICT: splits lines on `\n`, strips a
   * single trailing `\r` (never `trim()` — a live pane row ends with empty
   * option fields that `trim()` would eat, manufacturing a short row), splits
   * on `\t`, and THROWS {@link ReplyShapeError} on a wrong field count or
   * {@link FieldDecodeError} on a per-field decode failure.
   */
  parse(body: Uint8Array): RowOf<S>[];
  /** Render one row (fixture defaults for omitted fields) — no trailing `\n`. */
  fixtureLine(over?: Partial<RowOf<S>>): string;
  /** Render a reply body from a list of rows (each `\n`-terminated). */
  fixtureBody(rows: readonly Partial<RowOf<S>>[]): string;
  /** The fully-populated fixture row object (fixture defaults + overrides). */
  fixtureRow(over?: Partial<RowOf<S>>): RowOf<S>;
}

interface ErasedField {
  readonly key: string;
  readonly fmt: string;
  readonly codec: FieldCodec<unknown>;
  readonly fixture: unknown;
}

const DEC = new TextDecoder();
const ENC = new TextEncoder();

/**
 * Compile a {@link ReplyRow} from a schema. The schema's declaration order is
 * the column order (JS preserves string-key insertion order).
 */
export function defineReplyRow<S extends RowSchema>(replyName: string, spec: S): ReplyRow<S> {
  const fields: ErasedField[] = Object.entries(spec).map(([key, s]) => ({
    key,
    fmt: s.fmt,
    codec: s.codec as FieldCodec<unknown>,
    fixture: s.fixture,
  }));
  const keys = fields.map((f) => f.key) as (keyof S & string)[];
  const expected = fields.length;
  const format = fields.map((f) => f.fmt).join("\t");

  function resolve(over: Partial<RowOf<S>> | undefined): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const f of fields) {
      row[f.key] =
        over !== undefined && Object.prototype.hasOwnProperty.call(over, f.key)
          ? (over as Record<string, unknown>)[f.key]
          : f.fixture;
    }
    return row;
  }

  return {
    format,
    keys,

    parse(body: Uint8Array): RowOf<S>[] {
      const rows: RowOf<S>[] = [];
      for (const rawLine of DEC.decode(body).split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") continue;
        const parts = line.split("\t");
        if (parts.length !== expected) {
          throw new ReplyShapeError(replyName, expected, parts.length, line);
        }
        const row: Record<string, unknown> = {};
        for (let i = 0; i < expected; i++) {
          const f = fields[i]!;
          const raw = parts[i]!;
          try {
            row[f.key] = f.codec.decode(raw);
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            throw new FieldDecodeError(replyName, f.key, raw, reason);
          }
        }
        rows.push(row as RowOf<S>);
      }
      return rows;
    },

    fixtureLine(over?: Partial<RowOf<S>>): string {
      const row = resolve(over);
      return fields.map((f) => f.codec.encode(row[f.key])).join("\t");
    },

    fixtureBody(rows: readonly Partial<RowOf<S>>[]): string {
      return rows.map((r) => this.fixtureLine(r) + "\n").join("");
    },

    fixtureRow(over?: Partial<RowOf<S>>): RowOf<S> {
      return resolve(over) as RowOf<S>;
    },
  };
}

/** Encode a fixture body to bytes (test convenience). */
export function fixtureBytes<S extends RowSchema>(
  row: ReplyRow<S>,
  rows: readonly Partial<RowOf<S>>[],
): Uint8Array {
  return ENC.encode(row.fixtureBody(rows));
}
