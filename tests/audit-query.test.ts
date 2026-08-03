import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { logAudit, queryAuditLog } from "@/services/audit";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("queryAuditLog", () => {
  beforeEach(async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "acc-1" });
    await logAudit(ctx.db, { actor: "admin-1", action: "tier.unlocked", target: "acc-1" });
    await logAudit(ctx.db, { actor: "admin-1", action: "character.linked", target: "42" });
  });

  it("returns newest first, unfiltered", async () => {
    const rows = await queryAuditLog(ctx.db);
    expect(rows.map((r) => r.action)).toEqual([
      "character.linked",
      "tier.unlocked",
      "tier.changed",
    ]);
  });

  it("filters by action prefix, actor, and target", async () => {
    expect((await queryAuditLog(ctx.db, { action: "tier." })).map((r) => r.action)).toEqual([
      "tier.unlocked",
      "tier.changed",
    ]);
    expect(await queryAuditLog(ctx.db, { actor: "admin-1" })).toHaveLength(2);
    expect(await queryAuditLog(ctx.db, { target: "42" })).toHaveLength(1);
  });

  it("treats LIKE wildcards in the action filter as literals", async () => {
    expect(await queryAuditLog(ctx.db, { action: "tier%" })).toHaveLength(0);
    expect(await queryAuditLog(ctx.db, { action: "t_er." })).toHaveLength(0);
  });

  it("paginates with beforeId and caps the limit", async () => {
    const all = await queryAuditLog(ctx.db);
    const older = await queryAuditLog(ctx.db, { beforeId: all[0].id });
    expect(older.map((r) => r.id)).toEqual(all.slice(1).map((r) => r.id));
    expect(await queryAuditLog(ctx.db, { limit: 1 })).toHaveLength(1);
  });

  it("hard-caps the limit at 100 even when more rows exist and a higher limit is requested", async () => {
    for (let i = 0; i < 101; i++) {
      await logAudit(ctx.db, { actor: "system", action: "bulk.seed", target: `row-${i}` });
    }
    const rows = await queryAuditLog(ctx.db, { limit: 101 });
    expect(rows).toHaveLength(100);
  });
});
