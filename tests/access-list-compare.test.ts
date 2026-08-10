import { describe, expect, it } from "vitest";
import {
  compareAccessList,
  type AccessEntry,
  type RosterCharacter,
} from "@/core/access-list-compare";

/** A roster character with the two affiliation columns spelled out per case. */
const member = (
  characterId: number,
  affiliation: { corporationId?: number | null; allianceId?: number | null } = {},
): RosterCharacter => ({
  characterId,
  name: `Char ${characterId}`,
  accountId: `acct-${characterId}`,
  corporationId: affiliation.corporationId ?? null,
  allianceId: affiliation.allianceId ?? null,
});

const entry = (
  kind: AccessEntry["kind"],
  entityId: number,
  access = "blocked_by_default",
): AccessEntry => ({ kind, entityId, access });

describe("compareAccessList", () => {
  it("grants effective access when the character itself is listed", () => {
    expect(
      compareAccessList({
        allowEveryone: false,
        entries: [entry("character", 1)],
        roster: [member(1)],
      }),
    ).toEqual({ missingAccess: [], nonMembers: [], matched: 1, broadGrants: [] });
  });

  it("grants effective access through the character's corporation", () => {
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("corporation", 500)],
      roster: [member(1, { corporationId: 500 })],
    });
    expect(result.missingAccess).toEqual([]);
    expect(result.matched).toBe(1);
  });

  it("grants effective access through the character's alliance", () => {
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("alliance", 900)],
      roster: [member(1, { corporationId: 500, allianceId: 900 })],
    });
    expect(result.missingAccess).toEqual([]);
    expect(result.matched).toBe(1);
  });

  it("grants effective access to everyone when allowEveryone is set", () => {
    const result = compareAccessList({
      allowEveryone: true,
      entries: [],
      roster: [member(1), member(2)],
    });
    expect(result.missingAccess).toEqual([]);
    expect(result.matched).toBe(2);
  });

  it("reports allowEveryone as a broad grant, because zero missing is by construction", () => {
    // A list open to everyone has no missing members BY CONSTRUCTION. Reporting
    // only "0 discrepancies" would read as "correctly configured" when it means
    // "open to everyone" (spec: Discrepancy means effective access).
    const result = compareAccessList({
      allowEveryone: true,
      entries: [],
      roster: [member(1), member(2)],
    });
    expect(result.missingAccess).toHaveLength(0);
    expect(result.broadGrants).toEqual([
      { kind: "everyone", entityId: null, coveredMembers: 2 },
    ]);
  });

  it("fills both buckets: members with no access, and listed characters we do not know", () => {
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("character", 1), entry("character", 77)],
      roster: [member(1), member(2)],
    });
    expect(result.missingAccess.map((c) => c.characterId)).toEqual([2]);
    expect(result.nonMembers).toEqual([77]);
    expect(result.matched).toBe(1);
  });

  it("counts our own covered members on a corporation grant, and claims no more", () => {
    // The count is partial by design: authGD stores a corporationId per
    // character but holds no corp roster, so it can say "covers 2 of ours" and
    // never "covers 2 in total".
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("corporation", 500), entry("corporation", 501)],
      roster: [
        member(1, { corporationId: 500 }),
        member(2, { corporationId: 500 }),
        member(3, { corporationId: 999 }),
      ],
    });
    expect(result.broadGrants).toEqual([
      { kind: "corporation", entityId: 500, coveredMembers: 2 },
      { kind: "corporation", entityId: 501, coveredMembers: 0 },
    ]);
    expect(result.missingAccess.map((c) => c.characterId)).toEqual([3]);
    expect(result.matched).toBe(2);
  });

  it("counts our own covered members on an alliance grant", () => {
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("alliance", 900)],
      roster: [
        member(1, { corporationId: 500, allianceId: 900 }),
        member(2, { corporationId: 501, allianceId: null }),
      ],
    });
    expect(result.broadGrants).toEqual([
      { kind: "alliance", entityId: 900, coveredMembers: 1 },
    ]);
    expect(result.missingAccess.map((c) => c.characterId)).toEqual([2]);
  });

  it("treats an empty list as every member missing, with nothing to report back", () => {
    expect(
      compareAccessList({
        allowEveryone: false,
        entries: [],
        roster: [member(1), member(2)],
      }),
    ).toEqual({
      missingAccess: [member(1), member(2)],
      nonMembers: [],
      matched: 0,
      broadGrants: [],
    });
  });

  it("is empty in every bucket when both sides are empty", () => {
    expect(compareAccessList({ allowEveryone: false, entries: [], roster: [] })).toEqual({
      missingAccess: [],
      nonMembers: [],
      matched: 0,
      broadGrants: [],
    });
  });

  it("never matches a null affiliation against an entity id", () => {
    // A character with no recorded corporation must not accidentally match a
    // corporation grant; null is "unknown", not "id 0".
    const result = compareAccessList({
      allowEveryone: false,
      entries: [entry("corporation", 500), entry("alliance", 900)],
      roster: [member(1)],
    });
    expect(result.missingAccess.map((c) => c.characterId)).toEqual([1]);
  });
});
