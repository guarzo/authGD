import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { syncRun } from "@/db/schema";
import { getWorkerLiveness, WORKER_STALE_AFTER_MS } from "@/services/worker-health";
import { setupTestDb, truncateAll } from "./helpers/db";

const ctx = await setupTestDb();

beforeEach(async () => {
  await truncateAll(ctx.db);
});

afterAll(async () => {
  await ctx.cleanup();
});

const NOW = new Date("2026-08-03T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("getWorkerLiveness", () => {
  it("reports unknown when the worker has never run", async () => {
    const live = await getWorkerLiveness(ctx.db, NOW);
    expect(live).toEqual({
      status: "unknown",
      lastRunAt: null,
      lastJobType: null,
      ageMs: null,
      thresholdMs: WORKER_STALE_AFTER_MS,
    });
  });

  it("reports ok for a run inside the threshold", async () => {
    await ctx.db
      .insert(syncRun)
      .values({ jobType: "membership", startedAt: ago(29 * 60 * 1000) });

    const live = await getWorkerLiveness(ctx.db, NOW);
    expect(live.status).toBe("ok");
    expect(live.lastJobType).toBe("membership");
    expect(live.ageMs).toBe(29 * 60 * 1000);
  });

  it("reports stale once the newest run is older than the threshold", async () => {
    await ctx.db
      .insert(syncRun)
      .values({ jobType: "contacts", startedAt: ago(WORKER_STALE_AFTER_MS + 1000) });

    const live = await getWorkerLiveness(ctx.db, NOW);
    expect(live.status).toBe("stale");
    expect(live.lastJobType).toBe("contacts");
  });

  it("is ok exactly at the threshold — only strictly older is stale", async () => {
    await ctx.db
      .insert(syncRun)
      .values({ jobType: "purge", startedAt: ago(WORKER_STALE_AFTER_MS) });

    expect((await getWorkerLiveness(ctx.db, NOW)).status).toBe("ok");
  });

  it("uses the NEWEST run, not the newest of any one job type", async () => {
    // A worker that is alive but whose slowest job last ran days ago must not
    // read as stale: liveness is about the process, not per-job freshness.
    await ctx.db.insert(syncRun).values([
      { jobType: "token-health", startedAt: ago(3 * 24 * 60 * 60 * 1000) },
      { jobType: "membership", startedAt: ago(60 * 1000) },
    ]);

    const live = await getWorkerLiveness(ctx.db, NOW);
    expect(live.status).toBe("ok");
    expect(live.lastJobType).toBe("membership");
  });

  it("counts a started-but-unfinished run as alive", async () => {
    // startSyncRun writes the row before the job body runs. A long job in
    // flight is the worker working, not the worker dead.
    await ctx.db
      .insert(syncRun)
      .values({ jobType: "wanderer", startedAt: ago(60 * 1000), finishedAt: null });

    expect((await getWorkerLiveness(ctx.db, NOW)).status).toBe("ok");
  });

  it("counts a FAILED run as alive", async () => {
    // A failing job still proves the process is up and reaching Postgres.
    // Job-level failure is the dead-letter webhook's job to report, not this.
    await ctx.db.insert(syncRun).values({
      jobType: "discord-roles",
      startedAt: ago(60 * 1000),
      finishedAt: ago(30 * 1000),
      status: "failed",
      errorSummary: "boom",
    });

    expect((await getWorkerLiveness(ctx.db, NOW)).status).toBe("ok");
  });

  it("treats clock skew (a future run) as healthy rather than paging", async () => {
    await ctx.db
      .insert(syncRun)
      .values({ jobType: "membership", startedAt: new Date(NOW.getTime() + 60_000) });

    const live = await getWorkerLiveness(ctx.db, NOW);
    expect(live.status).toBe("ok");
    expect(live.ageMs).toBeLessThan(0);
  });
});
