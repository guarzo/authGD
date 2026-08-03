import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { createDb } from "@/db";
import { syncRun } from "@/db/schema";
import { checkLiveness, newestSyncRun } from "@/services/health";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

describe("checkLiveness", () => {
  it("is true against a reachable database", async () => {
    expect(await checkLiveness(ctx.db)).toBe(true);
  });

  // The failure branch is exercised for real rather than assumed: port 1 has
  // no listener, so the pool fails to connect.
  it(
    "is false when Postgres is unreachable",
    async () => {
      const badPool = new Pool({
        connectionString: "postgres://nobody:nobody@127.0.0.1:1/none",
        connectionTimeoutMillis: 1000,
        max: 1,
      });
      const bad = { db: drizzle(badPool, { schema }), pool: badPool };
      expect(await checkLiveness(bad.db)).toBe(false);
      await bad.pool.end();
    },
    10000,
  );
});

describe("newestSyncRun", () => {
  it("returns null when no runs are recorded", async () => {
    expect(await newestSyncRun(ctx.db)).toBeNull();
  });

  it("returns the most recently inserted run regardless of job type", async () => {
    await ctx.db.insert(syncRun).values({ jobType: "purge" });
    await ctx.db.insert(syncRun).values({ jobType: "membership" });
    const row = await newestSyncRun(ctx.db);
    expect(row?.jobType).toBe("membership");
    expect(row?.startedAt).toBeInstanceOf(Date);
  });
});
