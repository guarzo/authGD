import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Tier } from "@/core/tier";
import {
  getLocatableCharacters,
  getMemberCharacters,
  isContactsTarget,
} from "@/services/desired";
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

  it("carries corporation and alliance ids, so the access-list page and the syncs share one roster", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: member.id,
      main: true,
      corporationId: 500,
      allianceId: 900,
    });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: member.id });
    const rows = await getMemberCharacters(ctx.db);
    const byId = new Map(rows.map((r) => [r.characterId, r]));
    expect(byId.get(1)).toMatchObject({ corporationId: 500, allianceId: 900 });
    expect(byId.get(2)).toMatchObject({ corporationId: null, allianceId: null });
  });
});

describe("getLocatableCharacters", () => {
  it("returns characters of EVERY tier, not just members", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const alumni = await seedAccount(ctx.db, { tier: "alumni" });
    const associate = await seedAccount(ctx.db, { tier: "associate" });
    const pending = await seedAccount(ctx.db, { tier: "pending" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: member.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: alumni.id });
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: associate.id });
    await seedCharacter(ctx.db, cfg, { id: 4, accountId: pending.id });
    const rows = await getLocatableCharacters(ctx.db);
    expect(rows.map((r) => r.characterId).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("excludes affiliation_invalid characters — ESI rejects biomassed ids", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: acc.id,
      affiliationInvalid: true,
    });
    const rows = await getLocatableCharacters(ctx.db);
    expect(rows.map((r) => r.characterId)).toEqual([1]);
  });

  it("excludes characters with no stored refresh token — nothing to read with", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: acc.id, refreshToken: null });
    const rows = await getLocatableCharacters(ctx.db);
    expect(rows.map((r) => r.characterId)).toEqual([1]);
  });

  it("contains every member character, and more", async () => {
    // The guard against the two queries drifting: a location gap on a row the
    // contacts job syncs would be a bug. The fixture gives every member a
    // token deliberately — getMemberCharacters does NOT filter on
    // refresh_token_enc (a tokenless member is still a contact target), so
    // that is the condition under which the containment holds.
    const member = await seedAccount(ctx.db, { tier: "member" });
    const associate = await seedAccount(ctx.db, { tier: "associate" });
    await seedCharacter(ctx.db, cfg, { id: 1, accountId: member.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 2, accountId: member.id });
    await seedCharacter(ctx.db, cfg, { id: 3, accountId: associate.id });

    const members = await getMemberCharacters(ctx.db);
    const locatable = new Set(
      (await getLocatableCharacters(ctx.db)).map((r) => r.characterId),
    );
    for (const m of members) {
      expect(locatable.has(m.characterId), `member ${m.characterId} missing`).toBe(true);
    }
    expect(locatable.size).toBeGreaterThan(members.length); // the associate
  });
});
