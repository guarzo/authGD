import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, discordLink, payoutOperation } from "@/db/schema";
import {
  logAudit,
  queryAuditLog,
  resolveAuditIdentities,
  resolveFilterIdentity,
} from "@/services/audit";
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

/**
 * Counts calls made through the pg pool's `.query` for the duration of `fn`,
 * so we can assert resolution is batched rather than issued per row. Restores
 * the original method afterward regardless of success/failure.
 */
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

describe("resolveAuditIdentities / queryAuditLog resolution", () => {
  it("returns an empty array without resolution for an empty row set, issuing no queries", async () => {
    const { result: rows, calls } = await countQueries(() =>
      resolveAuditIdentities(ctx.db, []),
    );
    expect(rows).toEqual([]);
    expect(calls).toBe(0);
  });

  it("resolves actor 'system' to kind system with no name", async () => {
    await logAudit(ctx.db, { actor: "system", action: "tier.changed", target: "all" });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.actorKind).toBe("system");
    expect(row.actorName).toBeNull();
    expect(row.actor).toBe("system");
  });

  it("resolves an actor account uuid to its main character name", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90001,
      accountId: acc.id,
      name: "Actor Main",
      main: true,
    });
    await logAudit(ctx.db, { actor: acc.id, action: "tier.unlocked", target: acc.id });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.actorKind).toBe("account");
    expect(row.actorName).toBe("Actor Main");
    expect(row.actor).toBe(acc.id); // raw preserved
  });

  it("leaves an actor uuid with no matching account unresolved", async () => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    await logAudit(ctx.db, { actor: fakeUuid, action: "tier.unlocked", target: "all" });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.actorKind).toBe("unresolved");
    expect(row.actorName).toBeNull();
    expect(row.actor).toBe(fakeUuid);
  });

  it("resolves an account-shaped target to its main character name", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90002,
      accountId: acc.id,
      name: "Target Main",
      main: true,
    });
    await logAudit(ctx.db, { actor: "system", action: "status.changed", target: acc.id });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("account");
    expect(row.targetName).toBe("Target Main");
    expect(row.target).toBe(acc.id);
  });

  it("resolves a character-id target to the character's name", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, { id: 90003, accountId: acc.id, name: "Some Alt" });
    await logAudit(ctx.db, {
      actor: "system",
      action: "character.reclaimed",
      target: "90003",
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("character");
    expect(row.targetName).toBe("Some Alt");
    expect(row.target).toBe("90003");
  });

  it("resolves a discord snowflake target to the linked account's main character name", async () => {
    const acc = await seedAccount(ctx.db, { discordUserId: "555555555555555555" });
    await seedCharacter(ctx.db, cfg, {
      id: 90004,
      accountId: acc.id,
      name: "Discord Main",
      main: true,
    });
    await logAudit(ctx.db, {
      actor: acc.id,
      action: "discord.linked",
      target: "555555555555555555",
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("discord");
    expect(row.targetName).toBe("Discord Main");
    expect(row.target).toBe("555555555555555555");
  });

  it("classifies target 'all' as a literal", async () => {
    await logAudit(ctx.db, {
      actor: "system",
      action: "sync.recheck_requested",
      target: "all",
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("literal");
    expect(row.targetName).toBeNull();
    expect(row.target).toBe("all");
  });

  // RESERVED_TARGET_LITERALS inherits "system" from the any-field set, which
  // reads like an accident of composition and is not one: without it a target
  // of "system" would fall through to name resolution, find nothing, and render
  // as a dead `unresolved` cell instead of a filter link.
  it("classifies target 'system' as a literal too, not just as an actor", async () => {
    await logAudit(ctx.db, {
      actor: "system",
      action: "sync.requested",
      target: "system",
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("literal");
    expect(row.targetName).toBeNull();
    expect(row.target).toBe("system");
  });

  it("leaves an unresolvable target unchanged (discord.unlinked's stale previous snowflake)", async () => {
    await logAudit(ctx.db, {
      actor: "system",
      action: "discord.unlinked",
      target: "999999999999999999", // never linked to anyone
      details: { reason: "replaced" },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("unresolved");
    expect(row.targetName).toBeNull();
    expect(row.target).toBe("999999999999999999");
  });

  it("leaves target unresolved when the character id doesn't exist", async () => {
    await logAudit(ctx.db, {
      actor: "system",
      action: "token.needs_reauth",
      target: "424242",
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("unresolved");
    expect(row.targetName).toBeNull();
  });

  it("handles an account with a null mainCharacterId as unresolved", async () => {
    const acc = await seedAccount(ctx.db); // no character seeded, mainCharacterId stays null
    await logAudit(ctx.db, { actor: acc.id, action: "tier.unlocked", target: acc.id });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.actorKind).toBe("unresolved");
    expect(row.actorName).toBeNull();
    expect(row.targetKind).toBe("unresolved");
    expect(row.targetName).toBeNull();
  });

  it("does not confuse an account-shaped target with a discord/character id when action says otherwise", async () => {
    // A uuid-shaped target logged under a character.* action shouldn't be
    // treated as a character id (it won't match the digits shape anyway),
    // proving the shape+action combination, not action alone, gates resolution.
    const acc = await seedAccount(ctx.db);
    await logAudit(ctx.db, {
      actor: "system",
      action: "character.reclaimed",
      target: acc.id,
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("unresolved");
    expect(row.targetName).toBeNull();
  });

  it("resolves a reclaim's fromAccount to the origin account's main character name", async () => {
    const oldAcc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90005,
      accountId: oldAcc.id,
      name: "Old Owner",
      main: true,
    });
    await logAudit(ctx.db, {
      actor: "system",
      action: "character.reclaimed",
      target: "90006",
      details: { fromAccount: oldAcc.id },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.detailAccountNames).toEqual({ fromAccount: "Old Owner" });
  });

  it("leaves detailAccountNames empty when the reclaim's origin account no longer resolves", async () => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    await logAudit(ctx.db, {
      actor: "system",
      action: "character.reclaimed",
      target: "90007",
      details: { fromAccount: fakeUuid },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.detailAccountNames).toEqual({});
  });

  it("leaves detailAccountNames empty for actions that don't declare an account-uuid detail key", async () => {
    await logAudit(ctx.db, {
      actor: "system",
      action: "tier.changed",
      target: "all",
      details: { from: "member", to: "alumni" },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.detailAccountNames).toEqual({});
  });

  it("resolves a detail character id (account.main_changed's mainCharacterId)", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90008,
      accountId: acc.id,
      name: "New Main",
      main: true,
    });
    await logAudit(ctx.db, {
      actor: acc.id,
      action: "account.main_changed",
      target: acc.id,
      details: { mainCharacterId: 90008 },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.detailCharacterNames).toEqual({ mainCharacterId: "New Main" });
  });

  it("resolves both characterId and previousCharacterId on a holder_replaced row to distinct names", async () => {
    const acc1 = await seedAccount(ctx.db);
    const acc2 = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90009,
      accountId: acc1.id,
      name: "New Holder",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 90010,
      accountId: acc2.id,
      name: "Old Holder",
    });
    await logAudit(ctx.db, {
      actor: "system",
      action: "access_list.holder_replaced",
      target: "some-list",
      details: { characterId: 90009, previousCharacterId: 90010 },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.detailCharacterNames).toEqual({
      characterId: "New Holder",
      previousCharacterId: "Old Holder",
    });
  });

  it("leaves detailCharacterNames empty when the detail character id doesn't exist", async () => {
    await logAudit(ctx.db, {
      actor: "system",
      action: "account.main_changed",
      target: "all",
      details: { mainCharacterId: 424242 },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.detailCharacterNames).toEqual({});
  });

  it("leaves detailCharacterNames empty for actions that don't declare a character-id detail key", async () => {
    await logAudit(ctx.db, {
      actor: "system",
      action: "tier.changed",
      target: "all",
      details: { from: "member", to: "alumni" },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.detailCharacterNames).toEqual({});
  });

  it("resolves a full page of 200+ rows with a small, constant number of queries (no N+1)", async () => {
    const accounts = await Promise.all(
      Array.from({ length: 20 }, () => seedAccount(ctx.db)),
    );
    await Promise.all(
      accounts.map((acc, i) =>
        seedCharacter(ctx.db, cfg, {
          id: 91000 + i,
          accountId: acc.id,
          name: `Main ${i}`,
          main: true,
        }),
      ),
    );
    // Give a few accounts a discord link too.
    await ctx.db.insert(discordLink).values(
      accounts.slice(0, 5).map((acc, i) => ({
        accountId: acc.id,
        discordUserId: `10000000000000000${i}`,
      })),
    );

    for (let i = 0; i < 220; i++) {
      const acc = accounts[i % accounts.length];
      await logAudit(ctx.db, {
        actor: acc.id,
        action: i % 2 === 0 ? "tier.changed" : "character.reauthed",
        target: i % 2 === 0 ? acc.id : String(91000 + (i % accounts.length)),
      });
    }

    const rows = await ctx.db.select().from(auditLog).orderBy(auditLog.id);
    expect(rows.length).toBeGreaterThanOrEqual(200);

    const { result: resolved, calls } = await countQueries(() =>
      resolveAuditIdentities(ctx.db, rows),
    );

    expect(resolved).toHaveLength(rows.length);
    expect(resolved.every((r) => r.actorName !== null)).toBe(true);
    // Fixed, small number of batched queries regardless of 220 rows:
    // accounts + discordLinks (parallel) + discordAccounts + characters.
    expect(calls).toBeLessThanOrEqual(4);
  });
});

describe("resolveAuditIdentities: payout target kind", () => {
  it("resolves a payout.paid row's target to the operation's name", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Thursday roam", occurredAt: new Date(), corpSharePct: "10.00" })
      .returning();
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.paid",
      target: op.id,
      details: { participantId: "irrelevant-here" },
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("payout");
    expect(row.targetName).toBe("Thursday roam");
    expect(row.target).toBe(op.id); // raw uuid preserved
  });

  it("leaves an unknown operation uuid unresolved, raw target preserved", async () => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.finalized",
      target: fakeUuid,
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("unresolved");
    expect(row.targetName).toBeNull();
    expect(row.target).toBe(fakeUuid);
  });

  it("does not misclassify a payout row as an account, even though both target uuids", async () => {
    // Same uuid shape as an account id, seeded as a payout operation only —
    // if targetKindFromAction ever fell back to "account" for payout.* this
    // would spuriously resolve via the account/character join instead.
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90101,
      accountId: acc.id,
      name: "Should Not Appear",
      main: true,
    });
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Roster test", occurredAt: new Date(), corpSharePct: "0" })
      .returning();
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.roster_set",
      target: op.id,
    });
    const [row] = await queryAuditLog(ctx.db);
    expect(row.targetKind).toBe("payout");
    expect(row.targetName).toBe("Roster test");
    expect(row.targetName).not.toBe("Should Not Appear");
  });

  it("still names a deleted operation's older rows, via the payout.deleted fallback", async () => {
    // The operation row itself is never inserted here -- a hard delete leaves
    // nothing to join against, which is exactly the case this test is for.
    const opId = "11111111-1111-1111-1111-111111111111";
    await logAudit(ctx.db, { actor: "system", action: "payout.created", target: opId });
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.paid",
      target: opId,
      details: { participantId: "irrelevant-here" },
    });
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.deleted",
      target: opId,
      details: {
        name: "Deleted Roam",
        occurredAt: "2026-01-01",
        participantCount: 1,
        totalValue: "10.00",
      },
    });
    const rows = await queryAuditLog(ctx.db);
    for (const row of rows) {
      expect(row.targetKind).toBe("payout");
      expect(row.targetName).toBe("Deleted Roam");
    }
  });
});

describe("resolveFilterIdentity: payout operation names", () => {
  it("resolves a target filter by a live operation's name to that operation's uuid", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Thursday roam", occurredAt: new Date(), corpSharePct: "10.00" })
      .returning();
    await logAudit(ctx.db, { actor: "system", action: "payout.paid", target: op.id });
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.paid",
      target: "00000000-0000-0000-0000-000000000000",
    });

    const resolution = await resolveFilterIdentity(ctx.db, "target", "Thursday roam");
    expect(resolution.kind).toBe("name");
    if (resolution.kind !== "name") throw new Error("unreachable");
    expect(resolution.ids).toEqual([op.id]);
    expect(resolution.operationCount).toBe(1);
    expect(resolution.accountCount).toBe(0);

    const rows = await queryAuditLog(ctx.db, { targetIds: resolution.ids });
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe(op.id);
  });

  it("matches an operation name case-insensitively", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Thursday Roam", occurredAt: new Date(), corpSharePct: "0" })
      .returning();

    const resolution = await resolveFilterIdentity(ctx.db, "target", "thursday roam");
    expect(resolution.kind).toBe("name");
    if (resolution.kind !== "name") throw new Error("unreachable");
    expect(resolution.ids).toEqual([op.id]);
    expect(resolution.operationCount).toBe(1);
  });

  it("resolves a target filter by a deleted operation's name via the payout.deleted fallback", async () => {
    // No payout_operation row at all -- a hard delete leaves nothing to join
    // against, only the denormalised name on the payout.deleted audit row.
    const opId = "11111111-1111-1111-1111-111111111111";
    await logAudit(ctx.db, { actor: "system", action: "payout.created", target: opId });
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.paid",
      target: opId,
      details: { participantId: "irrelevant-here" },
    });
    await logAudit(ctx.db, {
      actor: "system",
      action: "payout.deleted",
      target: opId,
      details: { name: "Deleted Roam", occurredAt: "2026-01-01", participantCount: 1 },
    });

    const resolution = await resolveFilterIdentity(ctx.db, "target", "Deleted Roam");
    expect(resolution.kind).toBe("name");
    if (resolution.kind !== "name") throw new Error("unreachable");
    expect(resolution.ids).toEqual([opId]);
    expect(resolution.operationCount).toBe(1);

    const rows = await queryAuditLog(ctx.db, { targetIds: resolution.ids });
    expect(rows.map((r) => r.action).sort()).toEqual([
      "payout.created",
      "payout.deleted",
      "payout.paid",
    ]);
  });

  it("unions an account match and an operation match sharing a name", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90201,
      accountId: acc.id,
      name: "Shared Name",
      main: true,
    });
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Shared Name", occurredAt: new Date(), corpSharePct: "0" })
      .returning();

    const resolution = await resolveFilterIdentity(ctx.db, "target", "Shared Name");
    expect(resolution.kind).toBe("name");
    if (resolution.kind !== "name") throw new Error("unreachable");
    expect(resolution.accountCount).toBe(1);
    expect(resolution.operationCount).toBe(1);
    expect(new Set(resolution.ids)).toEqual(new Set([acc.id, "90201", op.id]));
  });

  it("gives operationCount 2 when two operations share a name", async () => {
    const [op1] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Twin Roam", occurredAt: new Date(), corpSharePct: "0" })
      .returning();
    const [op2] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Twin Roam", occurredAt: new Date(), corpSharePct: "0" })
      .returning();

    const resolution = await resolveFilterIdentity(ctx.db, "target", "Twin Roam");
    expect(resolution.kind).toBe("name");
    if (resolution.kind !== "name") throw new Error("unreachable");
    expect(resolution.operationCount).toBe(2);
    expect(new Set(resolution.ids)).toEqual(new Set([op1.id, op2.id]));
  });

  it("never resolves an operation name in the actor column", async () => {
    await ctx.db
      .insert(payoutOperation)
      .values({ name: "Actorless Roam", occurredAt: new Date(), corpSharePct: "0" })
      .returning();

    const resolution = await resolveFilterIdentity(ctx.db, "actor", "Actorless Roam");
    expect(resolution).toEqual({ kind: "none", name: "Actorless Roam" });
  });

  it("still returns raw for a pasted uuid with zero queries, guarding the short-circuit", async () => {
    const someUuid = "22222222-2222-2222-2222-222222222222";
    const { result: resolution, calls } = await countQueries(() =>
      resolveFilterIdentity(ctx.db, "target", someUuid),
    );
    expect(resolution).toEqual({ kind: "raw", ids: [someUuid] });
    expect(calls).toBe(0);
  });
});
