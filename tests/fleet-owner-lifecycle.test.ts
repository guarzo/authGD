import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { existsSync } from "node:fs";
import { createFleetTrust } from "../e2e/fleet-tls";
import { withFleetResources } from "../e2e/fleet-resources";
import { startFleetFixtures } from "../e2e/fleet-fixtures";
import { BASE_URL, WORKTREE_ROOT } from "../e2e/env";
import { startFleetWorker } from "../e2e/fleet-installations";
import { setupTestDb } from "./helpers/db";
import { createFleetPythonOwner } from "./helpers/fleet-python-owner";
import { RESET_LOCK_KEY } from "../e2e/db-isolation";

let db: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  db = await setupTestDb();
});
afterAll(async () => {
  await db.cleanup();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("actual Python lifecycle", () => {
  let owner: ReturnType<typeof createFleetPythonOwner>;
  let peer: Awaited<ReturnType<typeof owner.start>>;
  beforeEach(async (context) => {
    let current: ReturnType<typeof createFleetPythonOwner> | undefined;
    // Registered first, checked last: this observes the real onTestFinished
    // drain, and still retains a direct owner backstop for a RED regression.
    context.onTestFinished(async () => {
      if (!current) return;
      try {
        expect(existsSync(current.trustRoot)).toBe(false);
        if (current.installationRoot)
          expect(existsSync(current.installationRoot)).toBe(false);
      } finally {
        await current.close();
      }
    });
    // Pin verification, isolated trust, and imports of the real production Api
    // are fixture setup, not stop latency. The existing hook/readiness bounds
    // still reject startup failures; nothing is cached between tests.
    owner = current = createFleetPythonOwner(context);
    peer = await owner.start();
  });
  for (const stop of ["SIGTERM", "command"] as const)
    it(`stops the actual Python and presentation owners via ${stop}`, async () => {
      await peer.command("local");
      await vi.waitFor(async () =>
        expect(await peer.command("status")).toMatchObject({
          seen: 3,
          persisted_seen: 3,
          pending_roster: 0,
          presented_characters: 3,
        }),
      );
      if (stop === "command") await peer.command("stop");
      // Keep actual stop/reap plus root removal INSIDE the unchanged 5s test
      // deadline. Python exit 0 requires BOTH production owner stop outcomes.
      await owner.close();
      expect(existsSync(owner.installationRoot!)).toBe(false);
      expect(existsSync(owner.trustRoot)).toBe(false);
    });
  it("drains its registered owner even when the body has no cleanup finally", async () => {
    expect(await peer.command("status")).toMatchObject({ seen: 0, pending_roster: 0 });
    // No explicit close: the hook observation above must see both roots gone.
  });
});
it("a missing Python executable releases the partially created installation", async () => {
  let root = "";
  await withFleetResources(async (own) => {
    const trust = own(createFleetTrust(), (trust) => trust.close());
    vi.stubEnv("E2E_FLEET_TLS_ROOT", trust.root);
    vi.stubEnv("E2E_WINGMAN_PYTHON", "/no-owned-python-here");
    const { createInstallations } = await import("../e2e/fleet-installations");
    const installations = own(createInstallations(), (installations) =>
      installations.close(),
    );
    root = installations.root;
    await expect(installations.start("a")).rejects.toThrow(
      "Python executable unavailable",
    );
  });
  expect(existsSync(root)).toBe(false);
});
async function expectWorkerCancelled(
  pending: ReturnType<typeof startFleetWorker>,
  own: (worker: Awaited<ReturnType<typeof startFleetWorker>>) => void,
) {
  // Register success ownership before asserting rejection; an abort regression
  // must fail the oracle without abandoning the child it unexpectedly started.
  void pending.then(own, () => undefined);
  await expect(pending).rejects.toEqual(
    new Error("[fleet-e2e] worker startup cancelled"),
  );
}

it("the cancellation oracle rejects an unrelated startup failure", async () => {
  await expect(
    expectWorkerCancelled(
      Promise.reject(new Error("[fleet-e2e] worker startup failed")),
      () => {
        throw new Error("unexpected worker");
      },
    ),
  ).rejects.toThrow();
});

it("the cancellation oracle owns an unexpected successful worker before its assertion fails", async () => {
  await withFleetResources(async (ownFixture) => {
    const fixture = ownFixture(
      await startFleetFixtures({ appUrl: BASE_URL, worktree: WORKTREE_ROOT }),
      (fixture) => fixture.close(),
    );
    let stopped = false;
    let worker: Awaited<ReturnType<typeof startFleetWorker>> | undefined;
    try {
      await expect(
        withFleetResources(async (own) => {
          const pending = startFleetWorker(fixture.connection);
          // Independent backstop for a missing-ownership negative control.
          void pending.then(
            (value) => {
              worker = value;
            },
            () => undefined,
          );
          await expectWorkerCancelled(pending, (worker) => {
            own(worker, async (worker) => {
              await worker.close();
              stopped = true;
            });
          });
        }),
      ).rejects.toThrow();
      expect(stopped).toBe(true);
      await fixture.client.assertClean();
    } finally {
      await worker?.close();
    }
  });
});

it("the actual scoped worker drains on SIGTERM and cancellation during startup", async () => {
  await withFleetResources(async (own) => {
    const fixture = own(
      await startFleetFixtures({ appUrl: BASE_URL, worktree: WORKTREE_ROOT }),
      (fixture) => fixture.close(),
    );
    const worker = own(await startFleetWorker(fixture.connection), (worker) =>
      worker.close(),
    );
    await worker.close();
    const blocker = await db.pool.connect();
    const controller = new AbortController();
    let outcome: Promise<void> | undefined;
    try {
      const {
        rows: [{ pid }],
      } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT pg_advisory_lock($1)", [RESET_LOCK_KEY]);
      const pending = startFleetWorker(fixture.connection, controller.signal);
      outcome = expectWorkerCancelled(pending, (worker) => {
        own(worker, (worker) => worker.close());
      });
      void outcome.catch(() => undefined);
      // Hold actual startup DB admission: the child has installed its signal
      // handlers, but cannot announce ready. Immediate post-spawn SIGTERM can
      // instead kill Node before those handlers exist, a different stop path.
      await vi.waitFor(async () => {
        const { rows } = await blocker.query(
          "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        expect(rows).toHaveLength(1);
      });
      controller.abort();
    } finally {
      controller.abort();
      try {
        await blocker.query("SELECT pg_advisory_unlock($1)", [RESET_LOCK_KEY]);
      } finally {
        blocker.release();
      }
      await outcome;
    }
    await fixture.client.assertClean();
  });
});
