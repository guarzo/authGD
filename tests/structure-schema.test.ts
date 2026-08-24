import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { MANAGED_TABLE_NAMES } from "@/db/tables";

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

describe("structure monitor schema", () => {
  it("registers all four tables in MANAGED_TABLES", () => {
    for (const t of [
      "structure_holder",
      "structure_read_state",
      "structure",
      "structure_event",
    ]) {
      expect(MANAGED_TABLE_NAMES).toContain(t);
    }
  });

  it("pins structure_holder to a single row", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await ctx.db.execute(
      sql`insert into structure_holder (id, character_id, corporation_id, designated_by) values (1, 90000001, 5, 'system')`,
    );
    await expect(
      ctx.db.execute(
        sql`insert into structure_holder (id, character_id, corporation_id, designated_by) values (2, 90000001, 5, 'system')`,
      ),
    ).rejects.toThrow();
  });

  it("keys structure_read_state by (kind, corporation_id)", async () => {
    await ctx.db.execute(
      sql`insert into structure_read_state (kind, corporation_id, last_attempt_at, read_status) values ('roster', 98000001, now(), 'ok')`,
    );
    await ctx.db.execute(
      sql`insert into structure_read_state (kind, corporation_id, last_attempt_at, read_status) values ('roster', 98000002, now(), 'ok')`,
    );
    await expect(
      ctx.db.execute(
        sql`insert into structure_read_state (kind, corporation_id, last_attempt_at, read_status) values ('roster', 98000001, now(), 'ok')`,
      ),
    ).rejects.toThrow();
  });

  it("carries all four alert statuses", async () => {
    const res = await ctx.db.execute(
      sql`select unnest(enum_range(null::structure_alert_status))::text as v`,
    );
    const values = res.rows.map((r) => (r as { v: string }).v);
    expect(values.sort()).toEqual(["abandoned", "pending", "seeded", "sent"]);
  });
});
