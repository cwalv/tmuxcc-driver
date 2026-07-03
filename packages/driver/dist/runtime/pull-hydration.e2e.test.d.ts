/**
 * tc-76m8.28: `ClientFlags.pullHydration` — the addClient-time unsolicited
 * replay is suppressed for clients that hydrate by explicit `pane.attach`.
 *
 * Real tmux, full session-proxy assembly (`createSessionProxy` →
 * `sessionProxy.addClient`, the path that reads `opts.flags` — the fake-tmux
 * harnesses attach via `server.addClient` and bypass it).
 *
 * Why the flag exists (the geometry-changed-blip corruption, found by
 * tc-76m8.24): the addClient-time push captures tmux's grid BEFORE the client
 * has converged tmux to its tabs' geometry. A client that gates its own
 * `pane.attach` replay on settled geometry (the extension's resize-then-
 * restore gate) must therefore receive NO unsolicited replay — on a reconnect
 * whose geometry changed during the blip, the pushed stale-geometry grid
 * lands history rows in-viewport on the open recycled tab, where the managed
 * resize's SIGWINCH redraw destroys them. The driver cannot know "settled"
 * (managed authority is client-defined), so the gate is the CLIENT's; the
 * driver's part is to keep this entry point closed for clients that declare
 * they pull.
 *
 * Coverage:
 *   T1. pullHydration client: NO unsolicited hydration after attach (no
 *       pane.hydration.begin, no clear+replay frame); a subsequent explicit
 *       `pane.attach` on the SAME connection still hydrates (begin →
 *       clear+replay → end) — the pull path is the one entry point and it
 *       works.
 *   T2. Flag-less client: the tc-5quo bulk push is UNCHANGED (unsolicited
 *       begin + clear+replay arrive) — the suppression is flag-scoped, not a
 *       behavior change for clients that never send `pane.attach`.
 *   T3. pullHydration + primaryPaneId (targeted attach): the targeted-primary
 *       push is suppressed too — BOTH unsolicited forms are closed.
 *
 * The replay-frame detector keys on the CLEAR_AND_SCROLLBACK prefix
 * (`ESC[H ESC[2J ESC[3J`) that every hydration frame starts with — an idle
 * shell pane emits no such sequence on its own.
 *
 * @module runtime/pull-hydration.e2e.test
 */
export {};
//# sourceMappingURL=pull-hydration.e2e.test.d.ts.map