import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { auditLog, character, structureEvent } from "@/db/schema";
import { NOTIFICATIONS_SCOPE, STRUCTURES_SCOPE } from "@/lib/esi/client";
import {
  designateStructureHolder,
  findGrantableCharacter,
  getStructureHolder,
  markSeeded,
  stillStructureHolder,
  toHolderView,
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

  it("retires nothing when the holder is replaced within the same corp", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await seedCharacter(ctx.db, testConfig(), { id: 90000002, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    await ctx.db.insert(structureEvent).values({
      notificationId: 1,
      type: "StructureUnderAttack",
      sentAt: new Date(),
      corporationId: 98000001,
      alertStatus: "pending",
    });

    const result = await designateStructureHolder(ctx.db, 90000002, 98000001, account.id);
    expect(result.abandonedAlerts).toBe(0);

    const [one] = await ctx.db
      .select()
      .from(structureEvent)
      .where(eq(structureEvent.notificationId, 1));
    expect(one.alertStatus).toBe("pending");
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
    const holder = await getStructureHolder(ctx.db);
    expect(await stillStructureHolder(ctx.db, 90000001, holder!.designatedAt)).toBe(true);
    await designateStructureHolder(ctx.db, 90000002, 98000002, account.id);
    expect(await stillStructureHolder(ctx.db, 90000001, holder!.designatedAt)).toBe(
      false,
    );
  });

  it("returns true when nothing has changed since the snapshot", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    const holder = await getStructureHolder(ctx.db);
    expect(await stillStructureHolder(ctx.db, 90000001, holder!.designatedAt)).toBe(true);
  });

  it("is false after a same-character re-designation to a different corp", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), { id: 90000001, accountId: account.id });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);
    const snapshot = await getStructureHolder(ctx.db);

    // Same character, re-pinned to a different corp: the id-only CAS this
    // guards against would miss this entirely.
    await designateStructureHolder(ctx.db, 90000001, 98000002, account.id);
    expect(await stillStructureHolder(ctx.db, 90000001, snapshot!.designatedAt)).toBe(
      false,
    );
  });
});

describe("findGrantableCharacter", () => {
  it("returns null when no character carries both scopes", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    await seedCharacter(ctx.db, testConfig(), {
      id: 90000001,
      accountId: admin.id,
      scopes: [],
    });
    expect(await findGrantableCharacter(ctx.db)).toBeNull();
  });

  it("returns null when a character has only one of the two scopes", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    await seedCharacter(ctx.db, testConfig(), {
      id: 90000001,
      accountId: admin.id,
      scopes: [STRUCTURES_SCOPE],
    });
    await seedCharacter(ctx.db, testConfig(), {
      id: 90000002,
      accountId: admin.id,
      scopes: [NOTIFICATIONS_SCOPE],
    });
    expect(await findGrantableCharacter(ctx.db)).toBeNull();
  });

  it("returns the character when it carries both scopes", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    await seedCharacter(ctx.db, testConfig(), {
      id: 90000001,
      accountId: admin.id,
      name: "Grantable One",
      scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
      corporationId: 98000001,
    });
    expect(await findGrantableCharacter(ctx.db)).toMatchObject({
      characterId: 90000001,
      name: "Grantable One",
      corporationId: 98000001,
    });
  });

  it("ignores a character whose account is not an admin, even with both scopes", async () => {
    const nonAdmin = await seedAccount(ctx.db, { isAdmin: false });
    await seedCharacter(ctx.db, testConfig(), {
      id: 90000001,
      accountId: nonAdmin.id,
      scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
    });
    expect(await findGrantableCharacter(ctx.db)).toBeNull();
  });

  it("returns corporationId as null when the character has none", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    await seedCharacter(ctx.db, testConfig(), {
      id: 90000001,
      accountId: admin.id,
      scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
      corporationId: null,
    });
    expect(await findGrantableCharacter(ctx.db)).toMatchObject({
      characterId: 90000001,
      corporationId: null,
    });
  });
});

describe("toHolderView", () => {
  it("keeps the pinned corporationId distinct from the character's current one", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), {
      id: 90000001,
      accountId: account.id,
      corporationId: 98000001,
    });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);

    // The character moves corp after designation; the holder stays pinned.
    await ctx.db
      .update(character)
      .set({ corporationId: 98000099 })
      .where(eq(character.id, 90000001));

    const holder = await getStructureHolder(ctx.db);
    const view = await toHolderView(ctx.db, holder!);
    expect(view.corporationId).toBe(98000001);
    expect(view.currentCorporationId).toBe(98000099);
    expect(view.corporationId).not.toBe(view.currentCorporationId);
  });

  it("carries scopes and tokenStatus through from the character row", async () => {
    const account = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, testConfig(), {
      id: 90000001,
      accountId: account.id,
      scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
      tokenStatus: "needs_reauth",
    });
    await designateStructureHolder(ctx.db, 90000001, 98000001, account.id);

    const holder = await getStructureHolder(ctx.db);
    const view = await toHolderView(ctx.db, holder!);
    expect(view.scopes).toEqual([STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE]);
    expect(view.tokenStatus).toBe("needs_reauth");
  });
});
