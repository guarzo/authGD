import { afterEach, expect, it, vi } from "vitest";
import PgBoss from "pg-boss";

const captured = vi.hoisted(() => ({
  run: undefined as (() => Promise<void>) | undefined,
}));
// Execute the actual registered flow, stopping its body at the first DB boundary.
// No browser/provider or copied cleanup implementation is involved.
vi.mock("../e2e/fleet-browser", () => ({
  test: (_name: string, run: (fixtures: object) => Promise<void>) => {
    captured.run = () => run({});
  },
  expect,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("pg-boss");
  vi.resetModules();
});

it.each([false, true])(
  "source flow preserves body/disposer failures and late queue errors, pools last (queue error=%s)",
  async (queueError) => {
    const helpers = await import("../e2e/helpers");
    const scheduler = await import("../src/worker/fleet-source-scheduler");
    const events: string[] = [];
    const primary = new Error("synthetic source body failed");
    const cleanup = new Error("synthetic admission stop failed");
    const resources = helpers.testDb();
    const end = resources.pool.end.bind(resources.pool);
    vi.spyOn(helpers, "testDb").mockReturnValue(resources);
    const removed = new Promise<void>((resolve) => {
      resources.pool.once("remove", () => {
        events.push("pool-end");
        resolve();
      });
    });
    const owner = scheduler.createFleetSourceOwner();
    const stopAdmission = owner.stopAdmission.bind(owner);
    const drain = owner.drain.bind(owner);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = owner.wrap(async () => {
      await held;
      await resources.pool.query("SELECT 1");
      events.push("credential-settled");
    })(undefined);
    // Own rejection before the deliberately broken teardown can close its pool.
    void pending.catch(() => undefined);
    vi.spyOn(scheduler, "createFleetSourceOwner").mockReturnValue(owner);
    vi.spyOn(owner, "stopAdmission").mockImplementation(() => {
      events.push("stop-admission");
      stopAdmission();
      release();
      throw cleanup;
    });
    vi.spyOn(owner, "drain").mockImplementation(async () => {
      events.push("drain");
      await drain();
    });
    let boss: PgBoss | undefined;
    vi.doMock("pg-boss", () => ({
      default: class extends PgBoss {
        constructor(options: ConstructorParameters<typeof PgBoss>[0]) {
          super(options);
          // eslint-disable-next-line @typescript-eslint/no-this-alias -- Retain this exact instance for the RED-path cleanup backstop.
          boss = this;
          const offWork = this.offWork.bind(this);
          vi.spyOn(this as PgBoss, "offWork").mockImplementation(async (value) => {
            events.push("off-work");
            await offWork(value);
          });
          const stop = this.stop.bind(this);
          vi.spyOn(this as PgBoss, "stop").mockImplementation(async (options) => {
            events.push("boss-stop");
            await stop(options);
            // Even an event during final resource cleanup belongs to this flow.
            if (queueError)
              this.emit("error", new Error("synthetic private queue detail"));
          });
        }
      },
    }));
    vi.spyOn(helpers, "resetDb").mockRejectedValue(primary);
    try {
      await import("../e2e/fleet-source-flow");
      const result = await captured.run!().catch((error: unknown) => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([
        primary,
        cleanup,
        ...(queueError ? [new Error("[fleet-e2e] unexpected queue error event")] : []),
      ]);
      expect(resources.pool.ending).toBe(true);
      // pg-pool.end resolves before its client's asynchronous remove event.
      await removed;
      expect(events).toEqual([
        "stop-admission",
        "off-work",
        "drain",
        "credential-settled",
        "boss-stop",
        "pool-end",
      ]);
      expect(resources.pool.totalCount).toBe(0);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      // Backstop owns the RED path too; never strand the deliberately held work.
      stopAdmission();
      release();
      await drain();
      try {
        await boss?.stop({ graceful: true, wait: true });
      } finally {
        if (!resources.pool.ending) await end();
      }
    }
  },
);
