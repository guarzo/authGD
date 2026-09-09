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
    const controller = new AbortController();
    const pending = startFleetWorker(fixture.connection, controller.signal);
    // Cancellation is queued only AFTER the function has spawned its owned child.
    const outcome = pending.catch((error: unknown) => error);
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await fixture.client.assertClean();
  });
});
