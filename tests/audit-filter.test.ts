import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveFilterIdentity } from "@/services/audit";
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

/** Counts pg pool queries for the duration of `fn` (same shape as
 * tests/audit-resolve.test.ts) so we can assert the raw path is free. */
type PoolQuery = typeof import("pg").Pool.prototype.query;
async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
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
  // target "all" (src/app/admin/sync/actions.ts:13,25). Sending it down the
  // name path would match no character and silently return zero rows.
  it("treats the reserved literal 'all' as raw", async () => {
    const r = await resolveFilterIdentity(ctx.db, "target", "all");
    expect(r).toEqual({ kind: "raw", ids: ["all"] });
  });

  it("resolves an actor name to the account whose main displays it", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Zed");
    expect(r).toEqual({ kind: "name", name: "Zed", ids: [acc.id], accountCount: 1 });
  });

  it("matches case-insensitively", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "actor", "zED");
    expect(r.kind).toBe("name");
    expect((r as { ids: string[] }).ids).toEqual([acc.id]);
  });

  it("unions account, character and discord ids for a target name", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "target", "Zed");
    expect(r.kind).toBe("name");
    const ids = (r as { ids: string[] }).ids;
    expect(new Set(ids)).toEqual(new Set([acc.id, "90001", "555555555555555555"]));
  });

  it("does not include discord ids for an actor filter", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Zed");
    expect((r as { ids: string[] }).ids).toEqual([acc.id]);
  });

  it("resolves an alt's name to its character id only, never its account", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Boss", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: acc.id, name: "Alt Zed" });
    const r = await resolveFilterIdentity(ctx.db, "target", "Alt Zed");
    expect(r).toEqual({
      kind: "name", name: "Alt Zed", ids: ["90002"], accountCount: 1,
    });
  });

  it("an alt's name is unresolvable as an actor (no account displays it)", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Boss", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: acc.id, name: "Alt Zed" });
    const r = await resolveFilterIdentity(ctx.db, "actor", "Alt Zed");
    expect(r).toEqual({ kind: "none", name: "Alt Zed" });
  });

  it("reports accountCount 2 for two accounts sharing a main name", async () => {
    const a = await seedAccount(ctx.db);
    const b = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: a.id, name: "Zed", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: b.id, name: "Zed", main: true });
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
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: a.id, name: "Boss A", main: true });
    await seedCharacter(ctx.db, cfg, { id: 90002, accountId: b.id, name: "Boss B", main: true });
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
    await seedCharacter(ctx.db, cfg, { id: 90001, accountId: acc.id, name: "Zed", main: true });
    const t = await countQueries(() => resolveFilterIdentity(ctx.db, "target", "Zed"));
    expect(t.calls).toBeLessThanOrEqual(3);
    const a = await countQueries(() => resolveFilterIdentity(ctx.db, "actor", "Zed"));
    expect(a.calls).toBeLessThanOrEqual(2);
  });
});
