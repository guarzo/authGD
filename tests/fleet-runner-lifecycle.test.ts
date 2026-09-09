import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { withFleetResources } from "../e2e/fleet-resources";
import { FLEET_CONNECTION_FILE, assertFreePort } from "../e2e/fleet-server";
import { fleetClient, type FixtureConnection } from "../e2e/fleet-fixtures";
import { WORKTREE_ROOT, TEST_DATABASE_URL } from "../e2e/env";
import { setupTestDb } from "./helpers/db";

let db: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db.cleanup();
});
const roots = (parent = join(WORKTREE_ROOT, "tmp/task-10/fix1")) => {
  try {
    return readdirSync(parent)
      .filter((name) => name.startsWith("trust-"))
      .sort();
  } catch (error) {
    // A clean checkout has no scratch parent before the first owned acquisition.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

it("takes an empty scratch baseline before the first trust root exists", ({
  onTestFinished,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), "fleet-runner-scratch-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const parent = join(scratch, "tmp/task-10/fix1");
  expect(roots(parent)).toEqual([]);
  expect(existsSync(parent)).toBe(false);
  mkdirSync(join(parent, "trust-z"), { recursive: true });
  mkdirSync(join(parent, "trust-a"));
  writeFileSync(join(parent, "historic-artifact.json"), "preserved");
  expect(roots(parent)).toEqual(["trust-a", "trust-z"]);
  expect(readFileSync(join(parent, "historic-artifact.json"), "utf8")).toBe("preserved");
});

it("does not hide scratch baseline errors other than a missing directory", ({
  onTestFinished,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), "fleet-runner-scratch-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const notDirectory = join(scratch, "not-a-directory");
  writeFileSync(notDirectory, "preserved");
  expect(() => roots(notDirectory)).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
});
function writeForeignDescriptor(path: string, contents: string) {
  // This case can run alone, before a managed server creates tmp/e2e.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { flag: "wx" });
}

it("creates a foreign descriptor in fresh scratch without replacing an existing file", ({
  onTestFinished,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), "fleet-runner-scratch-"));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  const descriptor = join(scratch, "tmp/e2e/fleet-connection.json");
  writeForeignDescriptor(descriptor, "original");
  expect(readFileSync(descriptor, "utf8")).toBe("original");
  expect(() => writeForeignDescriptor(descriptor, "replacement")).toThrow(
    expect.objectContaining({ code: "EEXIST" }),
  );
  expect(readFileSync(descriptor, "utf8")).toBe("original");
});

const listening = () =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 3988 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
for (const mode of [
  "SIGTERM",
  "SIGINT",
  "double-SIGTERM",
  "before-startup",
  "trust-startup",
  "server-startup",
  "browser-startup",
  "failed-spawn",
  "occupied-startup",
  "foreign-descriptor",
] as const)
  it(`the actual top-level runner releases trust, descriptor and listeners after ${mode}`, async ({
    onTestFinished,
  }) => {
    const before = roots();
    let connection: FixtureConnection | undefined;
    await withFleetResources(async (own) => {
      const artifacts = join(WORKTREE_ROOT, "tmp/task-10/cancellation");
      mkdirSync(artifacts, { recursive: true });
      const callerHome = own(mkdtempSync(join(artifacts, "caller-home-")), (root) =>
        rmSync(root, { recursive: true, force: true }),
      );
      const callerNss = join(callerHome, ".pki/nssdb");
      mkdirSync(callerNss, { recursive: true });
      writeFileSync(join(callerNss, "marker"), "external-profile");
      if (mode === "occupied-startup") {
        const holder = own(
          createServer((_req, res) => res.end("external-holder")),
          async (server) => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          },
        );
        holder.listen(3988, "127.0.0.1");
        await once(holder, "listening");
      }
      expect(existsSync(FLEET_CONNECTION_FILE)).toBe(false);
      const foreignDescriptor = '{"token":"not-our-descriptor"}';
      if (mode === "foreign-descriptor") {
        writeForeignDescriptor(FLEET_CONNECTION_FILE, foreignDescriptor);
        own(FLEET_CONNECTION_FILE, (path) => rmSync(path, { force: true }));
      }
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "e2e/fleet-run.ts", "-g", "HTTPS serves"],
        {
          cwd: WORKTREE_ROOT,
          detached: true,
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH,
            HOME: callerHome,
            PLAYWRIGHT_BROWSERS_PATH:
              process.env.PLAYWRIGHT_BROWSERS_PATH ??
              dirname(dirname(dirname(chromium.executablePath()))),
            TEST_DATABASE_URL,
            NEXT_TELEMETRY_DISABLED: "1",
            E2E_DB_PORT: "5639",
            CI: "true",
            E2E_WINGMAN_ROOT: process.env.E2E_WINGMAN_ROOT,
            E2E_WINGMAN_PYTHON: process.env.E2E_WINGMAN_PYTHON,
            E2E_FLEET_PORT: "3988",
            E2E_FLEET_UPSTREAM_PORT: "3987",
            NODE_OPTIONS: `--import=${join(WORKTREE_ROOT, "tests/helpers/fleet-runner-owner.mjs")}`,
            ...(mode === "failed-spawn" ? { FLEET_RUNNER_TEST_FAILED_SPAWN: "1" } : {}),
            ...(mode === "double-SIGTERM"
              ? { FLEET_RUNNER_TEST_COUNT_SIGNALS: "1" }
              : {}),
            ...(mode === "browser-startup" ? { DEBUG: "pw:browser" } : {}),
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      const exited = once(child, "close");
      const acquiredRoots: string[] = [];
      child.on("message", (message: { fleetOwnedRoot: string }) => {
        acquiredRoots.push(message.fleetOwnedRoot);
        if (mode === "trust-startup") child.kill("SIGTERM");
      });
      let stopping: Promise<void> | undefined;
      const stop = () =>
        (stopping ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            // Only on a RED path: the preload retains real managed-server and
            // worker creation handles. It is not part of the success assertion.
            child.kill("SIGUSR2");
            const timer = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 10_000);
            try {
              await exited;
            } finally {
              clearTimeout(timer);
            }
          }
          // Creation registrations arrive on our private child IPC channel,
          // never via an unverified descriptor or directory/process scan.
          for (const root of acquiredRoots)
            rmSync(root, { recursive: true, force: true });
        })());
      own(child, stop);
      // Vitest timeouts don't cancel the body. Retain an independent disposer
      // as well as the normal finally, and share its in-flight drain on reentry.
      onTestFinished(stop);
      let browserLaunched = false;
      let browserClosed = false;
      let output = "";
      for (const stream of [child.stdout!, child.stderr!])
        stream.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8192);
          if (output.includes("<launched> pid=")) browserLaunched = true;
          if (output.includes("<process did exit:")) browserClosed = true;
        });
      if (mode === "before-startup") {
        await once(child, "spawn");
        child.kill("SIGTERM");
      } else if (mode === "trust-startup") {
        // The creation registration above delivers cancellation during trust
        // acquisition, without timing a filesystem poll against OpenSSL.
      } else if (mode === "server-startup") {
        await vi.waitFor(async () => expect(await listening()).toBe(true), {
          timeout: 20_000,
        });
        child.kill("SIGTERM");
      } else if (
        mode !== "occupied-startup" &&
        mode !== "failed-spawn" &&
        mode !== "foreign-descriptor"
      ) {
        await vi.waitFor(
          () => {
            expect(child.exitCode, "runner exited before fixture readiness").toBeNull();
            expect(existsSync(FLEET_CONNECTION_FILE)).toBe(true);
          },
          { timeout: 20_000 },
        );
        connection = JSON.parse(
          readFileSync(FLEET_CONNECTION_FILE, "utf8"),
        ) as FixtureConnection;
        expect(await fleetClient(connection).health()).toBeTruthy();
        if (mode === "browser-startup")
          await vi.waitFor(() => expect(browserLaunched).toBe(true), { timeout: 20_000 });
        child.kill(mode === "SIGINT" ? "SIGINT" : "SIGTERM");
        if (mode === "double-SIGTERM") {
          // Keep the runner alive for a distinct second delivery; count raw
          // arrivals so Playwright's 1s coalescer cannot hide duplicate forwarding.
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(child.kill("SIGTERM")).toBe(true);
        }
      }
      const [code] = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          own(
            setTimeout(
              () =>
                reject(
                  new Error(
                    "[fleet-e2e] top-level runner did not drain after cancellation",
                  ),
                ),
              12_000,
            ),
            clearTimeout,
          );
        }),
      ]);
      expect(code).not.toBe(0);
      if (mode === "trust-startup") expect(acquiredRoots).toHaveLength(1);
      if (mode === "browser-startup") expect(browserClosed).toBe(true);
      if (mode === "double-SIGTERM")
        expect(output.match(/\[fleet-runner-test\] interruption/g)).toHaveLength(1);
      expect(existsSync(FLEET_CONNECTION_FILE)).toBe(mode === "foreign-descriptor");
      if (mode === "foreign-descriptor")
        expect(readFileSync(FLEET_CONNECTION_FILE, "utf8")).toBe(foreignDescriptor);
      expect(readFileSync(join(callerNss, "marker"), "utf8")).toBe("external-profile");
      expect(readdirSync(callerNss)).toEqual(["marker"]);
      expect(roots()).toEqual(before);
      if (connection) await expect(fleetClient(connection).health()).rejects.toThrow();
      if (mode === "occupied-startup")
        expect(await (await fetch("http://127.0.0.1:3988")).text()).toBe(
          "external-holder",
        );
      else await assertFreePort("https://localhost:3988");
      await assertFreePort("http://127.0.0.1:3987");
    });
    expect(roots()).toEqual(before);
  }, 40_000);
