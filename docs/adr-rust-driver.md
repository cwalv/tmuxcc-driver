# ADR — Should the tmuxcc driver be rewritten in Rust? (tc-ni6f)

> Status: **Accepted** — operator ratified option (a) stay TS on 2026-07-02;
> the (b) reopen triggers T1/T2/T3 below stand. (tc-ni6f closed.)
> Amended 2026-07-02, post-ratification: the option-(b) cost analysis
> conflated moat accounting with porting difficulty — corrected in §1 and
> the (b) score (first-hand read of the flagged test surfaces; audit trail
> in tc-ni6f comments). The decision is unchanged.
> Date: 2026-07-02. Author: tc-ni6f IC (Fable-5), reviewing post-D1–D9 state.
> Inputs: [`ownership-seams-decisions.md`](./ownership-seams-decisions.md) §5 (baggage classification),
> [`test-portability-ledger.md`](./test-portability-ledger.md) (tc-a88z), the tc-4b6k.6
> A/B intervention data, the tc-4b6k.5 codegen outcome, tc-4b6k.11 fence
> analysis, [`perf.md`](./perf.md), and the operator's recorded lean
> (tc-ni6f comments, 2026-07-01).

## Decision being made

Whether the tmuxcc **driver** (the per-machine daemon: broker + in-process
session runtimes, now `@tmuxcc/driver` + `@tmuxcc/protocol`) should be
rewritten in Rust. Three options:

- **(a)** Stay TypeScript. D1–D9 are **shipped** — this option is the
  *current tree*, not a plan.
- **(b)** Full Rust rewrite behind the `protocol/` boundary; client SDK and
  hosts stay TS (that is what the boundary buys).
- **(c)** Hybrid — Rust the hot/typed core (parser + reducer/fold) behind
  FFI or a subprocess; supervisor/socket glue stays TS.

**Recommendation: (a), with named triggers for reopening (b). (c) is
rejected as dominated.** Rationale below; the operator makes the final call.

## What changed since the question was posed

The question was framed (and the operator's rewrite lean recorded) *before*
the D1–D9 epic ran. The epic converted four load-bearing hypotheticals into
evidence, and each one moved:

### 1. Rewrite risk is now quantified — and larger than the lean assumed

The lean's premise #1: "the correctness moat is the test suite, not the TS
impl; if the value lives in tests, rewrite risk drops sharply." tc-a88z
audited that claim ([`test-portability-ledger.md`](./test-portability-ledger.md)):

- **0 of 78** test files are fully black-box; every file needs at least
  setup re-authoring.
- **~65%** of real-tmux behavioral *cases* have wire-observable assertions
  that would re-validate any conforming implementation — a genuine moat.
- **~35%** are irreducibly white-box, *including both crown-jewel
  bug-catchers*: topology-canary C1 (tc-e3m — corrupts the committed model
  without emitting a wrong delta; invisible at the wire by construction) and
  flow-load F1–F6 (tc-55t — `fc.noteDrained` is a control input with no
  wire equivalent). These encode real production bugs caught only there.
- The entire white-box unit layer (~75% of ~450 cases: parser, state
  machine, wire codec) tests the TS implementation, not the protocol.
- Parity re-authoring estimate: **6–9 weeks** — *tests only*, assuming an
  engineer already familiar with the finished Rust implementation. The
  implementation itself is additional and unestimated.

So "rewrite risk drops sharply" is now "moderate-but-real risk on a 6–9
week test-reconstruction floor." The moat is genuine but narrower than the
lean priced in.

**Correction (2026-07-02, first-hand read of the flagged surfaces):**
"irreducible" is moat accounting — these cases cannot re-validate a new
implementation *unmodified* — not a measure of porting difficulty. The
"internal control surfaces" are production API, not test scaffolding:
`noteDrained` is the real drain path (the session proxy credits it on
transport write-completion), `isPanePaused`/`bufferedBytes` sit on the
`FlowController` interface and feed the shipped metrics registry, and
`pipeline.getModel()` is the read path every client snapshot is projected
from. Any conforming daemon must expose the same surfaces for its own
production needs, and Rust's in-module `#[cfg(test)]` idiom gives tests
private access with zero API pollution — the ledger's "design-first
testability surface" concern imports a TS-ism, where test access means
exporting. Re-authoring these tests is therefore proportional to writing
the components themselves. Two genuine residues: (1) **interleaving
determinism** — the canary drives a requery-racing-flow-control schedule
that single-threaded Node reproduces trivially; a Rust design preserves it
iff per-session state stays owned by one task (the design the fold model
implies anyway); (2) the canary's bug class — a slot-less write corrupting
the committed model — is partly what Rust's ownership and exhaustive
matching exclude by construction, so its port may land as a redundancy
check rather than a load-bearing guard.

### 2. The event-loop-contention argument for Rust was measured and fixed in TS

The frame's guardrail — "do not import 'Rust for latency' without the
tc-4b6k.6 A/B intervention data" — is now satisfied, and the data cuts
against the Rust pro. The one contention mechanism ever measured
first-hand was the broker's synchronous `spawnSync` south side. D6 fixed it
in TS (async spawn + single-flight refresh coalescing) and the confirming
A/B under a 4-session real-tmux firehose moved the curve in exactly the
mechanism's signature:

| event-loop lag | before | after |
|---|---|---|
| p99 | ~100–142 ms | ~13 ms |
| max | ~287–314 ms | ~14 ms |
| p50 | ~10 ms | ~10 ms (instrument/occupancy floor) |

`server-proxy.info` RTT p99 ~217→~72 ms. The .6 close-out records the
verdict explicitly: *"worker isolation / the Rust argument gets no
additional weight from THIS mechanism."* No other contention mechanism has
been measured. GC-on-hot-path remains **unmeasured** and per the review
guardrail carries no weight. [`perf.md`](./perf.md) shows the hot path at ~205 MB/s
sustained against a realistic 1–5 MB/s firehose — 40–200× headroom, no
per-byte allocation.

### 3. "Generated boundary de-risks the rewrite" is empirically softer

The strongest structural de-risking claim — flip codegen direction so both
ends are *generated* from `protocol/` schemas and drift becomes structurally
impossible — was attempted in tc-4b6k.5 and the **fallback was taken**
(hand-written-validated). Real friction, not preference: the custom
`tmuxcc:` URI scheme needs a non-standard resolver, and the TS-only union
types (`WireCommand`, `ClientMessage`, `SessionProxyMessage`) have no
schema counterpart — they would be post-generation hand additions anyway.
JSON-Schema→Rust (typify-class tooling) handles a *subset* of JSON Schema
and would hit the same or worse friction on the same unions. Until
tc-5ev.1 tightens the schemas to a codegen-friendly subset, a Rust daemon's
wire layer would be hand-written-validated-against-schema — the same
discipline TS uses today, with drift caught by conformance tests at run
time, not prevented structurally. The "both ends generated" de-risking is
**not currently available**.

### 4. The design-incidental baggage is already shed — in TS, without a clean sweep

The lean's premise #2: "at clean-sweep scope, language is an incremental
delta; clean-sweeping in TS then porting pays the redesign tax twice."
What actually happened: **there was no clean sweep.** D1–D9 landed as an
incremental, in-place refactor — client identity (D2), per-client binding
(D3), size partition (D4/D8), single-socket wire collapse + endpoint/GAP-1
deletion (D5), `@tmuxcc/protocol` extraction (D5b), async south side (D6),
claim-path state machine (S3), capability model (D9), recycle fence +
broker hygiene (tc-4b6k.11, tc-i1pg, tc-9r2y) — with the moat green
throughout (final integrated gate: 202 protocol + 1132 driver unit + 86
real-tmux + 262 client + 157 EDH, typecheck + boundary lint clean).

Two consequences:

- The redesign tax has been **paid once and banked** — in the
  language-neutral artifacts (`protocol/` schemas, PROTOCOL.md,
  session-lifecycle.md, the decisions doc). A future port inherits the
  design for free; the "pay the redesign twice" scenario can no longer
  occur regardless of when/whether a port happens.
- There is **no rewrite-scale effort in flight** for Rust to ride at
  marginal cost. A Rust rewrite today is a standalone port of a working,
  shipped, green design: language is its *entire* cost, not an increment
  on a redesign that was happening anyway. The premise's factual condition
  ("once you're reimplementing anyway") did not obtain.

## What a rewrite dissolves vs. what it ports

Per the §5 classification, updated to the shipped tree:

- **Dissolves (TS/Node-incidental)**: the `spawnSync` blocking class —
  *already fixed in TS*; Rust would make the class inexpressible
  (robustness, no longer a symptom). Single-event-loop firehose coupling —
  structural in Node, but with **no measured symptom** post-D6 at tested
  load. GC on the hot path — unmeasured, unweighted.
- **Ports (design-incidental)**: nothing left — the whole column shipped.
- **Ports at similar cost (inherent)**: the fold (bootstrap + requery +
  diff), correlator/tokenizer, flow control, reattach fidelity, the 35%
  white-box moat, plus the timing lessons the real-tmux suites encode.

**Unpriced cost the lean itself flagged, still unpriced**: node-pty →
Rust PTY (`portable-pty`). This is not a dependency swap — the tc-2x3
in-process collapse *semantics* ride on node-pty's lifetime model, and the
tc-4b6k.11 fence's SIGKILL-safety argument explicitly cites it ("session-
proxies are in-process, their `-CC` ptys die with the broker"). A Rust
daemon must re-derive and re-prove those teardown/orphan properties. The
epic's own history is the caution: the D5 wire collapse — a *refactor* of
tested glue, in-language — still produced a real snapshot-drop race that
1008 unit tests missed and only the EDH behavioral moat caught. A full
rewrite is that risk class across the entire surface at once.

## Option scores

Axes: (i) captures the debaggage findings, (ii) rewrite risk to the
real-tmux correctness moat, (iii) measured performance need, (iv)
product/strategic value, (v) opportunity cost, (vi) enabler status.

### (a) Stay TS — the shipped D1–D9 tree

- (i) **Fully realized.** Every design-incidental item is fixed; the tree
  is the cleanest the driver has been.
- (ii) **Zero.** The moat stays green; the flake-is-a-bug discipline keeps
  compounding on the existing suites.
- (iii) **Met.** p99 loop lag ~13 ms under firehose; 40–200× hot-path
  headroom; no measured deficiency remains.
- (iv) Keeps the Node runtime dependency and the node-pty native-build/ABI
  maintenance tax; single toolchain across driver + SDK + extension.
- (v) **None.** The queued driver work (tc-76m8.1 pane.notify, .2
  read-only enforcement, .3 geometry ownership, tc-gjdx session templates)
  proceeds immediately on the cleaned platform — several were literally
  blocked on D5b and are ready now.
- (vi) Is itself the prerequisite state for any later (b): protocol
  boundary clean, tests promoted, design recorded language-neutrally.

### (b) Full Rust rewrite behind `protocol/`

- (i) No design delta — it ports the same shipped design. Gains type-level
  *enforcement* of the model invariants (exhaustive matching on
  event/delta ADTs). Note the honest limit: the ownership-seams bug class
  that motivated "illegal states unrepresentable" was a *missing design
  axis* (per-client facts in a shared slot) — Rust would have represented
  the same wrong design just as happily; the fix was design, not language,
  and it has landed.
- (ii) **The dominant cost — though softer than first priced** (§1
  correction). The 6–9 week test re-authoring floor stands, but its
  scariest-looking share — the 35% irreducible set with both crown-jewel
  canaries — is mechanical re-expression against production surfaces a
  conforming daemon must expose anyway, not testability design work. The
  genuinely hard residues: PTY collapse semantics re-derived and re-proven;
  interleaving determinism held by concurrency design (per-session state
  owned by one task); and the implementation itself on top. The 65%
  behavioral moat + golden corpus + conformance transcripts + EDH host
  suite are a real safety net most rewrites never have — but they are the
  *floor* of safety, not the whole moat.
- (iii) Buys structural parallelism headroom **without a measured
  symptom** — exactly what perf-RCA discipline says not to pay for.
- (iv) **The real remaining case.** Static runtime-free binary
  (distribution beyond VS Code hosts — remote/SSH driver); shedding the
  node-pty ABI churn tax permanently; category norm (LSP/DAP neighbors are
  compiled daemons); the better ten-year home if the driver is the durable
  artifact. All genuine; none measured, none urgent — these are operator
  value judgments, which is why this gate is ratified, not auto-decided.
- (v) Freezes or forks driver feature work for the duration; the queued
  beads either wait or get implemented twice.
- (vi) Weakened: both-ends codegen unavailable until tc-5ev.1 (finding #3).

### (c) Hybrid — Rust core, TS glue

Rejected as dominated:

- Targets the component with the **most headroom** (parser/fold: 205 MB/s,
  40–200×) — negative expected perf value once FFI marshalling sits on the
  hot `%output` path.
- Eats the **hardest** share of the test re-authoring (parser 1–2 wk +
  state machine 2–3 wk — the ledger's two biggest categories) while
  dissolving **none** of the Node structural properties (event loop, GC,
  node-pty all stay).
- Cuts an unnatural seam through the tightest-coupled machinery
  (pipeline ↔ flow-control ↔ demux ↔ serve) right after tc-4b6k.5
  deliberately *unified* the runtime into one package. The subprocess
  variant re-opens the process boundary tc-2x3 spent an epic collapsing.
- Splits the toolchain *within* one process: cargo + napi-rs + node-gyp in
  a single build. Worst of both options.

The only world where (c) beats (a) is a measured hot-path deficiency
specifically in the parser/fold — the evidence shows the opposite.

## Recommendation

**Option (a).** Stay TS. The epic already delivered the debaggaged design;
every evidenced benefit a rewrite promised is either captured in TS
(contention, all design baggage) or unmeasured (GC, footprint, latency),
while the rewrite's costs are now quantified (6–9 wk tests-only floor) or
named-and-unpriced (PTY semantics re-derivation, implementation proper,
feature freeze). Under measure-don't-infer discipline the evidence
supports exactly one option today.

**Reopen (b) — not (c) — when any trigger fires:**

- **T1 (measured symptom):** driver latency/contention the TS
  implementation cannot fix — e.g. multi-session firehose loop-lag with
  the async south side already in place (the `bench/refresh-lag-ab.mjs`
  harness exists and is re-runnable), or measured GC pauses on the delta
  path via the existing metrics. A confirmed symptom flips (iii) from
  "unpaid-for headroom" to "named need".
- **T2 (distribution requirement):** a product need to run the driver
  where a Node runtime is not guaranteed (standalone distribution,
  remote/SSH driver, non-VS-Code hosts). This makes the static-binary pro
  concrete instead of speculative.
- **T3 (de-risking matured):** tc-5ev.1 lands (schemas tightened,
  generation flipped) making typify-class Rust codegen credible — restoring
  the "both ends generated" claim — *and* the irreducible white-box share
  has been shrunk by further promotion work.

**Rust-relevant investment that is worth doing now (serves both futures):**
continue the tc-a88z promotion program — lift assertions to wire- or
metrics-level wherever the bug class survives the move (the flow controller
already feeds the shipped metrics registry, so several "internal"
observations have production counterparts today). Every point shaved off
the irreducible 35% grows the share of the suite that re-validates any
implementation unmodified — rewrite de-risking *and* better testing for
the TS driver. This, not starting a port, is the highest-value move if the
rewrite intent stays live.

**The honest tension to weigh at ratification** — deferral is not free:
every feature landed on the TS driver (tc-76m8.x, tc-gjdx, D4 arbitration
futures, D8 axis widening) grows the surface a later port must cover, so
(b)'s price rises with time; if the strategic values in (iv) weigh heavily,
the efficient moment is before that queue lands, and it will never be
cheaper in surface-area terms than now. Against that: the moat promotion
program and tc-5ev.1 make a later port *safer* per unit of surface, and
the ledger's week-figures are human-engineer estimates — the agentic dev
mode this repo actually runs (this epic: 15 beads including the wire
collapse, integrated in ~a day) compresses implementation wall-clock,
though the timing-sensitive real-tmux suites and operator review attention
are exactly the parts that compress least. The §1 correction sharpens the
tension further: with porting difficulty largely dissolved, (b)'s price is
mostly wall-clock and feature pause rather than correctness risk — a
value/sequencing judgment, which is exactly what T1–T3 gate. These
derivatives point in opposite directions; the recommendation stands on
today's evidence, and the triggers define when it changes.
