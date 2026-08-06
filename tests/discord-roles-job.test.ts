import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, discordLink, outbox, syncRun } from "@/db/schema";
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
  { id: "10", name: "Member", position: 5, permissions: "0" },
  { id: "11", name: "Associate", position: 4, permissions: "0" },
  { id: "12", name: "Alumni", position: 3, permissions: "0" },
  { id: "bot-role", name: "Bot", position: 9, permissions: MANAGE_ROLES },
];

/** A member entry is either its role ids, or the full payload when a test
 *  cares about the names the job now lifts off it. */
type FakeMember =
  | string[]
  | null
  | {
      roles: string[];
      nick?: string | null;
      user?: { username?: string | null; global_name?: string | null } | null;
    };

function fakeDiscord(members: Record<string, FakeMember>, guildRoles = validGuildRoles) {
  const added: Array<[string, string]> = [];
  const removed: Array<[string, string]> = [];
  const client: DiscordClient = {
    getGuildRoles: async () => guildRoles,
    getBotUserId: async () => "bot-user",
    getGuildMember: async (userId) => {
      if (userId === "bot-user") return { roles: ["bot-role"] };
      const entry = members[userId];
      if (entry === null || entry === undefined) return null;
      return Array.isArray(entry) ? { roles: entry } : entry;
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
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["11", "999"] });
    const result = await runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client });
    expect(result.status).toBe("ok");
    expect(d.added).toEqual([["u1", "10"]]);
    expect(d.removed).toEqual([["u1", "11"]]); // 999 untouched
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "discord.role_changed")).toBe(true);
  });

  // The backfill. Links made before these columns existed, and links whose
  // owner has since renamed, are corrected here rather than by a migration —
  // `getGuildMember` was already being called for the role diff, so this costs
  // no extra API call and needs no separate job.
  it("records the member's handle and guild display name off the role read", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({
      u1: {
        roles: ["10"],
        nick: "Wardec Wally",
        user: { username: "guarzo", global_name: "Guarzo" },
      },
    });
    await runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client });
    const [link] = await ctx.db.select().from(discordLink);
    expect(link.username).toBe("guarzo");
    // nick wins over global_name: it is what this guild calls them.
    expect(link.displayName).toBe("Wardec Wally");
  });

  it("falls back to the global name when the member set no guild nickname", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({
      u1: { roles: ["10"], user: { username: "guarzo", global_name: "Guarzo" } },
    });
    await runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client });
    const [link] = await ctx.db.select().from(discordLink);
    expect(link.displayName).toBe("Guarzo");
  });

  it("leaves both names null when Discord sends neither, rather than writing a placeholder", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["10"] });
    await runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client });
    const [link] = await ctx.db.select().from(discordLink);
    expect(link.username).toBeNull();
    expect(link.displayName).toBeNull();
  });

  // Unguarded, unlike every role write in this job. Same line `wanderer.ts`
  // draws for its ACL observation: dry-run suppresses what we do TO the
  // outside world, not what the outside world told us. Guarding it would leave
  // the names permanently stale on an instance that only ever runs dry.
  it("records the names in dry-run, where the role changes are suppressed", async () => {
    const dryCfg = testConfig({ SYNC_MODE: "dry-run" });
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, dryCfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({
      u1: { roles: ["11"], nick: "Wardec Wally", user: { username: "guarzo" } },
    });
    const result = await runDiscordRolesJob({
      db: ctx.db,
      cfg: dryCfg,
      discord: d.client,
    });
    expect(result.status).toBe("ok");
    // The run really was suppressed, or the assertion below proves nothing.
    expect(result.counts).toHaveProperty("wouldChangeRoles", 1);
    const [link] = await ctx.db.select().from(discordLink);
    expect(link.username).toBe("guarzo");
    expect(link.displayName).toBe("Wardec Wally");
  });

  it("config validation failure is permanent: failed run, webhook, NO retry", async () => {
    const badRoles = validGuildRoles.filter((r) => r.id !== "11"); // associate missing
    const d = fakeDiscord({}, badRoles);
    const webhook = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await runDiscordRolesJob({
      db: ctx.db,
      cfg,
      discord: d.client,
      fetchImpl: webhook,
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
      fetchImpl: webhook,
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
    const acc = await seedAccount(ctx.db, { tier: "alumni", discordUserId: "gone" });
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
    // The strip failed silently before this fix: an unlinked member kept
    // roles they no longer qualified for with no trace of why.
    const [row] = await ctx.db.select().from(auditLog);
    expect(row).toMatchObject({
      actor: "system",
      action: "discord.role_strip_failed",
      target: "u9",
    });
    expect(row.details).toMatchObject({
      roleId: "10", // first of ["10", "12"] — the strip stopped there
      error: expect.stringContaining("403"),
    });
  });

  it("a permanent role-write failure in the main sweep writes one diagnosable audit row", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["999"] }); // needs role 10 added
    const client: DiscordClient = {
      ...d.client,
      addMemberRole: async () => {
        throw new DiscordApiError("discord PUT roles failed (403)", {
          status: 403,
          transient: false,
        });
      },
    };
    const result = await runDiscordRolesJob({ db: ctx.db, cfg, discord: client });
    expect(result.status).toBe("partial");
    expect(result.counts).toMatchObject({ failed: 1 });
    const rows = await ctx.db.select().from(auditLog);
    const failureRows = rows.filter((r) => r.action === "discord.role_sync_failed");
    expect(failureRows).toHaveLength(1);
    expect(failureRows[0]).toMatchObject({ target: "u1" });
    expect(failureRows[0].details).toMatchObject({
      op: "add",
      roleId: "10",
      tier: "member",
      error: expect.stringContaining("403"),
    });
  });

  it("does not write a second row for the exact same recurring failure", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["999"] });
    const client: DiscordClient = {
      ...d.client,
      addMemberRole: async () => {
        throw new DiscordApiError("discord PUT roles failed (403)", {
          status: 403,
          transient: false,
        });
      },
    };
    // Two ticks in a row, same unresolved cause each time.
    await runDiscordRolesJob({ db: ctx.db, cfg, discord: client });
    await runDiscordRolesJob({ db: ctx.db, cfg, discord: client });
    const rows = await ctx.db.select().from(auditLog);
    expect(rows.filter((r) => r.action === "discord.role_sync_failed")).toHaveLength(1);
  });

  it("writes again once the failure changes (a different role, or a different error)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["999"] });
    const failing: DiscordClient = {
      ...d.client,
      addMemberRole: async () => {
        throw new DiscordApiError("discord PUT roles failed (403)", {
          status: 403,
          transient: false,
        });
      },
    };
    await runDiscordRolesJob({ db: ctx.db, cfg, discord: failing });
    const laterFailing: DiscordClient = {
      ...d.client,
      addMemberRole: async () => {
        throw new DiscordApiError("discord PUT roles failed (500)", {
          status: 500,
          transient: false,
        });
      },
    };
    await runDiscordRolesJob({ db: ctx.db, cfg, discord: laterFailing });
    const rows = await ctx.db.select().from(auditLog);
    expect(rows.filter((r) => r.action === "discord.role_sync_failed")).toHaveLength(2);
  });

  it("does not audit a transient failure (pg-boss retry already covers it)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["999"] });
    const client: DiscordClient = {
      ...d.client,
      addMemberRole: async () => {
        throw new DiscordApiError("discord PUT roles failed (503)", {
          status: 503,
          transient: true,
        });
      },
    };
    // A transient failure earns a retry (thrown, not returned — same as the
    // config-fetch case above), so this rejects rather than resolving.
    await expect(
      runDiscordRolesJob({ db: ctx.db, cfg, discord: client }),
    ).rejects.toThrow(/503/);
    const rows = await ctx.db.select().from(auditLog);
    expect(rows.some((r) => r.action === "discord.role_sync_failed")).toBe(false);
  });

  it("re-syncs the account when a re-link lands DURING the strip", async () => {
    const d = fakeDiscord({ u9: ["10"] });
    // the re-link commits while the strip's role removal is in flight
    const client: DiscordClient = {
      ...d.client,
      removeMemberRole: async (userId, roleId) => {
        const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u9" });
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
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u9" });
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
    const a1 = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: a1.id, main: true });
    const a2 = await seedAccount(ctx.db, { tier: "alumni", discordUserId: "u2" });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: a2.id, main: true });
    const d = fakeDiscord({ u1: [], u2: [] });
    await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: d.client },
      { accountId: a1.id },
    );
    expect(d.added).toEqual([["u1", "10"]]); // u2 untouched
  });
});
