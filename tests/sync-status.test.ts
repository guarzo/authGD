import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_CRON } from "@/core/schedules";
import { outbox, syncRun } from "@/db/schema";
import { enqueueSync } from "@/services/outbox";
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
  // Every scheduled job is seeded, so the row set is fixed and only the runs
  // differ. Tests below assert on this ordering rather than on "which jobs
  // happen to have run".
  const SEEDED = [
    "membership",
    "membership-recheck",
    "contacts",
    "wanderer",
    "discord-roles",
    "token-health",
    "purge",
    "location",
  ];

  it("returns a row for every scheduled job on a fresh database", async () => {
    const groups = await getSyncStatus(ctx.db);
    expect(groups.map((g) => g.jobType)).toEqual(SEEDED);
    // A job that has never run must be visible AS never-run, not absent.
    expect(groups.every((g) => g.runs.length === 0)).toBe(true);
    // ...and nothing is queued with an empty outbox.
    expect(groups.every((g) => g.queued === false)).toBe(true);
    // ...and the seed set is JOB_CRON itself, so adding a scheduled job
    // without adding it to KNOWN_ORDER fails here rather than on the page.
    expect([...SEEDED].sort()).toEqual(Object.keys(JOB_CRON).sort());
  });

  it("groups newest-first per job with known jobs in fixed order", async () => {
    for (let i = 0; i < 3; i++) {
      const id = await startSyncRun(ctx.db, "contacts");
      await finishSyncRun(ctx.db, id, { status: "ok", counts: { added: i } });
    }
    const id = await startSyncRun(ctx.db, "membership");
    await finishSyncRun(ctx.db, id, { status: "failed", errorSummary: "boom" });
    const groups = await getSyncStatus(ctx.db, 2);
    expect(groups.map((g) => g.jobType)).toEqual(SEEDED);
    const byType = new Map(groups.map((g) => [g.jobType, g.runs]));
    expect(byType.get("contacts")).toHaveLength(2); // capped at runsPerJob
    expect(byType.get("contacts")?.[0].counts).toEqual({ added: 2 }); // newest first
    expect(byType.get("membership")?.[0].errorSummary).toBe("boom");
    expect(byType.get("purge")).toEqual([]); // seeded, never run
  });

  it("lists unknown job types after known ones", async () => {
    await startSyncRun(ctx.db, "zz-custom");
    await startSyncRun(ctx.db, "purge");
    const groups = await getSyncStatus(ctx.db);
    expect(groups.map((g) => g.jobType)).toEqual([...SEEDED, "zz-custom"]);
  });

  it("keeps rare jobs visible no matter how many runs other jobs pile up", async () => {
    await startSyncRun(ctx.db, "membership-recheck");
    // 501 competing rows: more than any plausible global row window, so a
    // regression back to windowed grouping fails this test.
    await ctx.db
      .insert(syncRun)
      .values(Array.from({ length: 501 }, () => ({ jobType: "contacts" })));
    const groups = await getSyncStatus(ctx.db, 5);
    const byType = new Map(groups.map((g) => [g.jobType, g.runs]));
    expect(byType.get("membership-recheck")).toHaveLength(1);
    expect(byType.get("contacts")).toHaveLength(5);
  });

  it("marks a job type queued from undispatched outbox work, including member-triggered rows", async () => {
    // "account" is a member-triggered payload (link/unlink an alt), not an
    // admin action, but the marker means "work is queued for this job", not
    // "you queued it" — it must count the same as an admin's "sync all".
    await enqueueSync(ctx.db, { kind: "account", accountId: "acc-1" });
    const groups = await getSyncStatus(ctx.db);
    const queued = new Map(groups.map((g) => [g.jobType, g.queued]));
    // account fans out to membership, contacts, wanderer, discord-roles.
    expect(queued.get("membership")).toBe(true);
    expect(queued.get("contacts")).toBe(true);
    expect(queued.get("wanderer")).toBe(true);
    expect(queued.get("discord-roles")).toBe(true);
    expect(queued.get("membership-recheck")).toBe(false);
    expect(queued.get("token-health")).toBe(false);
    expect(queued.get("purge")).toBe(false);
  });

  it("does not mark a job type queued once its outbox row is dispatched", async () => {
    await enqueueSync(ctx.db, { kind: "membership-recheck" });
    await ctx.db.update(outbox).set({ dispatchedAt: new Date() });
    const groups = await getSyncStatus(ctx.db);
    expect(groups.find((g) => g.jobType === "membership-recheck")?.queued).toBe(false);
  });

  it("reports queuedSince as the oldest undispatched row targeting that job type, per job type", async () => {
    // "all" targets membership/contacts/wanderer/discord-roles; a lone
    // membership-recheck row is older than it but targets a different job
    // type entirely, so it must not affect membership's queuedSince.
    await ctx.db.insert(outbox).values({
      payload: { kind: "membership-recheck" },
      createdAt: new Date(2000, 0, 1),
    });
    await ctx.db
      .insert(outbox)
      .values({ payload: { kind: "all" }, createdAt: new Date(2020, 0, 1) });
    const groups = await getSyncStatus(ctx.db);
    const byType = new Map(groups.map((g) => [g.jobType, g]));
    expect(byType.get("membership")?.queuedSince).toEqual(new Date(2020, 0, 1));
    expect(byType.get("membership-recheck")?.queuedSince).toEqual(new Date(2000, 0, 1));
    expect(byType.get("purge")?.queuedSince).toBeNull();
  });

  it("takes the min queuedSince across every payload fanning out to a job type", async () => {
    // Two payloads both target contacts: an "all" row and an account row.
    // contacts' queuedSince must be the older of the two, not whichever
    // payload happens to be read last.
    await ctx.db.insert(outbox).values({
      payload: { kind: "account", accountId: "acc-1" },
      createdAt: new Date(2020, 0, 1),
    });
    await ctx.db
      .insert(outbox)
      .values({ payload: { kind: "all" }, createdAt: new Date(2010, 0, 1) });
    const groups = await getSyncStatus(ctx.db);
    const contacts = groups.find((g) => g.jobType === "contacts");
    expect(contacts?.queuedSince).toEqual(new Date(2010, 0, 1));
  });
});
