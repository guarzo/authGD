import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { auditLog, structureEvent } from "@/db/schema";
import {
  designateStructureHolder,
  getStructureHolder,
  markSeeded,
  stillStructureHolder,
} from "@/services/structures";

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

describe("designateStructureHolder", () => {
  it("pins the corporation and audits the designation", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);

    const holder = await getStructureHolder(ctx.db);
    expect(holder).toMatchObject({ characterId: 90000001, corporationId: 98000001 });
    expect(holder?.seededAt).toBeNull();

    const rows = await ctx.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("structure.holder_designated");
    expect(rows[0].details).toMatchObject({
      characterId: 90000001,
      corporationId: 98000001,
    });
  });

  it("retires pending alerts when the holder is replaced, and says how many", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await seedCharacter(ctx.db, testConfig(), { id: 90000002, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    await ctx.db.insert(structureEvent).values([
      {
        notificationId: 1,
        type: "StructureUnderAttack",
        sentAt: new Date(),
        corporationId: 98000001,
        alertStatus: "pending",
      },
      {
        notificationId: 2,
        type: "StructureLostArmor",
        sentAt: new Date(),
        corporationId: 98000001,
        alertStatus: "sent",
      },
    ]);

    const result = await designateStructureHolder(ctx.db, 90000002, 98000002, account.id);
    expect(result.abandonedAlerts).toBe(1);

    const [one] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 1));
    expect(one.alertStatus).toBe("abandoned");
    const [two] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 2));
    expect(two.alertStatus).toBe("sent");

    const rows = await ctx.db.select().from(auditLog);
    const replaced = rows.find((r) => r.action === "structure.holder_replaced");
    expect(replaced?.details).toMatchObject({
      previousCharacterId: 90000001,
      characterId: 90000002,
      abandonedAlerts: 1,
    });
  });

  it("resets seededAt so a new holder re-seeds", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await seedCharacter(ctx.db, testConfig(), { id: 90000002, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    await markSeeded(ctx.db, new Date());
    expect((await getStructureHolder(ctx.db))?.seededAt).toBeInstanceOf(Date);
    await designateStructureHolder(ctx.db, 90000002, 98000002, account.id);
    expect((await getStructureHolder(ctx.db))?.seededAt).toBeNull();
  });
});

describe("stillStructureHolder", () => {
  it("is false once another character has been designated", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await seedCharacter(ctx.db, testConfig(), { id: 90000002, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    expect(await stillStructureHolder(ctx.db, 90000001)).toBe(true);
    await designateStructureHolder(ctx.db, 90000002, 98000002, account.id);
    expect(await stillStructureHolder(ctx.db, 90000001)).toBe(false);
  });
});
