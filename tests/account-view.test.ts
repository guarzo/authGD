import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { loadConfig, type Config } from "@/config";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  syncRun,
  wandererAclObservation,
} from "@/db/schema";
import {
  countAccountsByTier,
  getAccountView,
  getAdminAccountsList,
  getPushStatus,
} from "@/services/account-view";
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
    DISCORD_ROLE_ID_MEMBER: "10",
    DISCORD_ROLE_ID_ASSOCIATE: "11",
    DISCORD_ROLE_ID_ALUMNI: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_ACL_ID: "a",
    ESI_CONTACT: "ops@example.com",
    SYNC_MODE: "live",
  });
});
beforeEach(() =>
  ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, contact_sync_state,
      wanderer_acl_observation, sync_run RESTART IDENTITY CASCADE
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
        .values({ tier: "member", mainCharacterId: 1001 })
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
    expect(view.tier).toBe("member");
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

  // Both names are optional at every layer: a link made before the columns
  // existed, or one whose owner has left the guild, carries neither. The view
  // reports null rather than inventing a placeholder, and both pages render the
  // unlink control alone in that case.
  it("carries the discord names through, and reports null when the link has none", async () => {
    const [bare] = await ctx.db.insert(account).values({}).returning();
    await ctx.db
      .insert(discordLink)
      .values({ accountId: bare.id, discordUserId: "d-bare" });
    const bareView = await getAccountView(ctx.db, cfg, bare.id);
    expect(bareView.discordLinked).toBe(true);
    expect(bareView.discordUsername).toBeNull();
    expect(bareView.discordDisplayName).toBeNull();

    const [named] = await ctx.db.insert(account).values({}).returning();
    await ctx.db.insert(discordLink).values({
      accountId: named.id,
      discordUserId: "d-named",
      username: "guarzo",
      displayName: "Wardec Wally",
    });
    const namedView = await getAccountView(ctx.db, cfg, named.id);
    expect(namedView.discordUsername).toBe("guarzo");
    expect(namedView.discordDisplayName).toBe("Wardec Wally");
  });

  it("marks non-member characters as outside the contacts desired set", async () => {
    // An associate member is the content of a member's contact list, never a
    // target of the job, so contact_sync_state will never have a row for them.
    // The view has to say that structurally, or the page reads the permanent
    // null as "your first sync is still pending".
    const acc = await seedAccount(ctx.db, { tier: "associate" });
    await seedCharacter(ctx.db, cfg, { id: 2001, accountId: acc.id });

    const view = await getAccountView(ctx.db, cfg, acc.id);
    expect(view.characters[0].contactsTarget).toBe(false);
    expect(view.characters[0].contactSyncResult).toBeNull();
  });

  it("excludes a member character CCP reports as gone", async () => {
    // affiliation_invalid drops the character from getMemberCharacters, so it
    // stops accruing results for the same structural reason.
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 2002, accountId: acc.id });
    await seedCharacter(ctx.db, cfg, {
      id: 2003,
      accountId: acc.id,
      affiliationInvalid: true,
    });

    const view = await getAccountView(ctx.db, cfg, acc.id);
    const byId = new Map(view.characters.map((c) => [c.id, c]));
    expect(byId.get(2002)!.contactsTarget).toBe(true);
    expect(byId.get(2003)!.contactsTarget).toBe(false);
  });

  it("surfaces the label detail on the member view", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await ctx.db.insert(contactSyncState).values({
      characterId: 1,
      lastResult: "label_mismatch",
      lastDetail: "AUTHGD",
    });

    const view = await getAccountView(ctx.db, cfg, acc.id);
    const ch = view.characters.find((c) => c.id === 1);
    expect(ch?.contactSyncResult).toBe("label_mismatch");
    expect(ch?.contactSyncDetail).toBe("AUTHGD");
  });

  it("leaves the detail null when there is nothing to report", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id, main: true });
    await ctx.db
      .insert(contactSyncState)
      .values({ characterId: 2, lastResult: "ok", lastDetail: null });

    const view = await getAccountView(ctx.db, cfg, acc.id);
    expect(view.characters.find((c) => c.id === 2)?.contactSyncDetail).toBeNull();
  });
});

describe("getPushStatus", () => {
  const run = (
    jobType: string,
    status: "ok" | "partial" | "failed" | null,
    finishedAt: Date | null,
  ) => ctx.db.insert(syncRun).values({ jobType, status, finishedAt });

  it("reports never-run as null, and still answers when the next check is", async () => {
    const pushes = await getPushStatus(ctx.db, new Date("2026-08-03T12:07:00Z"));
    expect(pushes.standings.lastPushedAt).toBeNull();
    expect(pushes.map.lastPushedAt).toBeNull();
    expect(pushes.discord.lastPushedAt).toBeNull();
    // The cadence is knowable even when nothing has run yet, which is what
    // makes a first-boot account page reassuring rather than blank.
    expect(pushes.standings.nextCheckAt?.toISOString()).toBe("2026-08-03T13:05:00.000Z");
    expect(pushes.map.nextCheckAt?.toISOString()).toBe("2026-08-03T12:10:00.000Z");
    expect(pushes.discord.nextCheckAt?.toISOString()).toBe("2026-08-03T12:15:00.000Z");
  });

  it("takes the newest run per job, keeping the three independent", async () => {
    await run("contacts", "ok", new Date("2026-08-03T10:05:30Z"));
    await run("contacts", "ok", new Date("2026-08-03T11:05:30Z"));
    // Inserted last, so highest id, but finished EARLIER than the row above.
    // That makes id order and finished_at order disagree, which is the only
    // way to pin "newest by serial id, never max(finished_at)": a run whose
    // clock lagged is still the most recent thing the worker did.
    await run("contacts", "ok", new Date("2026-08-03T10:35:30Z"));
    await run("wanderer", "ok", new Date("2026-08-03T11:10:30Z"));
    const pushes = await getPushStatus(ctx.db, new Date("2026-08-03T12:07:00Z"));
    expect(pushes.standings.lastPushedAt).toEqual(new Date("2026-08-03T10:35:30Z"));
    expect(pushes.map.lastPushedAt).toEqual(new Date("2026-08-03T11:10:30Z"));
    expect(pushes.discord.lastPushedAt).toBeNull(); // never ran, unaffected
  });

  it("counts partial as pushed but never failed or still-running", async () => {
    // Something was written for some members: claiming nothing happened would
    // be the larger lie.
    await run("contacts", "partial", new Date("2026-08-03T10:05:30Z"));
    // A failed run and an in-flight run must not advance the clock past it.
    await run("contacts", "failed", new Date("2026-08-03T11:05:30Z"));
    await run("contacts", null, null);
    const pushes = await getPushStatus(ctx.db, new Date("2026-08-03T12:07:00Z"));
    expect(pushes.standings.lastPushedAt).toEqual(new Date("2026-08-03T10:05:30Z"));
  });
});

describe("getAdminAccountsList", () => {
  async function seedTrio() {
    // A: member, main "Alpha" + alt, on map, discord linked
    const a = await seedAccount(ctx.db, { tier: "member", discordUserId: "111" });
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
    // B: alumni + cryo, main "Beta"
    const b = await seedAccount(ctx.db, { tier: "alumni" });
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
    // C: locked associate, set by A, main "Gamma"
    const c = await seedAccount(ctx.db, { tier: "associate", tierLocked: true });
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
    // The list shape carries the handle only — the display name is the account
    // page's business, since this table already names the member in column one.
    expect(rowA).not.toHaveProperty("discordDisplayName");
    expect(rowA.discordUsername).toBeNull();
    await ctx.db.update(discordLink).set({ username: "guarzo", displayName: "Wally" });
    const refreshed = (await getAdminAccountsList(ctx.db, cfg)).find(
      (r) => r.accountId === a.id,
    )!;
    expect(refreshed.discordUsername).toBe("guarzo");
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
    const noMain = await seedAccount(ctx.db, { tier: "alumni" }); // zero characters
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
    const member = await getAdminAccountsList(ctx.db, cfg, { tier: "member" });
    expect(member.map((r) => r.accountId)).toEqual([a.id]);
    const cryo = await getAdminAccountsList(ctx.db, cfg, { status: "cryo" });
    expect(cryo.map((r) => r.accountId)).toEqual([b.id]);
  });

  it("sorts by tier rank and by tier-change date desc", async () => {
    await seedTrio();
    const byTier = await getAdminAccountsList(ctx.db, cfg, { sort: "tier" });
    expect(byTier.map((r) => r.tier)).toEqual(["member", "associate", "alumni"]);
    const byDate = await getAdminAccountsList(ctx.db, cfg, {
      sort: "tierChangedAt",
      dir: "desc",
    });
    // C is the only account with tierChangedAt; nulls sort last regardless of dir
    expect(byDate[0].tier).toBe("associate");
  });

  it("filters the admin list down to pending accounts", async () => {
    await seedAccount(ctx.db, { tier: "pending" });
    await seedAccount(ctx.db, { tier: "alumni" });
    await seedAccount(ctx.db, { tier: "member" });

    const rows = await getAdminAccountsList(ctx.db, cfg, { tier: "pending" });

    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe("pending");
  });

  it("sorts pending accounts ahead of every other tier when sorting by tier", async () => {
    await seedAccount(ctx.db, { tier: "alumni" });
    await seedAccount(ctx.db, { tier: "pending" });
    await seedAccount(ctx.db, { tier: "member" });
    await seedAccount(ctx.db, { tier: "associate" });

    const rows = await getAdminAccountsList(ctx.db, cfg, { sort: "tier" });

    expect(rows.map((r) => r.tier)).toEqual(["pending", "member", "associate", "alumni"]);
  });

  it("summarizes token health", async () => {
    const a = await seedAccount(ctx.db, { tier: "member" });
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

describe("countAccountsByTier", () => {
  it("counts only the requested tier, ignoring other rows", async () => {
    await seedAccount(ctx.db, { tier: "pending" });
    await seedAccount(ctx.db, { tier: "pending" });
    await seedAccount(ctx.db, { tier: "alumni" });
    await seedAccount(ctx.db, { tier: "member" });

    expect(await countAccountsByTier(ctx.db, "pending")).toBe(2);
    expect(await countAccountsByTier(ctx.db, "alumni")).toBe(1);
  });

  it("returns 0 rather than a falsy non-number when a tier has no rows", async () => {
    await seedAccount(ctx.db, { tier: "alumni" });

    expect(await countAccountsByTier(ctx.db, "associate")).toBe(0);
  });
});
