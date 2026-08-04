import { sql } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { QUEUES, createQueues, globalSingletonKey, scheduleJobs } from "@/worker/queues";
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
    const first = await boss.send(
      QUEUES.contacts,
      { jobType: "contacts" },
      { singletonKey: key },
    );
    const second = await boss.send(
      QUEUES.contacts,
      { jobType: "contacts" },
      { singletonKey: key },
    );
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
    // Scheduled ticks coalesce with dispatcher-emitted global sends only if
    // both name the same key. This asserts the registered schedule against
    // `globalSingletonKey` for EVERY queue rather than spot-checking two:
    // that function is the one definition the dispatcher also calls, so a
    // rename there now has to survive both sides or this fails. It used to be
    // four hand-copied literals across two files with nothing cross-checking
    // them, and discord-roles is the one that does not follow the pattern.
    for (const [name, s] of byName) {
      expect(s.options, name).toMatchObject({ singletonKey: globalSingletonKey(name) });
    }
    expect(byName.get(QUEUES.discordRoles)?.options).toMatchObject({
      singletonKey: "roles:all",
    });
  });

  it("repairs stale queue settings on startup (createQueue alone is ON CONFLICT DO NOTHING)", async () => {
    // pg-boss's Queue type requires name even on updateQueue
    await boss.updateQueue(QUEUES.contacts, {
      name: QUEUES.contacts,
      policy: "standard",
      retryLimit: 1,
      retryDelay: 1,
      retryBackoff: false,
    });
    await createQueues(boss);
    const q = await boss.getQueue(QUEUES.contacts);
    expect(q?.policy).toBe("short");
    expect(q?.retryLimit).toBe(5);
    expect(q?.deadLetter).toBe(QUEUES.deadLetter);
  });

  it("refuses to start when the DLQ itself has a dead-letter target (uncleanable)", async () => {
    // Set the one misconfiguration updateQueue cannot repair…
    await boss.updateQueue(QUEUES.deadLetter, {
      name: QUEUES.deadLetter,
      deadLetter: QUEUES.contacts,
    });
    try {
      await expect(createQueues(boss)).rejects.toThrow(/dead-letter target/);
    } finally {
      // …and clear it with the documented manual fix so later tests (and
      // reruns against the persistent test DB) start clean.
      const { db, pool } = createDb(TEST_URL);
      await db.execute(
        sql`UPDATE pgboss.queue SET dead_letter = NULL WHERE name = ${QUEUES.deadLetter}`,
      );
      await pool.end();
    }
  });
});
