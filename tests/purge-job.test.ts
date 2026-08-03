import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { oauthTransaction, outbox, session } from "@/db/schema";
import { runPurgeJob } from "@/jobs/purge";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

const DAY = 24 * 60 * 60 * 1000;

describe("runPurgeJob", () => {
  it("purges expired sessions, spent oauth transactions, and old dispatched outbox rows", async () => {
    const acc = await seedAccount(ctx.db);
    await ctx.db.insert(session).values([
      { id: "live", accountId: acc.id, expiresAt: new Date(Date.now() + DAY) },
      { id: "expired", accountId: acc.id, expiresAt: new Date(Date.now() - DAY) },
    ]);
    await ctx.db.insert(oauthTransaction).values([
      {
        stateHash: "live",
        intent: "login",
        pkceVerifier: "v",
        expiresAt: new Date(Date.now() + DAY),
      },
      {
        stateHash: "expired",
        intent: "login",
        pkceVerifier: "v",
        expiresAt: new Date(Date.now() - DAY),
      },
      {
        stateHash: "consumed",
        intent: "login",
        pkceVerifier: "v",
        expiresAt: new Date(Date.now() + DAY),
        consumedAt: new Date(),
      },
    ]);
    await ctx.db.insert(outbox).values([
      { payload: { kind: "all" } }, // undispatched → NEVER purged
      {
        payload: { kind: "all" },
        dispatchedAt: new Date(Date.now() - 8 * DAY),
        createdAt: new Date(Date.now() - 8 * DAY),
      },
      {
        payload: { kind: "all" },
        dispatchedAt: new Date(),
        createdAt: new Date(Date.now() - 8 * DAY),
      },
    ]);

    const result = await runPurgeJob({ db: ctx.db });
    expect(result.status).toBe("ok");
    expect(result.counts).toEqual({ sessions: 1, oauthTransactions: 2, outbox: 1 });

    expect((await ctx.db.select().from(session)).map((s) => s.id)).toEqual(["live"]);
    expect(
      (await ctx.db.select().from(oauthTransaction)).map((t) => t.stateHash),
    ).toEqual(["live"]);
    const survivors = await ctx.db.select().from(outbox);
    expect(survivors).toHaveLength(2);
    const dispatchedAts = survivors.map((r) => r.dispatchedAt);
    expect(dispatchedAts).toContainEqual(null); // undispatched survivor
    expect(dispatchedAts.some((d) => d !== null && d.getTime() > Date.now() - DAY)).toBe(
      true,
    ); // recent-dispatched survivor
  });
});
