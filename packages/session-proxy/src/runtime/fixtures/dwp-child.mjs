// dwp-child.mjs — test fixture for die-with-parent.test.ts (tc-2c5).
//
// Plays the "session-proxy" role: imports the real die-with-parent module (URL given
// in argv — a .ts file, resolved by the tsx loader the test spawns us with),
// installs the watchdog with PRODUCTION defaults (1 s poll, self-SIGTERM,
// 1.5 s hard-exit backstop), reports readiness, and idles forever.
//
// No SIGTERM handler is installed, so the default disposition terminates the
// process when the watchdog fires — like a session-proxy whose graceful path is the
// signal default.
//
// Usage: node --import tsx dwp-child.mjs <die-with-parent-module-url>

const moduleUrl = process.argv[2];
if (!moduleUrl) {
  process.stderr.write("usage: dwp-child.mjs <die-with-parent-module-url>\n");
  process.exit(1);
}

const { installDieWithParent } = await import(moduleUrl);
installDieWithParent();

process.stdout.write("CHILD_READY\n");

// Keep the child alive until the watchdog (or the test) takes it down.
setInterval(() => {}, 60_000);
