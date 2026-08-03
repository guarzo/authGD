import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getFlygdCharacters, isContactsTarget } from "@/services/desired";
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

describe("getFlygdCharacters", () => {
  it("returns every character of every flygd account and nothing else", async () => {
    const flygd = await seedAccount(ctx.db, { tier: "flygd" });
    const green = await seedAccount(ctx.db, { tier: "green" });
    const blue = await seedAccount(ctx.db, { tier: "blue", tierLocked: true });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: flygd.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: flygd.id }); // alt counts too
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: green.id });
    await seedCharacter(ctx.db, cfg, { id: 4, accountId: blue.id });
    const rows = await getFlygdCharacters(ctx.db);
    expect(rows.map((r) => r.characterId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ accountId: flygd.id, tokenStatus: "valid" });
  });

  it("excludes affiliation_invalid characters — they can't be contact targets or ACL members", async () => {
    const flygd = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: flygd.id, main: true });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: flygd.id,
      affiliationInvalid: true,
    });
    const rows = await getFlygdCharacters(ctx.db);
    expect(rows.map((r) => r.characterId)).toEqual([1]);
  });

  it("agrees with isContactsTarget on the same rows", async () => {
    // The predicate exists so callers holding rows don't re-derive the desired
    // set by hand. This is the guard against the two definitions drifting.
    const flygd = await seedAccount(ctx.db, { tier: "flygd" });
    const blue = await seedAccount(ctx.db, { tier: "blue" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: flygd.id, main: true });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: flygd.id,
      affiliationInvalid: true,
    });
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: blue.id });

    const inSet = new Set((await getFlygdCharacters(ctx.db)).map((r) => r.characterId));
    const cases = [
      { id: 1, tier: "flygd", affiliationInvalid: false },
      { id: 2, tier: "flygd", affiliationInvalid: true },
      { id: 3, tier: "blue", affiliationInvalid: false },
    ];
    for (const c of cases) {
      expect(isContactsTarget(c)).toBe(inSet.has(c.id));
    }
  });
});
