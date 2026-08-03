import { describe, expect, it, vi } from "vitest";

// The whole point of this file: exercise the database-failure branches instead
// of assuming they work. Both routes must degrade to 503, never to an
// undocumented 500.
vi.mock("@/db", () => ({
  getDb: () => ({
    execute: async () => {
      throw new Error("connection refused");
    },
    select: () => {
      throw new Error("connection refused");
    },
  }),
}));

const { GET: healthRoute } = await import("@/app/api/health/route");
const { GET: syncRoute } = await import("@/app/api/health/sync/route");

describe("health routes with the database down", () => {
  it("GET /api/health returns 503", async () => {
    const res = await healthRoute();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, db: "error" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("GET /api/health/sync returns 503 with db:error, not a 500", async () => {
    const res = await syncRoute();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      db: "error",
      newestRunAgeSec: null,
      newestJobType: null,
    });
  });
});
