import childProcess from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

// Playwright 1.62.1 claims a WorkerHost before awaiting mkdir, then forks it.
// SIGINT in that await calls stop() while process is undefined: __stop__ is
// discarded, but _didSendStop is latched. A later fork would wait five minutes
// and block webServer teardown. Dispose that late acquisition, not a PID found
// by scanning or a ready handshake (the lost stop precedes fork, not ready).
const fork = childProcess.fork;
let cancelled = false;
process.on("SIGINT", () => {
  cancelled = true;
});
childProcess.fork = function (...args) {
  const child = Reflect.apply(fork, this, args);
  if (cancelled) child.kill("SIGKILL");
  // ProcessHost installs its exit/reap listener synchronously after fork returns.
  return child;
};

const cli = fileURLToPath(
  new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
);
process.argv[1] = cli;
await import(cli);
