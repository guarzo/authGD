import { desc } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncRun } from "@/db/schema";
import { JobRetryError, runJob } from "@/services/sync-run";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

async function latestRun() {
  const rows = await ctx.db.select().from(syncRun).orderBy(desc(syncRun.id)).limit(1);
  return rows[0];
}

describe("runJob", () => {
  it("records an ok run with counts", async () => {
    await runJob(ctx.db, "membership", async () => ({
      status: "ok",
      counts: { resolved: 3 },
    }));
    const run = await latestRun();
    expect(run.jobType).toBe("membership");
    expect(run.status).toBe("ok");
    expect(run.finishedAt).not.toBeNull();
    expect(run.counts).toEqual({ resolved: 3 });
  });

  it("records failed and rethrows on unexpected errors", async () => {
    await expect(
      runJob(ctx.db, "contacts", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const run = await latestRun();
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toContain("boom");
  });

  it("records the result then throws JobRetryError when retry is requested", async () => {
    await expect(
      runJob(ctx.db, "wanderer", async () => ({
        status: "partial",
        errorSummary: "2 transient failures",
        retry: true,
      })),
    ).rejects.toBeInstanceOf(JobRetryError);
    const run = await latestRun();
    expect(run.status).toBe("partial");
    expect(run.errorSummary).toBe("2 transient failures");
  });

  it("records failed WITHOUT throwing for permanent-config results", async () => {
    const result = await runJob(ctx.db, "discord-roles", async () => ({
      status: "failed",
      errorSummary: "managed role ids are not distinct",
    }));
    expect(result.status).toBe("failed");
    const run = await latestRun();
    expect(run.status).toBe("failed");
  });
});
