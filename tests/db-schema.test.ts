import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, character, discordLink } from "@/db/schema";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("schema", () => {
  it("creates an account with defaults and a character", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    expect(acc.tier).toBe("green");
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
      ctx.db
        .insert(discordLink)
        .values({ accountId: a2.id, discordUserId: "duid-1" }),
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
});
