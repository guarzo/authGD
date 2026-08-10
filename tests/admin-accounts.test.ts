import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, auditLog, outbox } from "@/db/schema";
import {
  approveAccount,
  returnTierToAuto,
  setAccountStatus,
  setMainCharacterAsAdmin,
  setStatusNote,
  setTierManual,
} from "@/services/admin-accounts";
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

async function seedAdmin() {
  const acc = await seedAccount(ctx.db);
  await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, acc.id));
  return acc;
}
const getAcc = async (id: string) =>
  (await ctx.db.select().from(account).where(eq(account.id, id)))[0];
const outboxRows = () => ctx.db.select().from(outbox);
const lastAudit = async () =>
  (await ctx.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0];

describe("setTierManual", () => {
  it("sets tier, locks, stamps changed-by, audits, and enqueues sync in one tx", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "member" });
    const r = await ctx.db.transaction((tx) =>
      setTierManual(tx, admin.id, target.id, "associate"),
    );
    expect(r).toEqual({ ok: true, tierLocked: true });
    const after = await getAcc(target.id);
    expect(after.tier).toBe("associate");
    expect(after.tierLocked).toBe(true);
    expect(after.tierChangedBy).toBe(admin.id);
    expect(after.tierChangedAt).not.toBeNull();
    const audit = await lastAudit();
    expect(audit.action).toBe("tier.changed");
    expect(audit.actor).toBe(admin.id);
    expect(audit.details).toMatchObject({
      to: "associate",
      locked: true,
      cause: "manual",
    });
    expect(await outboxRows()).toHaveLength(1);
  });

  // Sweep item #1. Pressing the tier an account already holds, while it is
  // still UNLOCKED, is the pin: it stops the membership job from moving the
  // account later, which is the whole reason `tierLocked` exists. Admins reach
  // for it at exactly the moment the account already reads `member` — before
  // someone leaves the alliance — so this press must keep working in one
  // press. What made it a hazard was that it was indistinguishable from an
  // accidental press, and that is fixed on the surface (the chip arms first,
  // page.tsx) rather than here by removing the capability.
  it("pressing the tier already held on an UNLOCKED account pins it (locks, audits, syncs)", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "alumni", tierLocked: false });
    const r = await ctx.db.transaction((tx) =>
      setTierManual(tx, admin.id, target.id, "alumni"),
    );
    // `r.tierLocked` is what `setTierAction` reads to keep the confirmation
    // honest (view.ts): this press really did lock the account.
    expect(r).toEqual({ ok: true, tierLocked: true });
    const after = await getAcc(target.id);
    expect(after.tier).toBe("alumni");
    expect(after.tierLocked).toBe(true);
    expect(after.tierChangedBy).toBe(admin.id);
    // One audit row and one sync, naming the tier as unchanged — the record an
    // admin later reads on /admin/audit says "pinned at alumni", not a
    // demotion to some other tier and back.
    const audit = await lastAudit();
    expect(audit.action).toBe("tier.changed");
    expect(audit.details).toMatchObject({ from: "alumni", to: "alumni", locked: true });
    expect(await outboxRows()).toHaveLength(1);
  });

  it("is a no-op when already locked at that tier", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "associate", tierLocked: true });
    const r = await ctx.db.transaction((tx) =>
      setTierManual(tx, admin.id, target.id, "associate"),
    );
    expect(r).toEqual({ ok: true, tierLocked: true });
    expect(await outboxRows()).toHaveLength(0);
    expect(await lastAudit()).toBeUndefined();
  });

  it("rejects non-admin actors", async () => {
    const nobody = await seedAccount(ctx.db);
    const target = await seedAccount(ctx.db);
    const r = await ctx.db.transaction((tx) =>
      setTierManual(tx, nobody.id, target.id, "associate"),
    );
    expect(r).toEqual({ ok: false, error: "not_authorized" });
  });

  it("records the tier it moved from, so the transition reads both ways", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "member" });
    await ctx.db.transaction((tx) => setTierManual(tx, admin.id, target.id, "associate"));
    const audit = await lastAudit();
    expect(audit.details).toMatchObject({
      from: "member",
      to: "associate",
      locked: true,
      cause: "manual",
    });
  });
});

describe("setAccountStatus not_found", () => {
  it("returns not_found for a missing target account", async () => {
    const admin = await seedAdmin();
    const r = await ctx.db.transaction((tx) =>
      setAccountStatus(tx, admin.id, "00000000-0000-0000-0000-000000000000", "cryo"),
    );
    expect(r).toEqual({ ok: false, error: "not_found" });
  });
});

describe("returnTierToAuto", () => {
  it("clears the lock only — tier and changed-at untouched — audits, enqueues", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db, { tier: "associate", tierLocked: true });
    const before = await getAcc(target.id);
    await ctx.db.transaction((tx) => returnTierToAuto(tx, admin.id, target.id));
    const after = await getAcc(target.id);
    expect(after.tierLocked).toBe(false);
    expect(after.tier).toBe("associate"); // membership job converges it later
    expect(after.tierChangedAt).toEqual(before.tierChangedAt);
    expect((await lastAudit()).action).toBe("tier.unlocked");
    expect(await outboxRows()).toHaveLength(1);
  });

  it("is a no-op when already unlocked", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) => returnTierToAuto(tx, admin.id, target.id));
    expect(await outboxRows()).toHaveLength(0);
  });

  it("records the tier automation was handed back", async () => {
    const admin = await seedAdmin();
    // Seeded and locked tiers differ, so the assertion picks between two live
    // values rather than passing against a hardcoded literal.
    const target = await seedAccount(ctx.db, { tier: "member" });
    await ctx.db.transaction((tx) => setTierManual(tx, admin.id, target.id, "associate"));
    await ctx.db.transaction((tx) => returnTierToAuto(tx, admin.id, target.id));
    const audit = await lastAudit();
    expect(audit.action).toBe("tier.unlocked");
    expect(audit.details).toMatchObject({ tier: "associate" });
  });
});

describe("setAccountStatus / setStatusNote", () => {
  it("cryo toggle stamps the date, audits, and enqueues", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) => setAccountStatus(tx, admin.id, target.id, "cryo"));
    const after = await getAcc(target.id);
    expect(after.status).toBe("cryo");
    expect(after.statusChangedAt).not.toBeNull();
    expect((await lastAudit()).details).toMatchObject({ to: "cryo" });
    expect(await outboxRows()).toHaveLength(1);
  });

  it("status no-op when unchanged", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) => setAccountStatus(tx, admin.id, target.id, "active"));
    expect(await outboxRows()).toHaveLength(0);
  });

  it("note is trimmed, empty clears to null, audited, NO outbox row", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) =>
      setStatusNote(tx, admin.id, target.id, "  back in Oct  "),
    );
    expect((await getAcc(target.id)).statusNote).toBe("back in Oct");
    expect((await lastAudit()).action).toBe("status.note_changed");
    await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "   "));
    expect((await getAcc(target.id)).statusNote).toBeNull();
    expect(await outboxRows()).toHaveLength(0);
  });

  it("records the status it moved from", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) => setAccountStatus(tx, admin.id, target.id, "cryo"));
    const audit = await lastAudit();
    expect(audit.details).toMatchObject({ from: "active", to: "cryo" });
  });

  it("records whether a status note was added, replaced, or cleared", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);

    await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "first"));
    expect((await lastAudit()).details).toMatchObject({ had: false, has: true });

    await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "second"));
    expect((await lastAudit()).details).toMatchObject({ had: true, has: true });

    await ctx.db.transaction((tx) => setStatusNote(tx, admin.id, target.id, "   "));
    expect((await lastAudit()).details).toMatchObject({ had: true, has: false });
  });

  it("does not record the note text, which lives on the account", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await ctx.db.transaction((tx) =>
      setStatusNote(tx, admin.id, target.id, "left the corp"),
    );
    expect(JSON.stringify((await lastAudit()).details)).not.toContain("left the corp");
  });
});

describe("approveAccount", () => {
  it("approves to alumni WITHOUT locking, so the member can still auto-promote", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    const target = await seedAccount(ctx.db, { tier: "pending" });

    const res = await ctx.db.transaction((tx) =>
      approveAccount(tx, admin.id, target.id, "alumni"),
    );

    expect(res).toEqual({ ok: true });
    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.tier).toBe("alumni");
    expect(after.tierLocked).toBe(false);
    expect(after.tierChangedBy).toBe(admin.id);
  });

  it("approves to associate WITH a lock, since an unlocked associate converges to alumni", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    const target = await seedAccount(ctx.db, { tier: "pending" });

    await ctx.db.transaction((tx) =>
      approveAccount(tx, admin.id, target.id, "associate"),
    );

    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.tier).toBe("associate");
    expect(after.tierLocked).toBe(true);
  });

  it("refuses an account that is not pending", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    const target = await seedAccount(ctx.db, { tier: "member" });

    const res = await ctx.db.transaction((tx) =>
      approveAccount(tx, admin.id, target.id, "alumni"),
    );

    expect(res).toEqual({ ok: false, error: "not_pending" });
    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.tier).toBe("member");
  });

  it("refuses a non-admin actor", async () => {
    const nobody = await seedAccount(ctx.db, {});
    const target = await seedAccount(ctx.db, { tier: "pending" });

    const res = await ctx.db.transaction((tx) =>
      approveAccount(tx, nobody.id, target.id, "alumni"),
    );

    expect(res).toEqual({ ok: false, error: "not_authorized" });
  });

  it("returns not_found for a target that no longer exists (merged away)", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });

    const res = await ctx.db.transaction((tx) =>
      approveAccount(tx, admin.id, "00000000-0000-0000-0000-000000000000", "alumni"),
    );

    expect(res).toEqual({ ok: false, error: "not_found" });
  });

  it("audits the approval and enqueues a sync", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    const target = await seedAccount(ctx.db, { tier: "pending" });

    await ctx.db.transaction((tx) => approveAccount(tx, admin.id, target.id, "alumni"));

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "tier.approved"));
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(admin.id);
    expect(rows[0].target).toBe(target.id);
    expect(rows[0].details).toEqual({ to: "alumni", locked: false });
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  });
});

describe("setMainCharacterAsAdmin", () => {
  it("refuses a non-admin actor", async () => {
    const member = await seedAccount(ctx.db);
    const target = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90000001, accountId: target.id, main: true });
    const alt = await seedCharacter(ctx.db, cfg, { id: 90000002, accountId: target.id });
    const result = await ctx.db.transaction((tx) =>
      setMainCharacterAsAdmin(tx, member.id, target.id, alt.id),
    );
    expect(result).toEqual({ ok: false, error: "not_authorized" });
  });

  it("refuses a character that isn't on the account", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90000003, accountId: target.id, main: true });
    const other = await seedAccount(ctx.db);
    const stranger = await seedCharacter(ctx.db, cfg, {
      id: 90000004,
      accountId: other.id,
    });
    const result = await ctx.db.transaction((tx) =>
      setMainCharacterAsAdmin(tx, admin.id, target.id, stranger.id),
    );
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("promotes the alt, names it, and logs the admin action", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90000005, accountId: target.id, main: true });
    const alt = await seedCharacter(ctx.db, cfg, {
      id: 90000006,
      accountId: target.id,
      name: "Alt Two",
    });
    const result = await ctx.db.transaction((tx) =>
      setMainCharacterAsAdmin(tx, admin.id, target.id, alt.id),
    );
    expect(result).toEqual({ ok: true, name: "Alt Two" });
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(acc.mainCharacterId).toBe(alt.id);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, target.id));
    expect(rows.some((r) => r.action === "admin.main_changed")).toBe(true);
  });

  // actor === target here, which is exactly why the action discriminator exists
  // rather than a comparison of the two.
  it("an admin fixing their own account still writes the admin action", async () => {
    const admin = await seedAdmin();
    await seedCharacter(ctx.db, cfg, { id: 90000007, accountId: admin.id, main: true });
    const adminAlt = await seedCharacter(ctx.db, cfg, {
      id: 90000008,
      accountId: admin.id,
    });
    const result = await ctx.db.transaction((tx) =>
      setMainCharacterAsAdmin(tx, admin.id, admin.id, adminAlt.id),
    );
    expect(result.ok).toBe(true);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, admin.id));
    expect(rows.some((r) => r.action === "admin.main_changed")).toBe(true);
    expect(rows.some((r) => r.action === "account.main_changed")).toBe(false);
  });

  it("enqueues a sync so the tier re-decides", async () => {
    const admin = await seedAdmin();
    const target = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90000009, accountId: target.id, main: true });
    const alt = await seedCharacter(ctx.db, cfg, { id: 90000010, accountId: target.id });
    await ctx.db.transaction((tx) =>
      setMainCharacterAsAdmin(tx, admin.id, target.id, alt.id),
    );
    const rows = await ctx.db.select().from(outbox);
    expect(
      rows.some((r) => r.payload.kind === "account" && r.payload.accountId === target.id),
    ).toBe(true);
  });
});
