/**
 * Broker entry point — spawned as a child process by the VS Code extension
 * (or any other launcher) to start a broker for a given tmux socket name.
 *
 * Arguments:
 *   --socket-name <name>   tmux socket name (= broker socket directory name)
 *
 * Optional arguments:
 *   --runtime-dir <path>   override the base runtime directory
 *
 * Protocol:
 *   1. Parse arguments.
 *   2. Create and start a broker (createBroker from ./broker.js).
 *   3. Write "READY\n" to stdout so the launcher knows we are listening.
 *   4. On SIGTERM: call broker.shutdown() and exit cleanly.
 *
 * This mirrors the daemon-entry.ts pattern: a thin entry script whose
 * only job is argument parsing → start → READY signal → SIGTERM handling.
 *
 * @module broker-entry
 */

import { createBroker } from "./broker.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { socketName: string; runtimeDir?: string } {
  const args = process.argv.slice(2);
  let socketName = "";
  let runtimeDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--socket-name":
        socketName = args[++i] ?? "";
        break;
      case "--runtime-dir":
        runtimeDir = args[++i] ?? undefined;
        break;
    }
  }

  if (!socketName) {
    process.stderr.write(
      "Usage: broker-entry --socket-name <name> [--runtime-dir <path>]\n",
    );
    process.exit(1);
  }

  return runtimeDir !== undefined ? { socketName, runtimeDir } : { socketName };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { socketName, runtimeDir } = parseArgs();

  const brokerOpts = runtimeDir !== undefined
    ? { socketName, runtimeDir }
    : { socketName };
  const broker = createBroker(brokerOpts);

  await broker.start();

  // Signal readiness to the launcher
  process.stdout.write("READY\n");

  // Handle SIGTERM gracefully
  process.once("SIGTERM", () => {
    void broker.shutdown().finally(() => {
      process.exit(0);
    });
  });
}

// Run
main().catch((err: unknown) => {
  process.stderr.write(`broker-entry fatal: ${String(err)}\n`);
  process.exit(1);
});
