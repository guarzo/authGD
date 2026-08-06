import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { syncRun } from "@/db/schema";
import type { Dbx } from "@/db";
import { checkLiveness, newestSyncRun, workerHeartbeat } from "@/services/health";
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
  it("is false when Postgres is unreachable", async () => {
    // Built directly rather than via createDb so this test can use a 1s
    // connect timeout instead of that helper's production 5s — same Pool +
    // drizzle(schema) pairing, just impatient.
    const badPool = new Pool({
      connectionString: "postgres://nobody:nobody@127.0.0.1:1/none",
      connectionTimeoutMillis: 1000,
      max: 1,
    });
    const bad = { db: drizzle(badPool, { schema }), pool: badPool };
    try {
      expect(await checkLiveness(bad.db)).toBe(false);
    } finally {
      // A failed assertion throws; without the finally the pool would leak
      // and vitest would hang on open handles instead of reporting the
      // failure.
      await bad.pool.end();
    }
  }, 10000);
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

describe("workerHeartbeat", () => {
  // Minimal stand-in for the table pg-boss itself creates on `boss.start()`
  // (node_modules/pg-boss/src/plans.js, `createTableVersion`). Built by hand
  // rather than by booting a real PgBoss instance, because its maintenance
  // loop only ticks `maintained_on` on its own ~120s timer
  // (`maintenanceIntervalSeconds`) — far too slow for a unit test — and this
  // function only cares about the column's shape, not pg-boss's scheduling.
  // `IF NOT EXISTS` so this is a no-op on a shared test database where
  // `tests/worker-queues.test.ts` has already created the real thing.
  beforeAll(async () => {
    await ctx.db.execute(sql`create schema if not exists pgboss`);
    await ctx.db.execute(sql`
      create table if not exists pgboss.version (
        version int primary key,
        maintained_on timestamptz,
        cron_on timestamptz,
        monitored_on timestamptz
      )
    `);
  });

  it("returns null when the table has no rows at all", async () => {
    // A schema-having, row-having database is the realistic empty state
    // (pg-boss inserts its version row before any maintenance tick ever
    // sets `maintained_on`), but an ungrouped `max()` over zero ROWS is also
    // reachable if something else has truncated the table — both must
    // degrade to null rather than throwing.
    await ctx.db.execute(sql`delete from pgboss.version`);
    expect(await workerHeartbeat(ctx.db)).toBeNull();
  });

  it("reads the newest maintained_on across every row in the table", async () => {
    // An hour in the future is guaranteed to beat any timestamp a real
    // pg-boss maintenance tick in this same shared test database could set
    // to "now" while this test runs, so the assertion can't flake on a
    // sibling test file's worker racing this one.
    const stamp = new Date(Date.now() + 60 * 60 * 1000);
    await ctx.db.execute(sql`
      insert into pgboss.version (version, maintained_on)
      values (999999, ${stamp})
      on conflict (version) do update set maintained_on = excluded.maintained_on
    `);
    const result = await workerHeartbeat(ctx.db);
    expect(result?.getTime()).toBe(stamp.getTime());
  });

  // The pgboss schema is created by pg-boss's own `boss.start()`, not by this
  // app's migrations — a database no worker has ever run against yet has no
  // such schema, which reads as "no evidence either way", not a fault.
  // Exercised against a stub rather than a real connection: dropping the real
  // `pgboss` schema to reach this branch would break `tests/worker-queues.test.ts`
  // if it ran concurrently against the same shared database.
  it("falls open to null when the pgboss schema does not exist (42P01)", async () => {
    const undefinedTable: Dbx = {
      execute: async () => {
        const err = new Error('relation "pgboss.version" does not exist') as Error & {
          code?: string;
        };
        err.code = "42P01";
        throw err;
      },
    } as unknown as Dbx;
    expect(await workerHeartbeat(undefinedTable)).toBeNull();
  });
});
