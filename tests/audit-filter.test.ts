import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_CRON } from "@/core/schedules";
import { logAudit, queryAuditLog, resolveFilterIdentity } from "@/services/audit";
import { setupTestDb, truncateAll } from "./helpers/db";
import { discordLink } from "@/db/schema";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

/** Counts pg pool queries for the duration of `fn` (same shape as
 * tests/audit-resolve.test.ts) so we can assert the raw path is free. */
type PoolQuery = typeof import("pg").Pool.prototype.query;
async function countQueries<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  let calls = 0;
  const pool = ctx.pool as unknown as { query: PoolQuery };
  const origQuery: PoolQuery = pool.query.bind(pool);
  pool.query = ((...args: Parameters<PoolQuery>) => {
    calls++;
    return (origQuery as (...a: Parameters<PoolQuery>) => ReturnType<PoolQuery>)(...args);
  }) as PoolQuery;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    pool.query = origQuery;
  }
}

describe("resolveFilterIdentity", () => {
  it("treats a UUID as raw, with no queries", async () => {
    const uuid = "3f9a1c2e-0000-4000-8000-000000000001";
    const { result, calls } = await countQueries(() =>
      resolveFilterIdentity(ctx.db, "actor", uuid),
    );
    expect(result).toEqual({ kind: "raw", ids: [uuid] });
    expect(calls).toBe(0);
  });

  it("treats a bare digit string as raw, with no queries", async () => {
    const { result, calls } = await countQueries(() =>
      resolveFilterIdentity(ctx.db, "target", "90001"),
    );
    expect(result).toEqual({ kind: "raw", ids: ["90001"] });
    expect(calls).toBe(0);
  });

  it("treats the reserved literal 'system' as raw", async () => {
    const r = await resolveFilterIdentity(ctx.db, "actor", "system");
    expect(r).toEqual({ kind: "raw", ids: ["system"] });
  });

  // Regression guard: sync.requested / sync.recheck_requested write the literal
  // target "all" (src/app/admin/sync/actions.ts:14,56). Sending it down the
  // name path would match no character and silently return zero rows.
  it("treats the reserved literal 'all' as raw", async () => {
    const r = await resolveFilterIdentity(ctx.db, "target", "all");
    expect(r).toEqual({ kind: "raw", ids: ["all"] });
  });

  // A single-job re-run writes the JOB TYPE as the target (actions.ts:46), so
  // every schedules-table key is a literal too. Derived from JOB_CRON on both
  // sides on purpose: the point is that adding a scheduled job cannot leave a
  // target that renders in the log but cannot be filtered by.
  it.each(Object.keys(JOB_CRON))(
    "treats the job type %s as raw, with no queries",
    async (jobType) => {
      const { result, calls } = await countQueries(() =>
        resolveFilterIdentity(ctx.db, "target", jobType),
      );
      expect(result).toEqual({ kind: "raw", ids: [jobType] });
      expect(calls).toBe(0);
    },
  );

  // The reservation is scoped to the column that needs it. A job type is only
  // ever written to `target`, so reserving it for `actor` as well would make
  // an account or character with that name unfindable to buy nothing. This is
  // the half of the tradeoff we refused.
  it("still resolves a character named like a job type in the actor column", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Wanderer",
      main: true,
    });
    const res = await resolveFilterIdentity(ctx.db, "actor", "Wanderer");
    expect(res).toMatchObject({ kind: "name", name: "Wanderer" });
    expect(res).not.toEqual({ kind: "raw", ids: ["Wanderer"] });
  });

  // The end-to-end shape of the bug: the row exists, and the filter finds it.
  it("finds a single-job sync.requested row by its job-type target", async () => {
    const acc = await seedAccount(ctx.db);
    await logAudit(ctx.db, {
      actor: acc.id,
      action: "sync.requested",
      target: "wanderer",
    });
    await logAudit(ctx.db, { actor: acc.id, action: "sync.requested", target: "all" });
    const res = await resolveFilterIdentity(ctx.db, "target", "wanderer");
    expect(res).toEqual({ kind: "raw", ids: ["wanderer"] });
    const rows = await queryAuditLog(ctx.db, {
      targetIds: res.kind === "none" ? [] : res.ids,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("wanderer");
    // and the page renders it as a filter link rather than dead text
    expect(rows[0].targetKind).toBe("literal");
  });

  it("resolves an actor name to the account whose main displays it", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Zed",
      main: true,
    });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Zed");
    expect(r).toEqual({ kind: "name", name: "Zed", ids: [acc.id], accountCount: 1 });
  });

  it("matches case-insensitively", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Zed",
      main: true,
    });
    const r = await resolveFilterIdentity(ctx.db, "actor", "zED");
    expect(r.kind).toBe("name");
    expect((r as { ids: string[] }).ids).toEqual([acc.id]);
  });

  it("unions account, character and discord ids for a target name", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Zed",
      main: true,
    });
    const r = await resolveFilterIdentity(ctx.db, "target", "Zed");
    expect(r.kind).toBe("name");
    const ids = (r as { ids: string[] }).ids;
    expect(new Set(ids)).toEqual(new Set([acc.id, "90001", "555555555555555555"]));
  });

  it("does not include discord ids for an actor filter", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Zed",
      main: true,
    });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Zed");
    expect((r as { ids: string[] }).ids).toEqual([acc.id]);
  });

  it("resolves an alt's name to its character id only, never its account", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Boss",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: acc.id, name: "Alt Zed" });
    // The owning account HAS a discord link. Filtering by the alt's name must
    // still not pull it in: the discord id belongs to the person as displayed
    // (their main), and an alt's name is never what the log shows for it.
    // Without this row the exclusion would hold by accident rather than by rule.
    await ctx.db
      .insert(discordLink)
      .values({ accountId: acc.id, discordUserId: "555555555555555555" });
    const r = await resolveFilterIdentity(ctx.db, "target", "Alt Zed");
    expect(r).toEqual({
      kind: "name",
      name: "Alt Zed",
      ids: ["90002"],
      accountCount: 1,
    });
  });

  it("an alt's name is unresolvable as an actor (no account displays it)", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Boss",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: acc.id, name: "Alt Zed" });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Alt Zed");
    expect(r).toEqual({ kind: "none", name: "Alt Zed" });
  });

  it("reports accountCount 2 for two accounts sharing a main name", async () => {
    const a = await seedAccount(ctx.db);
    const b = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: a.id,
      name: "Zed",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, {
      id: 90002,
      accountId: b.id,
      name: "Zed",
      main: true,
    });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Zed");
    expect(r.kind).toBe("name");
    expect((r as { accountCount: number }).accountCount).toBe(2);
    expect(new Set((r as { ids: string[] }).ids)).toEqual(new Set([a.id, b.id]));
  });

  // The reason accountCount exists. Two same-named ALTS on two accounts widen
  // the target results across an account boundary while no account *displays*
  // the name -- counting only display-accounts would report 0 and hide it.
  it("counts owning accounts when two same-named alts widen a target filter", async () => {
    const a = await seedAccount(ctx.db);
    const b = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: a.id,
      name: "Boss A",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, {
      id: 90002,
      accountId: b.id,
      name: "Boss B",
      main: true,
    });
    await seedCharacter(ctx.db, cfg, { id: 90003, accountId: a.id, name: "Zed" });
    await seedCharacter(ctx.db, cfg, { id: 90004, accountId: b.id, name: "Zed" });
    const r = await resolveFilterIdentity(ctx.db, "target", "Zed");
    expect(r.kind).toBe("name");
    expect((r as { accountCount: number }).accountCount).toBe(2);
    expect(new Set((r as { ids: string[] }).ids)).toEqual(new Set(["90003", "90004"]));
  });

  it("returns kind none for a name that matches nothing, in one query", async () => {
    const { result, calls } = await countQueries(() =>
      resolveFilterIdentity(ctx.db, "target", "Nobody"),
    );
    expect(result).toEqual({ kind: "none", name: "Nobody" });
    expect(calls).toBe(1); // short-circuits after the character lookup
  });

  it("stays within the query budget: <=3 for a target name, <=2 for an actor name", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Zed",
      main: true,
    });
    const t = await countQueries(() => resolveFilterIdentity(ctx.db, "target", "Zed"));
    expect(t.calls).toBeLessThanOrEqual(3);
    const a = await countQueries(() => resolveFilterIdentity(ctx.db, "actor", "Zed"));
    expect(a.calls).toBeLessThanOrEqual(2);
  });
});

describe("queryAuditLog id-array filters", () => {
  it("matches a single id with equality, as before", async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "all" });
    await logAudit(ctx.db, { actor: "admin-1", action: "tier.changed", target: "42" });
    const rows = await queryAuditLog(ctx.db, { actorIds: ["admin-1"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("admin-1");
  });

  it("matches any of several ids", async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "a" });
    await logAudit(ctx.db, { actor: "admin-1", action: "tier.changed", target: "b" });
    await logAudit(ctx.db, { actor: "admin-2", action: "tier.changed", target: "c" });
    const rows = await queryAuditLog(ctx.db, { actorIds: ["admin-1", "admin-2"] });
    expect(rows.map((r) => r.actor).sort()).toEqual(["admin-1", "admin-2"]);
  });

  it("returns nothing, and issues no query, for an empty id list", async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "all" });
    const { result, calls } = await countQueries(() =>
      queryAuditLog(ctx.db, { actorIds: [] }),
    );
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("unions target ids across identifier forms", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Zed",
      main: true,
    });
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: acc.id });
    await logAudit(ctx.db, {
      actor: "system",
      action: "character.linked",
      target: "90001",
    });
    await logAudit(ctx.db, {
      actor: "system",
      action: "discord.role_changed",
      target: "555555555555555555",
    });
    await logAudit(ctx.db, {
      actor: "system",
      action: "tier.changed",
      target: "someone-else",
    });

    const res = await resolveFilterIdentity(ctx.db, "target", "Zed");
    const rows = await queryAuditLog(ctx.db, {
      targetIds: res.kind === "none" ? [] : res.ids,
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.action).sort()).toEqual([
      "character.linked",
      "discord.role_changed",
      "tier.changed",
    ]);
  });

  it("keeps beforeId keyset paging working under a union filter", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Zed",
      main: true,
    });
    for (let i = 0; i < 3; i++) {
      await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: acc.id });
      await logAudit(ctx.db, {
        actor: "system",
        action: "character.linked",
        target: "90001",
      });
    }
    const res = await resolveFilterIdentity(ctx.db, "target", "Zed");
    const ids = res.kind === "none" ? [] : res.ids;
    const all = await queryAuditLog(ctx.db, { targetIds: ids });
    expect(all).toHaveLength(6);
    const older = await queryAuditLog(ctx.db, { targetIds: ids, beforeId: all[0].id });
    expect(older).toHaveLength(5);
    expect(older.every((r) => r.id < all[0].id)).toBe(true);
  });
});
