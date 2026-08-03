import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, auditLog, character, outbox } from "@/db/schema";
import { runMembershipJob } from "@/jobs/membership";
import { EsiError, type Affiliation } from "@/lib/esi/client";
import { JobRetryError } from "@/services/sync-run";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig(); // allianceId 99000001

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

/** ESI fake: every id resolves into the given alliance (or none). */
const esiWith = (alliances: Record<number, number | null>) => ({
  postAffiliation: async (ids: number[]): Promise<Affiliation[]> =>
    ids.map((id) => ({
      characterId: id,
      corporationId: 1000,
      allianceId: alliances[id] ?? null,
    })),
});

async function getAccount(id: string) {
  const rows = await ctx.db.select().from(account).where(eq(account.id, id));
  return rows[0];
}

describe("runMembershipJob", () => {
  it("promotes green → flygd on a confirmed main in alliance, transactionally with the outbox row", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const result = await runMembershipJob(
      { db: ctx.db, cfg, esi: esiWith({ 1: 99000001 }) },
    );
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ promoted: 1, demoted: 0 });
    const after = await getAccount(acc.id);
    expect(after.tier).toBe("flygd");
    expect(after.tierChangedBy).toBe("system");
    const outboxRows = await ctx.db.select().from(outbox);
    expect(outboxRows.map((r) => r.payload)).toContainEqual({
      kind: "account",
      accountId: acc.id,
    });
    const audits = await ctx.db.select().from(auditLog);
    expect(
      audits.some((a) => a.action === "tier.changed" && a.target === acc.id),
    ).toBe(true);
  });

  it("demotes flygd → green when the main left the alliance", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id, main: true });
    await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({ 2: null }) });
    expect((await getAccount(acc.id)).tier).toBe("green");
  });

  it("never touches tier_locked accounts", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", tierLocked: true });
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: acc.id, main: true });
    await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({ 3: null }) });
    expect((await getAccount(acc.id)).tier).toBe("flygd");
  });

  it("skips null-main accounts", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 4, accountId: acc.id }); // not main
    await runMembershipJob({ db: ctx.db, cfg, esi: esiWith({ 4: null }) });
    expect((await getAccount(acc.id)).tier).toBe("flygd");
  });

  it("leaves accounts with unresolved mains untouched and retries", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 5, accountId: acc.id, main: true });
    const esi = {
      postAffiliation: async (): Promise<Affiliation[]> => {
        throw new EsiError("esi down", 503, "transient");
      },
    };
    await expect(
      runMembershipJob({ db: ctx.db, cfg, esi }),
    ).rejects.toBeInstanceOf(JobRetryError);
    expect((await getAccount(acc.id)).tier).toBe("flygd"); // an ESI outage can never mass-demote
  });

  it("flags only bisected 400 ids as affiliation_invalid and audits them", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, { id: 6, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 7, accountId: acc.id });
    const esi = {
      postAffiliation: async (ids: number[]): Promise<Affiliation[]> => {
        if (ids.includes(7)) throw new EsiError("bad id", 400, "permanent");
        return ids.map((id) => ({ characterId: id, corporationId: 1, allianceId: 99000001 }));
      },
    };
    const result = await runMembershipJob({ db: ctx.db, cfg, esi });
    expect(result.counts).toMatchObject({ invalid: 1, promoted: 1 });
    const rows = await ctx.db.select().from(character).where(eq(character.id, 7));
    expect(rows[0].affiliationInvalid).toBe(true);
    const six = await ctx.db.select().from(character).where(eq(character.id, 6));
    expect(six[0].affiliationInvalid).toBe(false);
    expect(six[0].allianceId).toBe(99000001);
  });

  it("excludes flagged characters unless recheckInvalid is set", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 8, accountId: acc.id, affiliationInvalid: true });
    const seen: number[][] = [];
    const esi = {
      postAffiliation: async (ids: number[]): Promise<Affiliation[]> => {
        seen.push(ids);
        return ids.map((id) => ({ characterId: id, corporationId: 1, allianceId: null }));
      },
    };
    await runMembershipJob({ db: ctx.db, cfg, esi });
    expect(seen.flat()).not.toContain(8);
    await runMembershipJob({ db: ctx.db, cfg, esi }, { recheckInvalid: true });
    expect(seen.flat()).toContain(8);
    // a successful recheck clears the flag
    const rows = await ctx.db.select().from(character).where(eq(character.id, 8));
    expect(rows[0].affiliationInvalid).toBe(false);
  });

  it("scopes to one account when accountId is passed", async () => {
    const a1 = await seedAccount(ctx.db, { tier: "green" });
    const a2 = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, { id: 10, accountId: a1.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 11, accountId: a2.id, main: true });
    await runMembershipJob(
      { db: ctx.db, cfg, esi: esiWith({ 10: 99000001, 11: 99000001 }) },
      { accountId: a1.id },
    );
    expect((await getAccount(a1.id)).tier).toBe("flygd");
    expect((await getAccount(a2.id)).tier).toBe("green"); // untouched
  });
});
