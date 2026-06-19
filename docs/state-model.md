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

## 4. The common case is single-writer

Product goal (see `ux-design-v2.md` §4.1, in the tmuxcc project design docs): native terminal UX for VS Code
users. Multi-client simultaneous attachment is expected to be rare-to-never.
Therefore in the common case **the only actor mutating tmux topology is the
same VS Code user, through tmuxcc's own verbs** — which are request-scoped
and self-correlated. A native VS Code terminal is single-plane,
single-authority; the topology plane is *imported* by tmux integration, and
its external mutations are rare. The reconciliation machinery is the price
of admission for the one thing tmux adds: persistence.

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
