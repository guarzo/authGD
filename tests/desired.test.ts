import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getFlygdCharacters } from "@/services/desired";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

describe("getFlygdCharacters", () => {
  it("returns every character of every flygd account and nothing else", async () => {
    const flygd = await seedAccount(ctx.db, { tier: "flygd" });
    const green = await seedAccount(ctx.db, { tier: "green" });
    const blue = await seedAccount(ctx.db, { tier: "blue", tierLocked: true });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: flygd.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: flygd.id }); // alt counts too
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: green.id });
    await seedCharacter(ctx.db, cfg, { id: 4, accountId: blue.id });
    const rows = await getFlygdCharacters(ctx.db);
    expect(rows.map((r) => r.characterId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ accountId: flygd.id, tokenStatus: "valid" });
  });
});
