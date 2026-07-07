#!/usr/bin/env node
// tmuxcc workspace-root npm guard (tc-k68g, hardened by tc-rs99).
//
// Intent: a developer who `cd`s into a workspace MEMBER subdir and runs
// `npm install` / `npm run build` directly silently no-ops the hoisted
// workspace (stale/missing dist, cryptic `tsc: not found`). Block that and
// point them at the root. Wired as each member's `preinstall` + `prebuild`:
//   "prebuild": "node ../../scripts/npm-root-guard.mjs"
//
// WHY THIS IS MORE THAN `INIT_CWD === cwd` (the tc-rs99 false-positive):
// npm exposes NO env var that distinguishes a DIRECT subdir invocation from a
// NESTED, root-initiated lifecycle build. The full npm_* env, INIT_CWD,
// npm_config_user_agent and npm_config_local_prefix are byte-identical in both
// (verified empirically, npm 10.9.7) — so option (a) "detect nesting from npm's
// lifecycle env" is not achievable. And `INIT_CWD === cwd` is TRUE for BOTH:
//   - direct subdir `npm run build`               (INIT_CWD = member = cwd) -> BLOCK
//   - a member lifecycle script that spawns a nested `npm run build`
//     (e.g. `pretest: "npm run build"`): the nested npm RE-SETS INIT_CWD to the
//     member dir, so INIT_CWD = cwd even though the user ran from the root.
//     This false-positive RED'd the canonical gate (gate:fast). -> must ALLOW
// `INIT_CWD === cwd` alone therefore cannot tell those two apart.
//
// DISCRIMINATOR (option b — root sentinel, the only documented-behavior one):
// child processes inherit env, so a root-initiated flow exports
// TMUXCC_NPM_FROM_ROOT=1 (see the workweave-root package.json fan-out scripts)
// and every nested npm lifecycle script inherits it. We ALSO allow the classic
// root `-w` fan-out, where npm runs the member script from the *root* cwd so
// INIT_CWD !== cwd. We BLOCK only when NEITHER holds: no sentinel AND
// INIT_CWD === cwd, which is exactly a true direct-subdir invocation.
//
// Keep this file self-contained per repo (no cross-repo import) — the vscode
// repo carries an identical copy; its unit test pins the two behaviours.

import { createRequire } from "node:module";

const SENTINEL = "TMUXCC_NPM_FROM_ROOT";

/**
 * @param {{ fromRoot: boolean, initCwd: string | undefined, cwd: string }} ctx
 * @returns {boolean} true when this is a direct subdir invocation (must block)
 */
export function isBlockedDirectSubdir({ fromRoot, initCwd, cwd }) {
  if (fromRoot) return false; // nested under a validated root flow -> allow
  return Boolean(initCwd) && initCwd === cwd; // direct subdir -> block
}

// Only run the side-effecting guard when invoked as a script, not when imported
// by the unit test.
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const cwd = process.cwd();
  const blocked = isBlockedDirectSubdir({
    fromRoot: process.env[SENTINEL] === "1",
    initCwd: process.env.INIT_CWD,
    cwd,
  });

  if (blocked) {
    let name = "<this-package>";
    try {
      const require = createRequire(import.meta.url);
      name = require(`${cwd}/package.json`).name;
    } catch {
      /* fall back to the placeholder */
    }
    console.error(
      `[tmuxcc] npm must run from the weave/workweave ROOT, not this subdir (${cwd}).\n` +
        `[tmuxcc] From the root: npm install  |  npm run build -w ${name}`,
    );
    process.exit(1);
  }
}
