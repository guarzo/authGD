import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { character, fleetEligibility } from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { buildDeviceCatalogue, readEligibleAccount } from "@/services/fleet-eligibility";
import { testConfig } from "./helpers/config";
import { setupTestDb } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const NOW = new Date("2026-09-04T12:00:00.000Z");
const FRESH = new Date(NOW.getTime() + 60_000);
const PAST = new Date(NOW.getTime() - 60_000);

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

async function seedEligibility(
  db: Db,
  opts: {
    characterId: number;
    accountId: string;
    fleetId: number;
    rosterCharacterIds: number[];
    expiresAt: Date;
    outcomeCode?: string;
  },
) {
  await db.insert(fleetEligibility).values({
    characterId: opts.characterId,
    accountId: opts.accountId,
    fleetId: opts.fleetId,
    rosterCharacterIds: opts.rosterCharacterIds,
    verifiedAt: NOW,
    expiresAt: opts.expiresAt,
    outcomeCode: opts.outcomeCode ?? "ok",
  });
}

describe("buildDeviceCatalogue", () => {
  it("includes only the account's own linked characters, ordered by id", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const other = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 92100002,
      accountId: acc.id,
      name: "Bravo",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 92100001,
      accountId: acc.id,
      name: "Alpha",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 92100099,
      accountId: other.id,
      name: "Someone Else",
    });

    const catalogue = await buildDeviceCatalogue(ctx.db, acc.id);
    expect(catalogue.characters).toEqual([
      { characterId: 92100001, characterName: "Alpha" },
      { characterId: 92100002, characterName: "Bravo" },
    ]);
  });

  it("produces the same revision for the same character set, and a different one after a rename", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, {
      id: 92100010,
      accountId: acc.id,
      name: "Charlie",
    });

    const first = await buildDeviceCatalogue(ctx.db, acc.id);
    const second = await buildDeviceCatalogue(ctx.db, acc.id);
    expect(second.revision).toBe(first.revision);
    expect(Number.isSafeInteger(first.revision)).toBe(true);

    await ctx.db
      .update(character)
      .set({ name: "Charlie Renamed" })
      .where(eq(character.id, ch.id));

    const third = await buildDeviceCatalogue(ctx.db, acc.id);
    expect(third.revision).not.toBe(first.revision);
  });
});

describe("readEligibleAccount", () => {
  it("returns non-null for an active Member with fresh Fleet Read evidence", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", status: "active" });
    const ch = await seedCharacter(ctx.db, cfg, {
      id: 92200001,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    await seedEligibility(ctx.db, {
      characterId: ch.id,
      accountId: acc.id,
      fleetId: 5100001,
      rosterCharacterIds: [ch.id],
      expiresAt: FRESH,
    });

    const result = await readEligibleAccount(ctx.db, acc.id, NOW);
    expect(result).not.toBeNull();
    expect(result?.fleetIds).toEqual([5100001]);
    expect([...(result?.rosterByFleet.get(5100001) ?? [])]).toEqual([ch.id]);
  });

  it("returns non-null for a cryo Member (status is not checked)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member", status: "cryo" });
    const ch = await seedCharacter(ctx.db, cfg, {
      id: 92200002,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    await seedEligibility(ctx.db, {
      characterId: ch.id,
      accountId: acc.id,
      fleetId: 5100002,
      rosterCharacterIds: [ch.id],
      expiresAt: FRESH,
    });

    expect(await readEligibleAccount(ctx.db, acc.id, NOW)).not.toBeNull();
  });

  it.each([
    ["associate", 92200010] as const,
    ["alumni", 92200011] as const,
    ["pending", 92200012] as const,
  ])(
    "returns null for a %s-tier account even with fresh evidence",
    async (tier, charId) => {
      const acc = await seedAccount(ctx.db, { tier });
      const ch = await seedCharacter(ctx.db, cfg, {
        id: charId,
        accountId: acc.id,
        scopes: [FLEET_READ_SCOPE],
      });
      await seedEligibility(ctx.db, {
        characterId: ch.id,
        accountId: acc.id,
        fleetId: 5100010,
        rosterCharacterIds: [ch.id],
        expiresAt: FRESH,
      });

      expect(await readEligibleAccount(ctx.db, acc.id, NOW)).toBeNull();
    },
  );

  it("returns null for an unknown account id", async () => {
    expect(
      await readEligibleAccount(ctx.db, "00000000-0000-0000-0000-000000000000", NOW),
    ).toBeNull();
  });

  it("returns null when the character's current scopes no longer include FLEET_READ_SCOPE", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, {
      id: 92200020,
      accountId: acc.id,
      scopes: ["esi-characters.read_contacts.v1"],
    });
    await seedEligibility(ctx.db, {
      characterId: ch.id,
      accountId: acc.id,
      fleetId: 5100020,
      rosterCharacterIds: [ch.id],
      expiresAt: FRESH,
    });

    expect(await readEligibleAccount(ctx.db, acc.id, NOW)).toBeNull();
  });

  it("returns null when the only eligibility row has expired", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, {
      id: 92200030,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    await seedEligibility(ctx.db, {
      characterId: ch.id,
      accountId: acc.id,
      fleetId: 5100030,
      rosterCharacterIds: [ch.id],
      expiresAt: PAST,
    });

    expect(await readEligibleAccount(ctx.db, acc.id, NOW)).toBeNull();
  });

  it("returns null when the roster does not include the row's own character (fails closed)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, {
      id: 92200040,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    await seedEligibility(ctx.db, {
      characterId: ch.id,
      accountId: acc.id,
      fleetId: 5100040,
      rosterCharacterIds: [999999999], // does not include ch.id
      expiresAt: FRESH,
    });

    expect(await readEligibleAccount(ctx.db, acc.id, NOW)).toBeNull();
  });

  it('returns null when the eligibility row\'s outcomeCode is not "ok"', async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, {
      id: 92200070,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    await seedEligibility(ctx.db, {
      characterId: ch.id,
      accountId: acc.id,
      fleetId: 5100070,
      rosterCharacterIds: [ch.id],
      expiresAt: FRESH,
      outcomeCode: "not_in_fleet",
    });

    expect(await readEligibleAccount(ctx.db, acc.id, NOW)).toBeNull();
  });

  it("returns null when the character has since moved to a different account than the eligibility row's own accountId", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const otherAcc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, {
      id: 92200071,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    await seedEligibility(ctx.db, {
      characterId: ch.id,
      accountId: acc.id,
      fleetId: 5100071,
      rosterCharacterIds: [ch.id],
      expiresAt: FRESH,
    });

    // Simulate a reclaim: the character now belongs to a different account,
    // while the eligibility row's own (denormalized) accountId is unchanged.
    await ctx.db
      .update(character)
      .set({ accountId: otherAcc.id })
      .where(eq(character.id, ch.id));

    expect(await readEligibleAccount(ctx.db, acc.id, NOW)).toBeNull();
    // The row is not simply "moved": the new account does not gain
    // eligibility from a row that was never verified for its character.
    expect(await readEligibleAccount(ctx.db, otherAcc.id, NOW)).toBeNull();
  });

  it("builds one fleet-to-roster set per fleet for a multi-fleet account, never letting the caller choose", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const chA = await seedCharacter(ctx.db, cfg, {
      id: 92200050,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    const chB = await seedCharacter(ctx.db, cfg, {
      id: 92200051,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    await seedEligibility(ctx.db, {
      characterId: chA.id,
      accountId: acc.id,
      fleetId: 5100050,
      rosterCharacterIds: [chA.id, 70000001],
      expiresAt: FRESH,
    });
    await seedEligibility(ctx.db, {
      characterId: chB.id,
      accountId: acc.id,
      fleetId: 5100051,
      rosterCharacterIds: [chB.id, 70000002, 70000003],
      expiresAt: FRESH,
    });

    const result = await readEligibleAccount(ctx.db, acc.id, NOW);
    expect(result).not.toBeNull();
    expect([...result!.fleetIds]).toEqual([5100050, 5100051]);
    expect([...(result!.rosterByFleet.get(5100050) ?? [])].sort()).toEqual(
      [chA.id, 70000001].sort(),
    );
    expect([...(result!.rosterByFleet.get(5100051) ?? [])].sort()).toEqual(
      [chB.id, 70000002, 70000003].sort(),
    );
  });

  it("returns the earliest expiry among the contributing rows", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const chA = await seedCharacter(ctx.db, cfg, {
      id: 92200060,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    const chB = await seedCharacter(ctx.db, cfg, {
      id: 92200061,
      accountId: acc.id,
      scopes: [FLEET_READ_SCOPE],
    });
    const soonerExpiry = new Date(NOW.getTime() + 10_000);
    const laterExpiry = new Date(NOW.getTime() + 120_000);
    await seedEligibility(ctx.db, {
      characterId: chA.id,
      accountId: acc.id,
      fleetId: 5100060,
      rosterCharacterIds: [chA.id],
      expiresAt: laterExpiry,
    });
    await seedEligibility(ctx.db, {
      characterId: chB.id,
      accountId: acc.id,
      fleetId: 5100061,
      rosterCharacterIds: [chB.id],
      expiresAt: soonerExpiry,
    });

    const result = await readEligibleAccount(ctx.db, acc.id, NOW);
    expect(result?.expiresAt).toEqual(soonerExpiry);
  });
});
