/**
 * Golden corpus tests for the tmux -CC control-mode parser.
 *
 * Verifies that the full parser stack (ControlTokenizer → parseNotification →
 * decodeOutputPayload → CommandCorrelator) produces expected event sequences
 * for a set of committed corpus samples.
 *
 * # Corpus samples
 *
 * ## Real-captured (tmux 3.4, `-C` mode, machine: chost)
 *   tmux34-session.raw  — real byte stream captured 2026-05-29 from tmux 3.4
 *     using `tmux -L tcgolden -C attach` (single-C, no DCS wrapper; tmux 3.4
 *     is the version present on this machine).  The stream includes:
 *       - multiple %begin/%end command blocks (list-windows, new-window,
 *         split-window, list-panes, list-sessions)
 *       - %session-changed, %session-window-changed, %window-add,
 *         %window-pane-changed, %layout-change (→ unknown), %exit
 *       - many %output notifications including one line whose decoded payload
 *         contains real non-UTF-8 bytes (\xc0\xfe\xff) — passes through the
 *         octal codec without round-tripping through a string.
 *     NOTE: no DCS wrapper emitted by -C (single dash); for DCS wrapper
 *     coverage see the real -CC capture below.
 *
 * ## Cross-version real captures (added under tc-3y8.5, 2026-06-10)
 *   tmux32a-C.raw  — tmux 3.2a (pre-3.4) captured inside ubuntu:22.04 docker
 *     image.  Same script as tmux34-session.raw (list-windows, new-window,
 *     split-window, list-panes, list-sessions, printf non-UTF-8 bytes,
 *     select-layout, detach).
 *     Verified divergences vs. tmux 3.4: NONE.  %layout-change carries the
 *     visible/full/flags 4-token form, same as 3.4 and 3.5a.  All notification
 *     keywords are the same.
 *
 *   tmux35a-C.raw  — tmux 3.5a (post-3.4) captured inside debian:trixie docker
 *     image.  Same script.
 *     Verified divergences vs. tmux 3.4: 3.5a additionally emits
 *     %window-renamed events when shells inside a freshly-spawned window/pane
 *     set their automatic-rename title.  Parser already handles
 *     %window-renamed (parsed by notifications.ts).  %layout-change format is
 *     unchanged (still visible/full/flags).
 *
 *   tmux34-CC.raw  — tmux 3.4 with `-CC` (double dash, DCS-wrapped) captured
 *     on the host.  This is the mode the product actually uses in
 *     production.  Starts with `\x1bP1000p`, ends with `\x1b\` (ST).
 *     All inner lines terminated `\r\n`.  Closes the previously-zero
 *     real-capture coverage on the DCS-wrapped path.
 *
 * ## Hand-authored fixtures (realistic, based on tmux protocol documentation)
 *   dcs-wrapper — minimal DCS-wrapped session with one command block and exit.
 *   older-session-renamed — older tmux format: %session-renamed <name> (no $id).
 *   non-utf8-output — %output line whose decoded payload is NOT valid UTF-8.
 *   block-error — command block that terminates with %error (not %end).
 *
 * ## Capture provenance / reproduction
 *   Capture driver: bin/golden-capture.py inside this directory's sibling
 *   tooling (kept off-tree; transient docker run).  Each capture used a
 *   per-run socket `tmuxcc-test-3y85-<n>` and the following script:
 *     1. `list-windows`           → response data, no notifications
 *     2. `new-window`             → %session-window-changed, %window-add
 *     3. `split-window -h`        → %window-pane-changed, %layout-change
 *     4. `list-panes`             → response data
 *     5. `list-sessions`          → response data
 *     6. `send-keys ... printf '\xc0\xfe\xff test bytes\n' Enter`
 *                                  → %output containing raw non-UTF-8 bytes
 *     7. `select-layout even-horizontal` → second %layout-change
 *     8. `detach-client`          → %exit and end of stream
 *
 *   Reproduction (in throwaway docker):
 *     docker run --rm -v <work>:/work -w /work <image> bash -c '
 *       apt-get update && apt-get install -y tmux python3
 *       python3 capture.py tmuxcc-test-3y85-<n> <C|CC> /work/<out>.raw
 *       tmux -L tmuxcc-test-3y85-<n> kill-server'
 *
 *   Images used:
 *     tmux32a-C.raw         : ubuntu:22.04  → tmux 3.2a-4ubuntu0.2
 *     tmux35a-C.raw         : debian:trixie → tmux 3.5a-3
 *     tmux34-C.raw          : host (Ubuntu 24.04) → tmux 3.4-1ubuntu0.1
 *     tmux34-CC.raw         : host (Ubuntu 24.04) → tmux 3.4-1ubuntu0.1
 *
 * # Cross-version notes
 * Older-format variants (%session-renamed without $id, etc.) are covered by
 * the hand-authored fixtures; see notifications.ts for the older-format
 * spec.  No version we captured emitted that older form (3.2a through 3.5a
 * all use `$<id>`-prefixed %session-renamed).
 *
 * # Acceptance criteria verified here
 * ✓ Parser output matches expected for each corpus sample.
 * ✓ Non-UTF-8 bytes preserved byte-exact (never round-tripped through a string).
 * ✓ Streaming invariance: byte-by-byte feed produces the same tokens as one-shot.
 * ✓ Real captures for pre-3.4 (tmux 3.2a), post-3.4 (tmux 3.5a), and
 *   `-CC` DCS-wrapped (tmux 3.4) modes — closes hand-authored-only coverage.
 * ✓ Golden corpus runs in CI under `npm test -w @tmuxcc/session-proxy`.
 *
 * @module parser/golden/golden.test.ts
 */
export {};
//# sourceMappingURL=golden.test.d.ts.map