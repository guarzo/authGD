import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accessListEntry, accessListHolder, character } from "@/db/schema";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { expectCheckViolation } from "./helpers/constraints";

const cfg = testConfig();
const HOLDER_ID = 90000001;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedHolder() {
  const acc = await seedAccount(ctx.db);
  await seedCharacter(ctx.db, cfg, { id: HOLDER_ID, accountId: acc.id });
  await ctx.db
    .insert(accessListHolder)
    .values({ id: 1, characterId: HOLDER_ID, designatedBy: acc.id });
  return acc;
}

describe("access_list_holder", () => {
  it("disappears when the holder character is deleted", async () => {
    await seedHolder();
    // The real unlink and transfer-reclaim paths both delete(character); a
    // NO ACTION default would make them fail for whoever is the holder.
    await ctx.db.delete(character).where(eq(character.id, HOLDER_ID));
    expect(await ctx.db.select().from(accessListHolder)).toEqual([]);
  });

  it("refuses a second row via the singleton check", async () => {
    const acc = await seedHolder();
    await seedCharacter(ctx.db, cfg, { id: 90000002, accountId: acc.id });
    await expectCheckViolation(
      ctx.db
        .insert(accessListHolder)
        .values({ id: 2, characterId: 90000002, designatedBy: acc.id }),
      "access_list_holder_singleton_ck",
    );
  });
});

describe("access_list_entry", () => {
  it("rejects a duplicate (list, kind, entity) triple", async () => {
    const row = {
      accessListId: 101,
      kind: "character" as const,
      entityId: 90000002,
      access: "member",
    };
    await ctx.db.insert(accessListEntry).values(row);
    await expectCheckViolation(
      ctx.db.insert(accessListEntry).values(row),
      "access_list_entry_uq",
    );
  });

  it("allows the same entity under a different kind", async () => {
    await ctx.db.insert(accessListEntry).values([
      { accessListId: 101, kind: "character", entityId: 5, access: "member" },
      { accessListId: 101, kind: "corporation", entityId: 5, access: "member" },
    ]);
    expect(await ctx.db.select().from(accessListEntry)).toHaveLength(2);
  });
});
