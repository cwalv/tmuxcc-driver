# tmux state model and the adapter architecture

> Design analysis, 2026-06-10 (operator + triage session). Sections 1–5 are
> settled analysis. **Section 6 (requery-on-event) is ADOPTED (2026-06-10)**
> — the final reservation, performance of event→requery vs event→reducer,
> was resolved by the rate analysis in §5 (relevant event frequency is low
> and bursty; leading-edge coalescing bounds storms). Implementation: epic
> tc-128. Nothing in the pipeline implements §6 as of adoption.
>
> Related (design docs live in the tmuxcc project repo): `ux-design-v2.md` §4 (UX-normative decisions), tc-zna.3 (spatial
> model), tc-zna.9 (bind-on-provenance), tc-2x3 (process collapse), tc-x6l
> (metrics + storm alarm).
>
> **Extension-side state:** this doc covers tmux's own state model. The
> *extension's* mirror of it — the driver-owned-canonical-state rewrite (epic
> tc-295a) that collapsed ~28 ad-hoc slots into the **four-store topology
> (S1 SocketStore · S2 SessionConnection registry · S3 BindingStore ·
> S4 TerminalRenderer)** — is documented in the project design doc `ext-a-design-context.md` §6.10.
> The driver owns every fact; the extension owns only policy + rendering and
> never reconciles two channels against each other.
>
> **Host/secondary unification — IMPLEMENTED (tc-u7cu.5, Theme 4; shipped
> 2026-06-15).** The earlier model gave the *first* pane a privileged "host"
> role backed by a long-lived host pty (S2 wrapped that pty); every other pane
> was a "secondary" tab. That distinction is GONE: S2 owns connect/lifetime via
> an explicit `start()` seam (no host pty), and EVERY pane — first included —
> renders as an identical S4 tab. See the project design doc `ext-a-design-context.md` §6.9 (refinement)
> and §6.10 (S2). This is what made the unbind-tab-close (tc-f5gu) and
> attach-with-history scrollback (tc-xq3s) fixes uniform.
>
> **Profile application → driver (tc-gjdx + tc-u7cu.1, partial).** Extension A's
> profile-apply implementation (`src/profiles/apply.ts`) was removed (tc-u7cu.1,
> shipped 2026-06-15); the driver-owned application that replaces it (tc-gjdx) is
> NOT yet implemented, so profiles don't materialize layouts until it lands. See
> the project design doc `ux-design-v2.md` §9.1.

## 1. What this system is

A **stateful protocol adapter**: it puts a real API on tmux. tmux's control
mode (`-CC`) is not a queryable API — it is a notification stream plus
ad-hoc command replies — so presenting one requires *materializing the
state* (bootstrap + reducer) and serving the model. The closest category
neighbors are LSP servers and DAP debug adapters: a protocol-speaking
sidecar that makes a complex tool embeddable by N frontends.

The wire protocol the proxies serve is **currently unnamed** (naming open;
candidates discussed: name the *protocol* as the durable thing, LSP-style).
Historical note: some earlier notes called it "the EDH wire protocol" — a
misnomer. EDH = VS Code's *Extension Development Host* (the F5 dev window);
"live EDH testing" always meant manual testing there, never a protocol.

## 2. Two planes of tmux state

| | Topology plane (sessions/windows/panes/layout) | Content plane (terminal grids) |
|---|---|---|
| Query | `list-*`, `display-message -F` | `capture-pane` |
| Event feed | `%window-add`, `%layout-change`, … | `%output` stream, `%pause`/`%continue` |
| The fold | reducer over discrete events → model | VT interpretation (= being a terminal emulator) |
| Who folds | the session-proxy (reducer) | the embedder's terminal (xterm.js) — deliberately NOT the adapter |
| Event retention | none | none |
| State retention | current state only; **destructive fold** (closed window leaves no trace) | current grid + scrollback: **append-ish** (rolls off at `history-limit`; `ED 3`/`clear-history` truncate retroactively; alt-screen contributes nothing) |

Notable asymmetries:

- There is **no `%pane-add` notification**; new panes are discovered only
  via `%layout-change` (the pane ID appears in the layout string).
- Pane content resync is **baseline + tail**: snapshot (`capture-pane`) and
  stream (`%output`) are different representations (grid vs bytes), so
  overlap cannot be reconciled idempotently — double-applied bytes corrupt.
  tmux's own flow-control contract ("on `%continue`, capture-pane") encodes
  this. A content baseline can also be invalidated *retroactively* (`ED 3`),
  so "baseline + live tail, recapture on doubt" is the strongest guarantee
  the upstream admits — not a shortcut.

## 3. Retention and coherence

tmux is a **state-primary** system: state is the truth, events are ephemeral
side effects of mutation (the inverse of event sourcing). Consequences:

- **No event log exists.** Notifications exist only in flight to attached
  control clients. A gap is not just lost — it is *unobservable*: there is
  no offset, cursor, or "what did I miss since N" to ask.
- **Snapshot and stream are unordered relative to each other.** A `list-*`
  reply carries no sequence number tying it to a position in the
  notification stream; events may pre- or post-date the snapshot contents.
  Hence: idempotent reducer, bootstrap dedup, re-snapshot on any doubt
  (reattach, pause/continue, known event-vocabulary gaps such as tmux 3.4's
  `%window-add` without `%layout-change`).
- Queries answer "what is true now," never "what changed." `tmux ls` is a
  real query interface; what tmux lacks is a *consistent read model* —
  snapshot + ordered deltas from that snapshot.

The adapter converts "no retention upstream" into real guarantees
downstream **by holding the fold, not history**: it can mint a fresh,
transactional "snapshot + deltas from here" for any client at any moment,
with sequence numbers it controls, because it owns the emission side.
Late-joining clients get backfill from the replica, not from tmux.

## 4. Single-writer *reconciliation pricing* survives; the ownership claim does not

> Revised 2026-07-02 (tc-4b6k O4 withdrawal / D3, `ownership-seams-decisions.md`
> §2). The original premise below — "multi-client is rare-to-never, so a fact
> can have one shared slot" — is **withdrawn** as an ownership claim. Shared-vs-
> per-client coherence is now a design *requirement*: a fact that differs per
> client (binding intent, D3; per-client size, D4) must carry a client-identity
> axis, and a per-client fact in a single shared slot is an illegal state made
> unrepresentable, not a rarity to tolerate. What survives is the *reconciliation
> pricing* argument: the machinery that serializes writers and requeries on
> invalidation is still justified by persistence, whether writers are one client
> or several. Concretely (D3, tc-4b6k.2): binding intent is stored per
> (pane, client-identity) in `@tmuxcc-bound-<key>` user-options and served as a
> per-client-resolved `pane.bound`; two windows can no longer diverge on one
> pane's bound state (seam S1 dissolved) because each writes its own slot. The
> geometry/layout carve-out stands: per-client geometry facilities are deferred,
> not spec'd now.

Product goal (see `ux-design-v2.md` §4.1, in the tmuxcc project design docs): native terminal UX for VS Code
users. Even with multi-client now a first-class concern, in the common case
**the only actor mutating tmux topology is the same VS Code user, through
tmuxcc's own verbs** — which are request-scoped and self-correlated. A native
VS Code terminal is single-plane, single-authority; the topology plane is
*imported* by tmux integration, and its external mutations are rare. The
reconciliation machinery is the price of admission for the one thing tmux
adds: persistence.

The irreducible exception: **pane death**. The programs inside panes are a
second writer — the user types `exit` and expects the tab to react now. The
content plane structurally cannot signal it (a stream going silent is not an
event). Death (pane/window close) is the one common, immediacy-critical
external topology event.

Caution for any design leaning on event/content correlation: "topology
changed ⇒ content moved" is a strong tendency, **not a guarantee** (silent
panes ignore SIGWINCH; `split-window -d` can spawn output-free panes;
scripted renames). Use the correlation opportunistically, never load-bearing.

## 5. Event-rate structure

Legitimate topology-event traffic is **bursty**: interactive resize
(`%layout-change` streams during drags), title churn (`automatic-rename`
tracking foreground processes), automation fan-outs (agents spawning panes
at machine speed — a target workload, not pathology). Sustained high rate is
near-certainly a bug (cf. the tc-3y8.8 reattach storm: ~8000 notif/s,
flatline). Discriminator: rate over a sliding window. This motivates the
runtime counters + storm alarm (tc-x6l) regardless of pipeline architecture.

## 6. PROPOSED: requery-on-event ("events as invalidation")

Status: **adopted, 2026-06-10** (decision record: tc-5ym; implementation:
epic tc-128 — engine+diff, coalescer, output buffering, reducer
retirement). Lands before tc-2x3 stage 2: shrink the reducer first, then
relocate less code.

Demote every topology notification to a dirty bit; never interpret event
content. On dirty: requery (`list-windows` + `list-panes`, ~0.5ms
round-trip), diff against the previous model, emit deltas from the diff.

- **Coalescing: 1 Hz ceiling, leading edge.** First event after quiet
  requeries immediately (rare events almost always land on quiet → instant
  service); follow-ups within the window fold into the trailing edge.
  Steady state costs zero (vs polling); storms are bounded to 1 requery/s
  regardless of input rate — and rendering the middle of a storm at 1 fps
  is a feature.
- **Sync points** carry the rest: query on attach/restore, query-after-own-
  verb (request-scoped; not stream-dependent), slow unconditional heartbeat
  (self-healing against silent panes and any future event-vocabulary gap),
  side-panel refresh on focus.
- **What it eliminates**: the event-interpretation bug class wholesale —
  every reducer bug of tc-3y8 (window-add attribution, unlinked-window
  phantoms, the 3.4 layout-change gap, multi-line gluing) is structurally
  impossible when event content is never trusted. Bootstrap, reconnect, and
  steady state become one code path.
- **Costs**: narration between samples is lost (transients invisible —
  acceptable for mirroring; stable IDs keep diffs correct across
  reparenting); topology/content stream-order coherence weakens (output for
  a not-yet-known pane must buffer briefly — machinery that already exists
  for bootstrap races).
- **Interaction with binding policy**: bind-on-provenance (tc-zna.9) is the
  keystone that makes a slow topology plane viable — foreign-pane discovery
  degrades to a detached side-panel node (staleness-tolerant), own verbs
  self-correlate, geometry is VS Code-authoritative (tc-zna.3). Only death
  needs eventful immediacy, and it rides the same leading edge.

Summary of the stance: **consult the authority at well-defined moments;
don't shadow its every move.** The git model, not the filesystem-watcher
model.

## 7. Reattach fidelity: scroll-on-clear off + structured grid reconstruction (tc-w3ir)

**Status: implemented 2026-06-29. Root-cause RCA: tc-kyq4.5.**

### The problem

Two independent factors combined to produce the "orphan" duplicate prompt on
detach → attach:

1. **scroll-on-clear (default on).** tmux's `scroll-on-clear` window option
   (`screen_write_clearscreen` in `screen-write.c`) scrolls cleared-screen
   content into scrollback so an attached tmux client can scroll up after
   `clear`. The driver's clients are **remote renderers** (xterm.js) that
   self-manage their own scrollback from the live `%output` stream and discard
   on clear — they never benefit from this preservation. The phantom lives only
   in tmux's grid and surfaces when `capture-pane -S -` resurrects it on
   reattach.

2. **Flat byte-stream replay + trim heuristic.** `_deliverReplay` (hydration.ts)
   previously sent `CLEAR_AND_SCROLLBACK` + the full captured body with trailing
   blank lines trimmed (`trimTrailingBlankLines`). The flat list discarded the
   grid's structure — the scrollback/screen boundary (`history_size`) and the
   cursor cell (`cursor_x`/`cursor_y`) — and the trim compensated only for a
   fresh no-scrollback pane, breaking the has-scrollback short-screen case
   (scrollback landed in the viewport as the "orphan").

### Fix A — scroll-on-clear off (tc-w3ir.1)

`setGlobalScrollOnClear(socketName, false)` is called inside `createSession()`
in `packages/driver/src/tmux-south.ts`, right after `new-session` succeeds.
It issues `set-option -wg scroll-on-clear off` as a server-global window option
on the dedicated tmux socket. Every managed pane inherits it; cleared-screen
content is not scrolled into history.

Key design decisions:

- **Driver default, not a renderer mode.** `scroll-on-clear off` is correct for
  the entire proxied-renderer client model, not an xterm.js-specific quirk. A
  renderer-profile seam is deferred until a genuinely renderer-specific setting
  appears (then scroll-on-clear would fold into the default renderer profile).
- **Server-global** (`-wg`) on the dedicated socket. The dedicated socket only
  ever hosts tmuxcc sessions, so a server-global is appropriate — no risk of
  clobbering unrelated user sessions.
- **Non-fatal on failure**: a too-old tmux build keeps the default-on behavior;
  the session still works.
- **Belt-and-suspenders at the attach seam** (tc-w3ir.5, P3) — setting
  scroll-on-clear off again at `attachToSession` time — is not yet implemented.

### Fix B — structured grid reconstruction (tc-w3ir.2)

`_deliverReplay` (hydration.ts) now reconstructs tmux's grid from tmux's own
data rather than relying on a flat byte stream + trim:

1. Read grid facts in a `display-message` round-trip:
   `#{cursor_x},#{cursor_y},#{history_size},#{pane_height}` (see
   `PANE_GRID_FACTS_FORMAT` / `displayMessagePane` in
   `packages/driver/src/parser/commands.ts`).
2. Deliver `CLEAR_AND_SCROLLBACK` + `lfToCrlf(stripOneTrailingLf(captureBody))`
   + `ESC[<cursor_y+1>;<cursor_x+1>H` (CUP cursor restore, 1-based).
3. Writing the full captured grid (`history_size` + `pane_height` rows) into an
   xterm viewport of `pane_height` rows scrolls the `history_size` leading rows
   into xterm's scrollback region and leaves the screen filling the viewport.
4. `trimTrailingBlankLines` is **deleted**. The fresh no-scrollback pane is
   top-anchored via the cursor escape (which subsumes the trim for every case).

### Capture gate: pipeline correlator %end — not shell-settled

Capture ordering is gated on the **pipeline correlator's `%end`** for each
command. `capture-pane` and `display-message` are issued via `pipeline.send`,
which resolves each command's promise when the correlator receives the matching
`%end` on the control connection. Because tmux's control connection is
FIFO-ordered, `%end` arrival confirms the command completed and the grid was
consistent at that moment.

**"Shell settled" is deliberately NOT waited on.** Shell redraw after SIGWINCH is
async and unbounded; there is no reliable signal for "the shell has finished
redrawing." The driver captures a coherent tmux-grid snapshot (as of `%end`);
the shell's SIGWINCH redraw converges via the live `%output` stream after the
client attaches.

### Current fidelity: same-size vs. different-size reattach

- **Same-size reattach**: fully faithful. The reconstructed grid is identical to
  tmux's view: scrollback above the fold, screen in the viewport, cursor at its
  true cell.
- **Different-size reattach**: the capture runs at the current (captured) pane
  size. The client's live `resize.request` (arriving async after attach, driven
  by VS Code's `Pseudoterminal.setDimensions`) then reflows tmux and the client
  converges via the live `%output` stream. No orphan; convergence is via the
  existing hydration-queue path.

**Future work (tc-w3ir.6):** thread the attach-time client viewport dimensions
(`extension → supervisor → addClient → hydration`) so a different-size reattach
can `refresh-client -C <w>x<h>` and gate the capture on the resulting `%end`,
yielding a single-pass reflowed reconstruction. Currently `addClient` takes no
size parameter; the client's dimensions arrive async via `resize.request` after
attach, so the resize-gate is not achievable in `hydration.ts` alone.

---

## §8 — Size partition and the client-flags model (D4, tc-4b6k.3)

### Problem: multi-client viewport flap

Each `session.attach` connection can issue `resize.request` → the driver issues
`refresh-client -C <W>x<H>` on the single tmux -CC client. When two VS Code
windows share the same session (different viewport sizes), both connections send
`resize.request` and the two calls race, flapping the tmux viewport between the
two window sizes. Every flap triggers a `%layout-change`, a diff, and a
`layout.updated` wire blast to all clients — a thundering-herd of size noise.

### Solution: owner/non-owner size partition

`session.attach` carries `flags?: ClientFlags` (`ignoreSize`, `readOnly`). The
session-proxy (D4, tc-4b6k.3) enforces two gates in its `transport.onControl`
handler, before messages reach `input-path.ts`:

- **ignoreSize gate**: `ignoreSize` (and `readOnly`, which implies it) makes a
  connection a size NON-CANDIDATE — it can never drive `refresh-client -C`. Among
  the remaining CANDIDATES the size owner is elected by ACTIVITY, not by a static
  flag (the `SizeOwnershipPolicy`, `runtime/size-ownership.ts`, tc-76m8.3):
  ownership follows the most-recently-active candidate, debounced on
  owner-silence, first-candidate-owns, immediate handoff on owner departure. A
  `resize.request` from a non-owner — a non-candidate, or a candidate that is not
  the current owner — is silently dropped. Candidacy is refcounted per client
  identity (tc-51oo): a window's several same-identity connections share one
  candidacy slot, so closing one (a pane-scoped aux, or a reconnect overlap) never
  strips a still-connected candidate's candidacy.
- **readOnly gate**: if `flags.readOnly === true`, `input` messages are silently
  dropped and mutating `command.request` verbs are rejected with
  `{ ok: false, code: "read-only" }`. Read-only queries (`pane.capture`,
  `session-proxy.info`) are served normally.

`ClientFlags` is stored on `ClientState` in `serve.ts` and surfaced in the
`session-proxy.info` → `clients[].flags` field for observability.

### Extension policy (tc-51oo)

Ordinary VS Code windows attach as size CANDIDATES (no size flags) and let the
driver's activity policy elect the owner — the extension no longer pre-decides
ownership from the `session.claim` `created` bit. A connection carries flags only
where "never drives size" is semantically true of it: read-only observers,
auxiliary pane-scoped connections, and the anonymous SDK reader (driver-admin),
which all pass `ignoreSize`.

| Path (`server-proxy-connect.ts`, unless noted) | flags sent | size role |
|---|---|---|
| `connectServerProxyAndClaim` (claim/join) | `{ pullHydration }` | candidate |
| `connectServerProxyAndClaim` (read-only observe) | `{ ignoreSize, readOnly, pullHydration }` | observer |
| `connectServerProxyAndAttachSession` (silent reattach) | none | candidate |
| `connectServerProxyAndAttachSession` (read-only observe) | `{ ignoreSize, readOnly }` | observer |
| `connectServerProxyAndCreateUnique` (mints a fresh session) | none | candidate (first → owner) |
| `connectServerProxyAndAttachPane` (auxiliary pane-scoped) | `{ ignoreSize, pullHydration }` | non-candidate |
| driver-admin `fetchSessionProxyInfo` (`driver-admin/src/info.ts`) | `{ ignoreSize }` | non-candidate |

`created` no longer affects the flags a claim connection sends — creator and
joiner both attach as candidates and the driver arbitrates by activity (the
`created` bit still gates create-time-only template application, unrelated to
size). The pane-scoped connection stays a non-candidate on SEMANTIC grounds — an
auxiliary pane-targeted connection is not its window's geometry driver, the main
session connection is; refcounted candidacy (not this flag) is what keeps closing
the aux from stripping the window's candidacy.

> Pre-existing pullHydration inconsistency (NOT a size concern, unchanged here):
> `connectServerProxyAndAttachSession` and `connectServerProxyAndCreateUnique` do
> not declare `pullHydration`, contra the tc-76m8.28 "every extension data
> connection declares pullHydration" convention — the driver falls back to its
> push-replay for them (degraded, never worse). Tracked separately; left as-is so
> this size-candidacy change does not perturb hydration behavior.

### Future-facility seam: multi-client arbitration modes

The shipped policy is the **activity-elected owner** (D4 mechanism + tc-76m8.3
policy, refcounted candidacy tc-51oo, described above). The `ClientFlags` wire
slot and the driver gates are also the _infrastructure_ for richer arbitration
modes that remain reserved (operator carve-out, not yet implemented):

1. **Minimum-size** (tmux default): smallest viewport among all attached clients.
   Currently bypassed by the control-mode single-client architecture.
2. **Manual / owner-pin**: an operator-chosen client holds size regardless of
   activity (an explicit "hold ownership" escape hatch above the activity policy).
3. **Latest-sender** (S3, deleted): last `resize.request` wins regardless of
   source — the pre-D4 behavior, now gated out for non-owners.

Owner-transfer across reconnects is no longer TBD: a reattaching window attaches
as a candidate and — when it is the sole/most-recently-active candidate — owns via
the activity policy (first-candidate-owns on an ownerless session, or handoff
after owner-silence between windows). No `session.claim-ownership` verb is needed.

## 9. Canonicality: the reply-row codec (tc-mysc)

§6's requery rebuilds the model from scratch every cycle out of two
tab-separated tmux replies. A tmux-canonical field that is missing from the
format is silently rebuilt from a hardcoded literal, and `diffModel` then emits
a delta CLOBBERING any correct value that arrived by another path — this is the
tc-pqb4 class (`synchronize-panes`/`monitor-*` were omitted from the format and
hardcoded, so every topology requery undid the optimistic toggle).

**Design (Design A): the format is derived from a typed schema, not hand-kept.**
Each reply kind is declared ONCE as a field map — `WINDOWS_ROW` / `PANES_ROW`
(`state/bootstrap.ts`), built on the generic codec in `state/reply-row.ts`. The
tmux format string, the strict parser, the row type, and the test fixture
builder are all DERIVED from that one declaration. Adding a canonical field is a
single edit; it is *unrepresentable* for the format and the parser to disagree,
for a row field to be untyped, or for a fixture to be missing a column. The
schema-derived round-trip property test covers a new field the day it is
declared — it is the test that would have caught tc-pqb4 at introduction. Eight
dead format fields (`window_width/height/flags`, `pane_index/top/left/pid/
current_command`) were parsed-and-dropped every cycle and are deleted; re-adding
any is a one-line schema edit.

The parse is STRICT and fail-loud: a wrong field count throws `ReplyShapeError`,
a bad field throws `FieldDecodeError`. This replaces both the old
`parts[i] ?? default` fallbacks and the `isNaN(width|height)` row-validity gate.
It strips only a trailing `\r` — never `trim()`, which used to eat the empty
trailing option columns of a live pane row and manufacture the very short row it
then defended against.

### The five load-bearing amendments (verified against tmux 3.4)

1. **Escalation routing.** A steady-state `ReplyShapeError` is DETERMINISTIC
   (format and parser are one artifact — the same reply re-parses identically),
   so the coalescer's absorb-and-retry path would serve a stale model forever at
   ~1 Hz. Reply-codec errors extend `ReplyCodecError`; the coalescer routes them
   to `onFatalError` (the per-session error boundary, tc-2x3.4) and does NOT
   retry — the same loud channel as a dispatch exception. Tested end-to-end in
   `coalescer.test.ts` ("ReplyCodecError is fatal, not retried").
2. **Sanitization target = user options, not names.** tmux ESCAPES a tab in a
   window/session NAME to a 2-char `\t` (never a raw tab → no shatter), but
   stores/emits RAW tabs in USER OPTIONS (`@tmuxcc_label`, `@tmuxcc-icon`) — the
   actual shipped injection vector. Those fields are read through
   `tabSanitized(...)` = an in-tmux `#{s/<TAB>/ /:var}`; names are read plain.
3. **Literal-TAB pin.** The `s///` pattern is a real 0x09 byte
   (`SANITIZE_TAB_PATTERN`), NOT the two-char `\t` — verified live, a two-char
   pattern matches the LETTER `t` and leaves tabs intact. Pinned by a unit
   assertion on the derived format AND a Layer-A test that a real `@tmuxcc_label`
   containing a tab and 't's round-trips tab→space only.
4. **Newline policy.** tmux emits an embedded newline RAW in both names and user
   options; no read-side modifier removes it (`#{q:}` over-escapes names and is a
   no-op on user options; POSIX `[[:...:]]` classes collide with the `:`
   modifier terminator → empty output). Policy: names are BOUNDED-THROW — a
   newline in a name is pathological (automatic-rename and normal renames never
   produce one) and the strict parser surfaces it loudly (routed to the boundary)
   rather than misparsing. For user options — the driver is the sole writer — the
   durable fix is write-point sanitization; the read-side `s///` closes the tab
   vector as defense-in-depth. Pinned by the Layer-A test.
5. **`paneTitle` non-optional once format-backed.** When `paneTitle` becomes
   format-backed (child bead), its projection defined→absent diff-guard
   (`projection.ts`) and the tests codifying it MUST be deleted — a silent guard
   for a state the schema makes unrepresentable is exactly the class this design
   removes. (Recorded here; enacted by the paneTitle child.)

### Canonical vs overlay (deferred to a child bead)

The second half of the tc-pqb4 class — the hardcoded literal at construction —
is closed by typing the model by provenance: canonical fields are a mechanical
`Pick` of the row (a hardcoded literal for a listed field becomes unwritable),
and client-local state (`boundClients`, the ownership-seams overlay) is carried
forward wholesale, not per-field. `mode` (`#{pane_mode}`) and `paneTitle`
(`#{pane_title}`) join the pane schema. These land in follow-on children of
tc-mysc; the codec bead lands the schema/codec, strict parse, escalation
routing, sanitizer, and the single fixture builder.
