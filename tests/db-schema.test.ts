import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, character, discordLink, universeName } from "@/db/schema";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("schema", () => {
  it("creates an account with defaults and a character", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    expect(acc.tier).toBe("alumni");
    expect(acc.tierLocked).toBe(false);
    expect(acc.status).toBe("active");
    expect(acc.isAdmin).toBe(false);

    const [ch] = await ctx.db
      .insert(character)
      .values({
        id: 90000001,
        accountId: acc.id,
        name: "Pilot One",
        ownerHash: "oh1",
        scopes: ["esi-characters.read_contacts.v1"],
        tokenStatus: "valid",
      })
      .returning();
    expect(ch.affiliationInvalid).toBe(false);
    expect(ch.tokenStatus).toBe("valid");
  });

  it("enforces unique discord_user_id", async () => {
    const [a1] = await ctx.db.insert(account).values({}).returning();
    const [a2] = await ctx.db.insert(account).values({}).returning();
    await ctx.db
      .insert(discordLink)
      .values({ accountId: a1.id, discordUserId: "duid-1" });
    await expect(
      ctx.db.insert(discordLink).values({ accountId: a2.id, discordUserId: "duid-1" }),
    ).rejects.toThrow();
  });

  it("rejects a main character belonging to another account", async () => {
    const [a1] = await ctx.db.insert(account).values({}).returning();
    const [a2] = await ctx.db.insert(account).values({}).returning();
    await ctx.db.insert(character).values({
      id: 90000042,
      accountId: a1.id,
      name: "Owned by a1",
      ownerHash: "oh",
      scopes: [],
      tokenStatus: "missing",
    });
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx
          .update(account)
          .set({ mainCharacterId: 90000042 })
          .where(eq(account.id, a2.id));
      }),
    ).rejects.toThrow();
  });

  it("tier enum carries the generic vocabulary in declaration order", async () => {
    const res = await ctx.db.execute(
      sql`SELECT e.enumlabel AS label
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'tier'
          ORDER BY e.enumsortorder`,
    );
    expect(res.rows.map((r) => r.label)).toEqual([
      "member",
      "associate",
      "alumni",
      "pending",
    ]);
  });

  it("account.tier defaults to alumni", async () => {
    const res = await ctx.db.execute(
      sql`SELECT column_default FROM information_schema.columns
          WHERE table_name = 'account' AND column_name = 'tier'`,
    );
    expect(String(res.rows[0]?.column_default)).toContain("alumni");
  });
});

describe("location columns", () => {
  it("defaults every location column to null on a fresh character", async () => {
    const acc = await seedAccount(ctx.db);
    const ch = await seedCharacter(ctx.db, cfg, { id: 90000201, accountId: acc.id });
    expect(ch.locationSystemId).toBeNull();
    expect(ch.locationStationId).toBeNull();
    expect(ch.locationStructureId).toBeNull();
    expect(ch.locationOnline).toBeNull();
    expect(ch.locationCheckedAt).toBeNull();
  });

  it("round-trips a written location", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90000202, accountId: acc.id });
    const checkedAt = new Date("2026-08-06T12:00:00Z");
    await ctx.db
      .update(character)
      .set({
        locationSystemId: 31000123,
        locationStructureId: 1035466617946,
        locationOnline: true,
        locationCheckedAt: checkedAt,
      })
      .where(eq(character.id, 90000202));
    const [row] = await ctx.db.select().from(character).where(eq(character.id, 90000202));
    expect(row.locationSystemId).toBe(31000123);
    expect(row.locationStationId).toBeNull();
    expect(row.locationStructureId).toBe(1035466617946);
    expect(row.locationOnline).toBe(true);
    expect(row.locationCheckedAt).toEqual(checkedAt);
  });
});

describe("universe_name", () => {
  it("stores one row per id across all three kinds, stamped with fetchedAt", async () => {
    await ctx.db.insert(universeName).values([
      { id: 31000123, kind: "system", name: "J123456" },
      { id: 60003760, kind: "station", name: "Jita IV - Moon 4" },
      { id: 1035466617946, kind: "structure", name: "Home Astrahus" },
    ]);
    const rows = await ctx.db.select().from(universeName).orderBy(universeName.id);
    expect(rows.map((r) => r.kind)).toEqual(["system", "station", "structure"]);
    expect(rows[2].name).toBe("Home Astrahus");
    expect(rows[0].fetchedAt).toBeInstanceOf(Date);
  });

  it("rejects a duplicate id", async () => {
    await ctx.db
      .insert(universeName)
      .values({ id: 31000999, kind: "system", name: "J999999" });
    await expect(
      ctx.db
        .insert(universeName)
        .values({ id: 31000999, kind: "system", name: "J999999" }),
    ).rejects.toThrow();
  });
});
