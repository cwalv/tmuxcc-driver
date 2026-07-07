/**
 * claim-session.test.ts — unit tests for the claim/activate path (tc-u4ny.2).
 *
 * # Coverage focus
 *
 * These tests target the structured-code discrimination in `doClaimSession`.
 * Instead of substring-matching tmux's free-text stderr, claim-session
 * discriminates via {@link isCommandError} with the structured code exported
 * from tmux-south — keeping the adapter's prose wording adapter-internal.
 *
 * ## Lost-create-race path (tc-u4ny.2)
 *
 * The "lost-create-race" path: `createSession` throws the session-name-taken
 * code (tmux-south classifies the collision) AND the subsequent `lookupByName`
 * still cannot find the session (deleted between the collision and the
 * refresh). The handler must throw `CommandError("internal", ...)` — not a
 * raw-prose error — so the dispatcher's `toCommandFailure` encodes it.
 *
 * The test is guarded by real-tmux availability because it uses a live
 * `createSession` call to trigger the name collision.
 *
 * @module claim-session.test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { createSessionClaimer } from "./claim-session.js";
import type { ClaimSessionContext, ClaimSessionEntry } from "./claim-session.js";
import { TMUX_SESSION_NAME_TAKEN_CODE } from "./tmux-south.js";
import { isCommandError } from "@tmuxcc/protocol";
import type { SessionId } from "@tmuxcc/protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;

function nextSocketName(): string {
  return `tmuxcc-test-cs-${process.pid}-${++counter}-${Date.now()}`;
}

function tmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
  return r.status === 0 && !r.error;
}

function killServer(socketName: string): void {
  spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", timeout: 5_000 });
}

const TMUX_AVAILABLE = tmuxAvailable();

// ---------------------------------------------------------------------------
// Lost-create-race path
// ---------------------------------------------------------------------------

describe(
  "createSessionClaimer — lost-create-race path (tc-u4ny.2)",
  { skip: !TMUX_AVAILABLE },
  () => {
    // tc-u4ny.2: when tmux-south emits the session-name-taken CommandError and
    // the subsequent lookup still fails (the session vanished between the
    // collision and the refresh), claim-session must throw
    // CommandError("internal") — discriminating via the structured code constant,
    // not via prose substring matching.
    it(
      "throws CommandError internal when the session cannot be found after a name-collision",
      async () => {
        const socketName = nextSocketName();
        try {
          // Seed the tmux server so that a second createSession call for the
          // same name collides and emits the structured name-taken code.
          const seedResult = spawnSync(
            "tmux",
            ["-L", socketName, "new-session", "-d", "-s", "lost-race"],
            { encoding: "utf8", timeout: 5_000 },
          );
          assert.equal(
            seedResult.status,
            0,
            `seed new-session failed: ${seedResult.stderr}`,
          );

          // Build a mock context that never finds the session in the table —
          // simulating the "truly lost race": another process created the
          // session, then deleted it before our refresh could see it.
          const mockEntry: ClaimSessionEntry = {
            sessionId: "s1" as SessionId,
            name: "lost-race",
          };
          void mockEntry; // unused; lookup always returns undefined below

          const ctx: ClaimSessionContext = {
            socketName,
            getCapabilities: () => undefined,
            refreshSessions: async () => {},
            // Always returns undefined — simulates the session having vanished
            // after the name collision before our refresh can see it.
            lookupByName: (_name: string): ClaimSessionEntry | undefined => undefined,
            registerSession: (_tmuxId: string, name: string): ClaimSessionEntry => ({
              sessionId: "s1" as SessionId,
              name,
            }),
            ensureSessionProxy: async (_sessionId: SessionId, _name: string): Promise<void> => {},
            onClaimComplete: () => {},
          };

          const claimer = createSessionClaimer(ctx);

          // Claim should:
          //   1. Look up "lost-race" → undefined (not in table)
          //   2. Call createSession → collision → tmux-south throws the
          //      structured name-taken code
          //   3. Discriminate via isCommandError(TMUX_SESSION_NAME_TAKEN_CODE)
          //   4. Refresh + lookup → still undefined (lost race)
          //   5. Throw CommandError("internal", "session.create race: ...")
          const err = await claimer.claim("lost-race").then(
            () => null,
            (e: unknown) => e,
          );

          assert.ok(
            isCommandError(err, "internal"),
            `Expected CommandError("internal") for the lost-race path, got: ${JSON.stringify(err)}`,
          );
          assert.ok(
            (err as Error).message.includes("session.create race"),
            `Expected "session.create race" in message, got: ${(err as Error).message}`,
          );
          // Verify the name-taken code constant is what the claimer discriminates —
          // this is the structured-code discrimination the bead mandates.
          assert.equal(
            TMUX_SESSION_NAME_TAKEN_CODE,
            "tmux.duplicate-session",
            "TMUX_SESSION_NAME_TAKEN_CODE must match the adapter wire code",
          );
        } finally {
          killServer(socketName);
        }
      },
    );
  },
);
