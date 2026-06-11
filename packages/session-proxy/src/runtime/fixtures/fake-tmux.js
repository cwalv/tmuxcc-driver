#!/usr/bin/env node
/**
 * fake-tmux.js — hermetic fake tmux -CC server for unit testing TmuxHost.
 *
 * Emits a minimal valid tmux control-mode byte stream on stdout, then waits
 * for stdin commands, echoing synthetic responses, then exits cleanly.
 *
 * This is NOT a real tmux implementation — it exists solely to exercise the
 * TmuxHost pipe/lifecycle/onData/onExit plumbing without depending on a real
 * tmux binary or a PTY.
 *
 * Output sequence:
 *   1. DCS intro:  \x1bP1000p
 *   2. %begin ... %end  (initial empty response)
 *   3. %sessions-changed
 *   4. %session-changed $0 fakesession
 *   5. Waits for stdin lines; for each line echoes:
 *      %begin <ts> <n> 0\r\n<line-back>\r\n%end <ts> <n> 0\r\n
 *   6. On stdin EOF (or "quit\n"): writes %exit\r\n then \x1b\\ (ST) then exits.
 *
 * Usage: node fake-tmux.js [--exit-code <n>]
 *
 * NOTE: This script is intentionally NOT wrapped with the pty bridge — it is
 * spawned directly via child_process.spawn with piped stdio so TmuxHost's pipe
 * plumbing is exercised hermetically. The PTY bridge is only needed for real
 * tmux. Pass the '--fake' flag to TmuxHostOptions... actually, the test spawns
 * fake-tmux directly as the 'pythonPath+bridgeArgs' (see test file).
 */
import { createInterface } from "node:readline";

const exitCode = (() => {
  const idx = process.argv.indexOf("--exit-code");
  if (idx !== -1 && process.argv[idx + 1] !== undefined) {
    return parseInt(process.argv[idx + 1], 10);
  }
  return 0;
})();

const ts = () => Math.floor(Date.now() / 1000);
let cmdNum = 270;

function write(s) {
  process.stdout.write(s);
}

// 1. DCS intro
write("\x1bP1000p");

// 2. Initial %begin/%end (tmux always sends this right after DCS open)
const t0 = ts();
write(`%begin ${t0} ${cmdNum} 0\r\n%end ${t0} ${cmdNum} 0\r\n`);
cmdNum++;

// 3-4. Session notifications
write(`%sessions-changed\r\n`);
write(`%session-changed $0 fakesession\r\n`);

// 5. Read stdin commands and echo responses
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let n = 0;

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "quit" || trimmed === "detach") {
    // Graceful exit sequence
    rl.close();
    return;
  }
  if (trimmed === "") return;

  const t = ts();
  const cn = cmdNum++;
  // Echo back the command as the body of a %begin/%end block
  write(`%begin ${t} ${cn} 0\r\n${trimmed}\r\n%end ${t} ${cn} 0\r\n`);
  n++;
});

rl.on("close", () => {
  // 6. Exit sequence
  write(`%exit\r\n`);
  write("\x1b\\"); // ST (DCS close)
  // Flush stdout then exit; without explicit exit the process hangs on
  // open stdout/stderr fds. Use setImmediate to let the writes drain.
  setImmediate(() => process.exit(exitCode));
});

// Guard: exit after 30s even if stdin never closes (prevents test leaks)
setTimeout(() => {
  write(`%exit\r\n`);
  write("\x1b\\");
  process.exit(exitCode);
}, 30_000).unref();
