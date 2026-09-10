import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { Client } from "pg";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { resetDb } from "../e2e/helpers";
import { WORKTREE_ROOT } from "../e2e/env";
import { databaseIsolationTestEnvironment as environment } from "./helpers/db-isolation-env";
import { resolveTestUrl, TEST_URL } from "./helpers/test-db-url";
import { setupTestDb } from "./helpers/db";
import { assertDatabaseIsolationEnvironment, RESET_LOCK_KEY } from "../e2e/db-isolation";

let fixture: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  fixture = await setupTestDb();
});
afterAll(async () => {
  await fixture?.cleanup();
});

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

async function observer() {
  const client = new Client({ connectionString: TEST_URL });
  await client.connect();
  resources.push(() => client.end());
  return client;
}

function resetOwner() {
  return fixture;
}

async function child(mode: string, entry = "db-isolation-child.mjs") {
  if (mode === "application-unlock")
    buildSync({
      entryPoints: [join(WORKTREE_ROOT, "src/db/index.ts")],
      outfile: join(WORKTREE_ROOT, "tmp/e2e/isolation-application-db.mjs"),
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
    });
  const process = spawn(
    globalThis.process.execPath,
    [join(WORKTREE_ROOT, "tests/helpers", entry), mode],
    { cwd: WORKTREE_ROOT, env: environment(), stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const events: string[] = [];
  let backendPid: number | undefined;
  process.on("message", (message: { event: string; pid?: number }) => {
    events.push(message.event);
    if (message.event === "private-query") backendPid = message.pid;
  });
  process.stdout!.on("data", () => {});
  let stderr = "";
  process.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(process, "exit");
  resources.push(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGTERM");
      await exited;
    }
    process.stdout!.destroy();
    process.stderr!.destroy();
    if (process.connected) process.disconnect();
  });
  return {
    process,
    events,
    backendPid: () => backendPid,
    stderr: () => stderr,
    async wait(event: string) {
      await vi.waitFor(() => expect(events).toContain(event));
    },
    async done(code = 0) {
      expect((await exited)[0], events.join(",")).toBe(code);
      expect(events, events.join(",")).toContain("done");
    },
  };
}

async function locks(client: Client) {
  return (
    await client.query<{
      pid: number;
      locktype: string;
      granted: boolean;
      relation: string | null;
      blockers: number[];
    }>(`SELECT l.pid, l.locktype, l.granted, c.relname AS relation,
      pg_blocking_pids(l.pid) AS blockers
      FROM pg_locks l LEFT JOIN pg_class c ON c.oid=l.relation
      WHERE l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND (l.locktype='advisory' OR c.relnamespace='public'::regnamespace)`)
  ).rows;
}

async function waiting(client: Client) {
  let snapshot: Awaited<ReturnType<typeof locks>> = [];
  await vi.waitFor(async () => {
    snapshot = await locks(client);
    expect(snapshot.some((lock) => !lock.granted)).toBe(true);
  });
  return snapshot;
}

function release(process: ChildProcess) {
  if (process.connected) process.send("continue");
}

it.each(["transaction", "queued", "destroy", "unsettled"])(
  "drains a real %s lease before reset takes any table lock",
  async (mode) => {
    const monitor = await observer();
    const owner = resetOwner();
    const server = await child(mode);
    await server.wait(mode === "queued" ? "queued" : "held");
    const resetting = resetDb(owner.db);
    // Attach immediately; assertions/cleanup must not leave a rejected reset.
    const settled = resetting.then(
      () => null,
      () => "reset-failed",
    );
    let snapshot: Awaited<ReturnType<typeof locks>>;
    try {
      snapshot = await waiting(monitor);
    } finally {
      release(server.process);
      await settled;
      await server.done();
    }
    // Without isolation this is a real TRUNCATE relation wait, not a helper mock.
    expect(
      snapshot!.filter((lock) => !lock.granted).map((lock) => lock.locktype),
    ).toEqual(["advisory"]);
    expect(await settled).toBeNull();
    if (mode === "unsettled") expect(server.events).toContain("unsettled-rejected");
    expect(
      (await locks(monitor)).filter(
        (lock) => lock.locktype === "advisory" && lock.blockers.length,
      ),
    ).toEqual([]);
  },
);

it.each([false, true])(
  "excludes delayed checkout through actual reset, including rollback=%s",
  async (failReset) => {
    const monitor = await observer();
    const owner = resetOwner();
    // Stretch the real helper's TRUNCATE, not a substitute reset function.
    const blocker = await observer();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE fleet_telemetry_row IN ACCESS SHARE MODE");
    const server = await child("delayed");
    await server.wait("ready");
    expect(server.events).toContain("response-closed");
    const resetting = resetDb(owner.db).then(
      () => "reset",
      () => "rollback",
    );
    try {
      const snapshot = await waiting(monitor);
      const resetPid = snapshot.find((lock) => !lock.granted)!.pid;
      release(server.process);
      await server.wait("checkout-start");
      let waitingServer: Awaited<ReturnType<typeof locks>> = [];
      await vi.waitFor(async () => {
        waitingServer = (await locks(monitor)).filter(
          (lock) => !lock.granted && lock.pid !== resetPid,
        );
        expect(waitingServer.length).toBeGreaterThan(0);
      });
      expect(waitingServer.map((lock) => lock.locktype)).toEqual(["advisory"]);
      expect(server.events).not.toContain("done");
      if (failReset) await monitor.query("SELECT pg_cancel_backend($1)", [resetPid]);
    } finally {
      await blocker.query("ROLLBACK");
      expect(await resetting).toBe(failReset ? "rollback" : "reset");
      await server.done();
    }
    // A subsequent reset can acquire the same gate; no failed-reset residue.
    await resetDb(owner.db);
  },
);

it("rolls back a cancelled drain without stranding the admitted transaction", async () => {
  const monitor = await observer();
  const owner = resetOwner();
  const server = await child("transaction");
  await server.wait("held");
  const resetting = resetDb(owner.db).then(
    () => "reset",
    () => "cancelled",
  );
  try {
    const snapshot = await waiting(monitor);
    const waiter = snapshot.find((lock) => !lock.granted)!;
    expect(waiter.locktype).toBe("advisory");
    await monitor.query("SELECT pg_cancel_backend($1)", [waiter.pid]);
    expect(await resetting).toBe("cancelled");
  } finally {
    release(server.process);
    await resetting;
    await server.done();
  }
  await resetDb(owner.db);
});

it.each(["error", "callback"])(
  "releases the %s path and ends its real pool",
  async (mode) => {
    const owner = resetOwner();
    const server = await child(mode);
    await server.done();
    if (mode === "error") expect(server.events).toContain("query-failed");
    await resetDb(owner.db);
  },
);

it.each(["admission-promise", "admission-callback", "unlock"])(
  "owns real transport failure during %s without leaking the client or error",
  async (phase) => {
    const monitor = await observer();
    const blocksAdmission = phase !== "unlock";
    if (blocksAdmission)
      await monitor.query("SELECT pg_advisory_lock($1)", [RESET_LOCK_KEY]);
    let holdsAdmission = blocksAdmission;
    try {
      const server = await child(phase, "db-isolation-transport.mjs");
      await server.wait("private-query");
      if (blocksAdmission) {
        await vi.waitFor(async () => {
          expect(
            (await locks(monitor)).some(
              (lock) =>
                lock.pid === server.backendPid() &&
                lock.locktype === "advisory" &&
                !lock.granted,
            ),
          ).toBe(true);
        });
      } else await server.wait("release-void");
      server.process.send("break-transport");
      // Allow the replacement client after the failed admission has been observed.
      // In the RED case the child exits instead of delivering the failure.
      if (blocksAdmission) {
        await vi.waitFor(() =>
          expect(
            server.events.includes("acquisition-failed") ||
              server.process.exitCode !== null,
          ).toBe(true),
        );
        await monitor.query("SELECT pg_advisory_unlock($1)", [RESET_LOCK_KEY]);
        holdsAdmission = false;
      }
      await server.done();
      expect(server.events).toContain(
        blocksAdmission ? "acquisition-failed" : "pool-error",
      );
      expect(server.events).not.toContain("uncaught-client-event");
      expect(server.events).not.toContain("unhandled-rejection");
    } finally {
      if (holdsAdmission)
        await monitor.query("SELECT pg_advisory_unlock($1)", [RESET_LOCK_KEY]);
    }
    await resetDb(fixture.db);
  },
);

it("fails visibly and drains the actual application pool after an unlock transport failure", async () => {
  const server = await child("application-unlock", "db-isolation-transport.mjs");
  await server.wait("release-void");
  server.process.send("break-transport");
  await server.done(1);
  expect(server.events).toContain("harness-failure");
  expect(server.events).not.toContain("uncaught-client-event");
  expect(server.events).not.toContain("unhandled-rejection");
  expect(server.stderr()).toContain("[e2e] database isolation pool failed");
  expect(server.stderr()).not.toContain("secret-sentinel");
  await resetDb(fixture.db);
});

it("uses the Vitest default for child configuration without changing the live override", async () => {
  const liveOverride = process.env.TEST_DATABASE_URL;
  // A plain object models an unset override/CI; never unset the real process env.
  const managedDefault = resolveTestUrl({}, WORKTREE_ROOT);
  vi.resetModules();
  vi.doMock("./helpers/test-db-url", () => ({ TEST_URL: managedDefault }));
  try {
    const { databaseIsolationTestEnvironment } =
      await import("./helpers/db-isolation-env");
    const selected = databaseIsolationTestEnvironment();
    expect(selected.DATABASE_URL).toBe(managedDefault);
    expect(selected.TEST_DATABASE_URL).toBe(managedDefault);
    expect(process.env.TEST_DATABASE_URL).toBe(liveOverride);
  } finally {
    vi.doUnmock("./helpers/test-db-url");
    vi.resetModules();
  }
});

it.each([
  ["E2E_DB_ISOLATION", ""],
  ["E2E_MANAGED_WORKTREE", "/not-owned"],
  ["TEST_DATABASE_URL", "postgres://authgd:authgd@localhost:5639/other"],
  ["DATABASE_URL", "postgres://authgd:authgd@remote.invalid:5639/authgd_test"],
  ["EVE_SSO_CLIENT_SECRET", "non-synthetic"],
  ["SYNC_MODE", "live"],
])("refuses unowned bootstrap %s before importing the application", (key, value) => {
  expect(() =>
    assertDatabaseIsolationEnvironment({ ...environment(), [key]: value }),
  ).toThrow();
});
