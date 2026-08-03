import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { loadConfig, type Config } from "@/config";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  wandererAclObservation,
} from "@/db/schema";
import { getAccountView, getAdminAccountsList } from "@/services/account-view";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let cfg: Config;

beforeAll(async () => {
  ctx = await setupTestDb();
  cfg = loadConfig({
    ...process.env,
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "http://localhost:3000",
    ALLIANCE_ID: "99000001",
    EVE_SSO_CLIENT_ID: "c",
    EVE_SSO_CLIENT_SECRET: "s",
    EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
    DISCORD_CLIENT_ID: "d",
    DISCORD_CLIENT_SECRET: "d",
    DISCORD_BOT_TOKEN: "d",
    DISCORD_GUILD_ID: "1",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_ACL_ID: "a",
    ESI_CONTACT: "ops@example.com",
  });
});
beforeEach(() =>
  ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, contact_sync_state,
      wanderer_acl_observation RESTART IDENTITY CASCADE
  `),
);
afterAll(() => ctx.cleanup());

describe("getAccountView", () => {
  it("assembles characters with token, sync, and map state", async () => {
    // account.main_character_id has a deferred composite FK onto
    // character(id, account_id); it isn't checked until COMMIT, so both
    // inserts must share one explicit transaction (the account row can't
    // reference a character that doesn't exist yet outside of that).
    const acc = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(account)
        .values({ tier: "flygd", mainCharacterId: 1001 })
        .returning();
      await tx.insert(character).values([
        {
          id: 1001,
          accountId: row.id,
          name: "Main",
          ownerHash: "o1",
          scopes: ["esi-characters.read_contacts.v1", "esi-characters.write_contacts.v1"],
          tokenStatus: "valid",
        },
        {
          id: 1002,
          accountId: row.id,
          name: "Alt",
          ownerHash: "o1",
          scopes: ["esi-characters.read_contacts.v1"], // missing write scope
          tokenStatus: "valid",
        },
      ]);
      return row;
    });
    await ctx.db.insert(discordLink).values({ accountId: acc.id, discordUserId: "d1" });
    await ctx.db.insert(contactSyncState).values({
      characterId: 1002,
      lastResult: "missing_label",
    });
    await ctx.db.insert(wandererAclObservation).values({
      characterId: 1001,
      role: "member",
      observedAt: new Date(),
    });

    const view = await getAccountView(ctx.db, cfg, acc.id);
    expect(view.tier).toBe("flygd");
    expect(view.discordLinked).toBe(true);

    const main = view.characters.find((c) => c.id === 1001)!;
    expect(main.isMain).toBe(true);
    expect(main.needsReauthForScopes).toBe(false);
    expect(main.onMapAcl).toBe(true);

    const alt = view.characters.find((c) => c.id === 1002)!;
    expect(alt.needsReauthForScopes).toBe(true);
    expect(alt.contactSyncResult).toBe("missing_label");
    expect(alt.onMapAcl).toBe(false);
  });

  it("handles an account with no characters and no discord link", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const view = await getAccountView(ctx.db, cfg, acc.id);
    expect(view.characters).toEqual([]);
    expect(view.discordLinked).toBe(false);
  });
});

describe("getAdminAccountsList", () => {
  async function seedTrio() {
    // A: flygd, main "Alpha" + alt, on map, discord linked
    const a = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "111" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: a.id,
      main: true,
      name: "Alpha",
    });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: a.id, name: "Alpha Alt" });
    await ctx.db.insert(wandererAclObservation).values({
      characterId: 1,
      role: "viewer",
      observedAt: new Date("2026-08-01T00:00:00Z"),
    });
    // B: green + cryo, main "Beta"
    const b = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, {
      id: 3,
      accountId: b.id,
      main: true,
      name: "Beta",
    });
    await ctx.db
      .update(account)
      .set({ status: "cryo", statusChangedAt: new Date(), statusNote: "afk" })
      .where(eq(account.id, b.id));
    // C: locked blue, set by A, main "Gamma"
    const c = await seedAccount(ctx.db, { tier: "blue", tierLocked: true });
    await seedCharacter(ctx.db, cfg, {
      id: 4,
      accountId: c.id,
      main: true,
      name: "Gamma",
    });
    await ctx.db
      .update(account)
      .set({ tierChangedAt: new Date("2026-07-01T00:00:00Z"), tierChangedBy: a.id })
      .where(eq(account.id, c.id));
    return { a, b, c };
  }

  it("assembles rows: map from observations, discord, lock, resolved changed-by", async () => {
    const { a, c } = await seedTrio();
    const rows = await getAdminAccountsList(ctx.db, cfg);
    const rowA = rows.find((r) => r.accountId === a.id)!;
    expect(rowA.mainName).toBe("Alpha");
    expect(rowA.discordLinked).toBe(true);
    expect(rowA.mapCount).toBe(1);
    expect(rowA.characters.find((ch) => ch.id === 1)?.mapObservedAt).toEqual(
      new Date("2026-08-01T00:00:00Z"),
    );
    expect(rowA.characters.find((ch) => ch.id === 2)?.mapObservedAt).toBeNull();
    const rowC = rows.find((r) => r.accountId === c.id)!;
    expect(rowC.tierLocked).toBe(true);
    expect(rowC.tierChangedByName).toBe("Alpha"); // resolved to actor's main
  });

  it("defaults to name sort with no-main accounts last — in BOTH directions", async () => {
    await seedTrio();
    const noMain = await seedAccount(ctx.db, { tier: "green" }); // zero characters
    const rows = await getAdminAccountsList(ctx.db, cfg);
    expect(rows.map((r) => r.mainName)).toEqual(["Alpha", "Beta", "Gamma", null]);
    expect(rows[3].accountId).toBe(noMain.id);
    const descRows = await getAdminAccountsList(ctx.db, cfg, {
      sort: "name",
      dir: "desc",
    });
    expect(descRows.map((r) => r.mainName)).toEqual(["Gamma", "Beta", "Alpha", null]);
  });

  it("filters by tier and by cryo status", async () => {
    const { a, b } = await seedTrio();
    const flygd = await getAdminAccountsList(ctx.db, cfg, { tier: "flygd" });
    expect(flygd.map((r) => r.accountId)).toEqual([a.id]);
    const cryo = await getAdminAccountsList(ctx.db, cfg, { status: "cryo" });
    expect(cryo.map((r) => r.accountId)).toEqual([b.id]);
  });

  it("sorts by tier rank and by tier-change date desc", async () => {
    await seedTrio();
    const byTier = await getAdminAccountsList(ctx.db, cfg, { sort: "tier" });
    expect(byTier.map((r) => r.tier)).toEqual(["flygd", "blue", "green"]);
    const byDate = await getAdminAccountsList(ctx.db, cfg, {
      sort: "tierChangedAt",
      dir: "desc",
    });
    // C is the only account with tierChangedAt; nulls sort last regardless of dir
    expect(byDate[0].tier).toBe("blue");
  });

  it("summarizes token health", async () => {
    const a = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 10, accountId: a.id, main: true, name: "T1" });
    await seedCharacter(ctx.db, cfg, { id: 11, accountId: a.id, name: "T2" });
    await ctx.db
      .update(character)
      .set({ tokenStatus: "invalid" })
      .where(eq(character.id, 11));
    // Pin the disjoint counters: a character explicitly flagged needs_reauth,
    // and a separate character that's "valid" but missing required scopes —
    // both must land in needsReauth, not healthy, without double-counting.
    await seedCharacter(ctx.db, cfg, {
      id: 12,
      accountId: a.id,
      name: "T3",
      tokenStatus: "needs_reauth",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 13,
      accountId: a.id,
      name: "T4",
      tokenStatus: "valid",
      scopes: [],
    });
    const [row] = await getAdminAccountsList(ctx.db, cfg);
    expect(row.tokenSummary).toEqual({ total: 4, healthy: 1, needsReauth: 2, dead: 1 });
  });
});
