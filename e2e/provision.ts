import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTAINER_NAME,
  DB_PORT,
  SHOULD_PROVISION,
  TEST_DATABASE_URL,
  WORKTREE_ROOT,
} from "./env";

/**
 * Stands up a Postgres container dedicated to this worktree.
 *
 * Everything here is synchronous on purpose. Playwright starts `webServer`
 * during plugin setup, which runs *before* `globalSetup`
 * (`createGlobalSetupTasks` in the runner orders plugins first), so a
 * `globalSetup` hook cannot guarantee a migrated database exists before
 * `next dev` boots, and cannot inspect the port ahead of the server that is
 * about to bind it. Config module load is the only point early enough, and
 * config loading is synchronous.
 *
 * The container is deliberately *not* torn down between runs. A throwaway
 * container per run would cost a fresh initdb plus a full migration every time,
 * and it would leave a reused dev server holding a pool against a database that
 * no longer exists — the exact stale-server failure this harness has to prevent.
 * Keeping it warm means a reused server always finds the same live database.
 */

const IMAGE = "postgres:16-alpine";
const STAMP_DIR = join(WORKTREE_ROOT, "tmp", "e2e");

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function docker(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("docker", args, { encoding: "utf8" });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

function requireDocker(): void {
  if (docker(["version", "--format", "{{.Server.Version}}"]).ok) return;
  throw new Error(
    `[e2e] Docker is not available, so the per-worktree test database cannot be ` +
      `started.\n` +
      `Either start Docker, or point the suite at a database you manage:\n` +
      `  TEST_DATABASE_URL=postgres://user:pass@host:port/db npm run test:e2e`,
  );
}

/** Host port this container currently publishes for 5432, if it exists. */
function publishedPort(): number | null {
  const res = docker([
    "inspect",
    "-f",
    '{{range $p := index .NetworkSettings.Ports "5432/tcp"}}{{$p.HostPort}}{{end}}',
    CONTAINER_NAME,
  ]);
  if (!res.ok || !res.stdout) return null;
  return Number(res.stdout) || null;
}

function containerState(): "missing" | "running" | "stopped" {
  const res = docker(["inspect", "-f", "{{.State.Running}}", CONTAINER_NAME]);
  if (!res.ok) return "missing";
  return res.stdout === "true" ? "running" : "stopped";
}

function waitForReady(): void {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (
      docker(["exec", CONTAINER_NAME, "pg_isready", "-U", "authgd", "-d", "authgd_test"])
        .ok
    ) {
      return;
    }
    sleepSync(500);
  }
  throw new Error(
    `[e2e] Postgres container ${CONTAINER_NAME} did not become ready within 60s.\n` +
      `Inspect it with: docker logs ${CONTAINER_NAME}`,
  );
}

function createContainer(): void {
  const res = docker([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-e",
    "POSTGRES_USER=authgd",
    "-e",
    "POSTGRES_PASSWORD=authgd",
    "-e",
    "POSTGRES_DB=authgd_test",
    "-p",
    `${DB_PORT}:5432`,
    IMAGE,
  ]);
  if (res.ok) return;

  // A hash collision, or an unrelated service, already owns the port. Say so
  // rather than letting the suite fail later on a database it never reached.
  if (/port is already allocated|address already in use/i.test(res.stderr)) {
    docker(["rm", "-f", CONTAINER_NAME]);
    throw new Error(
      `[e2e] Host port ${DB_PORT} is already in use, so the test database for ` +
        `this worktree could not start.\n` +
        `Find the holder with: docker ps --filter publish=${DB_PORT}\n` +
        `Then re-run with an explicit port: E2E_DB_PORT=<free port> npm run test:e2e`,
    );
  }
  throw new Error(`[e2e] Failed to start ${CONTAINER_NAME}:\n${res.stderr}`);
}

/**
 * Migrations are the slow part, so they run only when something actually
 * changed: a new container, or an edit under drizzle/. The stamp lives in
 * gitignored tmp/ and is keyed on the container id, so a recreated container
 * always re-migrates even if the migration set is untouched.
 */
function migrationStamp(): string {
  const containerId = docker(["inspect", "-f", "{{.Id}}", CONTAINER_NAME]).stdout;
  let journal = "";
  try {
    journal = readFileSync(
      join(WORKTREE_ROOT, "drizzle", "meta", "_journal.json"),
      "utf8",
    );
  } catch {
    // No journal readable — fall through to a stamp that never matches, which
    // makes the run migrate rather than assume it is up to date.
    journal = String(Date.now());
  }
  return createHash("sha256").update(`${containerId}\0${journal}`).digest("hex");
}

function migrate(): void {
  const res = spawnSync("npx", ["tsx", "src/db/migrate.ts"], {
    cwd: WORKTREE_ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
  if (res.status !== 0) {
    throw new Error(
      `[e2e] Migrating ${TEST_DATABASE_URL} failed:\n${res.stdout ?? ""}${res.stderr ?? ""}`,
    );
  }
}

export interface ProvisionResult {
  /**
   * True when the database was created or restarted during this call. The
   * caller uses it to decide whether a dev server left over from a previous run
   * may still be holding connections to a database that no longer exists.
   */
  recreated: boolean;
}

export function ensureTestDatabase(): ProvisionResult {
  // CI stands up its own Postgres service, and an explicit TEST_DATABASE_URL
  // means the developer is managing the database themselves. Both opt out.
  if (!SHOULD_PROVISION) return { recreated: false };

  requireDocker();

  let recreated = false;
  let state = containerState();

  // An existing container published on a different host port would leave the
  // URL in env.ts pointing nowhere. Recreate it rather than silently disagree.
  if (state !== "missing" && publishedPort() !== DB_PORT) {
    docker(["rm", "-f", CONTAINER_NAME]);
    state = "missing";
  }

  if (state === "missing") {
    createContainer();
    recreated = true;
  } else if (state === "stopped") {
    const res = docker(["start", CONTAINER_NAME]);
    if (!res.ok)
      throw new Error(`[e2e] Failed to start ${CONTAINER_NAME}:\n${res.stderr}`);
    recreated = true;
  }

  waitForReady();

  const stampFile = join(STAMP_DIR, `${CONTAINER_NAME}.stamp`);
  const stamp = migrationStamp();
  let applied = "";
  try {
    applied = readFileSync(stampFile, "utf8");
  } catch {
    applied = "";
  }
  if (applied !== stamp) {
    migrate();
    mkdirSync(STAMP_DIR, { recursive: true });
    writeFileSync(stampFile, stamp);
  }

  return { recreated };
}
