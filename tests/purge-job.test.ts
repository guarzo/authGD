import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fleetRecoveryChallenge, oauthTransaction, outbox, session } from "@/db/schema";
import { beginFleetRecovery } from "@/services/fleet-recovery";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
import { recoveryInitiation } from "./helpers/fleet-recovery";
import { eq } from "drizzle-orm";
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
  it("purges expired recovery challenges independently while mode is disabled and retains unexpired spent quota rows", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
    });
    const now = new Date();
    const keys = await pairDevice(
      ctx.db,
      (await seedAccount(ctx.db, { tier: "member" })).id,
      now,
    );
    const expired = await beginFleetRecovery(
      ctx.db,
      recoveryInitiation(keys, new Date(now.getTime() - 120000)),
    );
    const pending = await beginFleetRecovery(
      ctx.db,
      recoveryInitiation(keys, new Date(now.getTime() - 119000)),
    );
    // Hold issuance in the past so its on-demand cleanup doesn't delete expired.
    await ctx.db
      .update(fleetRecoveryChallenge)
      .set({ consumedAt: now, expiresAt: new Date(now.getTime() + 120000) })
      .where(eq(fleetRecoveryChallenge.id, pending.challengeId));
    await transitionFleetSharingMode(ctx.db, {
      enabled: false,
      expectedRevision: ready.revision + 1,
    });
    const result = await runPurgeJob({ db: ctx.db });
    expect(result.status).toBe("ok");
    expect(result.counts?.fleetRecoveryChallenges).toBe(1);
    const rows = await ctx.db.select().from(fleetRecoveryChallenge);
    expect(rows.map((r) => r.id)).toEqual([pending.challengeId]);
    expect(rows[0].consumedAt).not.toBeNull();
    expect(rows.map((r) => r.id)).not.toContain(expired.challengeId);
  });

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
    expect(result.counts).toEqual({
      sessions: 1,
      oauthTransactions: 2,
      outbox: 1,
      fleetRecoveryChallenges: 0,
      fleetSourceCleanup: 0,
    });

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
