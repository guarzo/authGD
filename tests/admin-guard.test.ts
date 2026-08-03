import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account } from "@/db/schema";
import { resolveAdmin } from "@/lib/admin-guard";
import { createSession } from "@/services/session";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("resolveAdmin", () => {
  it("resolves an admin session", async () => {
    const acc = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, acc.id));
    const sid = await createSession(ctx.db, acc.id);
    expect(await resolveAdmin(ctx.db, sid)).toEqual({ accountId: acc.id });
  });

  it("rejects a signed-in non-admin", async () => {
    const acc = await seedAccount(ctx.db);
    const sid = await createSession(ctx.db, acc.id);
    expect(await resolveAdmin(ctx.db, sid)).toBeNull();
  });

  it("rejects missing and bogus sessions", async () => {
    expect(await resolveAdmin(ctx.db, undefined)).toBeNull();
    expect(await resolveAdmin(ctx.db, "not-a-session")).toBeNull();
  });
});
