import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { buildSync } from "esbuild";
import {
  BASE_URL,
  IS_CI,
  SYNTHETIC_APP_ENV,
  TEST_DATABASE_URL,
  WORKTREE_ROOT,
} from "./env";
import { startFleetFixtures, type FixtureConnection } from "./fleet-fixtures";

export const FLEET_CONNECTION_FILE = join(WORKTREE_ROOT, "tmp/e2e/fleet-connection.json");
const preload = join(WORKTREE_ROOT, "tmp/e2e/fleet-preload.mjs");
const fontResponses = join(WORKTREE_ROOT, "e2e/fleet-font-responses.json");
let preloadBuilt = false;

function buildPreload() {
  if (preloadBuilt) return;
  // Compile before spawning any intercepted process. Runtime tsx compilation
  // creates esbuild workers which inherit NODE_OPTIONS and recursively try to
  // compile their own preload; a rejected handshake can then deadlock startup.
  mkdirSync(join(WORKTREE_ROOT, "tmp/e2e"), { recursive: true });
  buildSync({
    entryPoints: [join(WORKTREE_ROOT, "e2e/fleet-preload.mjs")],
    outfile: preload,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    define: { __dirname: JSON.stringify(join(WORKTREE_ROOT, "e2e")) },
  });
  preloadBuilt = true;
}

export function assertFleetDatabaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "postgres:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.port ||
    url.username !== "authgd" ||
    url.password !== "authgd" ||
    !/^\/authgd_test(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "[fleet-e2e] database must be an explicit local disposable authgd test database, without URL options",
    );
  }
  return url;
}

function assertAppUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    raw !== url.origin
  ) {
    throw new Error(
      "[fleet-e2e] app must be a canonical explicit loopback origin without a trailing slash",
    );
  }
  return url;
}

function assertNoDotenv() {
  // Next automatically loads these. Stat names only; never read their contents.
  for (const name of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local",
  ]) {
    if (existsSync(join(WORKTREE_ROOT, name)))
      throw new Error(
        `[fleet-e2e] refuses dotenv file ${name}; use a credential-free worktree`,
      );
  }
}

export function fleetFontWorkerPort(): string | null {
  // Next evaluates the font mock in a Node child rooted beside the fixture,
  // with its one compiler IPC port in argv[2]. Keep that child intercepted too.
  const script = process.argv[1] ?? "";
  const port = process.argv[2] ?? "";
  return resolve(process.cwd()) === dirname(fontResponses) &&
    dirname(script) === join(WORKTREE_ROOT, ".next/dev/build/chunks") &&
    /^pool_entry-\[mock\]_loader_[\w-]+\.js$/.test(basename(script)) &&
    /^\d+$/.test(port) &&
    Number(port) > 0 &&
    Number(port) <= 65535
    ? port
    : null;
}

export function assertFleetEnvironment(env: NodeJS.ProcessEnv): FixtureConnection {
  if (
    env.E2E_FLEET_INTEGRATIONS !== "1" ||
    env.E2E_DB_ISOLATION !== "1" ||
    env.SYNC_MODE !== "live" ||
    env.E2E_MANAGED_WORKTREE !== WORKTREE_ROOT ||
    (resolve(process.cwd()) !== WORKTREE_ROOT && fleetFontWorkerPort() === null)
  )
    throw new Error("[fleet-e2e] invalid integration profile/worktree");
  if (!env.NODE_OPTIONS?.includes(preload))
    throw new Error("[fleet-e2e] interception preload missing");
  if (
    env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES !== fontResponses ||
    !existsSync(fontResponses)
  )
    throw new Error("[fleet-e2e] controlled offline font responses missing");
  assertNoDotenv();
  const db = assertFleetDatabaseUrl(env.DATABASE_URL ?? "");
  if (env.TEST_DATABASE_URL !== db.href)
    throw new Error("[fleet-e2e] database configuration disagrees");
  assertAppUrl(env.APP_BASE_URL ?? "");
  for (const [key, value] of Object.entries(SYNTHETIC_APP_ENV)) {
    if (env[key] !== value) throw new Error(`[fleet-e2e] non-synthetic ${key}`);
  }
  for (const key of [
    "DISCORD_OPS_WEBHOOK_URL",
    "DISCORD_STRUCTURE_WEBHOOK_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NODE_USE_ENV_PROXY",
  ]) {
    if (env[key]) throw new Error(`[fleet-e2e] unexpected ${key}`);
  }
  const connection = JSON.parse(
    env.E2E_FLEET_FIXTURE ?? "null",
  ) as FixtureConnection | null;
  if (
    !connection ||
    connection.worktree !== WORKTREE_ROOT ||
    connection.appUrl !== env.APP_BASE_URL ||
    !/^[a-f0-9]{64}$/.test(connection.token)
  )
    throw new Error("[fleet-e2e] missing owned fixture channel");
  const fixtureUrl = new URL(connection.url);
  if (
    fixtureUrl.protocol !== "http:" ||
    fixtureUrl.hostname !== "127.0.0.1" ||
    !fixtureUrl.port ||
    fixtureUrl.username ||
    fixtureUrl.password ||
    fixtureUrl.pathname !== "/" ||
    fixtureUrl.search ||
    fixtureUrl.hash
  )
    throw new Error("[fleet-e2e] fixture must be a literal loopback origin");
  return connection;
}

export function fleetEnvironment(input: {
  databaseUrl: string;
  appUrl: string;
  fixture: FixtureConnection;
  mode?: "dev" | "start";
}): NodeJS.ProcessEnv {
  assertFleetDatabaseUrl(input.databaseUrl);
  assertAppUrl(input.appUrl);
  // No ambient credentials, proxy settings, NODE_OPTIONS or dotenv inheritance.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: input.mode === "start" ? "production" : "development",
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "SystemRoot"])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, SYNTHETIC_APP_ENV, {
    DATABASE_URL: input.databaseUrl,
    TEST_DATABASE_URL: input.databaseUrl,
    APP_BASE_URL: input.appUrl,
    SYNC_MODE: "live",
    E2E_FLEET_INTEGRATIONS: "1",
    E2E_MANAGED_WORKTREE: WORKTREE_ROOT,
    E2E_FLEET_FIXTURE: JSON.stringify(input.fixture),
    E2E_DB_ISOLATION: "1",
    NODE_OPTIONS: `--import=${preload}`,
    NODE_ENV: input.mode === "start" ? "production" : "development",
    NEXT_TELEMETRY_DISABLED: "1",
    // Turbopack fetches Google fonts natively, outside the Node socket guard.
    // Next's test seam supplies local-only CSS; production fonts stay untouched.
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: fontResponses,
  });
  assertFleetEnvironment(env);
  buildPreload();
  return env;
}

export async function assertFreePort(appUrl: string) {
  const url = assertAppUrl(appUrl);
  // Refuse any holder, even a matching worktree/DB. Never stop it or attach.
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer();
    try {
      server.listen(Number(url.port), host);
      await once(server, "listening");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Next binds IPv4. Missing IPv6 loopback is not an occupied app port.
      if (host === "::1" && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT"))
        continue;
      throw new Error(`[fleet-e2e] app port ${url.port} unavailable; refusing reuse`, {
        cause: error,
      });
    } finally {
      if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    }
  }
}

async function verifyDatabase(raw: string) {
  const url = assertFleetDatabaseUrl(raw);
  const client = new Client({
    connectionString: raw,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{
      db: string;
      role: string;
      gate: string | null;
    }>(
      "SELECT current_database() AS db, current_user AS role, to_regclass('public.fleet_access_check_gate')::text AS gate",
    );
    if (
      rows[0]?.db !== url.pathname.slice(1) ||
      rows[0]?.role !== "authgd" ||
      !rows[0]?.gate
    )
      throw new Error("[fleet-e2e] disposable database identity/schema not verified");
  } finally {
    await client.end();
  }
}

async function stopChild(child: ChildProcess) {
  if (!child.pid) return;
  // A separate POSIX group owns Next's forked server too. Never discover/kill
  // processes by port or cwd; only signal the group this launcher created.
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, "exit"), delay(3000)]);
  }
  signal("SIGKILL");
}

export async function startFleetServer(input: {
  databaseUrl: string;
  appUrl: string;
  mode?: "dev" | "start";
  publishConnection?: boolean;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  assertNoDotenv();
  assertFleetDatabaseUrl(input.databaseUrl);
  if (process.platform === "win32")
    throw new Error("[fleet-e2e] launcher requires POSIX process groups (Linux/CI)");
  await assertFreePort(input.appUrl);
  await verifyDatabase(input.databaseUrl);
  const fixtures = await startFleetFixtures({
    appUrl: input.appUrl,
    worktree: WORKTREE_ROOT,
  });
  let child: ChildProcess | undefined;
  let output = "";
  let closed = false;
  let published = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (child) await stopChild(child);
      // Include shutdown requests in the verdict, not just test-body traffic.
      await fixtures.client.assertClean();
    } finally {
      await fixtures.close();
      if (published && existsSync(FLEET_CONNECTION_FILE)) {
        const stored = JSON.parse(
          readFileSync(FLEET_CONNECTION_FILE, "utf8"),
        ) as FixtureConnection;
        if (stored.token === fixtures.connection.token) unlinkSync(FLEET_CONNECTION_FILE);
      }
    }
  }
  try {
    input.signal?.throwIfAborted();
    const env = fleetEnvironment({ ...input, fixture: fixtures.connection });
    const mode = input.mode ?? "dev";
    child = spawn(
      process.execPath,
      [
        join(WORKTREE_ROOT, "node_modules/next/dist/bin/next"),
        mode,
        "-H",
        "127.0.0.1",
        "-p",
        new URL(input.appUrl).port,
      ],
      {
        cwd: WORKTREE_ROOT,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
    });
    const deadline = Date.now() + 50_000;
    while (true) {
      input.signal?.throwIfAborted();
      if (spawnError || child.exitCode !== null || child.signalCode !== null)
        throw new Error(`[fleet-e2e] Next failed before readiness\n${output}`, {
          cause: spawnError,
        });
      if (Date.now() > deadline)
        throw new Error(`[fleet-e2e] Next readiness timed out\n${output}`);
      const res = await fetch(`${input.appUrl}/login`, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => null);
      input.signal?.throwIfAborted();
      if (res?.ok) break;
      await delay(100);
    }
    const state = await fixtures.client.snapshot();
    if (state.preloads.length < (mode === "dev" ? 2 : 1))
      throw new Error("[fleet-e2e] missing Next child interception handshake");
    await fixtures.client.assertClean();
    input.signal?.throwIfAborted();
    if (input.publishConnection) {
      mkdirSync(join(WORKTREE_ROOT, "tmp/e2e"), { recursive: true });
      writeFileSync(FLEET_CONNECTION_FILE, JSON.stringify(fixtures.connection), {
        flag: "wx",
        mode: 0o600,
      });
      published = true;
    }
    return { fixtures, child, close, output: () => output };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  if (process.env.E2E_FLEET_INTEGRATIONS !== "1")
    throw new Error("[fleet-e2e] integration profile required");
  const controller = new AbortController();
  let owned: Awaited<ReturnType<typeof startFleetServer>> | undefined = undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    let failed = false;
    try {
      await owned?.close();
    } catch (error) {
      failed = true;
      console.error(error);
    }
    process.exitCode = failed ? 1 : 0;
  };
  const onSignal = () => {
    controller.abort(new Error("[fleet-e2e] cancelled harness startup"));
    if (owned) void shutdown();
  };
  // Install before any await: SIGTERM during compilation must also reap Next.
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  owned = await startFleetServer({
    databaseUrl: TEST_DATABASE_URL,
    appUrl: BASE_URL,
    mode: IS_CI ? "start" : "dev",
    publishConnection: true,
    signal: controller.signal,
  });
  console.log(`[fleet-e2e] intercepted Next ready at ${BASE_URL}`);
  owned.child.on("exit", () => {
    if (!shuttingDown) {
      void shutdown().then(() => {
        process.exitCode = 1;
      });
    }
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(WORKTREE_ROOT, "e2e/fleet-server.ts")
) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
