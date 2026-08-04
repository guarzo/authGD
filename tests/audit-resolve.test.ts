import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, discordLink } from "@/db/schema";
import { logAudit, queryAuditLog, resolveAuditIdentities } from "@/services/audit";
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
