import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessListCatalog,
  accessListHolder,
  accessListWatch,
  auditLog,
} from "@/db/schema";
import {
  addWatch,
  designateHolder,
  getHolder,
  getWatchedListIds,
  removeWatch,
} from "@/services/access-lists";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

const audits = () => ctx.db.select().from(auditLog).orderBy(desc(auditLog.id));

/** Two linked characters, so the holder FK has something to point at. */
async function seedTwoCharacters() {
  const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
  await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
  await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id });
  return acc;
}

describe("getHolder / designateHolder", () => {
  it("returns null when nothing is designated", async () => {
    expect(await getHolder(ctx.db)).toBeNull();
  });

  it("designates a first holder and audits holder_designated", async () => {
    const acc = await seedTwoCharacters();
    await designateHolder(ctx.db, 1, acc.id);
    expect(await getHolder(ctx.db)).toMatchObject({
      characterId: 1,
      designatedBy: acc.id,
    });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: acc.id,
      action: "access_list.holder_designated",
      target: "1",
      details: { characterId: 1 },
    });
  });

  it("records BOTH the previous and the new character id when replacing", async () => {
    const acc = await seedTwoCharacters();
    await designateHolder(ctx.db, 1, acc.id);
    await designateHolder(ctx.db, 2, acc.id);
    expect(await getHolder(ctx.db)).toMatchObject({ characterId: 2 });
    const rows = await audits();
    expect(rows[0]).toMatchObject({
      action: "access_list.holder_replaced",
      target: "2",
      details: { previousCharacterId: 1, characterId: 2 },
    });
  });

  it("stays a singleton across repeated designation", async () => {
    const acc = await seedTwoCharacters();
    await designateHolder(ctx.db, 1, acc.id);
    await designateHolder(ctx.db, 2, acc.id);
    const rows = await ctx.db.select().from(accessListHolder);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, characterId: 2 });
  });
});

describe("addWatch / removeWatch / getWatchedListIds", () => {
  const seedCatalog = (accessListId: number, name: string) =>
    ctx.db.insert(accessListCatalog).values({
      accessListId,
      name,
      discoveredAt: new Date(),
      observedByCharacterId: 1,
    });

  it("adds a watch and audits the list id and name", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await seedCatalog(42, "Home Structures");
    await addWatch(ctx.db, 42, acc.id);
    expect(await getWatchedListIds(ctx.db)).toEqual([42]);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: acc.id,
      action: "access_list.watch_added",
      target: "42",
      details: { accessListId: 42, name: "Home Structures" },
    });
  });

  it("removes a watch and audits the list id and name", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await seedCatalog(42, "Home Structures");
    await addWatch(ctx.db, 42, acc.id);
    await removeWatch(ctx.db, 42, acc.id);
    expect(await getWatchedListIds(ctx.db)).toEqual([]);
    expect(await ctx.db.select().from(accessListWatch)).toHaveLength(0);
    const rows = await audits();
    expect(rows[0]).toMatchObject({
      action: "access_list.watch_removed",
      target: "42",
      details: { accessListId: 42, name: "Home Structures" },
    });
  });

  it("audits a null name for a list that is no longer in the catalog", async () => {
    // The usual reason to remove a watch: the holder can no longer see the
    // list, so discovery dropped it. An unnamed row still audits.
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await addWatch(ctx.db, 7, acc.id);
    await removeWatch(ctx.db, 7, acc.id);
    const rows = await audits();
    expect(rows[0]).toMatchObject({
      action: "access_list.watch_removed",
      details: { accessListId: 7, name: null },
    });
  });

  it("writes no audit row when nothing actually changed", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await addWatch(ctx.db, 7, acc.id);
    await addWatch(ctx.db, 7, acc.id); // already watched
    await removeWatch(ctx.db, 8, acc.id); // never watched
    expect(await audits()).toHaveLength(1);
  });

  it("returns watched ids in a stable order", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", isAdmin: true });
    await addWatch(ctx.db, 9, acc.id);
    await addWatch(ctx.db, 3, acc.id);
    expect(await getWatchedListIds(ctx.db)).toEqual([3, 9]);
  });
});
