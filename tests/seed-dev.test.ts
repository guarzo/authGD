import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, character, session } from "@/db/schema";
import { isLocalDatabase, seedDev } from "../scripts/seed-dev";
import { testConfig } from "./helpers/config";
import { setupTestDb, truncateAll } from "./helpers/db";

/**
 * The dev seed's contract is that it is safe to re-run. That is the whole
 * reason it uses fixed ids and upserts: e2e's helper auto-increments from a
 * module-level counter and would fail on a duplicate character primary key the
 * second time. These tests pin the convergence.
 */
const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("seedDev", () => {
  it("seeds accounts across every tier, with an admin and alts", async () => {
    const seeded = await seedDev(ctx.db, cfg);

    const accounts = await ctx.db.select().from(account);
    expect(accounts).toHaveLength(seeded.length);
    expect(accounts.filter((a) => a.isAdmin)).toHaveLength(1);
    expect(new Set(accounts.map((a) => a.tier))).toEqual(
      new Set(["flygd", "blue", "green"]),
    );
    expect(accounts.some((a) => a.status === "cryo")).toBe(true);
    expect(accounts.some((a) => a.tierLocked)).toBe(true);

    // Every account has its main set, and the deferred composite FK held.
    expect(accounts.every((a) => a.mainCharacterId !== null)).toBe(true);

    const chars = await ctx.db.select().from(character);
    expect(chars.length).toBeGreaterThan(accounts.length); // alts exist
    // Reserved block, clear of e2e's 90_000_0xx counter.
    expect(chars.every((c) => c.id >= 91_000_000 && c.id < 92_000_000)).toBe(true);
  });

  it("is idempotent: a second run converges instead of colliding or doubling", async () => {
    const first = await seedDev(ctx.db, cfg);
    const accountsAfterFirst = await ctx.db.select().from(account);
    const charsAfterFirst = await ctx.db.select().from(character);

    // The bug this guards against: e2e's seedMember would throw a duplicate
    // key here, because its id counter resets with the process.
    const second = await seedDev(ctx.db, cfg);

    const accountsAfterSecond = await ctx.db.select().from(account);
    const charsAfterSecond = await ctx.db.select().from(character);
    expect(accountsAfterSecond).toHaveLength(accountsAfterFirst.length);
    expect(charsAfterSecond).toHaveLength(charsAfterFirst.length);

    // Same accounts, not replacements — the uuids must survive.
    expect(new Set(second.map((s) => s.accountId))).toEqual(
      new Set(first.map((s) => s.accountId)),
    );
  });

  it("converges account state that drifted since the last run", async () => {
    const [first] = await seedDev(ctx.db, cfg);
    await ctx.db
      .update(account)
      .set({ tier: "green", isAdmin: false, status: "cryo" })
      .where(eq(account.id, first.accountId));

    await seedDev(ctx.db, cfg);

    const [restored] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.id, first.accountId));
    expect(restored.tier).toBe("flygd");
    expect(restored.isAdmin).toBe(true);
    expect(restored.status).toBe("active");
  });

  it("issues one usable session per account and revokes the previous run's", async () => {
    const first = await seedDev(ctx.db, cfg);
    expect(await ctx.db.select().from(session)).toHaveLength(first.length);

    const second = await seedDev(ctx.db, cfg);
    // Not accumulating: still one per account, and the ids are new.
    expect(await ctx.db.select().from(session)).toHaveLength(second.length);
    expect(new Set(second.map((s) => s.sessionId))).not.toEqual(
      new Set(first.map((s) => s.sessionId)),
    );
  });
});

describe("isLocalDatabase", () => {
  it("accepts loopback hosts", () => {
    for (const url of [
      "postgres://u:p@localhost:5433/authgd",
      "postgres://u:p@127.0.0.1:5433/authgd",
      "postgres://u:p@[::1]:5433/authgd",
      "postgresql://u:p@localhost:5433/authgd",
    ]) {
      expect(isLocalDatabase(url)).toBe(true);
    }
  });

  // `postgres:` is a non-special URL scheme, so WHATWG preserves host case:
  // new URL("postgres://LOCALHOST/db").hostname === "LOCALHOST". Without an
  // explicit toLowerCase these are refused, pushing developers toward
  // ALLOW_REMOTE_SEED=1 to work around a false rejection.
  it("accepts loopback hosts regardless of case", () => {
    for (const url of [
      "postgres://u:p@LOCALHOST:5433/authgd",
      "postgres://u:p@LocalHost:5433/authgd",
    ]) {
      expect(isLocalDatabase(url)).toBe(true);
    }
  });

  it("rejects remote hosts and anything unparseable", () => {
    for (const url of [
      "postgres://u:p@db.example.com:5432/authgd",
      "postgres://u:p@10.0.0.5:5432/authgd",
      "not a url",
      "",
    ]) {
      expect(isLocalDatabase(url)).toBe(false);
    }
  });
});
