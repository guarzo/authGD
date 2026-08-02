import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, session } from "@/db/schema";
import { createSession, getSessionAccount, revokeAccountSessions } from "@/services/session";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("sessions", () => {
  it("creates, resolves, and revokes sessions", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    expect(sid.length).toBeGreaterThanOrEqual(32);

    const resolved = await getSessionAccount(ctx.db, sid);
    expect(resolved?.accountId).toBe(acc.id);

    await revokeAccountSessions(ctx.db, acc.id);
    expect(await getSessionAccount(ctx.db, sid)).toBeNull();
  });

  it("rejects expired sessions", async () => {
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    await ctx.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.id, sid));
    expect(await getSessionAccount(ctx.db, sid)).toBeNull();
  });
});
