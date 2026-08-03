import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, outbox, syncRun } from "@/db/schema";
import { runDiscordRolesJob } from "@/jobs/discord-roles";
import { DiscordApiError, type DiscordClient } from "@/lib/discord/rest";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig(); // managed roles 10/11/12

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

const MANAGE_ROLES = String(1 << 28);
const validGuildRoles = [
  { id: "10", name: "FlyGD", position: 5, permissions: "0" },
  { id: "11", name: "Blue", position: 4, permissions: "0" },
  { id: "12", name: "Green", position: 3, permissions: "0" },
  { id: "bot-role", name: "Bot", position: 9, permissions: MANAGE_ROLES },
];

function fakeDiscord(members: Record<string, string[] | null>, guildRoles = validGuildRoles) {
  const added: Array<[string, string]> = [];
  const removed: Array<[string, string]> = [];
  const client: DiscordClient = {
    getGuildRoles: async () => guildRoles,
    getBotUserId: async () => "bot-user",
    getGuildMember: async (userId) => {
      if (userId === "bot-user") return { roles: ["bot-role"] };
      const roles = members[userId];
      return roles === null || roles === undefined ? null : { roles };
    },
    addMemberRole: async (userId, roleId) => {
      added.push([userId, roleId]);
    },
    removeMemberRole: async (userId, roleId) => {
      removed.push([userId, roleId]);
    },
  };
  return { client, added, removed };
}

describe("runDiscordRolesJob", () => {
  it("ensures exactly the tier's managed role, leaving other roles alone", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["11", "999"] });
    const result = await runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client });
    expect(result.status).toBe("ok");
    expect(d.added).toEqual([["u1", "10"]]);
    expect(d.removed).toEqual([["u1", "11"]]); // 999 untouched
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "discord.role_changed")).toBe(true);
  });

  it("config validation failure is permanent: failed run, webhook, NO retry", async () => {
    const badRoles = validGuildRoles.filter((r) => r.id !== "11"); // blue missing
    const d = fakeDiscord({}, badRoles);
    const webhook = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await runDiscordRolesJob({
      db: ctx.db,
      cfg,
      discord: d.client,
      fetchImpl: webhook as unknown as typeof fetch,
    });
    expect(result.status).toBe("failed"); // returned, not thrown → no retry loop
    expect(webhook).toHaveBeenCalledOnce();
    const runs = await ctx.db.select().from(syncRun);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorSummary).toContain("11");
  });

  it("treats a permanent config-fetch error (403) as permanent-config: no retry", async () => {
    const d = fakeDiscord({});
    const client: DiscordClient = {
      ...d.client,
      getGuildRoles: async () => {
        throw new DiscordApiError("discord GET /guilds/9000/roles failed (403)", {
          status: 403,
          transient: false,
        });
      },
    };
    const webhook = vi.fn(async () => new Response(null, { status: 204 }));
    // returned, not thrown: a bad bot token must not retry-loop
    const result = await runDiscordRolesJob({
      db: ctx.db,
      cfg,
      discord: client,
      fetchImpl: webhook as unknown as typeof fetch,
    });
    expect(result.status).toBe("failed");
    expect(webhook).toHaveBeenCalledOnce();
  });

  it("still retries transient config-fetch errors", async () => {
    const d = fakeDiscord({});
    const client: DiscordClient = {
      ...d.client,
      getGuildRoles: async () => {
        throw new DiscordApiError("discord GET /guilds/9000/roles failed (503)", {
          status: 503,
          transient: true,
        });
      },
    };
    await expect(
      runDiscordRolesJob({ db: ctx.db, cfg, discord: client }),
    ).rejects.toThrow(/503/); // thrown → pg-boss retries
  });

  it("logs and skips users not in the guild", async () => {
    const acc = await seedAccount(ctx.db, { tier: "green", discordUserId: "gone" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ gone: null });
    const result = await runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ notInGuild: 1 });
    expect(d.added).toEqual([]);
  });

  it("strips managed roles from an unlinked discord user ({kind:'discord-user'})", async () => {
    const d = fakeDiscord({ u9: ["10", "12", "999"] });
    const result = await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: d.client },
      { discordUserId: "u9" },
    );
    expect(result.status).toBe("ok");
    expect(d.removed.sort()).toEqual([
      ["u9", "10"],
      ["u9", "12"],
    ]);
    expect(d.added).toEqual([]);
  });

  it("a permanent DiscordApiError during a strip resolves with status failed (no throw)", async () => {
    const d = fakeDiscord({ u9: ["10", "12"] });
    const client: DiscordClient = {
      ...d.client,
      removeMemberRole: async () => {
        throw new DiscordApiError("discord DELETE roles failed (403)", {
          status: 403,
          transient: false,
        });
      },
    };
    const result = await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: client },
      { discordUserId: "u9" },
    );
    expect(result.status).toBe("failed");
  });

  it("re-syncs the account when a re-link lands DURING the strip", async () => {
    const d = fakeDiscord({ u9: ["10"] });
    // the re-link commits while the strip's role removal is in flight
    const client: DiscordClient = {
      ...d.client,
      removeMemberRole: async (userId, roleId) => {
        const acc = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u9" });
        await seedCharacter(ctx.db, cfg, { id: 99, accountId: acc.id, main: true });
        await d.client.removeMemberRole(userId, roleId);
      },
    };
    const result = await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: client },
      { discordUserId: "u9" },
    );
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ relinkResync: 1 });
    // the account path re-asserts the roles via a fresh outbox row
    const rows = await ctx.db.select().from(outbox);
    expect(rows.map((r) => r.payload)).toContainEqual(
      expect.objectContaining({ kind: "account" }),
    );
  });

  it("skips the strip when the user re-linked meanwhile", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u9" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u9: ["10"] });
    const result = await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: d.client },
      { discordUserId: "u9" },
    );
    expect(result.counts).toMatchObject({ skipped: 1 });
    expect(d.removed).toEqual([]);
  });

  it("scopes to one account when accountId is passed", async () => {
    const a1 = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: a1.id, main: true });
    const a2 = await seedAccount(ctx.db, { tier: "green", discordUserId: "u2" });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: a2.id, main: true });
    const d = fakeDiscord({ u1: [], u2: [] });
    await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: d.client },
      { accountId: a1.id },
    );
    expect(d.added).toEqual([["u1", "10"]]); // u2 untouched
  });
});
