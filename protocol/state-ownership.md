# Driver ⇄ client state-ownership contract

**Status:** normative
**Audience:** implementers of any language SDK (`@tmuxcc/client` today; a future
Extension B tomorrow) — the same audience as [`PROTOCOL.md`](PROTOCOL.md).
**Scope:** the contract *above* the wire. [`PROTOCOL.md`](PROTOCOL.md) pins the
message shapes (framing, handshake, correlation, error envelope); this document
pins what the state on those messages *means* — where durable state lives, who
owns and writes it, which facts are shared vs per-client, and what a failure
code obliges a client to do.

Everything below is **our** option namespace and **our** verbs. There is exactly
one dependency on tmux-internal behaviour (format-walk inheritance of the close
policy, §2); it is recorded as a verified-on-3.4 observation carrying its
verification note, and nowhere else does this document assert tmux internals.

Out of scope (owned elsewhere):

- **Framing, handshake, correlation, wire error *shape*** → [`PROTOCOL.md`](PROTOCOL.md).
- **Extension-side policy** (how a VS Code window renders a fact, close-decision
  UI, toast copy) → the vscode `ARCHITECTURE.md`.
- **Reply-row codec internals** (the schema, the strict parser, sanitization) →
  [`../docs/state-model.md`](../docs/state-model.md) §9. This document classifies
  the facts that codec carries; it does not restate the schema.

---

## 1. Durable-state registry — the `@tmuxcc-*` user-option namespace

All durable driver state that must survive a driver restart lives on tmux
objects as `@tmuxcc-*` user-options (never in a driver-private store). tmux is
the durable truth; the driver is the **sole writer** of every option below and
re-reads them on bootstrap/requery. A client never writes these directly — it
requests a change through a wire verb, and the driver performs the `set-option`.

| Option | tmux scope | Values | Written by (verb → set site) | Read path |
|---|---|---|---|---|
| `@tmuxcc` | session | `1` (present ⇒ tmuxcc-managed) | mark-on-attach / create (`claim-session.ts` mark step; `tmux-south.ts` `set-option … @tmuxcc 1`) | `listSessions` `#{@tmuxcc}` |
| `@tmuxcc-workspace` | session | workspace URI, or `\|`-joined URIs | `setSessionWorkspace` at create (`tmux-south.ts`) | `listSessions` `#{@tmuxcc-workspace}` |
| `@tmuxcc-template` | session | template config-key name | template apply (`template/apply.ts`, `set-option … @tmuxcc-template`) | `listSessions` `#{@tmuxcc-template}` |
| `@tmuxcc_label` | pane | opaque durable pane name (free text) | `rename-pane` verb (`set-option -pt %N @tmuxcc_label …`) | `list-panes` (pane requery), tab-sanitized |
| `@tmuxcc-detach` | pane / window / session | `detach` \| `kill` \| unset (inherit) | `set-object-policy` verb, at any of the three scopes | `list-panes`, **RESOLVED** by format-walk — see §2 |
| `@tmuxcc-icon` | pane | opaque icon-policy token (free text) | `set-object-policy` verb, pane scope | `list-panes` (pane requery), tab-sanitized |
| `@tmuxcc-bound` / `@tmuxcc-bound-<hex>` | pane, **per-client** | `1` (this client binds this pane) / unset | `set-object-policy` / input-path, THIS client's slot only | reconstructed on connect, **not** in the bulk requery — see §3 |

Notes:

- `@tmuxcc_label` uses an **underscore**, not a hyphen — it deliberately mirrors
  the bare `@tmuxcc` ownership marker as "canonical, driver-owned state carried
  on the object" (the other options are hyphenated). Preserve the exact spelling.
- **Per-client options (D3).** Binding intent is not a single shared slot: each
  client writes its *own* option name, `paneBoundOptionName(clientId)` =
  `@tmuxcc-bound-` + `sha1hex(clientId).slice(0,16)`. The hash is bounded,
  format-safe (contains no format metacharacters), and injective in practice for
  the handful of workspaces on one server. An `undefined` (anonymous / legacy)
  client falls back to the bare `@tmuxcc-bound` shared slot. This is the D3
  cardinality promotion — two clients binding the same pane write two distinct
  options instead of colliding in one (see
  [`../docs/ownership-seams-decisions.md`](../docs/ownership-seams-decisions.md)
  D1/D3).
- The free-text fields (`@tmuxcc_label`, `@tmuxcc-icon`) can carry raw tabs; the
  driver reads them through an in-tmux sanitizer and is the sole write point.
  The *why* is codec-internal — see [`../docs/state-model.md`](../docs/state-model.md)
  §9 amendments 2–4.

---

## 2. Resolution semantics — the detach cascade is driver-resolved

The close policy `@tmuxcc-detach` may be set at pane, window, or session scope.
The **effective** policy for a pane is the first-wins cascade *pane override →
window default → session default*. This cascade is resolved **driver-side**, and
clients receive the already-**RESOLVED** value — never the three raw per-scope
options.

The resolution mechanism is a tmux **format-walk**:

> tmux does NOT inherit user-options across scopes for `show-options`, but a
> `#{@tmuxcc-detach}` FORMAT reference DOES walk pane→window→session
> **(verified tmux 3.4)**.
> — `packages/driver/src/state/bootstrap.ts:180`

The pane requery reads the policy through a `#{@tmuxcc-detach}` format in
`list-panes -F`, so each pane row already carries the effective close policy —
exactly the first-wins value the host's close decision consumes. This is the
single tmux-internal-behaviour dependency in this document; it is recorded here
(as `bootstrap.ts:180` records it in code) as a verified-on-3.4 observation, and
must carry that verification note wherever it is repeated.

**Consequence for clients:** a client reads *one* resolved `detach` fact per
pane. It cannot, from the wire today, read the per-scope-*own* value (e.g. "what
is set on this window specifically", for a toggle UI that shows the current
setting at each scope). The extension approximates per-scope-own state
optimistically in an in-memory policy cache written through the same verb; a
first-class per-scope-own **read** over the wire is a follow-up (tc-i9aq.4).

---

## 3. Shared vs per-client classification

Every canonical fact carries an explicit **shared vs per-client** classification
(D1); a per-client fact in a shared slot is an illegal state made representable
([`../docs/ownership-seams-decisions.md`](../docs/ownership-seams-decisions.md)
D1). The classification below is reconciled against the **ratified canonicality
decision** — bead **tc-mysc** (closed) and its design note
[`../docs/state-model.md`](../docs/state-model.md) §9 "Canonicality: the
reply-row codec" — **not** the earlier `brief-canonicality.md` draft, parts of
which tc-mysc's amendments overrode.

### 3.1 Canonical facts (driver-owned, format-backed)

A **canonical** fact is one tmux is the source of truth for and that the driver
rebuilds every requery cycle by a *mechanical `Pick` from a format-backed reply
row*. Per the ratified decision, each reply kind (`WINDOWS_ROW`, `PANES_ROW`) is
declared once as a typed schema from which the tmux format string, the strict
parser, and the row type are all derived; a canonical field that is missing from
the format is unrepresentable, and a hardcoded literal standing in for a listed
field is unwritable. (Schema is in `state/bootstrap.ts` / `state/reply-row.ts` —
see [`../docs/state-model.md`](../docs/state-model.md) §9; not restated here.)

Canonical facts include: session / window / pane identity and topology, window
and pane names, the window layout, active flags, pane size, dead/exit state, the
window monitor/synchronize options, and the pane's durable driver-owned fields
`@tmuxcc_label`, the RESOLVED `@tmuxcc-detach` (§2), and `@tmuxcc-icon`. Pane
`mode` (`#{pane_mode}`) and `paneTitle` (`#{pane_title}`) are also canonical and
join the pane schema as the tc-mysc children land (tc-mysc.2 / tc-mysc.3); the
mechanical canonical/overlay `Pick` split itself is enacted by tc-mysc.1. Until
those children land the *classification* here is authoritative; the enactment is
tracked, not yet fully shipped.

The session-scoped markers `@tmuxcc`, `@tmuxcc-workspace`, `@tmuxcc-template`
(§1) are likewise canonical, read from the session list rather than the
pane/window requery.

### 3.2 Client-local overlay (per-client, carried forward)

A **client-local** fact is not tmux-canonical from the bulk requery's point of
view; it is reconstructed on connect and **carried forward wholesale** across
requery cycles rather than rebuilt per field (the ratified "overlay carried
forward" shape, [`../docs/state-model.md`](../docs/state-model.md) §9). The
load-bearing example:

- **Binding intent** (`boundClients`, the `@tmuxcc-bound-<hex>` per-client slot,
  §1). It is per-`(pane, client)`, deliberately **not** part of the bulk
  `list-panes` requery format, and is reconstructed on connect (tc-4b6k.2) and
  carried forward. Reading it into the shared canonical row would re-introduce
  the shared-slot illegal state D1/D3 removed.

Per-client **size ownership** (the owner/non-owner size partition, D4 /
tc-76m8.3) is likewise a per-client fact rather than a single shared model value;
its mechanics live in [`../docs/state-model.md`](../docs/state-model.md) §8.

### 3.3 Client identity is the axis (D2)

Every per-client fact needs an axis to hang on: *which* client. That axis is the
durable **client identity** presented at the handshake — `ClientIdentity`
(`identity.id` durable + stable across the client's own reloads, opaque to the
driver; `identity.label` display-only), carried on `client.capabilities` on both
wires. The *wire shape and framing* of identity is [`PROTOCOL.md`](PROTOCOL.md)
§3.3; what matters here is the contract: the driver keys per-`(object, client)`
facts on `identity.id` and never interprets its internal structure.

---

## 4. Error-envelope semantics

This section defines what the failure **codes mean** and what they oblige a
client to do (retry vs abort). The wire **shape** — the two failure channels,
`correlationId` correlation, exactly-one-response, and the `ErrorMessage` /
`CommandFailure` field layout — is [`PROTOCOL.md`](PROTOCOL.md) §5 and the
`schemas/`; it is not restated here. The two documents partition cleanly: §5 =
shape, this §4 = meaning.

### 4.1 The two failure channels (semantic distinction)

- A failure **attributable to an in-flight command** arrives as the command's
  own response with `result.ok = false` (a `CommandFailure`, code +
  human-readable `message` + optional structured `details`).
- A failure with **no in-flight command to correlate** — protocol-level or a
  session-lifecycle event — arrives as the unsolicited `ErrorMessage`
  (`type: "error"`).

A client must not match on the `message` prose (it is English, for
logging/debugging only). Branch on `code`, and on `details` where a contract
exists.

### 4.2 Code meanings and retry / abort obligations

Codes are open-ended for forward compatibility; a client encountering an unknown
code should treat it as a non-retryable failure and surface it.

**Server-proxy command codes** (`ServerProxyErrorCode`):

| Code | Meaning | Obligation |
|---|---|---|
| `session.not-found` | claim/destroy/info named an unknown session | do not retry the same id; refresh the session set |
| `session.name-taken` | create requested a name already in use | user-correctable; retry only with a different name |
| `template.invalid` | create referenced a malformed/unknown template | not retryable as-is |
| `tmux.unavailable` | the tmux binary could not be run | not retryable until the environment changes |
| `tmux.capability-required` | the probed tmux binary lacks a feature | **typed retry gate** — see §4.3 |
| `metrics.bind-invalid` | `set-metrics-http` asked for a non-loopback host | caller error; not retryable as-is |
| `server-proxy.shutting-down` | a command arrived during graceful broker shutdown | **abort** — the broker is exiting; do not retry on this connection |
| `internal` | unexpected broker-side error | not retryable; surface as a bug |

**Session-proxy command codes** (`SessionProxyCommandErrorCode`, on
`command.response` `result.ok=false`):

| Code | Meaning | Obligation |
|---|---|---|
| `verb.failed` | the tmux verb returned non-zero / a known-error string (e.g. split a dead pane) | surface; no blind retry (the input is at fault, not transient) |
| `verb.internal` | driver-side exception while running the verb | not retryable; surface as a bug |
| `verb.no-effect-ids` | verb "succeeded" but the reply lacked expected entity ids (also client-minted on a half-populated create) | treat as failure, **not** a half-success |
| `read-only` | mutating command rejected — this client attached read-only | **do not retry** without re-attaching read-write (authority is driver-enforced — see below) |
| `pane.not-found` | the targeted pane is absent from the session model | refresh the model; do not retry against the same id |
| `internal` | unexpected session-proxy error not attributable to the args | not retryable; surface as a bug |

**Unsolicited / wire codes** (`WireErrorCode`, on `ErrorMessage`):

| Code | Meaning | Obligation |
|---|---|---|
| `session.unavailable` | the bound session went away | **connection is dead** — stop issuing commands; interpret `cause` (§4.4) |
| `session.not-found` | `session.attach` named an unknown session (before the data connection closes) | the attach failed; do not reconnect to that id |
| `protocol.version-mismatch` | handshake versions differ | **abort** — connection is dead, no downgrade |
| `protocol.unknown-message` | an unknown message type was received (dropped) | non-fatal; log |
| `protocol.malformed` | reserved (parse failures close the connection today rather than emitting this) | connection-fatal in practice |
| `internal` | unexpected session-proxy-side error | surface as a bug |

`read-only` authority is **driver-enforced**, not delegated to tmux's read-only
flag: over control mode tmux's `read-only` blocks input paths but not other
mutating commands, so the driver — not tmux — is the authority boundary
([`PROTOCOL.md`](PROTOCOL.md) §12 caveat). A `read-only` code therefore reflects
a driver decision a client cannot retry around.

### 4.3 The one typed retry obligation (`tmux.capability-required`)

`tmux.capability-required` is the **only** code carrying a structured retry
contract. Its `details` is `CapabilityRequiredDetails { capability }` naming the
`TmuxCapabilityMap` key the probed binary lacks. The ratified retry gate
(tc-u4ny.3, closed) is:

- narrow with the structural discriminator `isCommandError(err,
  "tmux.capability-required")` (**not** `instanceof` — two copies of the protocol
  bundle in one extension-host defeat `instanceof`; the check is structural on
  `name` + `code`);
- read the capability with `requiredCapability(err)` (best-effort narrowing of
  wire-sourced `details`; never cast `err.details` directly);
- retry only when the gate matches (e.g. `newSessionEnvFlag` → retry the create
  with the env flag dropped). No other code has an automatic retry contract.

**Type-preserving rehydration is a client obligation.** The failure envelope
must survive as a typed `CommandError` (intact `code` + `details`) across every
boundary a client pumps it through — a wrapper that re-eras the code into
`message` prose breaks the retry gate. tc-u4ny.3 rehydrated all four such
boundaries in the shipped client; a new SDK must do the same and must never
recover the code by parsing `message`.

### 4.4 `cause` — the session-close reason

For `session.unavailable` **only**, the `ErrorMessage` carries an optional
`cause` (tc-fah2):

- `pane-exit` — the session death was the tail of the last bound pane's process
  exit (the user performed the exit). Downstream may silence attribution toasts.
- `external` — the server/session died with no attributed pane-exit cascade
  (external teardown, `kill-server`, etc.). Downstream shows the one explanatory
  toast.

`cause` is absent for every other code. The *display* decision it drives is
extension policy (→ vscode `ARCHITECTURE.md`); the contract here is only its
meaning.

> Reconciliation note: an earlier draft outline named this field `closeReason`.
> The ratified wire shape (schema + `ErrorMessage`, tc-fah2) is `cause` with the
> enum above; `closeReason` is not a shipped field.

---

## 5. Client obligations — lifetime facts a client may rely on

These are the durable lifetime guarantees a client builds on. They are specified
in full elsewhere; this section is a set of **pointers**, not a restatement.

- **Single broker socket (D5).** Every connection lands on one well-known broker
  socket and runs one handshake; a data connection is a `session.attach` step on
  the same socket, not a per-session socket. → [`PROTOCOL.md`](PROTOCOL.md) §1;
  [`../docs/ownership-seams-decisions.md`](../docs/ownership-seams-decisions.md)
  D5.
- **Session-lifecycle ordering.** `sessions.removed` fires only on a true tmux
  session drop, is never emitted *after* the data-connection close, and the one
  legal interleaving (in-flight data events after `sessions.removed`) is a real
  case a client must drain. → [`session-lifecycle.md`](session-lifecycle.md)
  (the normative C1–C4 contract).
- **Broker idle-exit.** The broker self-exits after an idle grace period
  (`--idle-exit-ms`, default 5 min) when no client is connected; a client must
  be prepared to re-launch/reconnect the broker rather than assume it is
  permanently resident. → the tmuxcc-driver repo's `ARCHITECTURE.md` §4
  ("Lifetime & exit").

---

## 6. Seam ledger

The per-seam catalog of ownership seams and their fix / out-of-scope verdicts —
the living successor to the descriptive `ownership-seams.md` map — is **not yet
landed**. Its recommended home is driver
[`../docs/seams-catalog.md`](../docs/seams-catalog.md) (implementation-facing
verdicts, next to `state-model.md` and `ownership-seams-decisions.md`); this
section will link it as its ledger once it lands.

Until then, the ratified seam **decisions** (D1–D9 and the seam findings S1–S7)
live in
[`../docs/ownership-seams-decisions.md`](../docs/ownership-seams-decisions.md).
This document does not restate those verdicts.
