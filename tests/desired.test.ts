import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Tier } from "@/core/tier";
import { getMemberCharacters, isContactsTarget } from "@/services/desired";
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

describe("getMemberCharacters", () => {
  it("returns every character of every member account and nothing else", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const alumni = await seedAccount(ctx.db, { tier: "alumni" });
    const associate = await seedAccount(ctx.db, { tier: "associate", tierLocked: true });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: member.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: member.id }); // alt counts too
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: alumni.id });
    await seedCharacter(ctx.db, cfg, { id: 4, accountId: associate.id });
    const rows = await getMemberCharacters(ctx.db);
    expect(rows.map((r) => r.characterId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({ accountId: member.id, tokenStatus: "valid" });
  });

  it("excludes affiliation_invalid characters — they can't be contact targets or ACL members", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: member.id, main: true });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: member.id,
      affiliationInvalid: true,
    });
    const rows = await getMemberCharacters(ctx.db);
    expect(rows.map((r) => r.characterId)).toEqual([1]);
  });

  it("agrees with isContactsTarget on the same rows", async () => {
    // The predicate exists so callers holding rows don't re-derive the desired
    // set by hand. This is the guard against the two definitions drifting.
    const member = await seedAccount(ctx.db, { tier: "member" });
    const associate = await seedAccount(ctx.db, { tier: "associate" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: member.id, main: true });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: member.id,
      affiliationInvalid: true,
    });
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: associate.id });

    const inSet = new Set((await getMemberCharacters(ctx.db)).map((r) => r.characterId));
    const cases: { id: number; tier: Tier; affiliationInvalid: boolean }[] = [
      { id: 1, tier: "member", affiliationInvalid: false },
      { id: 2, tier: "member", affiliationInvalid: true },
      { id: 3, tier: "associate", affiliationInvalid: false },
    ];
    for (const c of cases) {
      expect(isContactsTarget(c)).toBe(inSet.has(c.id));
    }
  });
});
