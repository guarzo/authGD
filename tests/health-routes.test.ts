import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { syncRun } from "@/db/schema";
import { setupTestDb, truncateAll } from "./helpers/db";

// The routes call getDb(), which would build a SECOND pool that nothing closes.
// Point it at the test pool instead so teardown actually tears everything down.
let testDb: Db;
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, getDb: () => testDb };
});

const { GET: healthRoute } = await import("@/app/api/health/route");
const { GET: syncRoute } = await import("@/app/api/health/sync/route");

let ctx: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  ctx = await setupTestDb();
  testDb = ctx.db;
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe("GET /api/health", () => {
  it("returns 200 and no-store when the database answers", async () => {
    const res = await healthRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "ok" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("GET /api/health/sync", () => {
  it("returns 503 and the documented null shape when no run exists", async () => {
    const res = await syncRoute();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      db: "ok",
      newestRunAgeSec: null,
      newestJobType: null,
    });
  });

  it("returns 200 for a run just recorded", async () => {
    await ctx.db.insert(syncRun).values({ jobType: "membership" });
    const res = await syncRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
    expect(body.newestJobType).toBe("membership");
    expect(body.newestRunAgeSec).toBeLessThan(60);
  });

  it("returns 503 naming the stale job when the newest run is 3 hours old", async () => {
    await ctx.db.insert(syncRun).values({
      jobType: "membership",
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const res = await syncRoute();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.newestJobType).toBe("membership");
    expect(body.newestRunAgeSec).toBeGreaterThan(10_000);
  });

  // A failed run still proves the worker is alive; job failures are /admin/sync's
  // job, not this endpoint's.
  it("counts a failed run as fresh", async () => {
    await ctx.db
      .insert(syncRun)
      .values({ jobType: "contacts", status: "failed", errorSummary: "boom" });
    const res = await syncRoute();
    expect(res.status).toBe(200);
  });

  it("sets no-store", async () => {
    const res = await syncRoute();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
