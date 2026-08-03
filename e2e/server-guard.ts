import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import {
  APP_PORT,
  BASE_URL,
  IS_CI,
  IS_RUNNER,
  TEST_DATABASE_URL,
  WORKTREE_ROOT,
} from "./env";

/**
 * Decides whether an already-running dev server on this worktree's port may be
 * reused.
 *
 * Why this exists: `reuseExistingServer` used to be a flat `!process.env.CI`
 * against a hardcoded port 3111. When a sibling worktree happened to hold 3111,
 * Playwright attached to it and the suite exercised *that* worktree's code
 * against *that* worktree's database — and passed. A false green is far worse
 * than a false red, because nothing prompts you to look.
 *
 * Per-worktree ports make that collision unlikely but not impossible (hashes
 * collide, and people set E2E_PORT by hand). So reuse is granted only when the
 * process holding the port can be *proved* to belong to this worktree and to be
 * reading this run's database. Anything unproven is a hard error naming the
 * override, never a silent attach.
 */

interface PortOwner {
  pid: number;
  cwd: string | null;
  databaseUrl: string | null;
}

function listenerPid(port: number): number | null {
  const probes: Array<[string, string[]]> = [
    ["ss", ["-lntpH", `sport = :${port}`]],
    ["lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]],
  ];
  for (const [cmd, args] of probes) {
    try {
      const out = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pid = /pid=(\d+)/.exec(out)?.[1] ?? out.trim().split("\n")[0];
      if (pid && Number(pid)) return Number(pid);
    } catch {
      // Probe unavailable or found nothing; try the next one.
    }
  }
  return null;
}

/** Reads the owner's identity from /proc. Returns nulls where unreadable. */
function describeOwner(pid: number): PortOwner {
  let cwd: string | null = null;
  let databaseUrl: string | null = null;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    cwd = null;
  }
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    databaseUrl = environ.find((e) => e.startsWith("DATABASE_URL="))?.slice(13) ?? null;
  } catch {
    databaseUrl = null;
  }
  return { pid, cwd, databaseUrl };
}

function isPortFree(port: number): boolean {
  return listenerPid(port) === null;
}

function stop(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (isPortFree(APP_PORT)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

const OVERRIDE_HINT = `Re-run on a port of your choosing:\n  E2E_PORT=<free port> npm run test:e2e`;

/**
 * @param dbRecreated whether provisioning just created or restarted the
 * database. A server that predates a recreated database holds a pool against
 * storage that may no longer exist, so it is never reused.
 */
export function resolveServerReuse(dbRecreated: boolean): boolean {
  // Only the runner starts servers. A worker re-importing the config must not
  // probe the port, and must never reach stop() — that would kill the server
  // the suite is mid-way through using.
  if (!IS_RUNNER) return true;

  // CI starts from a clean runner and must never attach to anything. This is
  // the same answer the old `!process.env.CI` gave.
  if (IS_CI) return false;

  const pid = listenerPid(APP_PORT);
  if (pid === null) return true; // Nothing to attach to; Playwright starts its own.

  const owner = describeOwner(pid);

  if (owner.cwd !== WORKTREE_ROOT) {
    throw new Error(
      `[e2e] ${BASE_URL} is held by pid ${pid}, which does not belong to this ` +
        `worktree.\n` +
        `  this worktree: ${WORKTREE_ROOT}\n` +
        `  port holder:   ${owner.cwd ?? "<unreadable — foreign user or container>"}\n` +
        `Refusing to attach: the suite would test that process's code against ` +
        `its database and report a pass that never touched this branch.\n` +
        OVERRIDE_HINT,
    );
  }

  // Ours, but pointed at a different database than this run will seed — the
  // two-sources-of-truth bug in server form. Restart it.
  if (owner.databaseUrl !== TEST_DATABASE_URL) {
    stop(pid);
    return false;
  }

  if (dbRecreated) {
    stop(pid);
    return false;
  }

  return true;
}
