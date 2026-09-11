import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createFleetTrust } from "./fleet-tls";
import { withFleetResources } from "./fleet-resources";
import { WORKTREE_ROOT } from "./env";

export const WINGMAN_REVISION = "911ae540db00d822e01c80b6c5236c1fffe719c3";
export function pinnedWingmanRoot() {
  const root = process.env.E2E_WINGMAN_ROOT;
  if (!root || resolve(root) !== root)
    throw new Error(
      "[fleet-e2e] E2E_WINGMAN_ROOT must name an absolute pinned checkout (no optional skip)",
    );
  const actual = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const diff = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", "wingman"],
    {
      encoding: "utf8",
    },
  );
  if (actual !== WINGMAN_REVISION || diff)
    throw new Error(
      "[fleet-e2e] Wingman production source does not match the immutable Task9b pin",
    );
  return root;
}
async function main() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("[fleet-e2e] insecure ambient TLS configuration refused");
  pinnedWingmanRoot();
  if (!process.env.E2E_WINGMAN_PYTHON)
    throw new Error(
      "[fleet-e2e] E2E_WINGMAN_PYTHON must name the locked Wingman environment interpreter",
    );
  const browsers =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    dirname(dirname(dirname(chromium.executablePath())));
  let child: ReturnType<typeof spawn> | undefined;
  let cancelled = false;
  // Playwright handles graceful interruption through SIGINT, not SIGTERM.
  // A second SIGINT can cancel its teardown task, so forward cancellation once.
  const onSignal = () => {
    if (cancelled) return;
    cancelled = true;
    child?.kill("SIGINT");
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await withFleetResources(async (own) => {
      const trust = own(createFleetTrust(), (trust) => trust.close());
      // CA bootstrap must precede Node/urllib imports and Chromium launch. An
      // isolated HOME gives Chromium a throwaway NSS database and fresh profile.
      child = own(
        spawn(
          process.execPath,
          [
            join(WORKTREE_ROOT, "e2e/fleet-playwright.mjs"),
            "test",
            "e2e/fleet-access.spec.ts",
            "e2e/fleet-joint.spec.ts",
            ...process.argv.slice(2),
          ],
          {
            cwd: WORKTREE_ROOT,
            env: {
              ...process.env,
              E2E_FLEET_INTEGRATIONS: "1",
              E2E_FLEET_TLS_ROOT: trust.root,
              NODE_EXTRA_CA_CERTS: trust.ca,
              HOME: trust.home,
              PLAYWRIGHT_BROWSERS_PATH: browsers,
            },
            stdio: "inherit",
          },
        ),
        async (child) => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            const closed = once(child, "close");
            child.kill("SIGINT");
            await closed;
          }
        },
      );
      const [code] = await once(child, "close");
      process.exitCode = cancelled ? 1 : typeof code === "number" ? code : 1;
    });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(WORKTREE_ROOT, "e2e/fleet-run.ts")
)
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error && error.message.startsWith("[fleet-e2e]")
        ? error.message
        : "[fleet-e2e] joint launcher failed; verify explicit pin/interpreter and isolated TLS prerequisites",
    );
    process.exitCode = 1;
  });
