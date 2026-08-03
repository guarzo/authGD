import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUES, createQueues, scheduleJobs } from "@/worker/queues";
import { TEST_URL } from "./helpers/db";

let boss: PgBoss;
beforeAll(async () => {
  boss = new PgBoss({ connectionString: TEST_URL });
  boss.on("error", () => {});
  await boss.start();
  await createQueues(boss);
});
afterAll(async () => {
  await boss.stop({ graceful: false, wait: false });
});

describe("worker queues", () => {
  it("coalesces duplicate sends via singletonKey", async () => {
    const key = `test-${Date.now()}`; // unique per run: pg-boss state persists
    const first = await boss.send(QUEUES.contacts, { jobType: "contacts" }, { singletonKey: key });
    const second = await boss.send(QUEUES.contacts, { jobType: "contacts" }, { singletonKey: key });
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // coalesced
  });

  it("applies one schedule per queue, each carrying its global singleton key", async () => {
    await scheduleJobs(boss);
    const schedules = await boss.getSchedules();
    const byName = new Map(schedules.map((s) => [s.name, s]));
    expect(byName.get(QUEUES.membership)?.cron).toBe("*/30 * * * *");
    expect(byName.get(QUEUES.membershipRecheck)?.cron).toBe("0 4 * * 0");
    expect(byName.get(QUEUES.contacts)?.cron).toBe("5 * * * *");
    expect(byName.get(QUEUES.wanderer)?.cron).toBe("10 * * * *");
    expect(byName.get(QUEUES.discordRoles)?.cron).toBe("15 * * * *");
    expect(byName.get(QUEUES.tokenHealth)?.cron).toBe("0 3 * * *");
    expect(byName.get(QUEUES.purge)?.cron).toBe("30 3 * * *");
    // scheduled ticks coalesce with dispatcher-emitted global sends
    expect(byName.get(QUEUES.contacts)?.options).toMatchObject({
      singletonKey: "contacts:all",
    });
    expect(byName.get(QUEUES.wanderer)?.options).toMatchObject({
      singletonKey: "wanderer:all",
    });
  });
});
