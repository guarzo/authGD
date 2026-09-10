import cp from "node:child_process";
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Test-only backstop. Keep actual creation handles so a RED cancellation test
// can drain its managed server without discovering processes or trusting a file.
const entry = path.basename(process.argv[1] || "");
if (["fleet-run.ts", "fleet-playwright.mjs", "cli.js"].includes(entry)) {
  if (entry !== "fleet-run.ts" && process.env.FLEET_RUNNER_TEST_COUNT_SIGNALS === "1")
    process.on("SIGINT", () => console.error("[fleet-runner-test] interruption"));
  if (entry === "fleet-run.ts") {
    const mkdtemp = fs.mkdtempSync;
    fs.mkdtempSync = function (...args) {
      const root = Reflect.apply(mkdtemp, this, args);
      process.send({ fleetOwnedRoot: root });
      return root;
    };
  }
  const children = [];
  let stopping;
  for (const method of ["spawn", "fork"]) {
    const original = cp[method];
    cp[method] = function (...args) {
      if (
        entry === "fleet-run.ts" &&
        process.env.FLEET_RUNNER_TEST_FAILED_SPAWN === "1"
      ) {
        args[0] = "/no-owned-playwright-executable";
      }
      const child = Reflect.apply(original, this, args);
      const group = method === "spawn" && args[2]?.detached === true;
      const closed = new Promise((resolve) => child.once("close", resolve));
      children.push({ child, group, closed });
      if (stopping) child.kill("SIGKILL");
      return child;
    };
  }
  process.on("SIGUSR2", () => {
    stopping ??= (async () => {
      const outcomes = await Promise.allSettled(
        children.map(async ({ child, group, closed }) => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            if (entry === "fleet-run.ts") child.kill("SIGUSR2");
            else if (group) process.kill(-child.pid, "SIGTERM");
            else child.kill("SIGKILL");
          }
          await closed;
        }),
      );
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        console.error("[fleet-e2e] test-owned backstop failed");
        process.exitCode = 1;
      }
    })();
  });
}
