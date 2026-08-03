import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syncRun } from "@/db/schema";
import { getSyncStatus } from "@/services/sync-status";
import { finishSyncRun, startSyncRun } from "@/services/sync-run";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("getSyncStatus", () => {
  it("groups newest-first per job with known jobs in fixed order", async () => {
    for (let i = 0; i < 3; i++) {
      const id = await startSyncRun(ctx.db, "contacts");
      await finishSyncRun(ctx.db, id, { status: "ok", counts: { added: i } });
    }
    const id = await startSyncRun(ctx.db, "membership");
    await finishSyncRun(ctx.db, id, { status: "failed", errorSummary: "boom" });
    const groups = await getSyncStatus(ctx.db, 2);
    expect(groups.map((g) => g.jobType)).toEqual(["membership", "contacts"]);
    expect(groups[1].runs).toHaveLength(2); // capped at runsPerJob
    expect(groups[1].runs[0].counts).toEqual({ added: 2 }); // newest first
    expect(groups[0].runs[0].errorSummary).toBe("boom");
  });

  it("lists unknown job types after known ones", async () => {
    await startSyncRun(ctx.db, "zz-custom");
    await startSyncRun(ctx.db, "purge");
    const groups = await getSyncStatus(ctx.db);
    expect(groups.map((g) => g.jobType)).toEqual(["purge", "zz-custom"]);
  });

  it("keeps rare jobs visible no matter how many runs other jobs pile up", async () => {
    await startSyncRun(ctx.db, "membership-recheck");
    // 501 competing rows: more than any plausible global row window, so a
    // regression back to windowed grouping fails this test.
    await ctx.db
      .insert(syncRun)
      .values(Array.from({ length: 501 }, () => ({ jobType: "contacts" })));
    const groups = await getSyncStatus(ctx.db, 5);
    expect(groups.map((g) => g.jobType)).toEqual(["membership-recheck", "contacts"]);
    expect(groups[0].runs).toHaveLength(1);
    expect(groups[1].runs).toHaveLength(5);
  });
});
