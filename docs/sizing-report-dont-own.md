# Sizing: report, don't own

**Status: graduated** (provisional in `projects/tmuxcc/docs/` per tc-33ji; moved to driver `docs/` by tc-cvny.5).
Design settled with the operator 2026-07-16; supersedes tc-gia3 ("Option C"
window-scoped-manual framing). Epic: **tc-cvny** (shipped 2026-07-17). Every upstream claim below was
verified against the in-tree reference clones (tmux, iTerm2, cmux,
microsoft/vscode) on 2026-07-16; cites are file:line at that date.

## 1. The problem, reduced

One invariant governs rendering a tmux pane in a VS Code terminal: **the
rendered grid must equal tmux's pane grid**. A terminal stream is
grid-addressed, not reflowable — tmux formats output for the pane's exact
cols×rows. Mismatch in the "pane smaller than box" direction is cosmetic
(content hugs the top-left; plain tmux shows the same for oversized clients);
mismatch in the "pane larger than box" direction is durable corruption
(mis-wrapped lines persist in xterm scrollback after convergence, mouse
coordinates go off-grid). The design's job is to make the bad direction
unreachable by construction and render the benign direction honestly.

From the invariant, the whole client-side kernel derives in four clauses:

1. **Render tmux's truth** (the pane's actual grid).
2. **When your boxes change, ask tmux to adopt them** (so the residual is zero).
3. **Letterbox any residual difference** (`Pseudoterminal.overrideDimensions` —
   the only geometry-write VS Code offers; a render fallback, budgeted at
   ~a screenful of code, not a subsystem).
4. **Ignore your own echo while a request is in flight** (iTerm2's equivalent
   is one integer: `numOutstandingWindowResizes`, TmuxController.m:1869).

Anything in the implementation not derivable from these four clauses must
justify itself separately. The pre-2026-07 sizing machinery mostly could not
(§3).

## 2. The settled principle: one decider per concern

Operator-settled 2026-07-16: **there cannot be any reimplementation of tmux
policy one layer up.** For each concern, exactly one decider — either tmux owns
it (use tmux's mechanism as designed) or our side owns it (and tmux is put in
the mode where it explicitly doesn't act). Never both.

The old design failed this twice:

- The driver re-implemented tmux's `window-size latest` election
  (activity-elected owner, candidacy refcounts, imbalance FATAL —
  `size-ownership.ts`, ~285 lines + the session-proxy owner gate) because the
  single `-CC` control client hides the real frontends from tmux, making
  tmux's native arbitration blind. **Worse than redundant: incoherent.** A raw
  side-by-side client (`tmux attach` next to VS Code — explicitly supported)
  gives tmux a second client, so tmux's native `latest` election runs
  *simultaneously* with the driver's frontend election, neither aware of the
  other. tmux can hand the window to the raw client, at which point the
  driver's owner election is decorative and its size writes silently
  ineffective.
- The client (extension) owned the lifecycle of tmux-side persistent state
  (`window-size manual` on strips) through in-memory bookkeeping — the
  tc-x9bj leak class (manual outliving the strip: unsplit, reconnect `reset()`,
  crash).

## 3. The mechanism: per-window client sizes

tmux ≥ 3.4 (see §6 for the 3.3 caveat) lets a **control client declare its
viewport per window**:

```
refresh-client -C @5:118x32     # this client's size FOR window @5
refresh-client -C @5:           # clear it
```

Verified semantics (tmux `cmd-refresh-client.c:90-103`, `resize.c:175-188`):
the per-window size is stored per (client, window) and **participates in
tmux's normal `latest`/`largest`/`smallest` arbitration** — a client
contributes its per-window size for that window when declared, else its global
size. It is not a mode; it is a truthful, finer-grained report into the
arbitration tmux already runs. (`resize-window` by contrast forces
`window-size manual` — a mode with a lifecycle. We don't use it.)

**The design:** the driver's control client reports each window's viewport =
that window's tab/group box, per window, change-gated. Nothing is ever
`manual`; there is no mode to enter, release, or leak — the tc-x9bj class
loses its substrate. A stale report's failure mode is soft (window sized by an
old report until the next report or another client's activity wins), not
frozen-forever.

Two per-window-size semantics pinned by tc-cvny.1 shape the report policy:

- **Participation is sticky, fallback is the global client size.** A control
  client is ignored for sizing until its first `refresh-client -C` ever
  (`resize.c:91-95`); the participation flags are never cleared. From then on,
  for any window *without* a `@w` entry the driver contributes its global tty
  size (`resize.c:180-190`) — live-confirmed: with the driver as sole client,
  the first report snapped every unreported window to the driver's arbitrary
  pty size, and clearing a report (`-C @w:`) means "adopt my global size",
  *not* "revert to previous size". Consequence: the driver **reports every
  window it knows** (never-revealed windows get creator-inherited dims at
  creation — this is why iTerm2 sizes invisible tabs, `PTYTab.m:5031`) and
  **does not clear reports while attached**; unbinding a window just stops
  updating its report (stale = soft, cleared = arbitrary). tmux frees the
  per-window entries itself on client loss (`server-client.c:396-410`).
- **A report is a ceiling, not just a bid.** After the `latest` election picks
  which client's size wins, every non-ignored client's declared `@w` size
  clamps the result downward (`resize.c:222-244`): window = min(winner, all
  `@w` reports). Live-confirmed both directions. So losing the election to a
  raw client can only *shrink* the window below our box (the benign letterbox
  direction); the corruption direction (pane grid larger than our box) is
  unreachable while our report stands, no matter who is `latest`.

**Strips** stop being a sizing special case: report the group's total box like
any window (tmux sizes the window, re-tiling panes proportionally), then push
the one thing tmux cannot know — sash subdivisions — via `resize-pane`. The
old atomic managed batch (`window-size manual` + `resize-window` +
`resize-pane`×N) collapses to the `resize-pane` part. The strip-vs-sole-pane
difference reduces to "strips also push pane subdivisions."

**Multi-client** resolves the right way — not by removing the contested
resource (all-manual would leave raw clients permanently letterboxed) but by
giving the one arbiter full information: tmux runs `latest` per window across
the driver's per-window reports and any raw client's size. When two of *our*
frontends show the same window, the driver reports the most recent box change
— a report policy, not an arbitration policy; tmux cannot see through the
single client either way, and the product goal keeps multi-frontend
incidental. The incidental case is milder than feared (tc-cvny.1, probe 1):
`send-keys` from a control client never moves `w->latest` (only real tty
keys, a plain client's terminal resize, attach, window selection/creation
commands, and detach re-election do), and per the ceiling semantics above a
raw client that does take `latest` can only shrink the window below our box,
never grow it past our report.

## 4. What this deletes / what it keeps

**Deleted** (driver): `runtime/size-ownership.ts` (285 lines, 3 test files);
the session-proxy owner gate + `lastResizeByClient` replay; the fwx0
owner-resolution in `hydration.ts` (its pre-capture gate becomes a per-window
report on the target pane's window); the candidacy-imbalance FATAL class (a
session-proxy-killing failure mode that sat on the single-client core path);
`runtime/manual-window-ledger.ts` (tc-x9bj Option B — correct groundwork,
obsoleted: with no manual mode there is nothing to release; keep a one-shot
attach hygiene `set -u window-size` for windows left manual by older builds).

**Deleted** (extension): the manual/`latest` two-regime boundary and its
lifecycle; the send-managed mode distinction in `evaluateWindow` where it
existed only for that lifecycle.

**Kept, unchanged**: the strip/promotion/unsplit inference machinery — it is
VS-Code-API-earned, not sizing machinery (§5); letterbox as the residual
render fallback; confirm-then-trust *only* in its echo-suppression +
clamp-detection role (clause 4); the protocol `ClientFlags`/identity seam
(operator carve-out — `readOnly` is orthogonal and stays; `ignoreSize`
re-reads naturally as "never reports sizes"; PROTOCOL §12's reserved parity
prose re-expressed per-window).

## 5. Why the remaining complexity is earned (the reference comparison)

**iTerm2** (canonical `-CC` consumer; no daemon, controller in-app, one
gateway per app-instance×session): native splitter tree fully isomorphic to
tmux's layout tree; sash drag → `resize-pane`, then *adopt* tmux's answering
layout; loop prevention = one counter + per-window size cache. In variable
mode (tmux ≥ 2.9, gated 3.4 for the `@w` form) it sizes **every window
independently** — shipped proof that per-window last-writer sizing is loop-free
(`TmuxController.m:1019-1054`: change-gated, "It's already that size. Do
nothing."). It sizes invisible tabs too (`PTYTab.m:5031`) — precedent for our
never-revealed-window answer: inherit the creating client's dims; first reveal
corrects.

**cmux** (Swift/macOS on Ghostty; UI process owns the `-CC` client directly,
one per host+session, no daemon): uses the *legacy* model — one client-level
`refresh-client -C`, leaning on `window-size latest` ("one client-level kick
redraws them all", `RemoteTmuxControlConnection.swift:506-510`) — validating
the simple architecture while sharing exactly the wart we're fixing (all
windows share one size). Borrowable tricks recorded for later beads:
`refresh-client -B` format subscriptions instead of polling (cwd,
alternate-screen/reflow class, `:659-737`); the attach-time redraw kick
(shrink a row, out-wait tmux's ~250ms resize coalescing, restore — forces
stale TUIs to repaint, `:476-542`); reconnect size reseed (`:1075-1078`);
180ms trailing-edge resize debounce (`:131-149`).

**VS Code's API** (verified in microsoft/vscode source) imposes the two
incompatibilities that are *not* deletable, and only these:

- *Structural*: panel terminal groups are single-axis strips
  (`terminalGroup.ts`; axis from panel position); editor-area terminals live
  in a separate system (editor grid). Arbitrary tmux layouts cannot render —
  hence the managed subset {single pane, flat strip} and tmux-authoritative
  letterboxed rendering for the rest. Binding a pane from a tmux-layout window
  promotes it to its own single-pane window (own-the-whole-window invariant,
  `spatial-model.ts:590` partial-bind peel, tc-2wdm.1;
  see `tmuxcc-vscode/docs/layout-regimes.md`).
- *Epistemic + write asymmetry*: no group-membership read, no split/unsplit
  events, no sash write (`terminalActions.ts:457` — resize commands act on the
  active pane, no target argument), nothing in the proposed-API pipeline.
  Native geometry is **readable per pane, not writable** — so structure must
  be *inferred* from geometry (the promotion/unsplit machinery — earned rent,
  iTerm2 needs none of it because it owns its UI events), and tmux truth is
  applied by letterboxing content, never by moving sashes.

**The daemon** (driver-as-separate-process) imposes no *capability* limit —
every hard geometry limit above comes from VS Code, not the process split. Its
costs are the protocol-vocabulary tax, connection-lifecycle machinery, and
two-ended convergence; its justification is the API-product claim (queryable
tmux API; SDK/CLI/QA tooling; LSP/DAP category), *not* technical necessity of
tmux integration — iTerm2 and cmux both ship daemonless. Feature designs
should notice when they pay the daemon tax without getting daemon value.

## 6. Version gate

The `@w:WxH` form landed 2021-08-27 (tmux commit `fd756a15`, issue 2594) — so
it is in **3.3** (2022-06) — but iTerm2 gates it at **3.4**
(`refreshClientSupportsWindowArgument`). tc-cvny.1 pinned the gate question
(probe 3): **3.3's implementation is byte-identical to 3.4's** (`git diff 3.3
3.4 -- resize.c cmd-refresh-client.c` is empty; the `client_window` helpers
are identical; no commit between `fd756a15` and 3.4 touches the mechanism).
iTerm2's 3.4 gate is not a bug judgment: it was authored 2021-08-27 — the same
day the feature landed on master, nine months before any release contained it
— when master self-reported `next-3.3`, which iTerm2 parses as 3.3
(`TmuxController.m:1559`), making "3.3" ambiguous between pre- and
post-feature dev builds; 3.4 was the first number that guaranteed the feature.
The form never got a CHANGES entry, so the gate was never revisited.

Our floor stays **3.4**, for our own reason: every tc-cvny.1 semantics probe,
the state-model amendments, and the test suite are verified against 3.4, and
3.3a→3.4 contains control-mode changes we have not verified on 3.3 (deferred
control-client reads `9e03df55`, command-sent keys skip paste handling
`eb1f8d70`, control-client `display-message` `93b1b781`). Lowering to 3.3
would be a verification project, not a code change. Enforcement: the D9
version probe (tc-cvny.2), fail-loud "tmux ≥ 3.4 required" at claim time.
**No `resize-window` fallback** (settled): the fallback is not a smaller
feature — it resurrects the manual lifecycle, i.e. two sizing regimes forever,
the exact disease. A degraded mode for older tmux is a separate later bead if
a real constituency appears.

## 7. Verification items — resolved (tc-cvny.1, 2026-07-16)

All three pinned by source reading (master `f0669334`, sites verified
identical at the 3.4 tag) *and* live probes on tmux 3.4 (private server, plain
client + `-CC` client on controlled ptys); full evidence in the tc-cvny.1 bead
comments.

1. **`send-keys` does not update `w->latest`.** It goes cmdq →
   `window_pane_key`; `cmd-send-keys.c` never touches latest, and a control
   client's `MSG_RESIZE` is explicitly skipped (`server-client.c:2244`).
   `w->latest` moves only on: real tty key input (`server-client.c:1432`),
   plain-client terminal resize, attach/session-switch
   (`server-client.c:415` — includes control clients), window
   selection/creation commands (`cmd-select-window.c:146`,
   `cmd-new-window.c:94`, `spawn.c:166`, `cmd-break-pane.c:110` — the
   *executing* client, so the driver's own `select-window` grabs latest), and
   detach re-election by activity time (`server-client.c:382-395` — control
   clients eligible). With the ceiling clamp (§3) the incidental raw-client
   story needs no driver machinery: a raw client's activity can only shrink
   the window below our report.
2. **Report → re-tile → push is strictly ordered; echo suppression must be
   state-based, not count-based.** `refresh-client -C @w:WxH` re-tiles
   synchronously inside the command (`recalculate_sizes_now(1)`,
   `cmd-refresh-client.c:103`), so a sash push queued after it on the same
   connection always applies to the re-tiled window — pushing *before* the
   report is corrupting (the proportional re-tile rescales the sash away;
   observed live). No extra ordering/coalescing machinery needed. But the
   notification stream is not one-echo-per-request: `now=1` bypasses the
   no-change gate (`resize.c:381-387`) and force-fires `%layout-change` for
   *every* window in the session on *every* report (no-op content included),
   and the transient proportional tile is emitted as its own `%layout-change`
   or hidden entirely depending on read batching. Clause-4 suppression
   therefore means: don't adopt layouts while a report/push burst is in
   flight; compare final layout to requested state at quiescence (iTerm2's
   outstanding-counter is the same shape). Pane-level SIGWINCH stays
   change-gated (`window_pane_resize`) — forced no-op re-resizes cost only
   notification chatter.
3. **3.3-vs-3.4 gate: resolved in §6** — identical implementation, iTerm2's
   gate is version-string conservatism from the feature's landing day; our
   floor stays 3.4 on verification-surface grounds.

## 8. Horizon (recorded, not designed against)

- **Floating panes**: unreleased upstream work-in-progress (format stubs
  merged to master 2026-04, `floating_panes_staging` active 2026-05; absent
  from 3.6b CHANGES/man). A pane owning geometry outside the tiled tree could
  someday map VS Code tabs more naturally than tiled windows. Docs-are-
  authoritative rule: revisit when released, not before.
- **Bind-in-place for foreign nested windows** (what stale layout-regimes.md
  described): API-feasible policy alternative to promote-on-attach; orthogonal
  to sizing; its own bead if ever wanted.
- The `NO vscode imports` brain/edge boundary makes an in-EDH (daemonless)
  controller a *possible* future shape; §5's daemon paragraph records the real
  trade. Not this epic.
