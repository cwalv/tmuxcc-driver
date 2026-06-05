/**
 * Daemon entry point — spawned as a child process by the broker supervisor.
 *
 * Arguments:
 *   --socket-name  <name>   tmux socket name (passed as -L <name> to tmux)
 *   --session-name <name>   tmux session name to attach to
 *   --socket-path  <path>   unix socket path the daemon should listen on
 *
 * Protocol:
 *   1. Parse arguments.
 *   2. Create a unix socket server on `--socket-path`.
 *   3. Create and start a daemon (createDaemon from @tmuxcc/daemon).
 *   4. Write "READY\n" to stdout so the supervisor knows we are listening.
 *   5. Accept client connections in a loop, calling daemon.addClient(transport).
 *   6. On SIGTERM: call daemon.stop() and exit cleanly.
 *
 * This is the multiplexed-socket endpoint described in SCHEMA.md §"Data plane":
 * the same socket carries both control-plane (JSON) and data-plane (0xCC) traffic.
 *
 * @module daemon-entry
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDaemon } from "@tmuxcc/daemon";
import { createSocketTransport } from "./socket-transport.js";
import { removeSocket, restrictSocket } from "./runtime-dir.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { socketName: string; sessionName: string; socketPath: string } {
  const args = process.argv.slice(2);
  let socketName = "";
  let sessionName = "";
  let socketPath = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--socket-name":
        socketName = args[++i] ?? "";
        break;
      case "--session-name":
        sessionName = args[++i] ?? "";
        break;
      case "--socket-path":
        socketPath = args[++i] ?? "";
        break;
    }
  }

  if (!socketName || !sessionName || !socketPath) {
    process.stderr.write(
      "Usage: daemon-entry --socket-name <name> --session-name <name> --socket-path <path>\n",
    );
    process.exit(1);
  }

  return { socketName, sessionName, socketPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { socketName, sessionName, socketPath } = parseArgs();

  // Remove stale socket file if present
  removeSocket(socketPath);

  // Create the daemon (not yet started)
  const daemon = createDaemon({
    host: {
      socketName,
      sessionName,
      attach: true, // broker creates session; daemon attaches
    },
  });

  // Create the unix socket server
  const server = net.createServer((socket) => {
    const transport = createSocketTransport(socket);
    void daemon.addClient(transport);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Restrict socket permissions to 0600
  restrictSocket(socketPath);

  // Start the daemon (spawns tmux -CC attach)
  try {
    await daemon.start();
  } catch (err: unknown) {
    process.stderr.write(`Daemon start failed: ${String(err)}\n`);
    server.close();
    removeSocket(socketPath);
    process.exit(1);
  }

  // Signal readiness to the broker supervisor
  process.stdout.write("READY\n");

  // Handle SIGTERM gracefully
  process.once("SIGTERM", () => {
    daemon.stop().finally(() => {
      server.close(() => {
        removeSocket(socketPath);
        process.exit(0);
      });
    });
  });

  // Handle daemon host exit (tmux crashed or session ended)
  // The daemon.start() installs an onExit handler that broadcasts session.unavailable.
  // We watch for it here to clean up the server.
  // Note: daemon.host is exposed on the Daemon interface.
  daemon.host.onExit(() => {
    // Give connected clients a moment to receive the session.unavailable error
    setTimeout(() => {
      server.close(() => {
        removeSocket(socketPath);
        process.exit(0);
      });
    }, 500);
  });
}

// Run
main().catch((err: unknown) => {
  process.stderr.write(`daemon-entry fatal: ${String(err)}\n`);
  process.exit(1);
});
