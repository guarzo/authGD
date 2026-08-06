import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
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

/**
 * Makes the first `failTimes` `db.insert(auditLog)` calls reject, then
 * restores normal behaviour for every call after — `failTimes: 1` is a
 * one-time DB fault (a statement timeout, a serialization conflict) and
 * exercises the retry-within-the-same-tick path both jobs' catch blocks
 * rely on: it fails the "written inside the try" success write once,
 * forcing the catch's own attempt to be what actually lands the row.
 * `failTimes: Infinity` is a database that stays down for the whole
 * deprovision/row, so BOTH the success write and the catch's compensating
 * retry fail — this is what exercises the `catch (auditErr)` swallow-and-log
 * itself, which the one-time-fault tests never reach because their retry
 * succeeds.
 *
 * Restores `db.insert` in `finally` at each call site — `ctx.db` is a shared,
 * module-level connection reused by every test in this file, and an
 * unrestored override would leak into whichever test runs next.
 */
function failAuditInserts(db: Db, failTimes = 1) {
  const originalInsert = db.insert.bind(db) as (
    table: unknown,
  ) => ReturnType<Db["insert"]>;
  let calls = 0;
  db.insert = ((table: unknown) => {
    if (table === auditLog) {
      calls++;
      if (calls <= failTimes) {
        return {
          values: async () => {
            throw new Error("simulated audit insert failure");
          },
        };
      }
    }
    return originalInsert(table);
  }) as unknown as typeof db.insert;
  return () => {
    db.insert = originalInsert as unknown as typeof db.insert;
  };
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

  it("audits the roles that landed even when a later role write in the same tick fails permanently", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    // Member wants role 10 and currently holds 11 → add ["10"], remove ["11"].
    // The add succeeds; the remove then fails permanently.
    const d = fakeDiscord({ u1: ["11"] });
    const client: DiscordClient = {
      ...d.client,
      removeMemberRole: async () => {
        throw new DiscordApiError("discord DELETE roles failed (403)", {
          status: 403,
          transient: false,
        });
      },
    };
    const result = await runDiscordRolesJob({ db: ctx.db, cfg, discord: client });
    expect(result.status).toBe("partial");
    expect(result.counts).toMatchObject({ changed: 1, failed: 1 });
    const rows = await ctx.db.select().from(auditLog);
    // The add that really landed is recorded, not just the failure.
    const changedRows = rows.filter((r) => r.action === "discord.role_changed");
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]).toMatchObject({ target: "u1" });
    expect(changedRows[0].details).toMatchObject({
      added: ["10"],
      removed: [],
      tier: "member",
      partial: true,
    });
    const failureRows = rows.filter((r) => r.action === "discord.role_sync_failed");
    expect(failureRows).toHaveLength(1);
  });

  it("audits the strips that landed even when a later strip in the same tick fails permanently", async () => {
    const d = fakeDiscord({ u9: ["10", "11", "12"] });
    let calls = 0;
    const client: DiscordClient = {
      ...d.client,
      removeMemberRole: async (userId, roleId) => {
        calls++;
        if (calls === 2) {
          throw new DiscordApiError("discord DELETE roles failed (403)", {
            status: 403,
            transient: false,
          });
        }
        await d.client.removeMemberRole(userId, roleId);
      },
    };
    const result = await runDiscordRolesJob(
      { db: ctx.db, cfg, discord: client },
      { discordUserId: "u9" },
    );
    expect(result.status).toBe("failed");
    const rows = await ctx.db.select().from(auditLog);
    // The first removal really landed and must be recorded, not just the
    // strip failure on the second one.
    const changedRows = rows.filter((r) => r.action === "discord.role_changed");
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]).toMatchObject({ target: "u9" });
    expect(changedRows[0].details).toMatchObject({
      removed: ["10"],
      cause: "discord unlinked",
      partial: true,
    });
    const failureRows = rows.filter((r) => r.action === "discord.role_strip_failed");
    expect(failureRows).toHaveLength(1);
  });

  it("still audits the strips that landed when a later strip in the same tick fails transiently", async () => {
    const d = fakeDiscord({ u9: ["10", "11", "12"] });
    let calls = 0;
    const client: DiscordClient = {
      ...d.client,
      removeMemberRole: async (userId, roleId) => {
        calls++;
        if (calls === 2) {
          throw new DiscordApiError("discord DELETE roles failed (503)", {
            status: 503,
            transient: true,
          });
        }
        await d.client.removeMemberRole(userId, roleId);
      },
    };
    // Transient → thrown, not returned, so pg-boss retries the whole job. A
    // retry re-derives `remove` from the member's CURRENT roles, so it only
    // ever sees and audits what's left — the removal from THIS attempt must
    // be recorded now or it never appears in audit_log at all.
    await expect(
      runDiscordRolesJob({ db: ctx.db, cfg, discord: client }, { discordUserId: "u9" }),
    ).rejects.toThrow(/503/);
    const rows = await ctx.db.select().from(auditLog);
    const changedRows = rows.filter((r) => r.action === "discord.role_changed");
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]).toMatchObject({ target: "u9" });
    expect(changedRows[0].details).toMatchObject({
      removed: ["10"],
      cause: "discord unlinked",
      partial: true,
    });
    // `role_strip_failed` is written only for permanent failures.
    expect(rows.some((r) => r.action === "discord.role_strip_failed")).toBe(false);
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

  it("strip path: a one-time DB fault on the success audit write is retried and lands, not lost or mislabeled partial", async () => {
    const d = fakeDiscord({ u9: ["10", "12"] });
    const restore = failAuditInserts(ctx.db);
    try {
      // The first insert (the success write, now inside the try) fails; the
      // catch's own attempt is the second `db.insert(auditLog)` call and
      // succeeds. The failure is not a Discord error, so it still propagates
      // once the write has landed — that propagation is what makes
      // `sync_run.status` show "failed" instead of a false "ok".
      await expect(
        runDiscordRolesJob(
          { db: ctx.db, cfg, discord: d.client },
          { discordUserId: "u9" },
        ),
      ).rejects.toThrow(/simulated audit insert failure/);
    } finally {
      restore();
    }
    const rows = await ctx.db.select().from(auditLog);
    const changedRows = rows.filter((r) => r.action === "discord.role_changed");
    // Exactly one row, not zero (the fault didn't erase it) and not two (the
    // retry didn't duplicate it).
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]).toMatchObject({ target: "u9" });
    // Both roles landed at Discord before the audit write failed, so this is
    // a COMPLETE strip whose audit attempt needed a retry — `partial` must
    // read false, not true, even though the row came from the catch.
    expect(changedRows[0].details).toMatchObject({
      removed: ["10", "12"],
      cause: "discord unlinked",
      partial: false,
    });
  });

  it("main sweep: a one-time DB fault on the success audit write is retried and lands, without double-counting or mislabeling partial", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    const d = fakeDiscord({ u1: ["999"] }); // needs only role 10 added
    const restore = failAuditInserts(ctx.db);
    try {
      // Not a Discord error, so it's bucketed as a transient failure and the
      // job retries via `JobRetryError` — the same visible-failure shape the
      // strip path's propagation produces, reached a different way here
      // because this loop never rethrows per-row.
      await expect(
        runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client }),
      ).rejects.toThrow(/simulated audit insert failure/);
    } finally {
      restore();
    }
    const rows = await ctx.db.select().from(auditLog);
    const changedRows = rows.filter((r) => r.action === "discord.role_changed");
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]).toMatchObject({ target: "u1" });
    // The add fully landed before the audit write failed — complete, not
    // partial — and `counts.changed` must reflect ONE change, not two, even
    // though the write was attempted twice.
    expect(changedRows[0].details).toMatchObject({
      added: ["10"],
      removed: [],
      tier: "member",
      partial: false,
    });
    const [run] = await ctx.db.select().from(syncRun);
    expect(run.counts).toMatchObject({ changed: 1 });
  });

  it("strip path: swallows a persistent audit-write failure (both attempts) and still propagates the original error", async () => {
    const d = fakeDiscord({ u9: ["10", "12"] });
    const restore = failAuditInserts(ctx.db, Infinity);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls: unknown[][];
    try {
      // Both the success write and the catch's compensating retry fail —
      // the `catch (auditErr)` swallow itself has to run, not just the
      // retry-succeeds path the one-time-fault test above exercises.
      await expect(
        runDiscordRolesJob(
          { db: ctx.db, cfg, discord: d.client },
          { discordUserId: "u9" },
        ),
      ).rejects.toThrow(/simulated audit insert failure/);
    } finally {
      // Read the recorded calls BEFORE restoring — `mockRestore` also clears
      // call history, not just the implementation, so asserting after it
      // would always see zero calls regardless of what actually happened.
      calls = spy.mock.calls;
      restore();
      spy.mockRestore();
    }
    // Neither attempt landed: no row exists to mislabel or duplicate.
    const rows = await ctx.db.select().from(auditLog);
    expect(rows.some((r) => r.action === "discord.role_changed")).toBe(false);
    // The swallow logs rather than staying silent, correlatable to the member
    // and to what actually came off before the write failed.
    expect(calls).toContainEqual([
      expect.stringContaining("discord.role_changed audit write failed for u9"),
    ]);
    expect(calls).toContainEqual([expect.stringContaining("removed 10, 12")]);
  });

  it("main sweep: swallows a persistent audit-write failure (both attempts), still marks the row failed, and does not abort the rest of the sweep", async () => {
    const a1 = await seedAccount(ctx.db, { tier: "member", discordUserId: "u1" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: a1.id, main: true });
    const a2 = await seedAccount(ctx.db, { tier: "member", discordUserId: "u2" });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: a2.id, main: true });
    const d = fakeDiscord({ u1: ["999"], u2: ["11"] }); // both need role 10 added
    const restore = failAuditInserts(ctx.db, Infinity);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls: unknown[][];
    try {
      // Every `db.insert(auditLog)` in the whole run fails, so u1's row
      // reaches the swallow — the point of this test is that this does NOT
      // escape u1's own catch and abort u2 along with it.
      await expect(
        runDiscordRolesJob({ db: ctx.db, cfg, discord: d.client }),
      ).rejects.toThrow(/simulated audit insert failure/);
    } finally {
      // See the strip-path test above: read calls before restoring.
      calls = spy.mock.calls;
      restore();
      spy.mockRestore();
    }
    // u2's real Discord role change still landed, even though its own audit
    // write also failed and was swallowed — the loop reached it at all,
    // which an unguarded throw on u1's write would have prevented entirely.
    expect(d.added).toEqual(
      expect.arrayContaining([
        ["u1", "10"],
        ["u2", "10"],
      ]),
    );
    const rows = await ctx.db.select().from(auditLog);
    expect(rows.some((r) => r.action === "discord.role_changed")).toBe(false);
    expect(calls).toContainEqual([
      expect.stringContaining("discord.role_changed audit write failed for u1"),
    ]);
    expect(calls).toContainEqual([
      expect.stringContaining("discord.role_changed audit write failed for u2"),
    ]);
    const [run] = await ctx.db.select().from(syncRun);
    // Both rows are real changes with no audit trail to show for it —
    // `counts.changed` still reflects that they happened.
    expect(run.counts).toMatchObject({ changed: 2 });
    expect(run.status).toBe("partial");
  });
});
