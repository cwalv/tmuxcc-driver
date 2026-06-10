// dwp-parent.mjs — test fixture for die-with-parent.test.ts (tc-2c5).
//
// Plays the "server-proxy" role: spawns the command given in argv as a regular
// (non-detached) child, prints the child's pid, and then idles until killed.
// The test SIGKILLs THIS process and asserts the child exits on its own —
// proving the child's die-with-parent enforcement, since a SIGKILLed parent
// delivers no signal to its children.
//
// stdio wiring of the child:
//   stdin  — "inherit": the child shares THIS process's stdin.  When the test
//            holds that pipe open across the SIGKILL, the child sees no EOF —
//            simulating the leaked-fd case where only a getppid() watch can
//            detect parent death.
//   stdout/stderr — "inherit": child diagnostics flow to the test runner.
//
// Usage: node dwp-parent.mjs <cmd> [args...]

import { spawn } from "node:child_process";

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  process.stderr.write("usage: dwp-parent.mjs <cmd> [args...]\n");
  process.exit(1);
}

const child = spawn(cmd, args, { stdio: ["inherit", "inherit", "inherit"] });

child.once("error", (err) => {
  process.stderr.write(`dwp-parent: spawn error: ${String(err)}\n`);
  process.exit(1);
});

child.once("spawn", () => {
  process.stdout.write(`CHILD_PID=${child.pid}\n`);
});

// Keep the parent alive until the test kills it.
setInterval(() => {}, 60_000);
