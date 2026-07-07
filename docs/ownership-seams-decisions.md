# Ownership & boundary decisions — architecture review tc-4b6k

> Ratified design record, 2026-07-01 (Fable-5 review session, bead tc-4b6k).
> Companion to the tmuxcc project repo's `docs/ownership-seams.md` (the descriptive map;
> its §1–§8 taxonomy is adopted as-is) and to the driver's
> [`state-model.md`](./state-model.md). Every finding below cites first-hand file/symbol
> evidence read during this review and names the design principle it rests on
> (Ousterhout *A Philosophy of Software Design*; FP-in-Rust principles — see
> `projects/foundations/docs/agent-persona/`).
>
> Product-goal input (operator, 2026-07-01, supersedes the premise in driver
> `state-model.md` §4): **"multi-client is supported-but-incidental and must
> not drive design" no longer stands.** For multi-client to be usable at all
> there must be a coherent story separating *shared* state from *per-client*
> state. The one place the old stance still applies is **geometry/layout
> management**: leave room for per-client geometry state later; do not spec it
> now.

## 0. TL;DR — the decisions

| # | Decision | One-line rationale |
|---|----------|--------------------|
| D1 | Every canonical fact gets an explicit **shared vs per-client** classification; per-client facts require a client identity axis | A per-client fact in a single shared slot is an illegal state made representable (FP: ADTs; seams doc Axis 1) |
| D2 | **Client identity enters the protocol** (durable identity presented at handshake) | The enabler for every per-client fact; today the wire has no notion of *which* client is connected |
| D3 | **Binding (B/C): promote cardinality** — `@tmuxcc-bound` becomes per-client; the driver serves `pane.bound` per requesting client | S1 divergence is unrepresentable-state fallout; bind-on-provenance is a guard, not a model |
| D4 | **Size (E/F): partition now, expressed as client flags** — non-owning clients attach with tmux-parity passive flags (`ignore-size`-equivalent) so only the owner drives size; arbitration modes are a *future* facility, not spec'd | Operator direction; kills the flap via general vocabulary (D8), not an owner-gate special case |
| D5 | **Collapse the wire, not the module** — one broker socket, per-(client,session) connections bound by a `session.attach` step; per-session sockets and their lifecycle machinery are deleted. Merge the two runtime packages into one driver package; extract the wire library into `@tmuxcc/protocol` | The per-session *socket* is the vestige of the pre-tc-2x3 process boundary; the in-process module boundary itself is sound |
| D6 | **Stay one process; de-block the south side** — replace the broker's `spawnSync` shell-outs with async equivalents; re-measure event-loop lag before considering worker isolation | The one *measured-mechanism* contention source found is self-inflicted synchronous I/O, removable in TS |
| D7 | Pane↔terminal cardinality (the tmuxcc-vscode repo's `docs/ext-a-design-context.md` "Default 1:1"): **1:1 per (pane, client)** | Capability per client; auto-bind policy (provenance) unchanged; mirroring stays a future opt-in |
| D8 | **Model fidelity (richness parity)** — the driver's model must not *erase* axes tmux natively has; the client axis becomes first-class protocol vocabulary even where the current client uses a subset | Operator direction (post-review addendum, 2026-07-01): "the driver should be as rich as tmux, even if we don't use it all in the current client" |
| D9 | **tmux capability model** — the driver probes the installed tmux's version/capabilities once, holds the result as canonical driver-owned state, and surfaces it through snapshot/info + handshake features; degradation centralizes there | D8's parity vocabulary is version-dependent; today the driver has *zero* tmux-version awareness and degrades per-call-site by swallowing failures |

O1–O4 answers: §2. Boundary verdict detail: §3. Code smells + design-it-twice:
§4. Feed for the Rust decision (tc-ni6f): §5. Follow-on beads: §6.

---

## 1. The corrected mechanical picture (first-hand)

Three findings from this review revise the map in `ownership-seams.md`. None
weaken its Axis-1/Axis-2 analysis — they sharpen where the fix must land.

### 1.1 There is no attach-mode decision (O1)

The full-vs-passive "decision" the seams doc set out to trace **does not exist
as a decision point**. The driver creates exactly two kinds of tmux client,
each with a *fixed* mode:

- **Session-proxy south-side client** — always FULL. One per **claimed**
  session per broker. `tmux-south.ts:268-269`: "flags include `control-mode`
  but NOT `no-output` or `ignore-size`. One per claimed session."
- **Watcher** — always PASSIVE (`-f no-output,ignore-size`,
  `tmux-south.ts:909`). One per **server-proxy process**, existing only to
  receive `%sessions-changed`. Its attach *target* is arbitrary: `rows[0]?.name`
  — the first session in `list-sessions` order (`tmux-south.ts:894-896`).

Non-claimed ("observed") sessions get **no tmux client at all** — their
topology comes from broker shell-outs (`listSessions`, `listSessionTopology`;
S1 lazy list, tc-i9aq.2). The seams doc's S2 reading ("windows attach passively
to sessions they observe") was a misinterpretation of the live evidence: the
two passive clients on `foundations-1670865d` were the two windows' *watchers*,
coincidentally parked on the list-order-first session.

**Principle**: this is a *consistency/obviousness* win to record — the system
is simpler than the observed behavior suggested. The bug class lives elsewhere
(§1.2).

### 1.2 Two full clients ⇒ the broker singleton was violated

Two FULL clients on one session means **two broker processes had each claimed
it** — the per-user-per-machine singleton (seams doc H) was broken at
observation time. First-hand mechanisms in `server-proxy-launcher.ts`:

- The check-then-act double-spawn race is documented and closed
  (`_ensureInFlight` single-flight, tc-jlyi.8; broker-side
  `_bindSocketAsOwner` bind-as-lock, tc-kyq4.1 — the loser backs off, never
  clobbers, `server-proxy.ts:785-817`).
- **Still open**: the stale-driver recycle (tc-7aqb.4/.5,
  `forceTeardownServerProxy`) SIGTERMs by pid and polls socket-gone with a 5 s
  "logged-soft" budget (`server-proxy-launcher.ts:930-976`). A hung-shutdown
  broker — the exact class tc-eqgp documents (`server.close()` waits for all
  connections to drain) — can outlive the budget while the replacement binds:
  two live brokers, two full clients. Installed-vsix + EDH have *different
  buildIds by construction* (`_computeBuildId`: dev = semver+`+dev.`+mtime), so
  the two-window dev setup exercised this recycle on alternating activations
  daily until tc-9im3's socket isolation.

**Consequence for the model**: S3's *tmux-level* flap (two clients on
`window-size latest`) is a symptom of the singleton violation, not of normal
multi-window operation. But fixing the singleton does not fix the seam — see
§1.3.

### 1.3 The driver deletes tmux's per-client size axis

Even in the correct one-broker topology, all N frontend windows funnel into
**one** tmux client identity: every window's `resize.request` maps to
`refresh-client -C WxH` on the session's single `-CC` client
(`input-path.ts:863-867`), unconditionally, regardless of which client
connection sent it. tmux natively *has* per-client size arbitration
(`window-size smallest|largest|latest`, per-client `refresh-client -C`,
session groups) — the 1-client proxy model bypasses all of it. The "desired
size" fact still has one slot fought over by N deciders; the flap merely moves
from tmux's latest-client rule to software last-writer-wins.

**Principle**: information leakage inverted — the adapter *hides too much*: it
erases a distinction (client identity) the upstream models natively and the
product now needs. This is the strongest evidence for D2: without client
identity on the wire, neither promote nor partition is even expressible.

---

## 2. Ownership decisions (O1–O4)

**O1 — answered** (§1.1–§1.2): no per-session attach-mode path exists; the
"passive observe" was watchers; two-full-clients was a broker-singleton
violation (double-spawn — closed; recycle takeover — residual, see bead in §6).

**O2 — per fact:**

- **Binding/render (B + C): PROMOTE CARDINALITY (D3).** `@tmuxcc-bound` is one
  scalar per pane (`state/bootstrap.ts` `TMUXCC_BOUND_OPTION`, "set-option -pt
  %N @tmuxcc-bound 1"), so "bound in window A, detached in window B" is
  canonically unrepresentable, and the truth escapes to per-window memory
  (`pane-bindings.ts` — an explicitly "PURE in-memory (bucket B)" registry)
  with no ordered wire to converge two windows (S1). Bind-on-provenance
  (tc-zna.9) is a *guard* against the missing axis, not a model. Fix: binding
  intent becomes a per-client fact — stored per (pane, client-identity) in
  tmux user-options, served per requesting client as `pane.bound` in that
  client's snapshot/deltas. The extension's C registry remains as live wiring
  state only; its durable shadow is canonical again. This restores "one fact,
  one owner, one ordered wire" (the tmuxcc-vscode repo's `docs/ext-a-design-context.md` §6.10) *by correcting the fact's
  cardinality instead of exempting it* — the seams doc's own observation that
  the PaneBindingRegistry row is the one store the principle does not cover.
  **Principle**: FP make-illegal-states-unrepresentable; Ousterhout define
  errors out of existence (the S1 divergence class ceases to exist rather than
  being reconciled).
- **Size/geometry (E + F): PARTITION NOW, AS CLIENT FLAGS (D4, mechanism
  amended by D8).** The partition is expressed in tmux's own vocabulary rather
  than as a driver special case: `session.attach` carries per-client flags
  mirroring tmux's client flags (`ignore-size`, `read-only`, …), and the
  driver's model holds a per-client size fact. Minimal semantics now: the
  owning client attaches full and its size drives `refresh-client -C`;
  non-owning clients attach `ignore-size` by extension policy and render
  read-only at the canonical size — behaviorally identical to the owner-gate,
  but the *mechanism* is general and the *policy* lives in the client, where
  tmux itself puts it (`attach -r` = `read-only,ignore-size`). Arbitration of
  multiple size-contributing clients (`window-size smallest|largest|latest`
  semantics driver-side, thin no-output size-carrier `-CC` clients, or session
  groups) is the recorded *future facility* — slots exist, nothing is built,
  per operator direction. **Principle**: Ousterhout general-purpose mechanism
  + special-purpose policy; the D8 fidelity rule decides *where* the
  generality lives (in the protocol vocabulary, not in a gate).

**O3 — Axis-2 write conflicts (extension-decided, tmux-persisted facts):**
resolved by the same two moves. Facts classified *per-client* (binding intent)
stop colliding because each client writes its own slot (D1+D3). Facts that
remain *shared* (`@tmuxcc-detach`, `@tmuxcc_label`/`-icon`, managed geometry)
keep last-writer-wins **deliberately** — they are user-visible object
properties where "most recent user action wins" is the correct semantic, the
same outcome tmux itself would give two `set-option` writers. No arbiter is
built. The write path stays the driver's `set-object-policy` verb (single
ordered wire per session), which serializes concurrent writers already.
**Principle**: define errors out of existence — concurrent rename is not an
error to referee; pull complexity downward only where a wrong outcome exists
(binding), not where any outcome is acceptable (labels).

### 2.1 The client axis — parity map (D8 addendum, 2026-07-01)

Post-review operator direction: the driver should be **as rich as tmux**, even
where the current client uses a subset. The review found the driver *erases*
tmux's client axis entirely (§1.3) — the axis tmux natively provides, verified
against tmux(1) in-tree (not observed behavior):

| tmux per-client capability | tmux mechanism | Driver-model slot (D8) |
|---|---|---|
| Per-client size | `refresh-client -C WxH`; `window-size latest\|largest\|smallest\|manual` arbitration | Per-client size fact on the D2 identity; owner-drives now, arbitration modes later |
| Passive/observer attach | client flags `ignore-size`, `no-output`, `read-only` (`attach -r` = `read-only,ignore-size`) — **but see the control-mode caveat below: `read-only` does not bind the `-CC` command channel** | Flags on `session.attach`; extension policy chooses per window; read-only *semantics* are driver-enforced, never delegated to tmux |
| Independent active pane | client flag `active-pane` | Future: per-client focus fact (today focus is a single model triple) |
| Output pacing | client flag `pause-after=seconds` (control mode) | Already partially internalized by driver flow-control; note only |
| Lifecycle behavior | client flags `no-detach-on-destroy`, `wait-exit` | Note only; revisit with detach policy |
| Per-member view of shared windows | session groups (`new-session -t`): shared windows, independent current-window + size | The heavyweight future option for full per-client geometry |

**Control-mode applicability (verified in source, 2026-07-01).** The driver
only ever attaches via `-CC`, so each capability was checked against the
control-mode path specifically:

- *Control-mode-specific by definition*: `no-output`, `pause-after`,
  `wait-exit` (man text: "in control mode"); `refresh-client -C` ("sets the
  width and height of a control mode client", tmux.1:1471).
- *Proven over `-CC` in tmuxcc's own history*: `ignore-size` (the watcher) and
  `window-size latest` arbitration across full `-CC` clients (the 74↔72 flap
  WAS two control clients).
- *Functional over `-CC`*: `active-pane` — `server_client_get_pane` resolves
  the per-client active pane for any client type (server-client.c:2752-2763);
  session groups are session-level, orthogonal to client type.
- *CAVEAT — `read-only` does NOT bind the control-mode command channel.*
  Enforcement points are keyboard/input paths (server-client.c key/mouse
  handling, key-bindings.c:697) plus `send-keys` (cmd-send-keys.c:171) and
  attach/switch/detach special cases; the `-CC` command dispatch
  (control.c:574 `cmd_parse_and_append`) has no readonly gate. A read-only
  control client is blocked from `send-keys` but can still run any other
  mutating command (`kill-session`, `split-window`, …). tmux's read-only is an
  input-authority concept, not a command-authority one. Consequence: the D4
  partition and any future observer tier are **driver-enforced**; the
  protocol may carry a `read-only` flag, but its semantics belong to the
  driver — never delegate them to tmux's flag. (This validates the original
  D4 instinct: the authority gate was always going to live in our layer.)

The rule going forward: when the driver narrows tmux (one `-CC` client
standing in for N frontend clients), the *model and protocol* must still carry
the axis, so widening later is an implementation change, not a protocol
change. **Principle**: information hiding is for *decisions likely to change*,
not for upstream capabilities — hiding tmux's client axis was overexposure's
inverse failure (a lossy abstraction), the thing the "real API on tmux"
category claim cannot afford.

**D9 — the version dimension (operator addendum, same session).** The parity
vocabulary is version-dependent (tmux CHANGES: `ignore-size` and the
`read-only`-flag mechanism, `active-pane`, `pause-after` each have distinct
introduction points), and the tree today has *no* driver↔tmux version seam at
all — verified: no `tmux -V` / `#{version}` probe anywhere in the driver; the
existing seams are wire `protocolVersion` (client↔driver, handshake-enforced)
and `buildId` (extension↔driver build, tc-7aqb). Driver↔tmux degradation is
per-call-site failure-swallowing ("tmux too old to know the option",
`tmux-south.ts:542`; scroll-on-clear "non-fatal on failure", tc-w3ir.1).
Decision: probe once per tmux server (version string + a version→capability
table maintained from the tmux reference repo's CHANGES — upstream's own
record), hold the result as canonical driver-owned state on the
`_tmuxAvailable` precedent (tc-295a.35), surface it in `server-proxy.info` /
snapshots, and derive version-gated protocol feature claims from it. Existing
swallow-sites migrate to consulting the capability state; a floor gate (below
minimum-supported tmux → the actionable-message path, like "tmuxcc requires
tmux") replaces silent partial function. **Principle**: define errors out of
existence at one locus instead of N scattered handlers (Ousterhout's
aggregate-the-error), and errors-as-values — capability absence is model
state, not an exception path.

*Verification note*: the tmux man page and the tmux source/CHANGES both live
in the workspace as a reference repo (`github/tmux/tmux`) — capability claims
in this doc are checked against that checkout, and the version→capability
table should be built and re-verified from it, not from memory.

**O4 — operator-decided (2026-07-01):** the incidental-multi-client premise is
withdrawn; shared-vs-per-client coherence is now a design requirement;
geometry/layout is the carve-out (facilities later, no spec now). Driver
`state-model.md` §4's "rare-to-never" premise must be revised when D2/D3 land
(the single-writer *reconciliation pricing* survives; the ownership claims do
not).

---

## 3. Boundary verdict (§2 of the review): collapse the wire, keep the module

**Verdict: the server-proxy ↔ session-proxy *module* boundary is sound and
stays; the per-session *socket* layer is post-collapse vestige and goes; the
*package* split is mis-factored and is re-cut.** (D5)

Evidence, first-hand:

1. **The in-process boundary is already a direct call.** `createSessionProxy`
   returns an object; `sessionProxy.addClient(transport)` takes a `Transport`
   (`session-proxy-supervisor.ts:815`). No IPC crosses the server-proxy ↔
   session-proxy seam. The supervisor (single-flight ensure, quarantine
   circuit-breaker) is a genuinely deep module and earns its interface.
2. **What still pays inter-process ceremony is the client path**: claim =
   connect broker socket → handshake → `session.claim` → *close* → connect
   per-session socket → second handshake (`server-proxy-connect.ts:152-189`) —
   while a *separate* persistent keepalive connection (tc-eqgp) sits idle
   carrying no commands. Every broker RPC pays a fresh connect+handshake+close.
3. **The per-session socket forces a class of accidental complexity.** Because
   per-session sockets rebind at fixed well-known paths across respawns, the
   supervisor carries `_socketPathRefCount`, ABA guards, and the
   `_closeServerFdOnly` rename-aside/close/rename-back dance
   (`session-proxy-supervisor.ts:378-412, 1013-1047`) — machinery accreted
   across tc-2x3.4, tc-2x3.6 GAP 1 and GAP 2 to guard races the design itself
   creates. **Red flag**: change amplification + conjoined methods; three
   generations of fixes defending one representational choice.
4. **The endpoint leaks deployment topology into the protocol.**
   `session.claim` returns a filesystem *path* the client must dial
   (`PROTOCOL.md` §1 "receives an `endpoint` string"). That is information
   leakage in Ousterhout's exact sense: both sides know where sockets live on
   disk.
5. **The mux already proves one socket suffices.** Control and data planes
   share one connection via the 0xCC magic byte (`socket-transport.ts` module
   doc; `PROTOCOL.md` §2). Session routing needs *zero* frame-format changes:
   keep one connection per (client, session) — preserving per-session kernel
   backpressure isolation (the tc-edf8 concern) — but land all connections on
   the one well-known broker socket and bind each to a session with a
   post-handshake `session.attach` step.

**Design-it-twice** (sketched alternatives compared):

- *(a) Status quo*: two sockets per claim, endpoint in protocol, socket
  lifecycle machinery. Interface cost: client dials dynamic paths; driver
  maintains rename-protect/refcount code.
- *(b) One socket, connection-per-(client,session)* — **chosen**: broker
  socket is the only endpoint; `session.claim` returns a `sessionId` (no
  endpoint); a connection sends `session.attach {sessionId}` after handshake
  and then IS that session's stream. Deletes: per-session socket paths +
  creation/teardown + GAP-1 machinery + the second handshake + the endpoint
  field. Keeps: per-session backpressure isolation, per-connection seq
  contract, quarantine, single-flight ensure.
- *(c) Full mux (all sessions over one connection)*: fewer fds, but couples
  backpressure across sessions — rejected on the tc-edf8 evidence (the
  `find /` firehose wedge must not stall sibling sessions' streams).

**Package re-cut** *(pre-tc-2x3 state)*: `@tmuxcc/server-proxy` imported its `Transport`, handshake,
and `WIRE_PROTOCOL_VERSION` *from* `@tmuxcc/session-proxy` — the session-proxy
package was a runtime **and** the de-facto protocol library. Re-cut along the
information boundary, not the dead process boundary: `@tmuxcc/protocol`
(types + handshake + framing, implementing `protocol/`'s schemas),
`@tmuxcc/driver` (broker + session runtime, one package), `@tmuxcc/client`.
**Principle**: decompose by information structure, not by execution history
(temporal decomposition is the red flag the current split exhibits).

**Event-loop / process model (D6)**: stay one process per machine. The
firehose-contention concern is real but the one *mechanism* found first-hand
is self-inflicted: the broker's entire south side is **synchronous
`spawnSync` shell-outs with 5 s timeouts on the shared loop**
(`tmux-south.ts` `listSessions` / `countPanesBySession` /
`countTmuxccClientsBySession` / `checkSessionPresence` / `setSessionMarker`),
driven by `_refreshSessions` on every `%sessions-changed`, every claim, every
info request (`server-proxy.ts:1204-1328, 1667, 1741`). Under churn each call
can stall *every* session's delta pipeline. Fix that (async spawn; or route
queries through the existing watcher `-CC` channel), then re-measure
`nodejs_eventloop_lag_seconds`; only escalate to worker-thread isolation (or
treat as a rewrite argument) if lag persists with the synchronous south side
gone. **Principle**: perf-RCA discipline — intervene on the measured
mechanism before re-architecting; pull complexity downward (the broker owns
its own blocking problem).

---

## 4. Code-smell findings (verified first-hand) + design-it-twice

Seed candidates from the bead comment, dispositioned, plus review finds:

| # | Finding | Evidence | Red flag / principle | Second design | Disposition |
|---|---------|----------|----------------------|---------------|-------------|
| S1 | Two-hop claim + throwaway handshake per broker RPC, while a dedicated keepalive connection idles | `server-proxy-connect.ts:152-189`; keepalive tc-eqgp `server-proxy-launcher.ts:1084-1146` | Pass-through ceremony; repetition | The keepalive **becomes** the client's broker connection: persistent, handshaken once, carries claims/destroys/info + `server-proxy.exiting` | Folded into D5 (bead §6.4) |
| S2 | Always-null `code`/`signal` kept "for wire/log compatibility"; sole consumer is a log line that can only print `code=null, signal=null` | `session-proxy-supervisor.ts:188-195`; consumer `server-proxy.ts:1190-1195` | FP: illegal states representable; comment admits the field is dead | Delete the fields; the crash log names the real cause (`host exit`) | Bead §6.7 (trivial) |
| S3 | God modules, extension side worse than driver: `extension.ts` 7,922 lines, `terminal-factory.ts` 5,918 (driver `server-proxy.ts` 2,036) | `wc -l`, this review | Conjoined responsibilities; cognitive load | Extension: extract verb/command registration and session-lifecycle orchestration from `extension.ts`; driver: extract the claim/activate state machine with phase-typed states (natural home for tc-is5w's histogram) | Beads §6.8/§6.9 |
| S4 | Synchronous south side on the shared event loop | §3 item D6 evidence | Pull complexity downward violated (broker exports its blocking to every session) | Async south side; watcher-channel queries | Bead §6.6 |
| S5 | Socket-lifecycle machinery (`_socketPathRefCount`, `_closeServerFdOnly`, ABA guards) | `session-proxy-supervisor.ts:378-412, 891-899, 1013-1047` | Change amplification: 3 fix-generations (tc-2x3.4, .6 GAP1, GAP2-adjacent) guarding a self-created race | Dissolves under D5(b) — session lifecycle no longer implies socket lifecycle. Quarantine + single-flight stay (cheap, justified) | Subsumed by bead §6.4 |
| S6 | Broker fuses metrics-HTTP toggling, window-option verbs (`setSynchronizePanes` etc. — synchronous shell-outs bypassing the session pipeline), self-exit policy, session table, claim path in one module | `server-proxy.ts:566-700` | Special-general mixture; shallow pass-through verbs | Window-option verbs move onto the session-proxy pipeline (they are session-scoped commands with an existing ordered wire — and the `%window-option-changed` round-trip already closes the loop); metrics-HTTP stays a separate module it already half-is | Bead §6.8; verbs part folded into §6.6 |
| S7 | Mutation authority ungated (seams doc G) — verified: every tree-menu `when` keys on node kind only (`viewItem == tmuxcc.session\|window\|pane.*`), handler resolves the clicked node's handle | `tmuxcc-vscode/package.json` menus; `extension.ts:2820` | Not a bug today (tmux-canonical facts converge; seams doc §3) | Under D1's taxonomy, add UI affordance distinguishing owned vs observed sessions before any destructive verb; policy-level, extension-only | Bead §6.10 (P3) |

Non-findings worth recording (claims-of-absence, fresh reads): the client SDK
(`clients/ts`: connection / mirror / pane-stream / input / render-hook) is
cleanly factored with a disciplined snapshot+delta+seq-gap contract
(`mirror.ts` module doc) — no action; the requery-on-event pipeline and its
correlator were not re-opened (shipped, tested, out of scope per the bead's
non-goals).

---

## 5. Feed for the Rust decision (tc-ni6f)

Classification of the §3/§4 baggage, per the coupled bead's axes:

- **TS/Node-incidental** (a rewrite *would* dissolve, but so would smaller TS
  fixes): the `spawnSync` blocking south side (Node API choice — async spawn
  fixes it in TS; Rust/tokio makes the class unexpressible); single-loop
  firehose coupling (structural in Node — worker isolation is awkward across
  `net.Server` handles; real parallelism is native in Rust); GC on the hot
  delta path (unmeasured as a symptom — do not weight it without evidence).
- **Design-incidental, language-neutral** (fix *before or regardless of* a
  rewrite — a rewrite that ports these ports the baggage): per-session sockets
  + lifecycle machinery, endpoint-in-protocol leakage, two-hop claim +
  per-RPC handshake, protocol-library tangled into a runtime package, absent
  client identity (D2). Every one of these is a *protocol/architecture* change
  that must be designed once in `protocol/` whichever language implements it.
- **Inherent to the domain** (ports either way at similar cost): the fold
  (bootstrap + requery + diff), correlator/tokenizer, flow control, reattach
  fidelity (tc-w3ir) — plus the timing-sensitive real-tmux test moat, whose
  portability is exactly tc-a88z's ledger.

**Sequencing implication**: the D2/D5 protocol work is a *prerequisite of both
futures* and shrinks the rewrite surface; doing it in TS first keeps the tests
green through the move (tc-a88z's promotion makes them re-usable against any
implementation). The Rust ADR should therefore weigh option (a)
refactor-in-TS as "do D1–D6, stop" vs option (b)/(c) as "do D1–D6, then port
behind the cleaned `protocol/` boundary" — not rewrite-from-here.

---

## 6. Follow-on implementation beads (children of tc-4b6k)

1. **Client identity in the protocol** (P1) — durable client/workspace
   identity presented at handshake; recorded in `protocol/`; prerequisite of
   2 and 3. (D2)
2. **Per-client binding intent** (P1, depends 1) — `@tmuxcc-bound` →
   per-client representation; driver serves `pane.bound` per client;
   extension renders canonically; revise `state-model.md` §4 premise;
   bind-on-provenance demoted from guard to default-policy. (D3)
3. **Owner-only size authority** (P1, depends 1) — driver gates
   `resize.request` by owning client; non-owners read-only; document the
   future per-client-geometry seam without building it. (D4)
4. **Single-socket wire collapse** (P1) — `session.attach` on the broker
   socket; delete per-session sockets, GAP-1 machinery, endpoint field,
   second handshake; keepalive becomes the persistent command connection;
   update `protocol/`, SDK, extension. (D5, S1, S5)
5. **Package re-cut** (P2, after/with 4) — `@tmuxcc/protocol` extraction;
   merge runtimes into `@tmuxcc/driver`. (D5)
6. **Async south side** (P2) — remove `spawnSync` from the broker loop;
   move window-option verbs onto the session pipeline; A/B
   `nodejs_eventloop_lag_seconds` before/after as the confirming
   intervention. (D6, S4, S6-part)
7. **Delete vestigial exit fields** (P2, trivial) — `SessionProxyExitInfo`
   `code`/`signal` and the "wire/log compatibility" framing. (S2)
8. **Driver claim-path extraction** (P3) — claim/activate state machine as
   its own module with phase-typed states; tc-is5w's home. (S3-driver)
9. **Extension module split** (P3) — carve `extension.ts` /
   `terminal-factory.ts`. (S3-ext)
10. **Owned-vs-observed UI affordance** (P3) — destructive verbs gated by
    D1 classification. (S7)
11. **Recycle-takeover fence** (P3, verify-class) — prove the stale-driver
    recycle cannot leave two live brokers past the 5 s soft budget, or fence
    it (drain-confirm before spawn). (§1.2 residual)
